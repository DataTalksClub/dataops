import { DynamoDBClient, GetItemCommand } from '@aws-sdk/client-dynamodb';
import { DecryptCommand, KMSClient } from '@aws-sdk/client-kms';
import { decodeFields } from './cipher';

/** Read an imported SecretString verbatim using this Lambda's workload identity. */
export async function readRuntimeSecret(name: string): Promise<string> {
  const read = createSecretReader({
    tableName: process.env.DATAOPS_SECRETS_TABLE || '',
    keyId: process.env.DATAOPS_SECRETS_KMS_KEY || '',
    region: process.env.AWS_REGION || '',
  });
  const fields = await read(name);
  if (typeof fields.value !== 'string' || !fields.value) throw new Error(`Secret '${name}' has no value`);
  return fields.value;
}

/** IAM is the machine identity: GetItem on the table plus context-scoped Decrypt. */
export function createSecretReader(options: {
  tableName: string;
  keyId: string;
  region: string;
  dynamodb?: Pick<DynamoDBClient, 'send'>;
  kms?: Pick<KMSClient, 'send'>;
}) {
  if (!options.tableName || !options.keyId || !options.region) {
    throw new Error('Secret reader requires tableName, keyId and region');
  }
  const dynamodb = options.dynamodb ?? new DynamoDBClient({ region: options.region });
  const kms = options.kms ?? new KMSClient({ region: options.region });
  return async (name: string): Promise<Record<string, string>> => {
    if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(name)) throw new Error('Invalid secret name');
    const result = await dynamodb.send(new GetItemCommand({
      TableName: options.tableName,
      Key: { PK: { S: 'SECRETS' }, SK: { S: `SECRET#${name}` } },
      ConsistentRead: true,
      ProjectionExpression: '#data',
      ExpressionAttributeNames: { '#data': 'data' },
    }));
    const ciphertext = result.Item?.data?.S;
    if (!ciphertext) throw new Error(`Secret '${name}' does not exist or has no ciphertext`);
    const decrypted = await kms.send(new DecryptCommand({
      KeyId: options.keyId,
      CiphertextBlob: Buffer.from(ciphertext, 'base64'),
      EncryptionContext: { secret: name },
    }));
    if (!decrypted.Plaintext) throw new Error('KMS returned no secret plaintext');
    return decodeFields(Buffer.from(decrypted.Plaintext).toString('utf8'));
  };
}
