import { createHash } from 'crypto';

import { TABLE_CONVERSATIONAL_STATE } from '../db/tableNames';
import {
  validateConversationalRecord,
  type ConversationalRecord,
} from './types';

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
type JsonRecord = Record<string, JsonValue>;

interface ConversationalEntitySpec {
  name: string;
  filename: string;
  tableName: string;
  recordType: string;
  map: (item: Record<string, unknown>) => JsonRecord;
  sortKey: (record: JsonRecord) => string;
}

const CONVERSATIONAL_ENTITY_SPECS: ConversationalEntitySpec[] = [
  ['identity_bindings', 'identity_bindings.jsonl', 'identity_binding'],
  ['identity_binding_audits', 'identity_binding_audits.jsonl', 'identity_binding_audit'],
  ['conversations', 'conversations.jsonl', 'conversation'],
  ['channel_bindings', 'channel_bindings.jsonl', 'channel_binding'],
  ['conversation_events', 'conversation_events.jsonl', 'conversation_event'],
  ['summary_checkpoints', 'summary_checkpoints.jsonl', 'summary_checkpoint'],
  ['plugin_drafts', 'plugin_drafts.jsonl', 'plugin_draft'],
  ['proposal_versions', 'proposal_versions.jsonl', 'proposal_version'],
  ['proposal_presentations', 'proposal_presentations.jsonl', 'proposal_presentation'],
  ['execution_attempts', 'execution_attempts.jsonl', 'execution_attempt'],
  ['conversation_audit_events', 'conversation_audit_events.jsonl', 'conversation_audit_event'],
  ['result_notifications', 'result_notifications.jsonl', 'result_notification'],
  ['conversational_private_payloads', 'conversational_private_payloads.jsonl', 'conversational_private_payload'],
].map(([name, filename, recordType]) => ({
  name,
  filename,
  tableName: TABLE_CONVERSATIONAL_STATE,
  recordType,
  map: mapConversationalRecord,
  sortKey: conversationalSortKey,
}));

function mapConversationalRecord(item: Record<string, unknown>): JsonRecord {
  const {
    PK: _pk, SK: _sk, GSI1PK: _gsi1pk, GSI1SK: _gsi1sk,
    GSI2PK: _gsi2pk, GSI2SK: _gsi2sk, conversationRelationshipPK: _relationship,
    actionTokenHash: _actionTokenHash,
    ...portable
  } = item;
  const typefullyPluginDraft = portable.recordType === 'plugin_draft'
    && portable.pluginId === 'typefully';
  if (typefullyPluginDraft && portable.data !== undefined) {
    portable.data = {
      kind: 'typefully_portable_redacted',
      dataHash: portableDigest(portable.data),
    };
  }
  if (
    portable.recordType === 'proposal_version'
    && portable.spec
    && typeof portable.spec === 'object'
    && !Array.isArray(portable.spec)
    && (portable.spec as Record<string, unknown>).pluginId === 'typefully'
  ) {
    const spec = { ...(portable.spec as Record<string, unknown>) };
    if (spec.proposedContent !== undefined) {
      spec.proposedContent = {
        kind: 'typefully_portable_redacted',
        contentHash: portableDigest(spec.proposedContent),
      };
    }
    portable.spec = spec;
  }
  if (
    portable.recordType === 'conversational_private_payload'
    && portable.content
    && typeof portable.content === 'object'
    && !Array.isArray(portable.content)
  ) {
    portable.content = redactPrivateText(portable.content as Record<string, unknown>);
  }
  if (portable.recordType === 'result_notification') {
    delete portable.channelConversationKey;
    delete portable.identityChannelUserId;
    delete portable.leaseExpiresAt;
    if (portable.status === 'pending' || portable.status === 'dispatching') {
      portable.status = 'outcome_unknown';
    }
  }
  const telegramBound = portable.channel === 'telegram' || portable.identityChannel === 'telegram';
  if (telegramBound) {
    for (const field of [
      'channelUserId',
      'channelConversationKey',
      'identityChannelUserId',
      'identityBindingId',
      'channelBindingId',
    ]) {
      if (typeof portable[field] === 'string') portable[field] = portableDigest(portable[field]);
    }
    if (
      (portable.recordType === 'identity_binding' || portable.recordType === 'channel_binding')
      && typeof portable.id === 'string'
    ) portable.id = portableDigest(portable.id);
    if (portable.recordType === 'conversation_event') {
      for (const field of ['idempotencyKey', 'provenance']) {
        if (typeof portable[field] === 'string') portable[field] = portableDigest(portable[field]);
      }
    }
  }
  return JSON.parse(JSON.stringify(portable)) as JsonRecord;
}

function portableDigest(value: unknown): string {
  return `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;
}

function redactPrivateText(value: Record<string, unknown>): JsonRecord {
  const redacted: JsonRecord = {};
  const removed: string[] = [];
  for (const [key, entry] of Object.entries(value)) {
    if (/^(?:text|caption|message|transcript|description|editUrl|privateUrl)$/i.test(key)) {
      removed.push(key);
      continue;
    }
    if (Array.isArray(entry)) {
      redacted[key] = entry.map((item) => (
        item && typeof item === 'object' && !Array.isArray(item)
          ? redactPrivateText(item as Record<string, unknown>)
          : item
      )) as JsonValue;
    } else if (entry && typeof entry === 'object') {
      redacted[key] = redactPrivateText(entry as Record<string, unknown>);
    } else {
      redacted[key] = entry as JsonValue;
    }
  }
  if (removed.length > 0) redacted.redactedFields = removed.sort();
  return redacted;
}

function conversationalSortKey(record: JsonRecord): string {
  if (record.recordType === 'conversation_event') {
    return `${record.conversationId}#${String(record.sequence).padStart(16, '0')}#${record.id}`;
  }
  if (record.recordType === 'proposal_version') {
    return `${record.proposalId}#${String(record.version).padStart(12, '0')}`;
  }
  return String(record.id || '');
}

function validateConversationalEntities(
  records: Record<string, JsonRecord[]>,
  errors: string[],
  generatedAt?: string
): void {
  const idsByEntity = new Map<string, Set<string>>();
  for (const spec of CONVERSATIONAL_ENTITY_SPECS) {
    const recordsForEntity = records[spec.name] || [];
    const ids = new Set<string>();
    idsByEntity.set(spec.name, ids);
    recordsForEntity.forEach((record, index) => {
      const context = `${spec.name}[${index}]`;
      try {
        validateConversationalRecord(
          record as unknown as ConversationalRecord,
          { portable: true }
        );
      } catch (error) {
        errors.push(`${context}: ${(error as Error).message}`);
      }
      required(record, 'id', context, errors);
      if (record.recordType !== spec.recordType) errors.push(`${context}.recordType must be ${spec.recordType}`);
      if (record.schemaVersion !== 1) errors.push(`${context}.schemaVersion must be 1`);
      timestamp(record, 'createdAt', context, errors);
      timestamp(record, 'updatedAt', context, errors);
      if (typeof record.id === 'string') {
        if (ids.has(record.id)) errors.push(`${context}.id duplicates ${record.id}`);
        ids.add(record.id);
      }
      rejectUnsafe(record, context, errors);
      if (JSON.stringify(record).length > 120_000) errors.push(`${context} exceeds portable record size`);
      if (
        generatedAt
        && typeof record.expiresAt === 'string'
        && Date.parse(record.expiresAt) <= Date.parse(generatedAt)
      ) {
        errors.push(`${context}.expiresAt must be later than manifest generated_at`);
      }
    });
  }

  const conversationsById = new Map<string, JsonRecord>(
    (records.conversations || [])
      .filter((record) => typeof record.id === 'string')
      .map((record) => [String(record.id), record])
  );
  const userIds = new Set(
    (records.users || [])
      .map((record) => record.user_id)
      .filter((id): id is string => typeof id === 'string' && id.length > 0)
  );
  const conversations = idsByEntity.get('conversations') || new Set<string>();
  const proposalVersions = new Set<string>();
  const draftsById = new Map<string, JsonRecord>(
    (records.plugin_drafts || [])
      .filter((record) => typeof record.id === 'string')
      .map((record) => [String(record.id), record])
  );
  const drafts = new Set(draftsById.keys());
  const proposalsById = new Map<string, JsonRecord[]>();
  for (const proposal of records.proposal_versions || []) {
    if (typeof proposal.proposalId !== 'string') continue;
    const versions = proposalsById.get(proposal.proposalId) || [];
    versions.push(proposal);
    proposalsById.set(proposal.proposalId, versions);
  }
  const privatePayloadsById = new Map<string, JsonRecord>(
    (records.conversational_private_payloads || [])
      .filter((record) => typeof record.id === 'string')
      .map((record) => [String(record.id), record])
  );
  const sequenceByConversation = new Map<string, Set<number>>();

  for (const [index, record] of (records.conversations || []).entries()) {
    const context = `conversations[${index}]`;
    enumField(record, 'audience', ['private', 'group', 'shared'], context, errors);
    enumField(record, 'status', ['active', 'closed', 'deleted'], context, errors);
    integer(record, 'revision', context, errors, 1);
    integer(record, 'nextEventSequence', context, errors, 1);
    if (typeof record.ownerUserId === 'string' && !userIds.has(record.ownerUserId)) {
      errors.push(`${context}.ownerUserId references missing exported user`);
    }
    if (typeof record.activeDraftId === 'string') {
      const draft = draftsById.get(record.activeDraftId);
      if (!draft) {
        errors.push(`${context}.activeDraftId references missing draft`);
      } else if (draft.conversationId !== record.id) {
        errors.push(`${context}.activeDraftId must reference a draft in the same conversation`);
      }
    }
    if (typeof record.activeProposalId === 'string') {
      const proposals = proposalsById.get(record.activeProposalId);
      if (!proposals || proposals.length === 0) {
        errors.push(`${context}.activeProposalId references missing proposal`);
      } else if (!proposals.some((proposal) => proposal.conversationId === record.id)) {
        errors.push(`${context}.activeProposalId must reference a proposal in the same conversation`);
      }
    }
  }
  for (const [index, record] of (records.identity_bindings || []).entries()) {
    const context = `identity_bindings[${index}]`;
    enumField(record, 'status', ['active', 'revoked'], context, errors);
    const userId = required(record, 'userId', context, errors);
    required(record, 'channelUserId', context, errors);
    if (userId && !userIds.has(userId)) {
      errors.push(`${context}.userId references missing exported user`);
    }
  }
  for (const specName of [
    'channel_bindings', 'conversation_events', 'summary_checkpoints', 'plugin_drafts',
    'proposal_versions', 'proposal_presentations', 'execution_attempts',
    'conversation_audit_events', 'result_notifications', 'conversational_private_payloads',
  ]) {
    for (const [index, record] of (records[specName] || []).entries()) {
      const conversationId = required(record, 'conversationId', `${specName}[${index}]`, errors);
      if (conversationId && !conversations.has(conversationId)) {
        errors.push(`${specName}[${index}].conversationId references missing conversation without relationship evidence`);
      }
    }
  }
  for (const [index, notification] of (records.result_notifications || []).entries()) {
    const context = `result_notifications[${index}]`;
    const payload = typeof notification.privatePayloadRef === 'string'
      ? privatePayloadsById.get(notification.privatePayloadRef)
      : undefined;
    if (!payload) {
      errors.push(`${context}.privatePayloadRef references missing private payload`);
    } else if (payload.conversationId !== notification.conversationId) {
      errors.push(`${context}.privatePayloadRef must stay in the same conversation`);
    }
    const conversation = conversationsById.get(String(notification.conversationId || ''));
    if (conversation && notification.actorId !== conversation.ownerUserId) {
      errors.push(`${context}.actorId must match conversation owner`);
    }
  }
  for (const [index, binding] of (records.channel_bindings || []).entries()) {
    const conversation = conversationsById.get(String(binding.conversationId || ''));
    if (
      conversation
      && typeof binding.ownerUserId === 'string'
      && binding.ownerUserId !== conversation.ownerUserId
    ) {
      errors.push(`channel_bindings[${index}].ownerUserId must match conversation owner`);
    }
  }
  let previousEventOrder = '';
  const maxSequenceByConversation = new Map<string, number>();
  for (const [index, event] of (records.conversation_events || []).entries()) {
    const context = `conversation_events[${index}]`;
    const conversationId = typeof event.conversationId === 'string' ? event.conversationId : '';
    const sequence = integer(event, 'sequence', context, errors, 1);
    if (sequence !== null) {
      const order = `${conversationId}#${String(sequence).padStart(16, '0')}#${String(event.id || '')}`;
      if (previousEventOrder && order <= previousEventOrder) {
        errors.push(`${context} is out of deterministic conversation/sequence order`);
      }
      previousEventOrder = order;
      const seen = sequenceByConversation.get(conversationId) || new Set<number>();
      if (seen.has(sequence)) errors.push(`${context}.sequence duplicates ${sequence} in conversation ${conversationId}`);
      seen.add(sequence);
      sequenceByConversation.set(conversationId, seen);
      maxSequenceByConversation.set(conversationId, Math.max(maxSequenceByConversation.get(conversationId) || 0, sequence));
    }
    enumField(event, 'direction', ['inbound', 'outbound', 'internal'], context, errors);
    enumField(event, 'classification', ['public', 'internal', 'private', 'sensitive'], context, errors);
    validatePrivatePayloadReference(
      event.payloadRef,
      event.conversationId,
      privatePayloadsById,
      `${context}.payloadRef`,
      errors
    );
  }
  for (const [conversationId, maximum] of maxSequenceByConversation) {
    const conversation = conversationsById.get(conversationId);
    if (
      conversation
      && typeof conversation.nextEventSequence === 'number'
      && conversation.nextEventSequence <= maximum
    ) {
      errors.push(`conversations.${conversationId}.nextEventSequence must be greater than exported event sequence ${maximum}`);
    }
  }
  for (const [index, draft] of (records.plugin_drafts || []).entries()) {
    enumField(draft, 'status', ['collecting', 'ready', 'abandoned'], `plugin_drafts[${index}]`, errors);
  }
  let previousProposalOrder = '';
  const proposalsByVersion = new Map<string, JsonRecord>();
  for (const [index, proposal] of (records.proposal_versions || []).entries()) {
    const context = `proposal_versions[${index}]`;
    const proposalId = required(proposal, 'proposalId', context, errors);
    const version = integer(proposal, 'version', context, errors, 1);
    if (proposalId && version !== null) {
      const key = `${proposalId}#${version}`;
      const order = `${proposalId}#${String(version).padStart(12, '0')}`;
      if (previousProposalOrder && order <= previousProposalOrder) {
        errors.push(`${context} is out of deterministic proposal/version order`);
      }
      previousProposalOrder = order;
      if (proposalVersions.has(key)) errors.push(`${context} duplicates proposal version ${key}`);
      proposalVersions.add(key);
      proposalsByVersion.set(key, proposal);
    }
    enumField(proposal, 'status', ['presented', 'superseded', 'expired', 'canceled', 'claimed', 'conflicted'], context, errors);
    if (proposal.draftId && !drafts.has(String(proposal.draftId))) errors.push(`${context}.draftId references missing draft`);
    if (proposal.draftId) {
      const draft = draftsById.get(String(proposal.draftId));
      if (draft && draft.conversationId !== proposal.conversationId) {
        errors.push(`${context}.draftId must reference a draft in the same conversation`);
      }
    }
    const spec = proposal.spec;
    if (spec && typeof spec === 'object' && !Array.isArray(spec)) {
      validatePrivatePayloadReference(
        spec.privatePayloadRef,
        proposal.conversationId,
        privatePayloadsById,
        `${context}.spec.privatePayloadRef`,
        errors
      );
    }
    sha256(proposal, 'canonicalPayloadHash', context, errors);
    sha256(proposal, 'renderedViewHash', context, errors);
  }
  for (const [index, presentation] of (records.proposal_presentations || []).entries()) {
    const context = `proposal_presentations[${index}]`;
    proposalReference(presentation, proposalVersions, context, errors);
    validateProposalConversation(presentation, proposalsByVersion, context, errors);
    enumField(presentation, 'status', ['active', 'consumed', 'revoked', 'expired'], context, errors);
  }
  for (const [index, attempt] of (records.execution_attempts || []).entries()) {
    const context = `execution_attempts[${index}]`;
    proposalReference(attempt, proposalVersions, context, errors);
    validateProposalConversation(attempt, proposalsByVersion, context, errors);
    enumField(attempt, 'status', ['queued', 'executing', 'succeeded', 'failed_safe', 'outcome_unknown', 'manually_resolved'], context, errors);
    enumField(attempt, 'deliveryMode', ['provider_idempotency', 'correlation_lookup', 'operator_reconciliation_only'], context, errors);
  }
}

function validatePrivatePayloadReference(
  reference: JsonValue | undefined,
  conversationId: JsonValue | undefined,
  payloads: Map<string, JsonRecord>,
  context: string,
  errors: string[]
): void {
  if (typeof reference !== 'string') return;
  const payload = payloads.get(reference);
  if (!payload) {
    errors.push(`${context} references missing private payload`);
  } else if (payload.conversationId !== conversationId) {
    errors.push(`${context} must reference a private payload in the same conversation`);
  }
}

function validateProposalConversation(
  record: JsonRecord,
  proposals: Map<string, JsonRecord>,
  context: string,
  errors: string[]
): void {
  const proposal = proposals.get(`${record.proposalId}#${record.proposalVersion}`);
  if (proposal && proposal.conversationId !== record.conversationId) {
    errors.push(`${context}.conversationId must match proposal version conversation`);
  }
}

function restoredRecord(entity: string, record: JsonRecord): JsonRecord {
  if (entity === 'proposal_presentations') {
    return { ...record, status: 'revoked', restoreDisposition: 'unusable_without_token_material' };
  }
  if (entity === 'execution_attempts' && (record.status === 'queued' || record.status === 'executing')) {
    return { ...record, recoveryBlocked: true, restoreDisposition: 'manual_recovery_required' };
  }
  return record;
}

function proposalReference(record: JsonRecord, versions: Set<string>, context: string, errors: string[]): void {
  const proposalId = required(record, 'proposalId', context, errors);
  const version = integer(record, 'proposalVersion', context, errors, 1);
  if (proposalId && version !== null && !versions.has(`${proposalId}#${version}`)) {
    errors.push(`${context} references missing proposal version ${proposalId}#${version}`);
  }
}

function required(record: JsonRecord, field: string, context: string, errors: string[]): string | null {
  const value = record[field];
  if (typeof value !== 'string' || value.length === 0 || value.length > 1_000) {
    errors.push(`${context}.${field} must be a bounded non-empty string`);
    return null;
  }
  return value;
}

function integer(record: JsonRecord, field: string, context: string, errors: string[], minimum: number): number | null {
  const value = record[field];
  if (!Number.isSafeInteger(value) || Number(value) < minimum) {
    errors.push(`${context}.${field} must be an integer >= ${minimum}`);
    return null;
  }
  return Number(value);
}

function timestamp(record: JsonRecord, field: string, context: string, errors: string[]): void {
  const value = record[field];
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) errors.push(`${context}.${field} must be a timestamp`);
}

function enumField(record: JsonRecord, field: string, values: string[], context: string, errors: string[]): void {
  if (typeof record[field] !== 'string' || !values.includes(String(record[field]))) {
    errors.push(`${context}.${field} must be one of: ${values.join(', ')}`);
  }
}

function sha256(record: JsonRecord, field: string, context: string, errors: string[]): void {
  if (typeof record[field] !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(String(record[field]))) {
    errors.push(`${context}.${field} must be a sha256 hash`);
  }
}

function rejectUnsafe(value: JsonValue, path: string, errors: string[]): void {
  if (!value || typeof value !== 'object') {
    if (typeof value === 'string' && /(X-Amz-Signature=|[?&](?:token|password|secret|credential)=)/i.test(value)) {
      errors.push(`${path} contains a signed URL or credential value`);
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => rejectUnsafe(entry, `${path}[${index}]`, errors));
    return;
  }
  for (const [key, entry] of Object.entries(value)) {
    if (/(token|authorization|cookie|credential|password|secret|api[_-]?key|mediaBytes|binary)/i.test(key)) {
      errors.push(`${path}.${key} is forbidden in a conversational export`);
      continue;
    }
    rejectUnsafe(entry, `${path}.${key}`, errors);
  }
}

export {
  CONVERSATIONAL_ENTITY_SPECS,
  restoredRecord,
  validateConversationalEntities,
};
export type { ConversationalEntitySpec };
