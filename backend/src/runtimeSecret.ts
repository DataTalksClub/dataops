import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';

let secretsClient: SecretsManagerClient | null = null;

/**
 * Read the deployed portal secret on each Secrets Manager-backed use so key
 * rotation invalidates derived cursor material without a warm-process restart.
 * Static environment injection remains preferred where deployment provides it.
 */
export async function portalRuntimeSecret(): Promise<string> {
  if (process.env.WORK_ENGINE_PORTAL_SECRET) return process.env.WORK_ENGINE_PORTAL_SECRET;
  const secretName = process.env.WORK_ENGINE_PORTAL_SECRET_NAME;
  if (!secretName) {
    return '';
  }

  secretsClient ||= new SecretsManagerClient({});
  const result = await secretsClient.send(new GetSecretValueCommand({ SecretId: secretName }));
  const secret = result.SecretString
    || (result.SecretBinary ? Buffer.from(result.SecretBinary).toString('utf-8') : '');
  return secret;
}
