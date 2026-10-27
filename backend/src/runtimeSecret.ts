import { createSecretReader } from './secrets/reader';

/**
 * Read the deployed portal secret on each team-store use so key
 * rotation invalidates derived cursor material without a warm-process restart.
 * Static environment injection remains preferred where deployment provides it.
 */
export async function portalRuntimeSecret(): Promise<string> {
  if (process.env.WORK_ENGINE_PORTAL_SECRET) return process.env.WORK_ENGINE_PORTAL_SECRET;
  const secretName = process.env.WORK_ENGINE_PORTAL_SECRET_NAME;
  if (!secretName) {
    if (process.env.NODE_ENV === 'test' || process.env.IS_LOCAL === 'true') {
      return 'dataops-test-portal-runtime-secret';
    }
    return '';
  }

  const read = createSecretReader({
    tableName: process.env.DATAOPS_SECRETS_TABLE || '',
    keyId: process.env.DATAOPS_SECRETS_KMS_KEY || '',
    region: process.env.AWS_REGION || '',
  });
  const fields = await read(secretName);
  if (typeof fields.value !== 'string' || !fields.value) throw new Error('Portal runtime secret is empty');
  return fields.value;
}
