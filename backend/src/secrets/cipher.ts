import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';
import {
  DecryptCommand,
  EncryptCommand,
  KMSClient,
} from '@aws-sdk/client-kms';

/**
 * Encryption for secret values at rest. Values are never stored in a plain
 * DynamoDB attribute: the store keeps only the ciphertext produced here, and
 * every decrypt is a KMS call that CloudTrail audits independently of the
 * application's own access audit.
 *
 * Infrastructure owns the key. Production selects it with
 * DATAOPS_SECRETS_KMS_KEY; when it is missing the store fails loudly instead
 * of falling back to plaintext. Local development uses a development key from
 * DATAOPS_SECRETS_DEV_KEY with the same AES-256-GCM envelope, and the test
 * environment pins a fixed development key so tests exercise real encryption
 * without AWS.
 */

/** KMS rejects Encrypt calls above 4 KiB of plaintext. */
export const MAX_PAYLOAD_BYTES = 4096;

export interface SecretCipher {
  encrypt(name: string, plaintext: string): Promise<string>;
  decrypt(name: string, ciphertext: string): Promise<string>;
}

const DEV_KEY_BYTES = 32;
const TEST_DEV_KEY = Buffer.alloc(DEV_KEY_BYTES, 0x44);

class KmsCipher implements SecretCipher {
  private client: KMSClient;

  constructor(private readonly keyId: string) {
    this.client = new KMSClient({});
  }

  async encrypt(name: string, plaintext: string): Promise<string> {
    const result = await this.client.send(new EncryptCommand({
      KeyId: this.keyId,
      Plaintext: Buffer.from(plaintext, 'utf8'),
      EncryptionContext: { secret: name },
    }));
    return Buffer.from(result.CiphertextBlob as Uint8Array).toString('base64');
  }

  async decrypt(name: string, ciphertext: string): Promise<string> {
    const result = await this.client.send(new DecryptCommand({
      CiphertextBlob: Buffer.from(ciphertext, 'base64'),
      KeyId: this.keyId,
      EncryptionContext: { secret: name },
    }));
    return Buffer.from(result.Plaintext as Uint8Array).toString('utf8');
  }
}

/** AES-256-GCM with a locally provided key: the development and test stand-in. */
class AesGcmCipher implements SecretCipher {
  constructor(private readonly key: Buffer) {}

  async encrypt(name: string, plaintext: string): Promise<string> {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    cipher.setAAD(Buffer.from(name, 'utf8'));
    const data = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), data]).toString('base64');
  }

  async decrypt(name: string, ciphertext: string): Promise<string> {
    const blob = Buffer.from(ciphertext, 'base64');
    const iv = blob.subarray(0, 12);
    const tag = blob.subarray(12, 28);
    const data = blob.subarray(28);
    const decipher = createDecipheriv('aes-256-gcm', this.key, iv);
    decipher.setAuthTag(tag);
    decipher.setAAD(Buffer.from(name, 'utf8'));
    return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
  }
}

function devKeyFromEnv(): Buffer {
  const raw = process.env.DATAOPS_SECRETS_DEV_KEY || '';
  const key = Buffer.from(raw, 'base64');
  if (key.length !== DEV_KEY_BYTES) {
    throw new Error(
      `DATAOPS_SECRETS_DEV_KEY must be ${DEV_KEY_BYTES} bytes of base64 `
      + `(openssl rand -base64 32). Local secret encryption is disabled without it.`,
    );
  }
  return key;
}

/** Pick the cipher for this environment, failing loudly when unconfigured. */
export function resolveSecretCipher(): SecretCipher {
  const kmsKey = process.env.DATAOPS_SECRETS_KMS_KEY;
  if (kmsKey) return new KmsCipher(kmsKey);
  if (process.env.NODE_ENV === 'test') return new AesGcmCipher(TEST_DEV_KEY);
  if (process.env.IS_LOCAL === 'true') return new AesGcmCipher(devKeyFromEnv());
  throw new Error(
    'DATAOPS_SECRETS_KMS_KEY is not configured. Secrets are encrypted with the '
    + 'stack\'s customer-managed KMS key in infrastructure; refusing to store '
    + 'or read them any other way.',
  );
}

/** The payload plaintext for one secret: the fields object as compact JSON. */
export function encodeFields(fields: Record<string, string>): string {
  return JSON.stringify(fields);
}

export function decodeFields(plaintext: string): Record<string, string> {
  const parsed = JSON.parse(plaintext);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Secret payload is not an object');
  }
  if (Object.values(parsed).some(value => typeof value !== 'string')) {
    throw new Error('Secret payload fields must be strings');
  }
  return parsed;
}
