import { DynamoDBClient, GetItemCommand } from '@aws-sdk/client-dynamodb';
import { MailingExportProviderError } from './mailchimp';

export type MailingExportCredentialReader = (credentialId: string) => Promise<Record<string, string>>;

const authorizationError = (): MailingExportProviderError =>
  new MailingExportProviderError('authorization', 'Mailing export credential is unavailable');

function optionalString(value: unknown): string | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const text = (value as { S?: unknown }).S;
  return typeof text === 'string' ? text : undefined;
}

function valueMap(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object') return null;
  const map = (value as { M?: unknown }).M;
  return map && typeof map === 'object' && !Array.isArray(map) ? map as Record<string, unknown> : null;
}

export async function readDapierMailchimpCredential(
  credentialId: string,
  client: Pick<DynamoDBClient, 'send'> = new DynamoDBClient({}),
): Promise<Record<string, string>> {
  try {
    const tableName = process.env.DATAOPS_DAPIER_CREDENTIALS_TABLE;
    if (!tableName || credentialId !== 'mailchimp') throw authorizationError();
    const result = await client.send(new GetItemCommand({
      TableName: tableName,
      Key: { credential_id: { S: credentialId } },
      ConsistentRead: true,
    }));
    const item = result.Item;
    if (!item || optionalString(item.credential_id) !== credentialId || optionalString(item.provider) !== 'mailchimp') {
      throw authorizationError();
    }
    const values = valueMap(item.value);
    const apiKey = values ? optionalString(values.apiKey) : undefined;
    if (!apiKey?.trim()) throw authorizationError();
    const server = values ? optionalString(values.server) : undefined;
    if (values && values.server !== undefined && server === undefined) throw authorizationError();
    return server === undefined ? { apiKey } : { apiKey, server };
  } catch {
    throw authorizationError();
  }
}
