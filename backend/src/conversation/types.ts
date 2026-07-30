type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

const RECORD_SCHEMA_VERSION = 1;
const MAX_ID_LENGTH = 200;
const MAX_SHORT_TEXT_BYTES = 4_096;
const MAX_PRIVATE_TEXT_BYTES = 32_768;
const MAX_JSON_BYTES = 65_536;
const SECRET_FIELD = /(authorization|cookie|credential|password|secret|api[_-]?key|raw[_-]?token|access[_-]?token|signed[_-]?url)/i;
const SIGNED_VALUE = /(X-Amz-(?:Signature|Credential|Security-Token)=|[?&](?:access_token|token|password|secret|credential|api[_-]?key)=)/i;
const CONTEXT_BODY_FIELD = /^(system|messages?|prompt|completion|body|content|text)$/i;
const CONTEXT_SECRET_VALUE = /(?:bearer\s+\S+|arn:[a-z0-9-]+:secretsmanager:[^\s,}"']+|(?:api[_-]?key|secret|token|password|credential|cookie|authorization)\s*[:=]\s*\S+)/i;

type RecordType =
  | 'identity_binding'
  | 'identity_binding_audit'
  | 'conversation'
  | 'channel_binding'
  | 'conversation_event'
  | 'summary_checkpoint'
  | 'plugin_draft'
  | 'proposal_version'
  | 'proposal_presentation'
  | 'execution_attempt'
  | 'conversation_audit_event'
  | 'result_notification'
  | 'conversational_private_payload'
  | 'skill_load_receipt'
  | 'context_receipt';

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

interface IdentityBindingAudit extends RecordBase {
  recordType: 'identity_binding_audit';
  channel: string;
  channelUserId: string;
  userId: string;
  action: 'created' | 'reactivated' | 'revoked';
  actorId: string;
  outcome: 'succeeded';
  bindingRevision: number;
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
  permissionRevision?: number;
  actorId?: string;
  conversationId?: string;
  draftRef?: string;
  proposalId?: string;
  proposalVersion?: number;
  resourceKey?: string;
  accountConfigDigest?: string;
  accountScopeDigest?: string;
  deliveryMode?: ExecutionAttempt['deliveryMode'];
  deliveryModeDigest?: string;
  expiresAt: string;
}

interface ProposalVersion extends RecordBase {
  recordType: 'proposal_version';
  proposalId: string;
  version: number;
  conversationId: string;
  draftId?: string;
  presentationIds?: string[];
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
  renderedViewHash?: string;
  identityBindingId?: string;
  channelBindingId?: string;
  channelConversationKey?: string;
  actionExpiresAt?: string;
  revision: number;
}

interface SafeExecutionReceipt {
  receiptId: string;
  effectHash: string;
  recordedAt: string;
  metadata?: JsonValue;
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
  actorId?: string;
  identityBindingId?: string;
  identityBindingRevision?: number;
  identityChannel?: string;
  identityChannelUserId?: string;
  channelBindingId?: string;
  channelConversationKey?: string;
  permissionRef?: string;
  permissionRevision?: number;
  resourceKey?: string;
  accountConfigDigest?: string;
  accountScopeDigest?: string;
  deliveryModeDigest?: string;
  draftRef?: string;
  canonicalPayloadHash?: string;
  renderedViewHash?: string;
  executorBuildDigest?: string;
  attemptNumber: number;
  readyAt: string;
  leaseOwner?: string;
  leaseExpiresAt?: string;
  leaseGeneration?: number;
  dispatchStartedAt?: string;
  recoveryBlocked: boolean;
  errorCode?: string;
  resultReceiptRef?: string;
  resultReceipt?: SafeExecutionReceipt;
  manualResolution?: {
    outcome: 'effect_applied' | 'no_effect' | 'found' | 'not_found';
    reason: string;
    actorId: string;
    resolvedAt: string;
    draftId?: string;
    proofClassification?: string;
  };
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

interface ResultNotification extends RecordBase {
  recordType: 'result_notification';
  conversationId: string;
  executionAttemptId: string;
  actorId: string;
  channel: string;
  channelConversationKey?: string;
  identityChannelUserId?: string;
  identityBindingId?: string;
  identityBindingRevision?: number;
  channelBindingId?: string;
  privatePayloadRef: string;
  status: 'pending' | 'dispatching' | 'delivered' | 'outcome_unknown';
  readyAt: string;
  leaseExpiresAt?: string;
  deliveredAt?: string;
  revision: number;
}

interface SkillLoadReceipt extends RecordBase {
  recordType: 'skill_load_receipt';
  conversationId: string;
  conversationRevision: number;
  actorId: string;
  role: 'admin' | 'operator';
  channel: 'telegram' | 'web';
  pluginId: string;
  pluginBuildDigest: string;
  schemaDigest: string;
  loadNonceHash: string;
  status: 'active' | 'consumed' | 'invalidated' | 'expired';
  consumedResult?: JsonValue;
}

interface StoredContextReceipt extends RecordBase {
  recordType: 'context_receipt';
  conversationId: string;
  conversationRevision: number;
  algorithmVersion: string;
  receipt: JsonValue;
}

type ConversationalRecord =
  | IdentityBinding
  | IdentityBindingAudit
  | Conversation
  | ChannelBinding
  | ConversationEvent
  | SummaryCheckpoint
  | PluginDraft
  | ProposalVersion
  | ProposalPresentation
  | ExecutionAttempt
  | ConversationAuditEvent
  | ResultNotification
  | ConversationalPrivatePayload
  | SkillLoadReceipt
  | StoredContextReceipt;

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

function assertBodyFreeContextReceipt(value: JsonValue, path: string): void {
  const visit = (candidate: JsonValue, candidatePath: string): void => {
    if (typeof candidate === 'string') {
      if (CONTEXT_SECRET_VALUE.test(candidate)) {
        throw new Error(`${candidatePath} contains forbidden secret-like data`);
      }
      return;
    }
    if (!candidate || typeof candidate !== 'object') return;
    if (Array.isArray(candidate)) {
      candidate.forEach((child, index) => visit(child, `${candidatePath}[${index}]`));
      return;
    }
    for (const [key, child] of Object.entries(candidate)) {
      if (CONTEXT_BODY_FIELD.test(key) || SECRET_FIELD.test(key)) {
        throw new Error(`${candidatePath}.${key} is forbidden`);
      }
      visit(child, `${candidatePath}.${key}`);
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
    'identity_binding_audit',
    'conversation',
    'channel_binding',
    'conversation_event',
    'summary_checkpoint',
    'plugin_draft',
    'proposal_version',
    'proposal_presentation',
    'execution_attempt',
    'conversation_audit_event',
    'result_notification',
    'conversational_private_payload',
    'skill_load_receipt',
    'context_receipt',
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
    case 'identity_binding_audit':
      assertString(record.channel, 'identity_binding_audit.channel');
      assertString(record.channelUserId, 'identity_binding_audit.channelUserId');
      assertString(record.userId, 'identity_binding_audit.userId');
      assertEnum(record.action, ['created', 'reactivated', 'revoked'], 'identity_binding_audit.action');
      assertString(record.actorId, 'identity_binding_audit.actorId');
      assertEnum(record.outcome, ['succeeded'], 'identity_binding_audit.outcome');
      assertInteger(record.bindingRevision, 'identity_binding_audit.bindingRevision', 1);
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
      assertSafeJson(
        record.data,
        'plugin_draft.data',
        record.pluginId === 'typefully' ? 96_000 : MAX_JSON_BYTES
      );
      assertInteger(record.revision, 'plugin_draft.revision', 1);
      break;
    case 'proposal_version':
      assertString(record.proposalId, 'proposal_version.proposalId');
      assertInteger(record.version, 'proposal_version.version', 1);
      assertString(record.conversationId, 'proposal_version.conversationId');
      if (record.draftId) assertString(record.draftId, 'proposal_version.draftId');
      if (record.presentationIds !== undefined) {
        if (
          !Array.isArray(record.presentationIds)
          || record.presentationIds.length < 1
          || record.presentationIds.length > 8
          || new Set(record.presentationIds).size !== record.presentationIds.length
        ) throw new Error('proposal_version.presentationIds must be 1..8 unique ids');
        record.presentationIds.forEach((id, index) => {
          assertString(id, `proposal_version.presentationIds[${index}]`);
        });
      }
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
      if (record.renderedViewHash) assertHash(record.renderedViewHash, 'proposal_presentation.renderedViewHash');
      if (record.identityBindingId) assertString(record.identityBindingId, 'proposal_presentation.identityBindingId');
      if (record.channelBindingId) assertString(record.channelBindingId, 'proposal_presentation.channelBindingId');
      if (record.channelConversationKey) assertString(record.channelConversationKey, 'proposal_presentation.channelConversationKey', 500);
      if (record.actionExpiresAt) assertIsoTimestamp(record.actionExpiresAt, 'proposal_presentation.actionExpiresAt');
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
      if (record.actorId) assertString(record.actorId, 'execution_attempt.actorId');
      if (record.identityBindingId) assertString(record.identityBindingId, 'execution_attempt.identityBindingId');
      if (record.identityBindingRevision !== undefined) {
        assertInteger(record.identityBindingRevision, 'execution_attempt.identityBindingRevision', 1);
      }
      if (record.identityChannel) assertString(record.identityChannel, 'execution_attempt.identityChannel');
      if (record.identityChannelUserId) assertString(record.identityChannelUserId, 'execution_attempt.identityChannelUserId');
      if (record.channelBindingId) assertString(record.channelBindingId, 'execution_attempt.channelBindingId');
      if (record.channelConversationKey) assertString(record.channelConversationKey, 'execution_attempt.channelConversationKey', 500);
      if (record.permissionRef) assertString(record.permissionRef, 'execution_attempt.permissionRef');
      if (record.permissionRevision !== undefined) {
        assertInteger(record.permissionRevision, 'execution_attempt.permissionRevision', 1);
      }
      if (record.resourceKey) assertString(record.resourceKey, 'execution_attempt.resourceKey');
      if (record.draftRef) assertString(record.draftRef, 'execution_attempt.draftRef');
      for (const field of [
        'accountConfigDigest', 'accountScopeDigest', 'deliveryModeDigest',
      ] as const) {
        if (record[field]) assertHash(record[field], `execution_attempt.${field}`);
      }
      if (record.canonicalPayloadHash) assertHash(record.canonicalPayloadHash, 'execution_attempt.canonicalPayloadHash');
      if (record.renderedViewHash) assertHash(record.renderedViewHash, 'execution_attempt.renderedViewHash');
      if (record.executorBuildDigest) assertHash(record.executorBuildDigest, 'execution_attempt.executorBuildDigest');
      if (record.leaseGeneration !== undefined) assertInteger(record.leaseGeneration, 'execution_attempt.leaseGeneration', 0);
      if (record.dispatchStartedAt) assertIsoTimestamp(record.dispatchStartedAt, 'execution_attempt.dispatchStartedAt');
      if (record.errorCode) assertString(record.errorCode, 'execution_attempt.errorCode', 1_000);
      if (record.resultReceiptRef) assertString(record.resultReceiptRef, 'execution_attempt.resultReceiptRef', 1_000);
      if (record.resultReceipt) {
        validateSafeExecutionReceipt(record.resultReceipt);
      }
      if (record.manualResolution) {
        assertEnum(
          record.manualResolution.outcome,
          ['effect_applied', 'no_effect', 'found', 'not_found'],
          'execution_attempt.manualResolution.outcome'
        );
        assertString(record.manualResolution.reason, 'execution_attempt.manualResolution.reason', 1_000);
        assertString(record.manualResolution.actorId, 'execution_attempt.manualResolution.actorId');
        assertIsoTimestamp(record.manualResolution.resolvedAt, 'execution_attempt.manualResolution.resolvedAt');
        if (record.manualResolution.draftId) {
          assertString(record.manualResolution.draftId, 'execution_attempt.manualResolution.draftId', 500);
        }
        if (record.manualResolution.proofClassification) {
          assertString(
            record.manualResolution.proofClassification,
            'execution_attempt.manualResolution.proofClassification',
            100
          );
        }
      }
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
    case 'result_notification':
      assertString(record.conversationId, 'result_notification.conversationId');
      assertString(record.executionAttemptId, 'result_notification.executionAttemptId');
      assertString(record.actorId, 'result_notification.actorId');
      assertString(record.channel, 'result_notification.channel');
      if (options.portable) {
        if ('channelConversationKey' in record) {
          throw new Error('result_notification.channelConversationKey is forbidden in portable records');
        }
        if ('identityChannelUserId' in record) {
          throw new Error('result_notification.identityChannelUserId is forbidden in portable records');
        }
      } else {
        assertString(record.channelConversationKey, 'result_notification.channelConversationKey', 500);
        assertString(record.identityChannelUserId, 'result_notification.identityChannelUserId', 500);
      }
      assertString(record.identityBindingId, 'result_notification.identityBindingId');
      assertInteger(record.identityBindingRevision, 'result_notification.identityBindingRevision', 1);
      assertString(record.channelBindingId, 'result_notification.channelBindingId');
      assertString(record.privatePayloadRef, 'result_notification.privatePayloadRef');
      assertEnum(record.status, ['pending', 'dispatching', 'delivered', 'outcome_unknown'], 'result_notification.status');
      assertIsoTimestamp(record.readyAt, 'result_notification.readyAt');
      if (record.leaseExpiresAt) assertIsoTimestamp(record.leaseExpiresAt, 'result_notification.leaseExpiresAt');
      if (record.deliveredAt) assertIsoTimestamp(record.deliveredAt, 'result_notification.deliveredAt');
      assertInteger(record.revision, 'result_notification.revision', 1);
      break;
    case 'conversational_private_payload':
      assertString(record.conversationId, 'conversational_private_payload.conversationId');
      assertEnum(record.classification, ['private', 'sensitive'], 'conversational_private_payload.classification');
      assertSafeJson(
        record.content,
        'conversational_private_payload.content',
        (
          record.content
          && typeof record.content === 'object'
          && !Array.isArray(record.content)
          && record.content.kind === 'telegram_outbound'
        ) ? 96_000 : MAX_JSON_BYTES
      );
      break;
    case 'skill_load_receipt':
      assertString(record.conversationId, 'skill_load_receipt.conversationId');
      assertInteger(record.conversationRevision, 'skill_load_receipt.conversationRevision', 1);
      assertString(record.actorId, 'skill_load_receipt.actorId');
      assertEnum(record.role, ['admin', 'operator'], 'skill_load_receipt.role');
      assertEnum(record.channel, ['telegram', 'web'], 'skill_load_receipt.channel');
      assertString(record.pluginId, 'skill_load_receipt.pluginId');
      assertHash(record.pluginBuildDigest, 'skill_load_receipt.pluginBuildDigest');
      assertHash(record.schemaDigest, 'skill_load_receipt.schemaDigest');
      assertHash(record.loadNonceHash, 'skill_load_receipt.loadNonceHash');
      assertEnum(record.status, ['active', 'consumed', 'invalidated', 'expired'], 'skill_load_receipt.status');
      if (record.consumedResult !== undefined) assertSafeJson(record.consumedResult, 'skill_load_receipt.consumedResult');
      break;
    case 'context_receipt':
      assertString(record.conversationId, 'context_receipt.conversationId');
      assertInteger(record.conversationRevision, 'context_receipt.conversationRevision', 1);
      assertString(record.algorithmVersion, 'context_receipt.algorithmVersion');
      assertSafeJson(record.receipt, 'context_receipt.receipt');
      assertBodyFreeContextReceipt(record.receipt, 'context_receipt.receipt');
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
  if (record.recordType === 'skill_load_receipt') {
    assertIsoTimestamp(record.expiresAt, 'skill_load_receipt.expiresAt');
    assertInteger(record.ttl, 'skill_load_receipt.ttl', 1);
    if (Math.floor(Date.parse(record.expiresAt) / 1000) !== record.ttl) {
      throw new Error('skill_load_receipt.ttl must match expiresAt');
    }
    const duration = Date.parse(record.expiresAt) - Date.parse(record.createdAt);
    if (duration !== 5 * 60_000) throw new Error('skill_load_receipt must expire after five minutes');
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
    || record.recordType === 'identity_binding_audit'
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
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) {
    throw new Error('proposal_version.spec must be an object');
  }
  assertSafeJson(
    spec,
    'proposal_version.spec',
    spec.pluginId === 'typefully' ? 96_000 : MAX_JSON_BYTES
  );
  for (const field of [
    'pluginId', 'pluginBuildDigest', 'schemaDigest', 'policyDigest',
    'action', 'operation', 'effect', 'permissionRef',
  ] as const) {
    assertString(spec[field], `proposal_version.spec.${field}`);
  }
  for (const field of ['pluginBuildDigest', 'schemaDigest', 'policyDigest'] as const) {
    assertHash(spec[field], `proposal_version.spec.${field}`);
  }
  if (spec.permissionRevision !== undefined) {
    assertInteger(spec.permissionRevision, 'proposal_version.spec.permissionRevision', 1);
  }
  for (const field of [
    'actorId', 'conversationId', 'draftRef', 'proposalId',
  ] as const) {
    if (spec[field]) assertString(spec[field], `proposal_version.spec.${field}`);
  }
  if (spec.proposalVersion !== undefined) {
    assertInteger(spec.proposalVersion, 'proposal_version.spec.proposalVersion', 1);
  }
  if (spec.resourceKey) assertString(spec.resourceKey, 'proposal_version.spec.resourceKey');
  for (const field of [
    'accountConfigDigest', 'accountScopeDigest', 'deliveryModeDigest',
  ] as const) {
    if (spec[field]) assertHash(spec[field], `proposal_version.spec.${field}`);
  }
  if (spec.deliveryMode) {
    assertEnum(
      spec.deliveryMode,
      ['provider_idempotency', 'correlation_lookup', 'operator_reconciliation_only'],
      'proposal_version.spec.deliveryMode'
    );
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

function validateSafeExecutionReceipt(receipt: SafeExecutionReceipt): void {
  assertString(receipt.receiptId, 'execution_attempt.resultReceipt.receiptId');
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,199}$/.test(receipt.receiptId) || CONTEXT_SECRET_VALUE.test(receipt.receiptId)) {
    throw new Error('execution_attempt.resultReceipt.receiptId is unsafe');
  }
  assertHash(receipt.effectHash, 'execution_attempt.resultReceipt.effectHash');
  assertIsoTimestamp(receipt.recordedAt, 'execution_attempt.resultReceipt.recordedAt');
  if (receipt.metadata === undefined) return;
  if (!receipt.metadata || typeof receipt.metadata !== 'object' || Array.isArray(receipt.metadata)) {
    throw new Error('execution_attempt.resultReceipt.metadata must be a flat safe object');
  }
  const entries = Object.entries(receipt.metadata);
  if (entries.length > 20) throw new Error('execution_attempt.resultReceipt.metadata has too many fields');
  for (const [key, value] of entries) {
    if (!/^[a-zA-Z][a-zA-Z0-9_.-]{0,63}$/.test(key) || SECRET_FIELD.test(key)) {
      throw new Error('execution_attempt.resultReceipt.metadata contains an unsafe field');
    }
    if (!['string', 'number', 'boolean'].includes(typeof value) && value !== null) {
      throw new Error('execution_attempt.resultReceipt.metadata values must be scalar');
    }
    if (
      typeof value === 'string'
      && (Buffer.byteLength(value, 'utf8') > 500 || SIGNED_VALUE.test(value) || CONTEXT_SECRET_VALUE.test(value))
    ) {
      throw new Error('execution_attempt.resultReceipt.metadata contains an unsafe value');
    }
    if (typeof value === 'number' && !Number.isFinite(value)) {
      throw new Error('execution_attempt.resultReceipt.metadata contains an unsafe number');
    }
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
  validateSafeExecutionReceipt,
};
export type {
  ChannelBinding,
  Conversation,
  ConversationAuditEvent,
  ConversationEvent,
  ConversationalPrivatePayload,
  ResultNotification,
  ConversationalRecord,
  ExecutionAttempt,
  IdentityBinding,
  IdentityBindingAudit,
  JsonValue,
  PluginDraft,
  ProposalPresentation,
  ProposalSpec,
  ProposalVersion,
  SafeExecutionReceipt,
  RecordBase,
  RecordType,
  SkillLoadReceipt,
  StoredContextReceipt,
  SummaryCheckpoint,
};
