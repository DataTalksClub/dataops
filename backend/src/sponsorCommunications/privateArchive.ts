import { createHash } from 'crypto';
import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { PutCommand, ScanCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { getClient } from '../db/client';
import { TABLE_SPONSOR_CRM } from '../db/tableNames';
import { canonicalJson } from './core';

const PRIVATE_TYPES = new Set([
  'communication-suggestion',
  'communication-draft-version',
  'communication-private-payload',
  'communication-presentation',
  'sponsor-send-attempt',
  'sponsor-send-event-fact',
  'pending-sponsor-send-event-set',
  'email-suppression',
  'sponsor-send-config',
  'sponsor-communication-audit',
  'sponsor-send-correlation',
  'suppression-migration-orphan',
  'suppression-version-count',
  'suppression-coverage',
]);
const FORBIDDEN_KEYS = new Set(['token', 'tokenHash', 'reviewToken', 'correlationToken', 'leaseOwner', 'leaseExpiresAt', 'hmacKey', 'keys']);
const sha = (value: string) => createHash('sha256').update(value).digest('hex');

export type SponsorPrivateArchive = {
  manifest: {
    schemaVersion: '1';
    classification: 'private-sponsor-communications';
    generatedAt: string;
    count: number;
    recordsSha256: string;
    configVersions: number[];
    configDigests: string[];
    recordCounts: Record<string, number>;
  };
  records: Array<Record<string, unknown>>;
};

function hasForbidden(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(hasForbidden);
  if (!value || typeof value !== 'object') return false;
  return Object.entries(value as Record<string, unknown>).some(([key, child]) => FORBIDDEN_KEYS.has(key) || hasForbidden(child));
}

const isString = (value: unknown): value is string => typeof value === 'string' && value.length > 0;
const isInteger = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value);
const isIso = (value: unknown): value is string => (
  isString(value)
  && Number.isFinite(Date.parse(value))
  && new Date(value).toISOString() === value
);
const isEnum = (value: unknown, allowed: readonly string[]) => isString(value) && allowed.includes(value);
const requireFields = (record: Record<string, unknown>, strings: string[], integers: string[] = []) => {
  if (strings.some((field) => !isString(record[field])) || integers.some((field) => !isInteger(record[field]))) {
    throw new Error(`Private sponsor archive has an invalid ${String(record.recordType)} schema`);
  }
};
const requireTimestamps = (record: Record<string, unknown>, fields: string[]) => {
  if (fields.some((field) => !isIso(record[field]))) {
    throw new Error(`Private sponsor archive has an invalid ${String(record.recordType)} timestamp`);
  }
};

function validateRecordSchema(record: Record<string, unknown>): void {
  requireFields(record, ['PK', 'SK', 'recordType']);
  for (const field of [
    'createdAt', 'updatedAt', 'expiresAt', 'eventTime', 'at', 'abandonedAt',
    'retentionAnchoredAt', 'dispatchStartedAt',
  ]) {
    if (record[field] !== undefined && !isIso(record[field])) {
      throw new Error(`Private sponsor archive has an invalid ${String(record.recordType)} timestamp`);
    }
  }
  for (const field of ['ttl', 'payloadDeleteAt']) {
    if (record[field] !== undefined && !isInteger(record[field])) {
      throw new Error(`Private sponsor archive has an invalid ${String(record.recordType)} retention value`);
    }
  }
  switch (record.recordType) {
    case 'communication-suggestion':
      requireFields(record, ['id', 'bookingId', 'organizationId', 'communicationType'], ['version']);
      if (typeof record.eligible !== 'boolean' || !isEnum(record.status, ['open', 'dismissed', 'ineligible'])) throw new Error('Invalid suggestion state');
      requireTimestamps(record, ['createdAt', 'updatedAt']);
      break;
    case 'communication-draft-version':
      requireFields(record, ['id', 'communicationId', 'bookingId', 'suggestionId', 'payloadHash', 'previewHash', 'configDigest'], ['version']);
      if ((record.payloadExpired === true) === isString(record.payloadRef)) throw new Error('Invalid draft payload state');
      requireTimestamps(record, ['createdAt']);
      break;
    case 'communication-private-payload':
      requireFields(record, ['id', 'communicationId', 'payloadHash'], ['version']);
      if (!record.payload || typeof record.payload !== 'object') throw new Error('Invalid private payload');
      requireTimestamps(record, ['createdAt']);
      break;
    case 'communication-presentation':
      requireFields(record, ['id', 'communicationId', 'bookingId', 'payloadHash', 'previewHash'], ['draftVersion', 'revision']);
      if (!isEnum(record.state, ['revoked']) || (record.payloadExpired === true) === isString(record.payloadRef)) throw new Error('Invalid presentation state');
      requireTimestamps(record, ['expiresAt', 'createdAt']);
      break;
    case 'sponsor-send-attempt':
      requireFields(record, [
        'id', 'communicationId', 'bookingId', 'payloadHash', 'previewHash', 'configDigest',
        'sesAccount', 'sesRegion', 'sesIdentityArn', 'from', 'configurationSet', 'configurationSetGeneration',
      ], ['draftVersion', 'configGeneration', 'revision']);
      if (
        !isEnum(record.status, ['queued', 'executing', 'accepted', 'provider_observed', 'failed_safe', 'outcome_unknown', 'cancelled', 'resolved'])
        || record.recoveryBlocked !== true
        || (record.payloadExpired === true) === isString(record.payloadRef)
      ) throw new Error('Invalid send attempt state');
      requireTimestamps(record, ['createdAt', 'updatedAt']);
      break;
    case 'sponsor-send-event-fact':
      requireFields(record, [
        'id', 'attemptId', 'communicationId', 'bookingId', 'eventType', 'eventTime',
        'messageId', 'configurationSetGeneration',
      ]);
      if (!isEnum(record.eventType, ['SEND', 'DELIVERY', 'DELIVERY_DELAY', 'REJECT', 'RENDERING_FAILURE', 'BOUNCE', 'COMPLAINT'])) throw new Error('Invalid send event type');
      requireTimestamps(record, ['eventTime', 'createdAt']);
      break;
    case 'pending-sponsor-send-event-set':
      requireFields(record, ['id', 'attemptId', 'candidateMessageId'], ['revision']);
      requireTimestamps(record, ['updatedAt']);
      break;
    case 'email-suppression':
      requireFields(record, ['id', 'keyVersion', 'contactId', 'organizationId', 'category', 'status'], ['revision']);
      if (!isEnum(record.category, ['manual', 'bounce', 'complaint']) || !isEnum(record.status, ['active', 'removed'])) throw new Error('Invalid suppression state');
      requireTimestamps(record, ['createdAt', 'updatedAt']);
      break;
    case 'sponsor-send-config':
      requireFields(record, [
        'digest', 'templateSetGeneration', 'hmacActiveVersion', 'hmacKeyringDigest',
        'sesAccount', 'sesRegion', 'sesIdentityArn', 'from', 'configurationSet',
        'configurationSetGeneration', 'approverPolicyVersion',
      ], ['generation']);
      if (
        record.enabled !== false
        || !Array.isArray(record.hmacAcceptedVersions)
        || record.hmacAcceptedVersions.some((version) => !isString(version))
        || new Set(record.hmacAcceptedVersions).size !== record.hmacAcceptedVersions.length
        || !record.hmacAcceptedVersions.includes(record.hmacActiveVersion)
      ) throw new Error('Invalid disabled config');
      break;
    case 'sponsor-communication-audit':
      requireFields(record, ['action', 'at']);
      requireTimestamps(record, ['at']);
      break;
    case 'sponsor-send-correlation':
      requireFields(record, ['id', 'attemptId', 'communicationId', 'correlationHash'], ['configGeneration']);
      requireTimestamps(record, ['createdAt']);
      break;
    case 'suppression-migration-orphan':
      requireFields(record, ['id', 'suppressionId', 'keyVersion', 'contactId', 'organizationId', 'status'], ['revision']);
      if (!isEnum(record.status, ['unresolved', 'resolved'])) throw new Error('Invalid suppression orphan state');
      requireTimestamps(record, ['createdAt', 'updatedAt']);
      break;
    case 'suppression-version-count':
      requireFields(record, ['keyVersion'], ['liveCount']);
      requireTimestamps(record, ['updatedAt']);
      break;
    case 'suppression-coverage':
      if (!(Array.isArray(record.liveVersions) || record.liveVersions instanceof Set)) throw new Error('Invalid suppression coverage');
      requireTimestamps(record, ['updatedAt']);
      break;
    default:
      throw new Error('Private sponsor archive contains an unknown record schema');
  }
}

function portableRecord(raw: Record<string, unknown>, nowSeconds: number): Record<string, unknown> | null {
  if (!PRIVATE_TYPES.has(String(raw.recordType))) return null;
  if (raw.recordType === 'communication-private-payload' && typeof raw.ttl === 'number' && raw.ttl <= nowSeconds) return null;
  const record = structuredClone(raw);
  for (const key of ['tokenHash', 'correlationToken', 'leaseOwner', 'leaseExpiresAt', 'GSI2PK', 'GSI2SK']) delete record[key];
  if (record.recordType === 'communication-presentation') {
    record.state = 'revoked';
    record.revision = Number(record.revision || 0) + 1;
  }
  if (record.recordType === 'sponsor-send-attempt') {
    record.recoveryBlocked = true;
    delete record.dueKey;
    delete record.dueAt;
    delete record.dispatchGeneration;
  }
  if (record.recordType === 'sponsor-send-config') record.enabled = false;
  return record;
}

export async function exportSponsorCommunications(
  client: DynamoDBDocumentClient,
  generatedAt = new Date().toISOString(),
): Promise<SponsorPrivateArchive> {
  const source: Record<string, unknown>[] = [];
  let cursor: Record<string, unknown> | undefined;
  do {
    const result = await client.send(new ScanCommand({
      TableName: TABLE_SPONSOR_CRM,
      ExclusiveStartKey: cursor,
      ProjectionExpression: '#pk,#sk,recordType,id,communicationId,bookingId,organizationId,contactId,suggestionId,payloadRef,payloadExpired,attemptId,suppressionId,#version,revision,generation,createdAt,updatedAt,#status,#state,eligible,safeReason,safeReasonCode,communicationType,occurrenceKey,bookingVersion,payloadHash,previewHash,configDigest,#digest,configGeneration,templateSetGeneration,hmacActiveVersion,hmacAcceptedVersions,hmacKeyringDigest,sesAccount,sesRegion,sesIdentityArn,#from,replyTo,configurationSet,configurationSetGeneration,approverPolicyVersion,enabled,payload,retentionAnchoredAt,#ttl,draftVersion,expiresAt,createdBy,approverId,roleSnapshot,derivedStatus,dispatchStartedAt,providerMessageId,providerFacts,recoveryBlocked,payloadDeleteAt,eventType,eventTime,messageId,keyVersion,liveCount,liveVersions,category,facts,candidateMessageId,#action,actorId,#at,correlationHash',
      ExpressionAttributeNames: {
        '#pk': 'PK', '#sk': 'SK', '#version': 'version', '#status': 'status', '#state': 'state',
        '#from': 'from', '#ttl': 'ttl', '#action': 'action', '#at': 'at', '#digest': 'digest',
      },
    }));
    source.push(...(result.Items || []) as Record<string, unknown>[]);
    cursor = result.LastEvaluatedKey;
  } while (cursor);
  const now = Math.floor(Date.parse(generatedAt) / 1000);
  const records = source.map((item) => portableRecord(item, now)).filter((item): item is Record<string, unknown> => !!item);
  const retainedPayloads = new Set(records.filter((item) => item.recordType === 'communication-private-payload').map((item) => String(item.id)));
  for (const record of records) {
    if (
      ['communication-draft-version', 'communication-presentation', 'sponsor-send-attempt'].includes(String(record.recordType))
      && !retainedPayloads.has(String(record.payloadRef))
    ) {
      delete record.payloadRef;
      record.payloadExpired = true;
    }
  }
  records.sort((a, b) => `${a.PK}\0${a.SK}`.localeCompare(`${b.PK}\0${b.SK}`));
  if (records.some(hasForbidden)) throw new Error('Private archive contains forbidden action material');
  const lines = records.map(canonicalJson).join('\n') + (records.length ? '\n' : '');
  const recordCounts = records.reduce<Record<string, number>>((counts, record) => {
    const type = String(record.recordType);
    counts[type] = (counts[type] || 0) + 1;
    return counts;
  }, {});
  return {
    manifest: {
      schemaVersion: '1',
      classification: 'private-sponsor-communications',
      generatedAt,
      count: records.length,
      recordsSha256: sha(lines),
      configVersions: [...new Set(records.filter((item) => item.recordType === 'sponsor-send-config').map((item) => Number(item.generation)))].sort((a, b) => a - b),
      configDigests: [...new Set(records.filter((item) => item.recordType === 'sponsor-send-config' && typeof item.digest === 'string').map((item) => String(item.digest)))].sort(),
      recordCounts: Object.fromEntries(Object.entries(recordCounts).sort(([a], [b]) => a.localeCompare(b))),
    },
    records,
  };
}

export function validateSponsorPrivateArchive(archive: SponsorPrivateArchive): void {
  if (
    archive?.manifest?.schemaVersion !== '1'
    || archive.manifest.classification !== 'private-sponsor-communications'
    || !Array.isArray(archive.records)
    || archive.manifest.count !== archive.records.length
    || !isIso(archive.manifest.generatedAt)
  ) throw new Error('Invalid private sponsor archive manifest');
  const ordered = [...archive.records].sort((a, b) => `${a.PK}\0${a.SK}`.localeCompare(`${b.PK}\0${b.SK}`));
  if (canonicalJson(ordered) !== canonicalJson(archive.records)) throw new Error('Private sponsor archive order is unstable');
  const lines = archive.records.map(canonicalJson).join('\n') + (archive.records.length ? '\n' : '');
  if (sha(lines) !== archive.manifest.recordsSha256) throw new Error('Private sponsor archive checksum mismatch');
  if (archive.records.some((item) => !PRIVATE_TYPES.has(String(item.recordType)) || hasForbidden(item))) {
    throw new Error('Private sponsor archive contains unknown or forbidden fields');
  }
  for (const record of archive.records) validateRecordSchema(record);
  const keys = new Set(archive.records.map((item) => `${item.PK}\0${item.SK}`));
  if (keys.size !== archive.records.length) throw new Error('Private sponsor archive contains duplicate keys');
  const payloads = new Map(archive.records.filter((item) => item.recordType === 'communication-private-payload')
    .map((item) => [String(item.id), item]));
  const suggestions = new Map(archive.records.filter((item) => item.recordType === 'communication-suggestion')
    .map((item) => [String(item.id), item]));
  const drafts = new Map(archive.records.filter((item) => item.recordType === 'communication-draft-version')
    .map((item) => [`${item.communicationId}#${item.version}`, item]));
  const attempts = new Map(archive.records.filter((item) => item.recordType === 'sponsor-send-attempt')
    .map((item) => [String(item.id), item]));
  const configRecords = archive.records.filter((item) => item.recordType === 'sponsor-send-config');
  const configDigests = [...new Set(configRecords.map((item) => String(item.digest)))].sort();
  const configVersions = [...new Set(configRecords.map((item) => Number(item.generation)))].sort((a, b) => a - b);
  const recordCounts = archive.records.reduce<Record<string, number>>((counts, record) => {
    const type = String(record.recordType);
    counts[type] = (counts[type] || 0) + 1;
    return counts;
  }, {});
  if (
    canonicalJson(archive.manifest.configDigests) !== canonicalJson(configDigests)
    || canonicalJson(archive.manifest.configVersions) !== canonicalJson(configVersions)
    || canonicalJson(archive.manifest.recordCounts) !== canonicalJson(Object.fromEntries(Object.entries(recordCounts).sort(([a], [b]) => a.localeCompare(b))))
  ) throw new Error('Private sponsor archive manifest coverage mismatch');
  const configRelationships = new Map<string, Record<string, unknown>>();
  const immutableConfigFields = [
    'sesAccount', 'sesRegion', 'sesIdentityArn', 'from', 'replyTo',
    'configurationSet', 'configurationSetGeneration', 'templateSetGeneration',
    'hmacActiveVersion', 'hmacAcceptedVersions', 'hmacKeyringDigest', 'approverPolicyVersion',
  ];
  for (const config of configRecords) {
    const relationship = `${config.generation}#${config.digest}`;
    const existing = configRelationships.get(relationship);
    if (
      existing
      && immutableConfigFields.some((field) => (
        canonicalJson({ value: existing[field] }) !== canonicalJson({ value: config[field] })
      ))
    ) throw new Error('Private sponsor archive has conflicting configuration snapshots');
    configRelationships.set(relationship, config);
  }
  const authorizedKeyVersions = new Set(configRecords.flatMap((item) => item.hmacAcceptedVersions as string[]));
  for (const record of archive.records) {
    if (
      typeof record.configDigest === 'string'
      && typeof record.configGeneration === 'number'
      && !configRelationships.has(`${record.configGeneration}#${record.configDigest}`)
    ) throw new Error('Private sponsor archive has a missing configuration relationship');
  }
  const samePayloadState = (record: Record<string, unknown>, draft: Record<string, unknown>) => (
    record.payloadExpired === draft.payloadExpired
    && record.payloadRef === draft.payloadRef
  );
  const hasExactKey = (record: Record<string, unknown>, kind: string, id: unknown) => (
    isString(id)
    && record.PK === `${kind}#${id}`
    && record.SK === `${kind}#${id}`
  );
  for (const record of archive.records) {
    if (record.recordType === 'communication-draft-version') {
      const suggestion = suggestions.get(String(record.suggestionId));
      const payload = record.payloadRef ? payloads.get(String(record.payloadRef)) : undefined;
      const body = payload?.payload as Record<string, unknown> | undefined;
      if (!suggestion || suggestion.bookingId !== record.bookingId) {
        throw new Error('Private sponsor archive has a dangling suggestion reference');
      }
      if (record.payloadExpired !== true && (
        !payload
        || payload.communicationId !== record.communicationId
        || payload.version !== record.version
        || payload.payloadHash !== record.payloadHash
        || body?.communicationId !== record.communicationId
        || body?.version !== record.version
        || body?.bookingId !== record.bookingId
        || body?.suggestionId !== record.suggestionId
        || body?.organizationId !== suggestion.organizationId
        || body?.communicationType !== suggestion.communicationType
        || body?.sendConfigDigest !== record.configDigest
      )) throw new Error('Private sponsor archive has a dangling payload reference');
    }
    if (record.recordType === 'communication-private-payload') {
      const draft = drafts.get(`${record.communicationId}#${record.version}`);
      if (
        !draft
        || draft.payloadRef !== record.id
        || draft.payloadHash !== record.payloadHash
      ) throw new Error('Private sponsor archive has a dangling payload reference');
    }
    if (record.recordType === 'communication-presentation') {
      const draft = drafts.get(`${record.communicationId}#${record.draftVersion}`);
      if (
        !draft
        || record.bookingId !== draft.bookingId
        || record.payloadHash !== draft.payloadHash
        || record.previewHash !== draft.previewHash
        || !samePayloadState(record, draft)
      ) {
        throw new Error('Private sponsor archive has a dangling presentation reference');
      }
    }
    if (record.recordType === 'sponsor-send-attempt') {
      const draft = drafts.get(`${record.communicationId}#${record.draftVersion}`);
      const config = configRelationships.get(`${record.configGeneration}#${record.configDigest}`);
      if (
        !draft
        || record.bookingId !== draft.bookingId
        || record.payloadHash !== draft.payloadHash
        || record.previewHash !== draft.previewHash
        || !samePayloadState(record, draft)
        || !config
        || record.sesAccount !== config.sesAccount
        || record.sesRegion !== config.sesRegion
        || record.sesIdentityArn !== config.sesIdentityArn
        || record.from !== config.from
        || record.replyTo !== config.replyTo
        || record.configurationSet !== config.configurationSet
        || record.configurationSetGeneration !== config.configurationSetGeneration
      ) {
        throw new Error('Private sponsor archive has a dangling attempt reference');
      }
    }
    if (record.recordType === 'sponsor-send-event-fact') {
      const attempt = attempts.get(String(record.attemptId));
      if (
        !attempt
        || !hasExactKey(record, 'SPONSOR_SEND_EVENT', record.id)
        || record.communicationId !== attempt.communicationId
        || record.bookingId !== attempt.bookingId
        || !isString(attempt.providerMessageId)
        || record.messageId !== attempt.providerMessageId
        || record.configurationSetGeneration !== attempt.configurationSetGeneration
      ) {
        throw new Error('Private sponsor archive has a dangling event/correlation reference');
      }
    }
    if (record.recordType === 'pending-sponsor-send-event-set') {
      const attempt = attempts.get(String(record.attemptId));
      if (
        !attempt
        || record.id !== attempt.id
        || !hasExactKey(record, 'PENDING_SPONSOR_SEND_EVENTS', attempt.id)
        || !isString(attempt.providerMessageId)
        || record.candidateMessageId !== attempt.providerMessageId
      ) throw new Error('Private sponsor archive has a dangling event/correlation reference');
    }
    if (record.recordType === 'sponsor-send-correlation') {
      const attempt = attempts.get(String(record.attemptId));
      if (
        !attempt
        || !hasExactKey(record, 'SPONSOR_SEND_CORRELATION', attempt.correlationHash)
        || record.id !== attempt.correlationHash
        || record.communicationId !== attempt.communicationId
        || record.configGeneration !== attempt.configGeneration
        || record.correlationHash !== attempt.correlationHash
      ) throw new Error('Private sponsor archive has a dangling event/correlation reference');
    }
    if (record.recordType === 'email-suppression' && (
      typeof record.keyVersion !== 'string'
      || typeof record.contactId !== 'string'
      || typeof record.organizationId !== 'string'
      || !authorizedKeyVersions.has(record.keyVersion)
    )) throw new Error('Private sponsor archive has an invalid suppression relationship');
    if (
      record.recordType === 'suppression-migration-orphan'
      && !authorizedKeyVersions.has(String(record.keyVersion))
    ) throw new Error('Private sponsor archive has an invalid suppression relationship');
    if (record.recordType === 'sponsor-send-config' && (
      record.enabled !== false
      || !Array.isArray(record.hmacAcceptedVersions)
      || typeof record.digest !== 'string'
    )) throw new Error('Private sponsor archive has an invalid disabled config');
  }
  const suppressionCounts = archive.records
    .filter((item) => item.recordType === 'email-suppression' && item.status === 'active')
    .reduce<Record<string, number>>((counts, item) => {
      const version = String(item.keyVersion);
      counts[version] = (counts[version] || 0) + 1;
      return counts;
    }, {});
  const countRecordList = archive.records.filter((item) => item.recordType === 'suppression-version-count');
  const countRecords = Object.fromEntries(countRecordList.map((item) => [String(item.keyVersion), Number(item.liveCount)]));
  if (
    Object.keys(countRecords).length !== countRecordList.length
    || Object.keys(countRecords).some((version) => !authorizedKeyVersions.has(version))
  ) throw new Error('Private sponsor archive suppression coverage is inconsistent');
  const coverage = archive.records.find((item) => item.recordType === 'suppression-coverage');
  const liveVersions = coverage?.liveVersions instanceof Set
    ? [...coverage.liveVersions].map(String).sort()
    : Array.isArray(coverage?.liveVersions) ? coverage.liveVersions.map(String).sort() : [];
  if (
    liveVersions.some((version) => !authorizedKeyVersions.has(version))
    || new Set(liveVersions).size !== liveVersions.length
    || canonicalJson(suppressionCounts) !== canonicalJson(countRecords)
    || canonicalJson(Object.keys(suppressionCounts).sort()) !== canonicalJson(liveVersions)
  ) throw new Error('Private sponsor archive suppression coverage is inconsistent');
}

export async function restoreSponsorPrivateArchive(
  client: DynamoDBDocumentClient,
  archive: SponsorPrivateArchive,
  options: { dryRun: boolean; targetTable: string },
): Promise<{ count: number; dryRun: boolean }> {
  validateSponsorPrivateArchive(archive);
  if (!options.targetTable || options.targetTable === TABLE_SPONSOR_CRM) throw new Error('Restore requires an explicit disposable target table');
  if (options.dryRun) return { count: archive.records.length, dryRun: true };
  for (const source of archive.records) {
    const record = structuredClone(source);
    if (record.recordType === 'communication-presentation') { record.state = 'revoked'; delete record.tokenHash; }
    if (record.recordType === 'sponsor-send-attempt') {
      record.recoveryBlocked = true;
      delete record.leaseOwner; delete record.leaseExpiresAt; delete record.correlationToken;
      delete record.GSI2PK; delete record.GSI2SK;
    }
    if (record.recordType === 'sponsor-send-config') record.enabled = false;
    await client.send(new PutCommand({ TableName: options.targetTable, Item: record, ConditionExpression: 'attribute_not_exists(PK) AND attribute_not_exists(SK)' }));
  }
  return { count: archive.records.length, dryRun: false };
}

const streamBody = async (body: unknown): Promise<string> => {
  if (typeof body === 'string') return body;
  if (body && typeof (body as { transformToString?: () => Promise<string> }).transformToString === 'function') {
    return (body as { transformToString: () => Promise<string> }).transformToString();
  }
  throw new Error('Archive object body is unavailable');
};

export async function sponsorPrivateArchiveHandler(event: {
  action?: 'export' | 'validate' | 'dry-run';
  archiveKey?: string;
}) {
  if (event.action && !['export', 'validate', 'dry-run'].includes(event.action)) {
    throw new Error('Unsupported private archive action');
  }
  const client = await getClient();
  const bucket = process.env.SPONSOR_COMMUNICATION_PRIVATE_ARCHIVE_BUCKET || '';
  const prefix = process.env.SPONSOR_COMMUNICATION_PRIVATE_ARCHIVE_PREFIX || 'sponsor-communications';
  if (!bucket) throw new Error('Private archive bucket is not configured');
  const s3 = new S3Client({});
  if (!event.action || event.action === 'export') {
    const archive = await exportSponsorCommunications(client);
    const key = `${prefix}/${archive.manifest.generatedAt.replace(/[:.]/g, '-')}.json`;
    await s3.send(new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: JSON.stringify(archive),
      ContentType: 'application/json',
      ServerSideEncryption: 'aws:kms',
      SSEKMSKeyId: process.env.SPONSOR_COMMUNICATION_PRIVATE_ARCHIVE_KMS_KEY,
    }));
    return { archiveKey: key, count: archive.manifest.count, checksum: archive.manifest.recordsSha256 };
  }
  if (!event.archiveKey || !event.archiveKey.startsWith(`${prefix}/`)) throw new Error('Invalid private archive key');
  const object = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: event.archiveKey }));
  const archive = JSON.parse(await streamBody(object.Body)) as SponsorPrivateArchive;
  validateSponsorPrivateArchive(archive);
  return { valid: true, dryRun: event.action === 'dry-run', count: archive.manifest.count };
}
