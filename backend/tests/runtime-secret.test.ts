import test from 'node:test';
import assert from 'node:assert/strict';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { KMSClient } from '@aws-sdk/client-kms';
import { portalRuntimeSecret } from '../src/runtimeSecret';

test('portal runtime reads fresh context-bound value and propagates decrypt denial', async () => {
  const env = { ...process.env };
  const ddbSend = DynamoDBClient.prototype.send;
  const kmsSend = KMSClient.prototype.send;
  let calls = 0;
  let denied = false;
  try {
    delete process.env.WORK_ENGINE_PORTAL_SECRET;
    process.env.WORK_ENGINE_PORTAL_SECRET_NAME = 'dataops-v1.work-engine.portal-secret';
    process.env.DATAOPS_SECRETS_TABLE = 'fixture-secrets';
    process.env.DATAOPS_SECRETS_KMS_KEY = 'fixture-key';
    process.env.AWS_REGION = 'eu-west-1';
    DynamoDBClient.prototype.send = (async (command: any) => {
      assert.equal(command.input.TableName, 'fixture-secrets');
      assert.equal(command.input.Key.SK.S, 'SECRET#dataops-v1.work-engine.portal-secret');
      return { Item: { data: { S: Buffer.from('ciphertext').toString('base64') } } };
    }) as any;
    KMSClient.prototype.send = (async (command: any) => {
      assert.deepEqual(command.input.EncryptionContext, { secret: 'dataops-v1.work-engine.portal-secret' });
      if (denied) throw new Error('decrypt denied');
      return { Plaintext: Buffer.from(JSON.stringify({ value: `fixture-${++calls}` })) };
    }) as any;
    assert.equal(await portalRuntimeSecret(), 'fixture-1');
    assert.equal(await portalRuntimeSecret(), 'fixture-2');
    denied = true;
    await assert.rejects(portalRuntimeSecret(), /decrypt denied/);
  } finally {
    process.env = env;
    DynamoDBClient.prototype.send = ddbSend;
    KMSClient.prototype.send = kmsSend;
  }
});
