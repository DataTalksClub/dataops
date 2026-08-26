import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';

let cachedPortalSecret: string | null | undefined;
let secretsClient: SecretsManagerClient | null = null;

/**
 * Read the deployed portal secret without putting its value in module scope
 * longer than necessary. Environment injection remains preferred in tests.
 */
export async function portalRuntimeSecret(): Promise<string> {
  if (process.env.WORK_ENGINE_PORTAL_SECRET) return process.env.WORK_ENGINE_PORTAL_SECRET;
  if (cachedPortalSecret !== undefined) return cachedPortalSecret ?? '';

  const secretName = process.env.WORK_ENGINE_PORTAL_SECRET_NAME;
  if (!secretName) {
    cachedPortalSecret = null;
    return '';
  }

  secretsClient ||= new SecretsManagerClient({});
  const result = await secretsClient.send(new GetSecretValueCommand({ SecretId: secretName }));
  const secret = result.SecretString
    || (result.SecretBinary ? Buffer.from(result.SecretBinary).toString('utf-8') : '');
  cachedPortalSecret = secret || null;
  return secret;
}

export function clearPortalRuntimeSecretForTests(): void {
  cachedPortalSecret = undefined;
  secretsClient = null;
}
