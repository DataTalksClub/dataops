import { it } from 'node:test';
import assert from 'node:assert/strict';
import { KMSClient } from '@aws-sdk/client-kms';
import { createSecretReader } from '../src/secrets/reader';
import { resolveSecretCipher } from '../src/secrets/cipher';

it('local ciphertext is bound to the requested name', async () => {
  const cipher = resolveSecretCipher();
  const ciphertext = await cipher.encrypt('allowed', '{"value":"fixture"}');
  assert.equal(await cipher.decrypt('allowed', ciphertext), '{"value":"fixture"}');
  await assert.rejects(cipher.decrypt('other', ciphertext));
});

it('KMS encrypt and decrypt always include the name and configured key', async () => {
  const previous = process.env.DATAOPS_SECRETS_KMS_KEY;
  const original = KMSClient.prototype.send;
  const inputs: any[] = [];
  process.env.DATAOPS_SECRETS_KMS_KEY = 'fixture-key';
  KMSClient.prototype.send = (async (command: any) => {
    inputs.push(command.input);
    return { CiphertextBlob: Buffer.from('cipher'), Plaintext: Buffer.from('{}') };
  }) as any;
  try {
    const cipher = resolveSecretCipher();
    await cipher.encrypt('allowed', '{}');
    await cipher.decrypt('allowed', Buffer.from('cipher').toString('base64'));
    for (const input of inputs) {
      assert.deepEqual(input.EncryptionContext, { secret: 'allowed' });
      assert.equal(input.KeyId, 'fixture-key');
    }
  } finally {
    KMSClient.prototype.send = original;
    if (previous === undefined) delete process.env.DATAOPS_SECRETS_KMS_KEY;
    else process.env.DATAOPS_SECRETS_KMS_KEY = previous;
  }
});

it('machine reader requests only one ciphertext and sends name context to KMS', async () => {
  const read = createSecretReader({
    tableName: 'fixture-table', keyId: 'fixture-key', region: 'eu-west-1',
    dynamodb: { send: async (command: any) => {
      assert.deepEqual(command.input.Key, { PK: { S: 'SECRETS' }, SK: { S: 'SECRET#allowed' } });
      assert.equal(command.input.ConsistentRead, true);
      return { Item: { data: { S: Buffer.from('cipher').toString('base64') } } };
    } } as any,
    kms: { send: async (command: any) => {
      assert.deepEqual(command.input.EncryptionContext, { secret: 'allowed' });
      assert.equal(command.input.KeyId, 'fixture-key');
      return { Plaintext: Buffer.from('{"value":"fixture"}') };
    } } as any,
  });
  assert.deepEqual(await read('allowed'), { value: 'fixture' });
  await assert.rejects(read('bad/name'));
});

it('missing secrets do not call KMS', async () => {
  const read = createSecretReader({ tableName: 'fixture', keyId: 'fixture', region: 'eu-west-1',
    dynamodb: { send: async () => ({}) } as any,
    kms: { send: async () => { throw new Error('must not decrypt'); } } as any });
  await assert.rejects(read('missing'), /does not exist/);
});
