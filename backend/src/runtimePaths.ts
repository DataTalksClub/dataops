/** Root of the compiled runtime distribution. */
export const RUNTIME_ROOT = __dirname;

/**
 * A bucket the application requires is not configured. Buckets are declared in
 * infrastructure and passed to the Lambda by name; the application never
 * creates one, so a missing name means the deployment is wrong.
 */
export class BucketNotConfiguredError extends Error {
  readonly envName: string;

  constructor(envName: string) {
    super(
      `${envName} is not set. Buckets are defined in infrastructure and are never created by the application. `
      + 'Deploy the stack, or set it for local development.',
    );
    this.name = 'BucketNotConfiguredError';
    this.envName = envName;
  }
}

function requiredBucket(envName: string): string {
  const name = process.env[envName];
  if (!name) throw new BucketNotConfiguredError(envName);
  return name;
}

/** Private bucket holding bookkeeping documents and monthly report archives. */
export function bookkeepingDocumentsBucket(): string {
  return requiredBucket('BOOKKEEPING_DOCUMENTS_BUCKET');
}

/** Private bucket holding documents imported from email. */
export function emailDocumentsBucket(): string {
  return requiredBucket('EMAIL_DOCUMENTS_BUCKET');
}
