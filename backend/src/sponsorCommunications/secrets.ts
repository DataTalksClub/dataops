import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { canonicalJson, COMMUNICATION_TYPES, keyringDigest, sha256, validateKeyring, type CommunicationType, type HmacKeyring } from './core';

export type SponsorTemplate = {
  id: CommunicationType;
  version: string;
  subject: string;
  body: string;
  placeholders: string[];
};
export type SponsorTemplateBundle = {
  schemaVersion: '1';
  generation: string;
  templates: SponsorTemplate[];
};

let secretsClient: SecretsManagerClient | undefined;
const exactSecret = async (arn: string) => {
  if (!arn) throw new Error('Required sponsor communication secret ARN is not configured');
  secretsClient ||= new SecretsManagerClient({});
  const response = await secretsClient.send(new GetSecretValueCommand({ SecretId: arn }));
  if (!response.SecretString || !response.VersionId) throw new Error('Sponsor communication secret is missing a versioned string');
  return { value: response.SecretString, versionId: response.VersionId };
};

const parse = (value: string, label: string): Record<string, unknown> => {
  try {
    const parsed = JSON.parse(value);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
    return parsed as Record<string, unknown>;
  } catch {
    throw new Error(`${label} secret has invalid JSON`);
  }
};

export function validateTemplateBundle(value: unknown): { bundle: SponsorTemplateBundle; digest: string } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid template bundle');
  const raw = value as Record<string, unknown>;
  if (raw.schemaVersion !== '1' || typeof raw.generation !== 'string' || !raw.generation || !Array.isArray(raw.templates)) {
    throw new Error('Invalid template bundle schema');
  }
  const templates = raw.templates.map((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error('Invalid template');
    const item = entry as Record<string, unknown>;
    if (
      !COMMUNICATION_TYPES.includes(item.id as CommunicationType)
      || typeof item.version !== 'string'
      || typeof item.subject !== 'string'
      || typeof item.body !== 'string'
      || !Array.isArray(item.placeholders)
      || item.placeholders.some((placeholder) => !['organizationName', 'publicationDate', 'materialDeadline', 'publicLink'].includes(String(placeholder)))
      || Buffer.byteLength(item.subject) > 998
      || Buffer.byteLength(item.body) > 100_000
    ) throw new Error('Invalid sponsor communication template');
    return {
      id: item.id as CommunicationType,
      version: item.version,
      subject: item.subject,
      body: item.body,
      placeholders: item.placeholders.map(String),
    };
  });
  if (templates.length !== COMMUNICATION_TYPES.length || new Set(templates.map((item) => item.id)).size !== COMMUNICATION_TYPES.length) {
    throw new Error('Template bundle must contain exactly the four allowlisted templates');
  }
  const bundle = { schemaVersion: '1' as const, generation: raw.generation, templates };
  return { bundle, digest: sha256(canonicalJson(bundle)) };
}

export async function loadTemplateBundle(): Promise<{ bundle: SponsorTemplateBundle; digest: string; secretVersionId: string }> {
  if (process.env.NODE_ENV === 'test' && process.env.SPONSOR_COMMUNICATIONS_TEST_TEMPLATE_BUNDLE) {
    const validated = validateTemplateBundle(parse(process.env.SPONSOR_COMMUNICATIONS_TEST_TEMPLATE_BUNDLE, 'Template bundle'));
    return { ...validated, secretVersionId: 'synthetic-test-version' };
  }
  const result = await exactSecret(process.env.SPONSOR_COMMUNICATION_TEMPLATE_SECRET_ARN || '');
  return { ...validateTemplateBundle(parse(result.value, 'Template bundle')), secretVersionId: result.versionId };
}

export async function loadHmacKeyring(): Promise<{ keyring: HmacKeyring; digest: string }> {
  let raw: Record<string, unknown>;
  let secretVersionId: string;
  if (process.env.NODE_ENV === 'test' && process.env.SPONSOR_COMMUNICATIONS_TEST_HMAC_KEYRING) {
    raw = parse(process.env.SPONSOR_COMMUNICATIONS_TEST_HMAC_KEYRING, 'HMAC keyring');
    secretVersionId = String(raw.secretVersionId || 'synthetic-test-version');
  } else {
    const result = await exactSecret(process.env.SPONSOR_COMMUNICATION_HMAC_SECRET_ARN || '');
    raw = parse(result.value, 'HMAC keyring');
    secretVersionId = result.versionId;
  }
  const keys = raw.keys && typeof raw.keys === 'object' && !Array.isArray(raw.keys) ? raw.keys as Record<string, string> : {};
  const keyring = validateKeyring({
    secretVersionId,
    activeVersion: String(raw.activeVersion || ''),
    acceptedVersions: Array.isArray(raw.acceptedVersions) ? raw.acceptedVersions.map(String) : [],
    keys,
  });
  return { keyring, digest: keyringDigest(keyring) };
}

export function renderTemplate(
  template: SponsorTemplate,
  values: { organizationName: string; publicationDate?: string; materialDeadline?: string; publicLink?: string },
): { subject: string; body: string } {
  const allowed = new Set(template.placeholders);
  const render = (input: string) => input.replace(/\{\{([A-Za-z]+)\}\}/g, (_match, name: string) => {
    if (!allowed.has(name) || !(name in values)) throw new Error('Template contains an unavailable placeholder');
    return String(values[name as keyof typeof values] || '');
  });
  const subject = render(template.subject);
  const body = render(template.body);
  if (/\{\{|\}\}/.test(subject) || /\{\{|\}\}/.test(body)) throw new Error('Template contains an unresolved placeholder');
  return { subject, body };
}
