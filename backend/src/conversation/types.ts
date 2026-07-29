type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

const RECORD_SCHEMA_VERSION = 1;
const MAX_ID_LENGTH = 200;
const MAX_SHORT_TEXT_BYTES = 4_096;
const MAX_PRIVATE_TEXT_BYTES = 32_768;
const MAX_JSON_BYTES = 65_536;
const SECRET_FIELD = /(authorization|cookie|credential|password|secret|api[_-]?key|raw[_-]?token|access[_-]?token|signed[_-]?url)/i;
const SIGNED_VALUE = /(X-Amz-(?:Signature|Credential|Security-Token)=|[?&](?:access_token|token|password|secret|credential|api[_-]?key)=)/i;

type RecordType =
  | 'identity_binding'
  | 'conversation'
  | 'channel_binding'
  | 'conversation_event'
  | 'summary_checkpoint'
  | 'plugin_draft'
  | 'proposal_version'
  | 'proposal_presentation'
  | 'execution_attempt'
  | 'conversation_audit_event'
  | 'conversational_private_payload';

interface RecordBase {
  id: string;
  recordType: RecordType;
  schemaVersion: number;
  createdAt: string;
  updatedAt: string;
  expiresAt?: string;
  ttl?: number;
}

interface IdentityBinding extends RecordBase {
  recordType: 'identity_binding';
  userId: string;
  channel: string;
  channelUserId: string;
  displayUsername?: string;
  status: 'active' | 'revoked';
  provisionedBy: string;
  provisionedAt: string;
  revokedBy?: string;
  revokedAt?: string;
  revision: number;
}

interface Conversation extends RecordBase {
  recordType: 'conversation';
  ownerUserId: string;
  audience: 'private' | 'group' | 'shared';
  status: 'active' | 'closed' | 'deleted';
  objective?: string;
  currentReference?: string;
  activeDraftId?: string;
  activeProposalId?: string;
  nextEventSequence: number;
  revision: number;
  deletedAt?: string;
}

interface ChannelBinding extends RecordBase {
  recordType: 'channel_binding';
  conversationId: string;
  ownerUserId: string;
  channel: string;
  channelConversationKey: string;
}

interface ConversationEvent extends RecordBase {
  recordType: 'conversation_event';
  conversationId: string;
  sequence: number;
  channel: string;
  idempotencyKey: string;
  eventType: string;
  direction: 'inbound' | 'outbound' | 'internal';
  actorId: string;
  provenance: string;
  classification: 'public' | 'internal' | 'private' | 'sensitive';
  payload?: JsonValue;
  payloadRef?: string;
}

interface SummaryCheckpoint extends RecordBase {
  recordType: 'summary_checkpoint';
  conversationId: string;
  fromSequence: number;
  throughSequence: number;
  summary: string;
  revision: number;
}

interface PluginDraft extends RecordBase {
  recordType: 'plugin_draft';
  conversationId: string;
  pluginId: string;
  pluginBuild: string;
  status: 'collecting' | 'ready' | 'abandoned';
  data: JsonValue;
  revision: number;
}

interface ProposalSpec {
  pluginId: string;
  pluginBuildDigest: string;
  schemaDigest: string;
  policyDigest: string;
  action: string;
  operation: string;
  effect: string;
  targetRef?: string;
  destinationRef?: string;
  proposedContent?: JsonValue;
  privatePayloadRef?: string;
  baseRevision?: string;
  sourceRefs: Array<{ ref: string; revision?: string; classification: string }>;
  permissionRef: string;
  expiresAt: string;
}

interface ProposalVersion extends RecordBase {
  recordType: 'proposal_version';
  proposalId: string;
  version: number;
  conversationId: string;
  draftId?: string;
  status: 'presented' | 'superseded' | 'expired' | 'canceled' | 'claimed' | 'conflicted';
  spec: ProposalSpec;
  canonicalPayloadHash: string;
  renderedViewHash: string;
  actorId: string;
  channel: string;
  revision: number;
}

interface ProposalPresentation extends RecordBase {
  recordType: 'proposal_presentation';
  proposalId: string;
  proposalVersion: number;
  conversationId: string;
  actorId: string;
  channel: string;
  status: 'active' | 'consumed' | 'revoked' | 'expired';
  actionTokenHash: string;
  revision: number;
}

interface ExecutionAttempt extends RecordBase {
  recordType: 'execution_attempt';
  proposalId: string;
  proposalVersion: number;
  conversationId: string;
  status: 'queued' | 'executing' | 'succeeded' | 'failed_safe' | 'outcome_unknown' | 'manually_resolved';
  deliveryMode: 'provider_idempotency' | 'correlation_lookup' | 'operator_reconciliation_only';
  idempotencyRef?: string;
  correlationRef?: string;
  attemptNumber: number;
  readyAt: string;
  leaseOwner?: string;
  leaseExpiresAt?: string;
  recoveryBlocked: boolean;
  errorCode?: string;
  resultReceiptRef?: string;
  revision: number;
}

interface ConversationAuditEvent extends RecordBase {
  recordType: 'conversation_audit_event';
  conversationId: string;
  subjectType: string;
  subjectId: string;
  action: string;
  actorId: string;
  payloadHash?: string;
  outcome: string;
}

interface ConversationalPrivatePayload extends RecordBase {
  recordType: 'conversational_private_payload';
  conversationId: string;
  classification: 'private' | 'sensitive';
  content: JsonValue;
}

type ConversationalRecord =
  | IdentityBinding
  | Conversation
  | ChannelBinding
  | ConversationEvent
  | SummaryCheckpoint
  | PluginDraft
  | ProposalVersion
  | ProposalPresentation
  | ExecutionAttempt
  | ConversationAuditEvent
  | ConversationalPrivatePayload;

function assertString(value: unknown, path: string, maximum = MAX_ID_LENGTH): asserts value is string {
  if (typeof value !== 'string' || value.length === 0 || Buffer.byteLength(value, 'utf8') > maximum) {
    throw new Error(`${path} must be a non-empty string no larger than ${maximum} bytes`);
  }
}

function assertIsoTimestamp(value: unknown, path: string): asserts value is string {
  assertString(value, path, 100);
  if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z$/.test(value) || Number.isNaN(Date.parse(value))) {
    throw new Error(`${path} must be an ISO timestamp`);
  }
}

function assertInteger(value: unknown, path: string, minimum = 0): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) {
    throw new Error(`${path} must be an integer >= ${minimum}`);
  }
}

function assertEnum(value: unknown, allowed: readonly string[], path: string): void {
  if (typeof value !== 'string' || !allowed.includes(value)) {
    throw new Error(`${path} must be one of: ${allowed.join(', ')}`);
  }
}

function assertSafeJson(value: unknown, path: string, maximum = MAX_JSON_BYTES): asserts value is JsonValue {
  let serialized: string;
  try {
    serialized = JSON.stringify(value);
  } catch {
    throw new Error(`${path} must be JSON serializable`);
  }
  if (serialized === undefined || Buffer.byteLength(serialized, 'utf8') > maximum) {
    throw new Error(`${path} must be bounded JSON no larger than ${maximum} bytes`);
  }
  const visit = (candidate: unknown, candidatePath: string): void => {
    if (Buffer.isBuffer(candidate) || candidate instanceof Uint8Array) {
      throw new Error(`${candidatePath} must not contain binary media`);
    }
    if (typeof candidate === 'string' && SIGNED_VALUE.test(candidate)) {
      throw new Error(`${candidatePath} must not contain signed URLs or credentials`);
    }
    if (!candidate || typeof candidate !== 'object') return;
    if (Array.isArray(candidate)) {
      candidate.forEach((entry, index) => visit(entry, `${candidatePath}[${index}]`));
      return;
    }
    for (const [key, entry] of Object.entries(candidate as Record<string, unknown>)) {
      if (SECRET_FIELD.test(key)) throw new Error(`${candidatePath}.${key} is a forbidden secret-like field`);
      visit(entry, `${candidatePath}.${key}`);
    }
  };
  visit(value, path);
}

function validateConversationalRecord(
  record: ConversationalRecord,
  options: { portable?: boolean } = {}
): void {
  assertEnum(record.recordType, [
    'identity_binding',
    'conversation',
    'channel_binding',
    'conversation_event',
    'summary_checkpoint',
    'plugin_draft',
    'proposal_version',
    'proposal_presentation',
    'execution_attempt',
    'conversation_audit_event',
    'conversational_private_payload',
  ], 'recordType');
  assertString(record.id, `${record.recordType}.id`);
  if (record.schemaVersion !== RECORD_SCHEMA_VERSION) {
    throw new Error(`${record.recordType}.schemaVersion must be ${RECORD_SCHEMA_VERSION}`);
  }
  assertIsoTimestamp(record.createdAt, `${record.recordType}.createdAt`);
  assertIsoTimestamp(record.updatedAt, `${record.recordType}.updatedAt`);
  if (Date.parse(record.updatedAt) < Date.parse(record.createdAt)) {
    throw new Error(`${record.recordType}.updatedAt must not precede createdAt`);
  }
  assertRetention(record);

  assertSafeJson(record, record.recordType, 120_000);
  switch (record.recordType) {
    case 'identity_binding':
      assertString(record.userId, 'identity_binding.userId');
      assertString(record.channel, 'identity_binding.channel');
      assertString(record.channelUserId, 'identity_binding.channelUserId');
      assertString(record.provisionedBy, 'identity_binding.provisionedBy');
      assertIsoTimestamp(record.provisionedAt, 'identity_binding.provisionedAt');
      if (record.displayUsername !== undefined) assertString(record.displayUsername, 'identity_binding.displayUsername', 500);
      assertEnum(record.status, ['active', 'revoked'], 'identity_binding.status');
      assertInteger(record.revision, 'identity_binding.revision', 1);
      if (record.status === 'revoked') {
        assertString(record.revokedBy, 'identity_binding.revokedBy');
        assertIsoTimestamp(record.revokedAt, 'identity_binding.revokedAt');
      }
      break;
    case 'conversation':
      assertString(record.ownerUserId, 'conversation.ownerUserId');
      assertEnum(record.audience, ['private', 'group', 'shared'], 'conversation.audience');
      assertEnum(record.status, ['active', 'closed', 'deleted'], 'conversation.status');
      assertInteger(record.nextEventSequence, 'conversation.nextEventSequence', 1);
      assertInteger(record.revision, 'conversation.revision', 1);
      if (record.objective) assertString(record.objective, 'conversation.objective', MAX_SHORT_TEXT_BYTES);
      if (record.currentReference) assertString(record.currentReference, 'conversation.currentReference', 1_000);
      if (record.activeDraftId) assertString(record.activeDraftId, 'conversation.activeDraftId');
      if (record.activeProposalId) assertString(record.activeProposalId, 'conversation.activeProposalId');
      if (record.status === 'deleted') assertIsoTimestamp(record.deletedAt, 'conversation.deletedAt');
      break;
    case 'channel_binding':
      assertString(record.conversationId, 'channel_binding.conversationId');
      assertString(record.ownerUserId, 'channel_binding.ownerUserId');
      assertString(record.channel, 'channel_binding.channel');
      assertString(record.channelConversationKey, 'channel_binding.channelConversationKey', 500);
      break;
    case 'conversation_event':
      assertString(record.conversationId, 'conversation_event.conversationId');
      assertInteger(record.sequence, 'conversation_event.sequence', 1);
      assertString(record.channel, 'conversation_event.channel');
      assertString(record.idempotencyKey, 'conversation_event.idempotencyKey', 500);
      assertString(record.eventType, 'conversation_event.eventType');
      assertEnum(record.direction, ['inbound', 'outbound', 'internal'], 'conversation_event.direction');
      assertString(record.actorId, 'conversation_event.actorId');
      assertString(record.provenance, 'conversation_event.provenance', 1_000);
      assertEnum(record.classification, ['public', 'internal', 'private', 'sensitive'], 'conversation_event.classification');
      if (record.payload !== undefined) assertSafeJson(record.payload, 'conversation_event.payload');
      if (!record.payload && !record.payloadRef) throw new Error('conversation_event requires payload or payloadRef');
      if (record.payloadRef) assertString(record.payloadRef, 'conversation_event.payloadRef');
      break;
    case 'summary_checkpoint':
      assertString(record.conversationId, 'summary_checkpoint.conversationId');
      assertInteger(record.fromSequence, 'summary_checkpoint.fromSequence', 1);
      assertInteger(record.throughSequence, 'summary_checkpoint.throughSequence', record.fromSequence);
      assertString(record.summary, 'summary_checkpoint.summary', MAX_PRIVATE_TEXT_BYTES);
      assertInteger(record.revision, 'summary_checkpoint.revision', 1);
      break;
    case 'plugin_draft':
      assertString(record.conversationId, 'plugin_draft.conversationId');
      assertString(record.pluginId, 'plugin_draft.pluginId');
      assertString(record.pluginBuild, 'plugin_draft.pluginBuild', 500);
      assertEnum(record.status, ['collecting', 'ready', 'abandoned'], 'plugin_draft.status');
      assertSafeJson(record.data, 'plugin_draft.data');
      assertInteger(record.revision, 'plugin_draft.revision', 1);
      break;
    case 'proposal_version':
      assertString(record.proposalId, 'proposal_version.proposalId');
      assertInteger(record.version, 'proposal_version.version', 1);
      assertString(record.conversationId, 'proposal_version.conversationId');
      if (record.draftId) assertString(record.draftId, 'proposal_version.draftId');
      assertEnum(record.status, ['presented', 'superseded', 'expired', 'canceled', 'claimed', 'conflicted'], 'proposal_version.status');
      assertProposalSpec(record.spec);
      assertHash(record.canonicalPayloadHash, 'proposal_version.canonicalPayloadHash');
      assertHash(record.renderedViewHash, 'proposal_version.renderedViewHash');
      assertString(record.actorId, 'proposal_version.actorId');
      assertString(record.channel, 'proposal_version.channel');
      assertInteger(record.revision, 'proposal_version.revision', 1);
      break;
    case 'proposal_presentation':
      assertString(record.proposalId, 'proposal_presentation.proposalId');
      assertInteger(record.proposalVersion, 'proposal_presentation.proposalVersion', 1);
      assertString(record.conversationId, 'proposal_presentation.conversationId');
      assertString(record.actorId, 'proposal_presentation.actorId');
      assertString(record.channel, 'proposal_presentation.channel');
      assertEnum(record.status, ['active', 'consumed', 'revoked', 'expired'], 'proposal_presentation.status');
      if (options.portable) {
        if ('actionTokenHash' in record) throw new Error('proposal_presentation.actionTokenHash is forbidden in portable records');
      } else {
        assertHash(record.actionTokenHash, 'proposal_presentation.actionTokenHash');
      }
      assertInteger(record.revision, 'proposal_presentation.revision', 1);
      break;
    case 'execution_attempt':
      assertString(record.proposalId, 'execution_attempt.proposalId');
      assertInteger(record.proposalVersion, 'execution_attempt.proposalVersion', 1);
      assertString(record.conversationId, 'execution_attempt.conversationId');
      assertEnum(record.status, ['queued', 'executing', 'succeeded', 'failed_safe', 'outcome_unknown', 'manually_resolved'], 'execution_attempt.status');
      assertEnum(record.deliveryMode, ['provider_idempotency', 'correlation_lookup', 'operator_reconciliation_only'], 'execution_attempt.deliveryMode');
      assertInteger(record.attemptNumber, 'execution_attempt.attemptNumber', 1);
      assertIsoTimestamp(record.readyAt, 'execution_attempt.readyAt');
      if (typeof record.recoveryBlocked !== 'boolean') throw new Error('execution_attempt.recoveryBlocked must be a boolean');
      if (record.leaseOwner) assertString(record.leaseOwner, 'execution_attempt.leaseOwner');
      if (record.leaseExpiresAt) assertIsoTimestamp(record.leaseExpiresAt, 'execution_attempt.leaseExpiresAt');
      if (record.idempotencyRef) assertString(record.idempotencyRef, 'execution_attempt.idempotencyRef', 1_000);
      if (record.correlationRef) assertString(record.correlationRef, 'execution_attempt.correlationRef', 1_000);
      if (record.errorCode) assertString(record.errorCode, 'execution_attempt.errorCode', 1_000);
      if (record.resultReceiptRef) assertString(record.resultReceiptRef, 'execution_attempt.resultReceiptRef', 1_000);
      assertInteger(record.revision, 'execution_attempt.revision', 1);
      break;
    case 'conversation_audit_event':
      assertString(record.conversationId, 'conversation_audit_event.conversationId');
      assertString(record.subjectType, 'conversation_audit_event.subjectType');
      assertString(record.subjectId, 'conversation_audit_event.subjectId');
      assertString(record.action, 'conversation_audit_event.action');
      assertString(record.actorId, 'conversation_audit_event.actorId');
      assertString(record.outcome, 'conversation_audit_event.outcome');
      if (record.payloadHash) assertHash(record.payloadHash, 'conversation_audit_event.payloadHash');
      for (const forbidden of ['message', 'payload', 'body', 'url', 'actionTokenHash', 'providerResponse']) {
        if (forbidden in record) throw new Error(`conversation_audit_event.${forbidden} is forbidden`);
      }
      break;
    case 'conversational_private_payload':
      assertString(record.conversationId, 'conversational_private_payload.conversationId');
      assertEnum(record.classification, ['private', 'sensitive'], 'conversational_private_payload.classification');
      assertSafeJson(record.content, 'conversational_private_payload.content');
      break;
  }
}

function assertRetention(record: ConversationalRecord): void {
  if (record.recordType === 'identity_binding') {
    if (record.expiresAt !== undefined || record.ttl !== undefined) {
      throw new Error('identity_binding must not have expiresAt or ttl');
    }
    return;
  }
  assertIsoTimestamp(record.expiresAt, `${record.recordType}.expiresAt`);
  assertInteger(record.ttl, `${record.recordType}.ttl`, 1);
  if (Math.floor(Date.parse(record.expiresAt) / 1000) !== record.ttl) {
    throw new Error(`${record.recordType}.ttl must match expiresAt`);
  }
  const retentionDays = (
    record.recordType === 'execution_attempt'
    || record.recordType === 'conversation_audit_event'
  ) ? 365 : 30;
  const retentionBase = (
    record.recordType === 'conversation_event'
    || record.recordType === 'proposal_version'
    || record.recordType === 'proposal_presentation'
    || record.recordType === 'conversation_audit_event'
  ) ? record.createdAt : record.updatedAt;
  const expected = Date.parse(retentionBase) + retentionDays * 86_400_000;
  if (Date.parse(record.expiresAt) !== expected) {
    throw new Error(`${record.recordType}.expiresAt must enforce ${retentionDays}-day retention`);
  }
}

function assertProposalSpec(spec: ProposalSpec): void {
  assertSafeJson(spec, 'proposal_version.spec');
  for (const field of [
    'pluginId', 'pluginBuildDigest', 'schemaDigest', 'policyDigest',
    'action', 'operation', 'effect', 'permissionRef',
  ] as const) {
    assertString(spec[field], `proposal_version.spec.${field}`);
  }
  for (const field of ['pluginBuildDigest', 'schemaDigest', 'policyDigest'] as const) {
    assertHash(spec[field], `proposal_version.spec.${field}`);
  }
  assertIsoTimestamp(spec.expiresAt, 'proposal_version.spec.expiresAt');
  if (!Array.isArray(spec.sourceRefs)) throw new Error('proposal_version.spec.sourceRefs must be an array');
  spec.sourceRefs.forEach((source, index) => {
    assertString(source.ref, `proposal_version.spec.sourceRefs[${index}].ref`);
    assertEnum(source.classification, ['public', 'internal', 'private', 'sensitive'], `proposal_version.spec.sourceRefs[${index}].classification`);
  });
  if (spec.proposedContent === undefined && !spec.privatePayloadRef) {
    throw new Error('proposal_version.spec requires proposedContent or privatePayloadRef');
  }
}

function assertHash(value: unknown, path: string): asserts value is string {
  if (typeof value !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(value)) {
    throw new Error(`${path} must be a sha256 hash`);
  }
}

function isExpired(record: Pick<RecordBase, 'expiresAt'>, now = new Date()): boolean {
  return Boolean(record.expiresAt && Date.parse(record.expiresAt) <= now.getTime());
}

function expiryFrom(timestamp: string, days: number): { expiresAt: string; ttl: number } {
  const expiresAt = new Date(Date.parse(timestamp) + days * 86_400_000).toISOString();
  return { expiresAt, ttl: Math.floor(Date.parse(expiresAt) / 1000) };
}

export {
  MAX_JSON_BYTES,
  MAX_PRIVATE_TEXT_BYTES,
  RECORD_SCHEMA_VERSION,
  expiryFrom,
  isExpired,
  validateConversationalRecord,
};
export type {
  ChannelBinding,
  Conversation,
  ConversationAuditEvent,
  ConversationEvent,
  ConversationalPrivatePayload,
  ConversationalRecord,
  ExecutionAttempt,
  IdentityBinding,
  JsonValue,
  PluginDraft,
  ProposalPresentation,
  ProposalSpec,
  ProposalVersion,
  RecordBase,
  RecordType,
  SummaryCheckpoint,
};
