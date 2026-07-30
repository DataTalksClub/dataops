import { createHash, createHmac, randomBytes } from 'crypto';

export const COMMUNICATION_TYPES = [
  'booking-confirmation',
  'materials-reminder',
  'publication-live',
  'performance-follow-up',
] as const;
export type CommunicationType = typeof COMMUNICATION_TYPES[number];
export const SES_EVENT_TYPES = [
  'SEND',
  'DELIVERY',
  'DELIVERY_DELAY',
  'REJECT',
  'RENDERING_FAILURE',
  'BOUNCE',
  'COMPLAINT',
] as const;
export type SponsorSesEventType = typeof SES_EVENT_TYPES[number];

export type HmacKeyring = {
  secretVersionId: string;
  activeVersion: string;
  acceptedVersions: string[];
  keys: Record<string, string>;
};

export type SendConfig = {
  enabled: boolean;
  generation: number;
  templateBundleGeneration: string;
  templateBundleDigest: string;
  hmacSecretVersionId: string;
  hmacActiveVersion: string;
  hmacAcceptedVersions: string[];
  hmacKeyringDigest: string;
  sesAccount: string;
  sesRegion: string;
  sesIdentityArn: string;
  from: string;
  replyTo?: string;
  configurationSet: string;
  configurationSetGeneration: string;
  approverPolicyVersion: string;
  digest: string;
};

export type CanonicalPayload = {
  from: string;
  replyTo?: string;
  to: string;
  communicationType: CommunicationType;
  communicationId: string;
  version: number;
  subject: string;
  subjectBytes: number;
  body: string;
  bodyBytes: number;
  publicLinks: string[];
  templateId: CommunicationType;
  templateVersion: string;
  templateDigest: string;
  templateBundleGeneration: string;
  bookingId: string;
  bookingVersion: number;
  organizationId: string;
  organizationVersion: number;
  contactId: string;
  contactVersion: number;
  suggestionId: string;
  suggestionVersion: number;
  approverPolicyVersion: string;
  sesAccount: string;
  sesRegion: string;
  sesIdentityArn: string;
  configurationSet: string;
  configurationSetGeneration: string;
  hmacKeyringDigest: string;
  sendConfigGeneration: number;
  sendConfigDigest: string;
};

const ASCII_WS = /^[\t ]+|[\t ]+$/g;
const CONTROL = /[\u0000-\u001f\u007f]/;
const EMAIL = /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('Non-finite numbers are not canonical JSON');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).filter((key) => record[key] !== undefined).sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`;
  }
  throw new Error('Unsupported canonical JSON value');
}

export const sha256 = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');

export function normalizeEmail(value: unknown): string {
  if (typeof value !== 'string') throw new Error('Email must be a string');
  const trimmed = value.replace(ASCII_WS, '');
  if (
    !trimmed
    || Buffer.byteLength(trimmed, 'ascii') !== Buffer.byteLength(trimmed, 'utf8')
    || Buffer.byteLength(trimmed, 'utf8') > 254
    || CONTROL.test(trimmed)
    || /[<>()",;:\\\s]/.test(trimmed)
  ) throw new Error('Email must be one plain 7-bit-ASCII address');
  const canonical = trimmed.toLowerCase();
  if (!EMAIL.test(canonical) || canonical.split('@').length !== 2) throw new Error('Invalid email address');
  return canonical;
}

export function normalizeContent(subject: unknown, body: unknown): { subject: string; body: string } {
  if (typeof subject !== 'string' || typeof body !== 'string') throw new Error('Subject and body are required');
  const normalizedSubject = subject.replace(/\r\n?/g, '\n');
  const normalizedBody = body.replace(/\r\n?/g, '\n');
  if (!normalizedSubject || Buffer.byteLength(normalizedSubject) > 998 || /[\n\u0000-\u001f\u007f]/.test(normalizedSubject)) {
    throw new Error('Subject contains invalid controls or exceeds 998 bytes');
  }
  if (!normalizedBody || Buffer.byteLength(normalizedBody) > 100_000 || /\u0000/.test(normalizedBody)) {
    throw new Error('Body is empty or exceeds 100000 bytes');
  }
  return { subject: normalizedSubject, body: normalizedBody };
}

export function normalizePublicLinks(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 10) throw new Error('publicLinks must be a bounded array');
  return value.map((candidate) => {
    if (typeof candidate !== 'string' || candidate.length > 2048) throw new Error('Invalid public link');
    const parsed = new URL(candidate);
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.searchParams.toString().match(/(?:token|sig|key|credential)/i)) {
      throw new Error('Public links must be safe HTTPS URLs');
    }
    return parsed.toString();
  }).sort();
}

export function validateKeyring(keyring: HmacKeyring): HmacKeyring {
  const accepted = [...new Set(keyring.acceptedVersions)];
  if (
    !keyring.secretVersionId
    || !keyring.activeVersion
    || accepted.length < 1
    || accepted.length > 2
    || !accepted.includes(keyring.activeVersion)
    || Object.keys(keyring.keys).length !== accepted.length
    || accepted.some((version) => typeof keyring.keys[version] !== 'string' || Buffer.from(keyring.keys[version], 'base64').length < 32)
  ) throw new Error('Invalid HMAC keyring');
  return { ...keyring, acceptedVersions: accepted.sort() };
}

export function keyringDigest(keyring: HmacKeyring): string {
  const valid = validateKeyring(keyring);
  return sha256(canonicalJson({
    secretVersionId: valid.secretVersionId,
    activeVersion: valid.activeVersion,
    acceptedVersions: valid.acceptedVersions,
    materialDigests: Object.fromEntries(valid.acceptedVersions.map((version) => [version, sha256(Buffer.from(valid.keys[version], 'base64'))])),
  }));
}

export function suppressionKey(version: string, canonicalAddress: string, keyring: HmacKeyring): string {
  const valid = validateKeyring(keyring);
  if (!valid.acceptedVersions.includes(version)) throw new Error('Suppression key version is not accepted');
  const digest = createHmac('sha256', Buffer.from(valid.keys[version], 'base64'))
    .update(`dataops:sponsor-email-suppression:v1\0${canonicalAddress}`)
    .digest('hex');
  return `SUPPRESSION#${version}#${digest}`;
}

export function validateSendConfig(config: Omit<SendConfig, 'digest'> & { digest?: string }, keyring: HmacKeyring): SendConfig {
  const from = normalizeEmail(config.from);
  const replyTo = config.replyTo ? normalizeEmail(config.replyTo) : undefined;
  const validKeyring = validateKeyring(keyring);
  if (
    config.generation < 1
    || config.hmacSecretVersionId !== validKeyring.secretVersionId
    || config.hmacActiveVersion !== validKeyring.activeVersion
    || canonicalJson([...config.hmacAcceptedVersions].sort()) !== canonicalJson(validKeyring.acceptedVersions)
    || config.hmacKeyringDigest !== keyringDigest(validKeyring)
    || !/^arn:[^:]+:ses:[^:]+:\d{12}:identity\/[^/]+$/.test(config.sesIdentityArn)
    || !config.configurationSet
    || !config.configurationSetGeneration
  ) throw new Error('Send configuration does not match the HMAC keyring or SES identity');
  const { digest: ignored, ...unsigned } = { ...config, from, replyTo };
  const digest = sha256(canonicalJson(unsigned));
  if (config.digest && config.digest !== digest) throw new Error('Send configuration digest mismatch');
  return { ...unsigned, digest };
}

export function canonicalPayload(input: Omit<CanonicalPayload, 'subjectBytes' | 'bodyBytes'>): { payload: CanonicalPayload; hash: string; previewHash: string } {
  const content = normalizeContent(input.subject, input.body);
  const payload: CanonicalPayload = {
    ...input,
    from: normalizeEmail(input.from),
    replyTo: input.replyTo ? normalizeEmail(input.replyTo) : undefined,
    to: normalizeEmail(input.to),
    subject: content.subject,
    subjectBytes: Buffer.byteLength(content.subject),
    body: content.body,
    bodyBytes: Buffer.byteLength(content.body),
    publicLinks: normalizePublicLinks(input.publicLinks),
  };
  const canonical = canonicalJson(payload);
  const hash = sha256(canonical);
  const preview = canonicalJson({
    from: payload.from,
    replyTo: payload.replyTo,
    to: payload.to,
    type: payload.communicationType,
    subject: payload.subject,
    body: payload.body,
    publicLinks: payload.publicLinks,
    canonicalHash: hash,
  });
  return { payload, hash, previewHash: sha256(preview) };
}

export const newReviewToken = () => randomBytes(32).toString('base64url');
export const newCorrelationToken = () => randomBytes(32).toString('base64url');
export const attemptIdFor = (communicationId: string, version: number, payloadHash: string) =>
  sha256(`sponsor-send-attempt:v1\0${communicationId}\0${version}\0${payloadHash}`);

export function payloadDeleteAt(anchor: string): number {
  const parsed = Date.parse(anchor);
  if (!Number.isFinite(parsed)) throw new Error('Invalid retention anchor');
  return Math.floor(parsed / 1000) + (30 * 24 * 60 * 60);
}

export type ProviderFacts = Partial<Record<SponsorSesEventType, { firstAt: string; lastAt: string; count: number; eventIds: string[] }>>;
export function derivedStatus(facts: ProviderFacts, executionStatus: string): string {
  if (facts.COMPLAINT) return 'complained';
  if (facts.BOUNCE) return 'bounced';
  if (facts.REJECT || facts.RENDERING_FAILURE) return 'rejected';
  if (facts.DELIVERY) return 'delivered';
  if (facts.DELIVERY_DELAY) return 'delayed';
  if (facts.SEND) return 'provider_observed';
  return executionStatus;
}

export function mergeProviderFact(
  existing: ProviderFacts,
  type: SponsorSesEventType,
  eventId: string,
  eventTime: string,
): ProviderFacts {
  if (!SES_EVENT_TYPES.includes(type) || !eventId || !Number.isFinite(Date.parse(eventTime))) throw new Error('Invalid provider fact');
  const current = existing[type];
  if (current?.eventIds.includes(eventId)) return existing;
  const ids = [...(current?.eventIds || []), eventId].sort().slice(-20);
  return {
    ...existing,
    [type]: {
      firstAt: current && current.firstAt < eventTime ? current.firstAt : eventTime,
      lastAt: current && current.lastAt > eventTime ? current.lastAt : eventTime,
      count: Math.min(10_000, (current?.count || 0) + 1),
      eventIds: ids,
    },
  };
}
