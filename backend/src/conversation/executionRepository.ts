import { createHash } from 'crypto';
import {
  DeleteCommand,
  GetCommand,
  PutCommand,
  QueryCommand,
  TransactWriteCommand,
  UpdateCommand,
  type DynamoDBDocumentClient,
} from '@aws-sdk/lib-dynamodb';

import { TABLE_CONVERSATIONAL_STATE, TABLE_USERS } from '../db/setup';
import {
  expiryFrom,
  validateConversationalRecord,
  validateSafeExecutionReceipt,
  type ExecutionAttempt,
  type IdentityBinding,
  type JsonValue,
  type PluginDraft,
  type ProposalPresentation,
  type ProposalVersion,
  type SafeExecutionReceipt,
} from './types';

interface ApprovalPermission {
  userId: string;
  permissionRef: string;
  enabled: boolean;
  revision: number;
  allowedResourceKeys?: string[];
  accountScopeDigest?: string;
  accountConfigDigest?: string;
  deliveryModeDigest?: string;
}

interface CanonicalTarget {
  targetRef: string;
  revision: string;
}

interface DispatchStateGuard {
  kind: 'typefully_public_source';
  conversationId: string;
  actorId: string;
  draftId: string;
  draftRevision: number;
  draftData: JsonValue;
  pluginBuild: string;
  payloads: Array<{ id: string; content: JsonValue }>;
}

interface AtomicApprovalInput {
  presentation: ProposalPresentation;
  proposal: ProposalVersion;
  identity: IdentityBinding;
  channelUserId: string;
  channelConversationKey: string;
  attempt: ExecutionAttempt;
  siblingPresentations?: ProposalPresentation[];
  auditId: string;
  now: string;
}

interface AtomicPresentationInput {
  proposal: ProposalVersion;
  presentation: ProposalPresentation;
  supersededProposals: ProposalVersion[];
  supersededPresentations: ProposalPresentation[];
}

interface AtomicTypefullyRequestChangesInput {
  presentation: ProposalPresentation;
  proposal: ProposalVersion;
  draft: PluginDraft;
  nextDraft: PluginDraft;
  siblingPresentations: ProposalPresentation[];
  now: string;
}

type AttemptStatus = ExecutionAttempt['status'];

function approvalScopeDigest(resourceKeys: string[]): string {
  const sorted = [...resourceKeys].sort();
  return `sha256:${createHash('sha256').update(JSON.stringify(sorted)).digest('hex')}`;
}

function clean<T>(item: Record<string, unknown> | undefined): T | null {
  if (!item) return null;
  const {
    PK: _pk, SK: _sk, GSI1PK: _gsi1pk, GSI1SK: _gsi1sk,
    GSI2PK: _gsi2pk, GSI2SK: _gsi2sk, conversationRelationshipPK: _relationship,
    ...record
  } = item;
  return record as T;
}

function versionSk(version: number): string {
  return `VERSION#${String(version).padStart(12, '0')}`;
}

function recoverySortKey(attempt: ExecutionAttempt): string {
  return `READY#${attempt.readyAt}#LEASE#${attempt.leaseExpiresAt || '-'}#${attempt.id}`;
}

function attemptItem(attempt: ExecutionAttempt): Record<string, unknown> {
  validateConversationalRecord(attempt);
  return {
    ...attempt,
    PK: `ATTEMPT#${attempt.id}`,
    SK: 'META',
    GSI1PK: `PROPOSAL#${attempt.proposalId}#${attempt.proposalVersion}`,
    GSI1SK: `ATTEMPT#${String(attempt.attemptNumber).padStart(8, '0')}#${attempt.id}`,
    GSI2PK: `ATTEMPT_STATE#${attempt.status}`,
    GSI2SK: recoverySortKey(attempt),
    conversationRelationshipPK: `CONVERSATION#${attempt.conversationId}`,
  };
}

async function putApprovalPermission(
  client: DynamoDBDocumentClient,
  permission: ApprovalPermission
): Promise<void> {
  if (
    !permission.userId
    || !permission.permissionRef
    || !Number.isSafeInteger(permission.revision)
    || permission.revision < 1
  ) throw new Error('Approval permission is invalid');
  if (permission.allowedResourceKeys !== undefined) {
    if (
      !Array.isArray(permission.allowedResourceKeys)
      || permission.allowedResourceKeys.length > 2
      || permission.allowedResourceKeys.some(
        (key) => !['typefully:account:alexey', 'typefully:account:datatalksclub'].includes(key)
      )
      || [...new Set(permission.allowedResourceKeys)].sort().join('\0')
        !== permission.allowedResourceKeys.join('\0')
    ) throw new Error('Approval permission resource scope is invalid');
    if (permission.accountScopeDigest !== approvalScopeDigest(permission.allowedResourceKeys)) {
      throw new Error('Approval permission scope digest is invalid');
    }
  } else if (permission.accountScopeDigest !== undefined) {
    throw new Error('Approval permission scope digest requires resource scope');
  }
  for (const digest of [
    permission.accountScopeDigest,
    permission.accountConfigDigest,
    permission.deliveryModeDigest,
  ]) {
    if (digest !== undefined && !/^sha256:[a-f0-9]{64}$/.test(digest)) {
      throw new Error('Approval permission digest is invalid');
    }
  }
  await client.send(new PutCommand({
    TableName: TABLE_CONVERSATIONAL_STATE,
    Item: {
      PK: `AUTHZ#${permission.userId}#${permission.permissionRef}`,
      SK: 'STATE',
      recordType: 'execution_authorization_state',
      ...permission,
    },
    ConditionExpression: 'attribute_not_exists(PK) OR #revision < :revision',
    ExpressionAttributeNames: { '#revision': 'revision' },
    ExpressionAttributeValues: { ':revision': permission.revision },
  }));
}

async function getApprovalPermission(
  client: DynamoDBDocumentClient,
  userId: string,
  permissionRef: string
): Promise<ApprovalPermission | null> {
  const result = await client.send(new GetCommand({
    TableName: TABLE_CONVERSATIONAL_STATE,
    Key: { PK: `AUTHZ#${userId}#${permissionRef}`, SK: 'STATE' },
    ConsistentRead: true,
  }));
  return clean<ApprovalPermission>(result.Item as Record<string, unknown> | undefined);
}

async function putCanonicalTarget(
  client: DynamoDBDocumentClient,
  target: CanonicalTarget
): Promise<void> {
  await client.send(new PutCommand({
    TableName: TABLE_CONVERSATIONAL_STATE,
    Item: {
      PK: `CANONICAL_TARGET#${target.targetRef}`,
      SK: 'REVISION',
      recordType: 'canonical_target_revision',
      ...target,
    },
  }));
}

async function getCanonicalTarget(
  client: DynamoDBDocumentClient,
  targetRef: string
): Promise<CanonicalTarget | null> {
  const result = await client.send(new GetCommand({
    TableName: TABLE_CONVERSATIONAL_STATE,
    Key: { PK: `CANONICAL_TARGET#${targetRef}`, SK: 'REVISION' },
  }));
  return clean<CanonicalTarget>(result.Item as Record<string, unknown> | undefined);
}

async function getProposalVersion(
  client: DynamoDBDocumentClient,
  proposalId: string,
  version: number
): Promise<ProposalVersion | null> {
  const result = await client.send(new GetCommand({
    TableName: TABLE_CONVERSATIONAL_STATE,
    Key: { PK: `PROPOSAL#${proposalId}`, SK: versionSk(version) },
  }));
  return clean<ProposalVersion>(result.Item as Record<string, unknown> | undefined);
}

async function atomicStorePresentedProposal(
  client: DynamoDBDocumentClient,
  input: AtomicPresentationInput
): Promise<void> {
  const { proposal, presentation } = input;
  validateConversationalRecord(proposal);
  validateConversationalRecord(presentation);
  const proposalItem = {
    ...proposal,
    PK: `PROPOSAL#${proposal.proposalId}`,
    SK: versionSk(proposal.version),
    GSI1PK: `CONVERSATION#${proposal.conversationId}`,
    GSI1SK: `PROPOSAL#${proposal.proposalId}#${versionSk(proposal.version)}`,
  };
  const presentationItem = {
    ...presentation,
    PK: `PRESENTATION#${presentation.actionTokenHash}`,
    SK: 'META',
    GSI1PK: `PROPOSAL#${presentation.proposalId}#${presentation.proposalVersion}`,
    GSI1SK: `PRESENTATION#${presentation.createdAt}#${presentation.id}`,
    conversationRelationshipPK: `CONVERSATION#${presentation.conversationId}`,
  };
  const link = {
    PK: `CONVERSATION#${presentation.conversationId}`,
    SK: `RELATIONSHIP#proposal_presentation#${presentation.id}`,
    GSI1PK: `CONVERSATION#${presentation.conversationId}`,
    GSI1SK: `RELATIONSHIP#proposal_presentation#${presentation.id}`,
    recordType: 'conversation_relationship_link',
    conversationId: presentation.conversationId,
    targetPK: presentationItem.PK,
    targetSK: presentationItem.SK,
    expiresAt: presentation.expiresAt,
    ttl: presentation.ttl,
  };
  const writes: NonNullable<ConstructorParameters<typeof TransactWriteCommand>[0]['TransactItems']> = [
    { Put: { TableName: TABLE_CONVERSATIONAL_STATE, Item: proposalItem, ConditionExpression: 'attribute_not_exists(PK)' } },
    { Put: { TableName: TABLE_CONVERSATIONAL_STATE, Item: presentationItem, ConditionExpression: 'attribute_not_exists(PK)' } },
    { Put: { TableName: TABLE_CONVERSATIONAL_STATE, Item: link, ConditionExpression: 'attribute_not_exists(PK)' } },
  ];
  for (const older of input.supersededProposals) {
    if (older.status !== 'presented') continue;
    writes.push({
      Update: {
        TableName: TABLE_CONVERSATIONAL_STATE,
        Key: { PK: `PROPOSAL#${older.proposalId}`, SK: versionSk(older.version) },
        UpdateExpression: 'SET #status = :superseded, updatedAt = :now, revision = revision + :one',
        ConditionExpression: '#status = :presented AND revision = :revision',
        ExpressionAttributeNames: { '#status': 'status' },
        ExpressionAttributeValues: {
          ':superseded': 'superseded', ':presented': 'presented',
          ':revision': older.revision, ':now': proposal.createdAt, ':one': 1,
        },
      },
    });
  }
  for (const older of input.supersededPresentations) {
    if (older.status !== 'active') continue;
    writes.push({
      Update: {
        TableName: TABLE_CONVERSATIONAL_STATE,
        Key: { PK: `PRESENTATION#${older.actionTokenHash}`, SK: 'META' },
        UpdateExpression: 'SET #status = :revoked, updatedAt = :now, revision = revision + :one',
        ConditionExpression: '#status = :active AND revision = :revision',
        ExpressionAttributeNames: { '#status': 'status' },
        ExpressionAttributeValues: {
          ':revoked': 'revoked', ':active': 'active',
          ':revision': older.revision, ':now': proposal.createdAt, ':one': 1,
        },
      },
    });
  }
  if (writes.length > 50) throw new Error('Too many proposal controls to supersede atomically');
  if (process.env.NODE_ENV !== 'test') {
    await client.send(new TransactWriteCommand({ TransactItems: writes }));
    return;
  }
  await client.send(new PutCommand({
    TableName: TABLE_CONVERSATIONAL_STATE,
    Item: proposalItem,
    ConditionExpression: 'attribute_not_exists(PK)',
  }));
  await client.send(new PutCommand({
    TableName: TABLE_CONVERSATIONAL_STATE,
    Item: presentationItem,
    ConditionExpression: 'attribute_not_exists(PK)',
  }));
  await client.send(new PutCommand({
    TableName: TABLE_CONVERSATIONAL_STATE,
    Item: link,
    ConditionExpression: 'attribute_not_exists(PK)',
  }));
  for (const write of writes.slice(3)) {
    if (write.Update) await client.send(new UpdateCommand(write.Update));
  }
}

async function atomicTypefullyRequestChanges(
  client: DynamoDBDocumentClient,
  input: AtomicTypefullyRequestChangesInput
): Promise<void> {
  const { presentation, proposal, draft, nextDraft, now } = input;
  validateConversationalRecord(nextDraft);
  if (
    presentation.status !== 'active'
    || proposal.status !== 'presented'
    || draft.status !== 'ready'
    || presentation.proposalId !== proposal.proposalId
    || presentation.proposalVersion !== proposal.version
    || proposal.draftId !== draft.id
    || draft.id !== nextDraft.id
    || nextDraft.revision !== draft.revision + 1
  ) throw new Error('typefully_request_changes_not_current');
  const siblings = input.siblingPresentations.filter((sibling) => sibling.status === 'active');
  const boundIds = proposal.presentationIds || [];
  if (
    boundIds.length < 1
    || boundIds.length > 8
    || siblings.length !== boundIds.length
    || new Set(siblings.map((sibling) => sibling.id)).size !== siblings.length
    || !boundIds.every((id) => siblings.some((sibling) => sibling.id === id))
    || !siblings.some((sibling) => sibling.actionTokenHash === presentation.actionTokenHash)
    || siblings.some((sibling) => (
      sibling.proposalId !== proposal.proposalId
      || sibling.proposalVersion !== proposal.version
      || sibling.actorId !== proposal.actorId
      || sibling.conversationId !== proposal.conversationId
    ))
  ) {
    throw new Error('typefully_request_changes_presentation_missing');
  }
  const writes: NonNullable<
    ConstructorParameters<typeof TransactWriteCommand>[0]['TransactItems']
  > = siblings.map((sibling) => ({
    Update: {
      TableName: TABLE_CONVERSATIONAL_STATE,
      Key: { PK: `PRESENTATION#${sibling.actionTokenHash}`, SK: 'META' },
      UpdateExpression: 'SET #status = :revoked, updatedAt = :now, revision = revision + :one',
      ConditionExpression: '#status = :active AND revision = :revision',
      ExpressionAttributeNames: { '#status': 'status' },
      ExpressionAttributeValues: {
        ':revoked': 'revoked',
        ':active': 'active',
        ':revision': sibling.revision,
        ':now': now,
        ':one': 1,
      },
    },
  }));
  writes.push(
    {
      Update: {
        TableName: TABLE_CONVERSATIONAL_STATE,
        Key: { PK: `PROPOSAL#${proposal.proposalId}`, SK: versionSk(proposal.version) },
        UpdateExpression: 'SET #status = :superseded, updatedAt = :now, revision = revision + :one',
        ConditionExpression: '#status = :presented AND revision = :revision',
        ExpressionAttributeNames: { '#status': 'status' },
        ExpressionAttributeValues: {
          ':superseded': 'superseded',
          ':presented': 'presented',
          ':revision': proposal.revision,
          ':now': now,
          ':one': 1,
        },
      },
    },
    {
      Put: {
        TableName: TABLE_CONVERSATIONAL_STATE,
        Item: {
          ...nextDraft,
          PK: `CONVERSATION#${nextDraft.conversationId}`,
          SK: `DRAFT#${nextDraft.id}`,
          GSI1PK: `CONVERSATION#${nextDraft.conversationId}`,
          GSI1SK: `DRAFT#${nextDraft.updatedAt}#${nextDraft.id}`,
        },
        ConditionExpression: 'revision = :revision AND #status = :ready AND pluginId = :pluginId AND pluginBuild = :pluginBuild',
        ExpressionAttributeNames: { '#status': 'status' },
        ExpressionAttributeValues: {
          ':revision': draft.revision,
          ':ready': 'ready',
          ':pluginId': 'typefully',
          ':pluginBuild': draft.pluginBuild,
        },
      },
    }
  );
  if (writes.length > 50) throw new Error('too_many_typefully_presentations');
  await client.send(new TransactWriteCommand({ TransactItems: writes }));
}

async function atomicApproval(
  client: DynamoDBDocumentClient,
  input: AtomicApprovalInput
): Promise<void> {
  const { presentation, proposal, identity, attempt, now } = input;
  const retention = expiryFrom(now, 365);
  const audit = {
    PK: `AUDIT#execution_attempt#${attempt.id}`,
    SK: `${now}#${input.auditId}`,
    GSI1PK: `CONVERSATION#${attempt.conversationId}`,
    GSI1SK: `AUDIT#${now}#${input.auditId}`,
    id: input.auditId,
    recordType: 'conversation_audit_event',
    schemaVersion: 1,
    conversationId: attempt.conversationId,
    subjectType: 'execution_attempt',
    subjectId: attempt.id,
    action: 'approval_claimed',
    actorId: presentation.actorId,
    payloadHash: proposal.canonicalPayloadHash,
    outcome: 'queued',
    createdAt: now,
    updatedAt: now,
    ...retention,
  };
  const transaction: ConstructorParameters<typeof TransactWriteCommand>[0]['TransactItems'] = [
    {
      ConditionCheck: {
        TableName: TABLE_USERS,
        Key: { PK: `USER#${presentation.actorId}`, SK: `USER#${presentation.actorId}` },
        ConditionExpression: 'attribute_exists(PK) AND (attribute_not_exists(disabled) OR disabled = :false) AND #role IN (:admin, :operator)',
        ExpressionAttributeNames: { '#role': 'role' },
        ExpressionAttributeValues: {
          ':false': false,
          ':admin': 'admin',
          ':operator': 'operator',
        },
      },
    },
    {
      ConditionCheck: {
        TableName: TABLE_CONVERSATIONAL_STATE,
        Key: { PK: `IDENTITY#${identity.channel}#${input.channelUserId}`, SK: 'META' },
        ConditionExpression: '#status = :active AND userId = :actor AND revision = :identityRevision AND id = :identityId',
        ExpressionAttributeNames: { '#status': 'status' },
        ExpressionAttributeValues: {
          ':active': 'active',
          ':actor': presentation.actorId,
          ':identityRevision': identity.revision,
          ':identityId': identity.id,
        },
      },
    },
    {
      ConditionCheck: {
        TableName: TABLE_CONVERSATIONAL_STATE,
        Key: { PK: `AUTHZ#${presentation.actorId}#${proposal.spec.permissionRef}`, SK: 'STATE' },
        ConditionExpression: [
          'enabled = :true',
          'revision = :revision',
          ...(proposal.spec.resourceKey ? ['contains(allowedResourceKeys, :resourceKey)'] : []),
          ...(proposal.spec.accountScopeDigest ? ['accountScopeDigest = :accountScopeDigest'] : []),
          ...(proposal.spec.accountConfigDigest ? ['accountConfigDigest = :accountConfigDigest'] : []),
          ...(proposal.spec.deliveryModeDigest ? ['deliveryModeDigest = :deliveryModeDigest'] : []),
        ].join(' AND '),
        ExpressionAttributeValues: {
          ':true': true,
          ':revision': attempt.permissionRevision,
          ...(proposal.spec.resourceKey ? { ':resourceKey': proposal.spec.resourceKey } : {}),
          ...(proposal.spec.accountScopeDigest
            ? { ':accountScopeDigest': proposal.spec.accountScopeDigest }
            : {}),
          ...(proposal.spec.accountConfigDigest
            ? { ':accountConfigDigest': proposal.spec.accountConfigDigest }
            : {}),
          ...(proposal.spec.deliveryModeDigest
            ? { ':deliveryModeDigest': proposal.spec.deliveryModeDigest }
            : {}),
        },
      },
    },
    {
      ConditionCheck: {
        TableName: TABLE_CONVERSATIONAL_STATE,
        Key: { PK: `CONVERSATION#${proposal.conversationId}`, SK: 'META' },
        ConditionExpression: '#status = :active AND ownerUserId = :actor',
        ExpressionAttributeNames: { '#status': 'status' },
        ExpressionAttributeValues: { ':active': 'active', ':actor': presentation.actorId },
      },
    },
    {
      ConditionCheck: {
        TableName: TABLE_CONVERSATIONAL_STATE,
        Key: { PK: `CHANNEL#${presentation.channel}#${input.channelConversationKey}`, SK: 'BINDING' },
        ConditionExpression: 'id = :channelBindingId AND conversationId = :conversationId AND ownerUserId = :actor',
        ExpressionAttributeValues: {
          ':channelBindingId': presentation.channelBindingId,
          ':conversationId': proposal.conversationId,
          ':actor': presentation.actorId,
        },
      },
    },
  ];
  if (proposal.spec.targetRef && proposal.spec.baseRevision) {
    transaction.push({
      ConditionCheck: {
        TableName: TABLE_CONVERSATIONAL_STATE,
        Key: { PK: `CANONICAL_TARGET#${proposal.spec.targetRef}`, SK: 'REVISION' },
        ConditionExpression: 'revision = :baseRevision',
        ExpressionAttributeValues: { ':baseRevision': proposal.spec.baseRevision },
      },
    });
  }
  transaction.push(
    {
      Update: {
        TableName: TABLE_CONVERSATIONAL_STATE,
        Key: { PK: `PRESENTATION#${presentation.actionTokenHash}`, SK: 'META' },
        UpdateExpression: 'SET #status = :consumed, updatedAt = :now, revision = revision + :one',
        ConditionExpression: '#status = :active AND revision = :revision AND actionExpiresAt > :now AND renderedViewHash = :viewHash AND identityBindingId = :identityId AND channelBindingId = :channelBindingId AND channelConversationKey = :channelKey AND actorId = :actor AND channel = :channel',
        ExpressionAttributeNames: { '#status': 'status' },
        ExpressionAttributeValues: {
          ':consumed': 'consumed',
          ':active': 'active',
          ':revision': presentation.revision,
          ':now': now,
          ':one': 1,
          ':viewHash': proposal.renderedViewHash,
          ':identityId': presentation.identityBindingId,
          ':channelBindingId': presentation.channelBindingId,
          ':channelKey': input.channelConversationKey,
          ':actor': presentation.actorId,
          ':channel': presentation.channel,
        },
      },
    },
    {
      Update: {
        TableName: TABLE_CONVERSATIONAL_STATE,
        Key: { PK: `PROPOSAL#${proposal.proposalId}`, SK: versionSk(proposal.version) },
        UpdateExpression: 'SET #status = :claimed, updatedAt = :now, revision = revision + :one',
        ConditionExpression: '#status = :presented AND revision = :revision AND canonicalPayloadHash = :payloadHash AND renderedViewHash = :viewHash AND spec.#pluginBuildDigest = :buildDigest AND spec.#schemaDigest = :schemaDigest AND spec.#policyDigest = :policyDigest AND spec.#permissionRef = :permissionRef AND spec.#expiresAt = :specExpiresAt',
        ExpressionAttributeNames: {
          '#status': 'status',
          '#pluginBuildDigest': 'pluginBuildDigest',
          '#schemaDigest': 'schemaDigest',
          '#policyDigest': 'policyDigest',
          '#permissionRef': 'permissionRef',
          '#expiresAt': 'expiresAt',
        },
        ExpressionAttributeValues: {
          ':claimed': 'claimed',
          ':presented': 'presented',
          ':revision': proposal.revision,
          ':now': now,
          ':one': 1,
          ':payloadHash': proposal.canonicalPayloadHash,
          ':viewHash': proposal.renderedViewHash,
          ':buildDigest': proposal.spec.pluginBuildDigest,
          ':schemaDigest': proposal.spec.schemaDigest,
          ':policyDigest': proposal.spec.policyDigest,
          ':permissionRef': proposal.spec.permissionRef,
          ':specExpiresAt': proposal.spec.expiresAt,
        },
      },
    },
    {
      Put: {
        TableName: TABLE_CONVERSATIONAL_STATE,
        Item: attemptItem(attempt),
        ConditionExpression: 'attribute_not_exists(PK)',
      },
    },
    {
      Put: {
        TableName: TABLE_CONVERSATIONAL_STATE,
        Item: audit,
        ConditionExpression: 'attribute_not_exists(PK)',
      },
    },
    {
      Put: {
        TableName: TABLE_CONVERSATIONAL_STATE,
        Item: {
          PK: `CONVERSATION#${attempt.conversationId}`,
          SK: `RELATIONSHIP#execution_attempt#${attempt.id}`,
          GSI1PK: `CONVERSATION#${attempt.conversationId}`,
          GSI1SK: `RELATIONSHIP#execution_attempt#${attempt.id}`,
          recordType: 'conversation_relationship_link',
          conversationId: attempt.conversationId,
          targetPK: `ATTEMPT#${attempt.id}`,
          targetSK: 'META',
          expiresAt: attempt.expiresAt,
          ttl: attempt.ttl,
        },
        ConditionExpression: 'attribute_not_exists(PK)',
      },
    }
  );
  for (const sibling of input.siblingPresentations || []) {
    if (sibling.actionTokenHash === presentation.actionTokenHash || sibling.status !== 'active') continue;
    transaction.push({
      Update: {
        TableName: TABLE_CONVERSATIONAL_STATE,
        Key: { PK: `PRESENTATION#${sibling.actionTokenHash}`, SK: 'META' },
        UpdateExpression: 'SET #status = :revoked, updatedAt = :now, revision = revision + :one',
        ConditionExpression: '#status = :active AND revision = :revision AND proposalId = :proposalId AND proposalVersion = :proposalVersion AND renderedViewHash = :viewHash',
        ExpressionAttributeNames: { '#status': 'status' },
        ExpressionAttributeValues: {
          ':revoked': 'revoked', ':active': 'active', ':revision': sibling.revision,
          ':proposalId': proposal.proposalId, ':proposalVersion': proposal.version,
          ':viewHash': proposal.renderedViewHash, ':now': now, ':one': 1,
        },
      },
    });
  }
  if (process.env.NODE_ENV === 'test') {
    let attemptWritten = false;
    try {
      await client.send(new PutCommand({
        TableName: TABLE_CONVERSATIONAL_STATE,
        Item: attemptItem(attempt),
        ConditionExpression: 'attribute_not_exists(PK)',
      }));
      attemptWritten = true;
      await client.send(new UpdateCommand({
        TableName: TABLE_CONVERSATIONAL_STATE,
        Key: { PK: `PRESENTATION#${presentation.actionTokenHash}`, SK: 'META' },
        UpdateExpression: 'SET #status = :consumed, updatedAt = :now, revision = revision + :one',
        ConditionExpression: '#status = :active AND revision = :revision AND actionExpiresAt > :now AND renderedViewHash = :viewHash',
        ExpressionAttributeNames: { '#status': 'status' },
        ExpressionAttributeValues: {
          ':consumed': 'consumed', ':active': 'active', ':revision': presentation.revision,
          ':now': now, ':one': 1, ':viewHash': proposal.renderedViewHash,
        },
      }));
      for (const sibling of input.siblingPresentations || []) {
        if (sibling.actionTokenHash === presentation.actionTokenHash || sibling.status !== 'active') continue;
        await client.send(new UpdateCommand({
          TableName: TABLE_CONVERSATIONAL_STATE,
          Key: { PK: `PRESENTATION#${sibling.actionTokenHash}`, SK: 'META' },
          UpdateExpression: 'SET #status = :revoked, updatedAt = :now, revision = revision + :one',
          ConditionExpression: '#status = :active AND revision = :revision',
          ExpressionAttributeNames: { '#status': 'status' },
          ExpressionAttributeValues: {
            ':revoked': 'revoked', ':active': 'active', ':revision': sibling.revision,
            ':now': now, ':one': 1,
          },
        }));
      }
      await client.send(new UpdateCommand({
        TableName: TABLE_CONVERSATIONAL_STATE,
        Key: { PK: `PROPOSAL#${proposal.proposalId}`, SK: versionSk(proposal.version) },
        UpdateExpression: 'SET #status = :claimed, updatedAt = :now, revision = revision + :one',
        ConditionExpression: '#status = :presented AND revision = :revision AND canonicalPayloadHash = :payloadHash AND renderedViewHash = :viewHash',
        ExpressionAttributeNames: { '#status': 'status' },
        ExpressionAttributeValues: {
          ':claimed': 'claimed', ':presented': 'presented', ':revision': proposal.revision,
          ':now': now, ':one': 1, ':payloadHash': proposal.canonicalPayloadHash,
          ':viewHash': proposal.renderedViewHash,
        },
      }));
      await client.send(new PutCommand({
        TableName: TABLE_CONVERSATIONAL_STATE,
        Item: audit,
        ConditionExpression: 'attribute_not_exists(PK)',
      }));
      await client.send(new PutCommand({
        TableName: TABLE_CONVERSATIONAL_STATE,
        Item: {
          PK: `CONVERSATION#${attempt.conversationId}`,
          SK: `RELATIONSHIP#execution_attempt#${attempt.id}`,
          GSI1PK: `CONVERSATION#${attempt.conversationId}`,
          GSI1SK: `RELATIONSHIP#execution_attempt#${attempt.id}`,
          recordType: 'conversation_relationship_link',
          conversationId: attempt.conversationId,
          targetPK: `ATTEMPT#${attempt.id}`,
          targetSK: 'META',
          expiresAt: attempt.expiresAt,
          ttl: attempt.ttl,
        },
        ConditionExpression: 'attribute_not_exists(PK)',
      }));
      return;
    } catch (error) {
      if (attemptWritten) {
        const stored = await getProposalVersion(client, proposal.proposalId, proposal.version);
        if (stored?.status !== 'claimed') {
          await client.send(new DeleteCommand({
            TableName: TABLE_CONVERSATIONAL_STATE,
            Key: { PK: `ATTEMPT#${attempt.id}`, SK: 'META' },
          }));
        }
      }
      const name = (error as { name?: string }).name;
      if (name === 'ConditionalCheckFailedException') {
        throw Object.assign(new Error('approval condition changed'), { name: 'TransactionCanceledException' });
      }
      throw error;
    }
  }
  await client.send(new TransactWriteCommand({ TransactItems: transaction }));
}

async function markProposalConflicted(
  client: DynamoDBDocumentClient,
  proposal: ProposalVersion,
  presentation: ProposalPresentation,
  now: string
): Promise<void> {
  if (process.env.NODE_ENV === 'test') {
    await client.send(new UpdateCommand({
      TableName: TABLE_CONVERSATIONAL_STATE,
      Key: { PK: `PROPOSAL#${proposal.proposalId}`, SK: versionSk(proposal.version) },
      UpdateExpression: 'SET #status = :conflicted, updatedAt = :now, revision = revision + :one',
      ConditionExpression: '#status = :presented AND revision = :revision',
      ExpressionAttributeNames: { '#status': 'status' },
      ExpressionAttributeValues: {
        ':conflicted': 'conflicted', ':presented': 'presented',
        ':revision': proposal.revision, ':now': now, ':one': 1,
      },
    }));
    await client.send(new UpdateCommand({
      TableName: TABLE_CONVERSATIONAL_STATE,
      Key: { PK: `PRESENTATION#${presentation.actionTokenHash}`, SK: 'META' },
      UpdateExpression: 'SET #status = :revoked, updatedAt = :now, revision = revision + :one',
      ConditionExpression: '#status = :active',
      ExpressionAttributeNames: { '#status': 'status' },
      ExpressionAttributeValues: {
        ':revoked': 'revoked', ':active': 'active', ':now': now, ':one': 1,
      },
    }));
    return;
  }
  await client.send(new TransactWriteCommand({
    TransactItems: [
      {
        Update: {
          TableName: TABLE_CONVERSATIONAL_STATE,
          Key: { PK: `PROPOSAL#${proposal.proposalId}`, SK: versionSk(proposal.version) },
          UpdateExpression: 'SET #status = :conflicted, updatedAt = :now, revision = revision + :one',
          ConditionExpression: '#status = :presented AND revision = :revision',
          ExpressionAttributeNames: { '#status': 'status' },
          ExpressionAttributeValues: {
            ':conflicted': 'conflicted', ':presented': 'presented',
            ':revision': proposal.revision, ':now': now, ':one': 1,
          },
        },
      },
      {
        Update: {
          TableName: TABLE_CONVERSATIONAL_STATE,
          Key: { PK: `PRESENTATION#${presentation.actionTokenHash}`, SK: 'META' },
          UpdateExpression: 'SET #status = :revoked, updatedAt = :now, revision = revision + :one',
          ConditionExpression: '#status = :active',
          ExpressionAttributeNames: { '#status': 'status' },
          ExpressionAttributeValues: {
            ':revoked': 'revoked', ':active': 'active', ':now': now, ':one': 1,
          },
        },
      },
    ],
  }));
}

async function claimQueuedAttempt(
  client: DynamoDBDocumentClient,
  attemptId: string,
  leaseOwner: string,
  now: string,
  leaseExpiresAt: string
): Promise<ExecutionAttempt | null> {
  try {
    const result = await client.send(new UpdateCommand({
      TableName: TABLE_CONVERSATIONAL_STATE,
      Key: { PK: `ATTEMPT#${attemptId}`, SK: 'META' },
      UpdateExpression: 'SET #status = :executing, leaseOwner = :owner, leaseExpiresAt = :leaseExpiresAt, leaseGeneration = if_not_exists(leaseGeneration, :zero) + :one, attemptNumber = attemptNumber + :one, revision = revision + :one, updatedAt = :now, readyAt = :leaseExpiresAt, GSI2PK = :state, GSI2SK = :recoverySort REMOVE dispatchStartedAt',
      ConditionExpression: '#status = :queued AND readyAt <= :now',
      ExpressionAttributeNames: { '#status': 'status' },
      ExpressionAttributeValues: {
        ':queued': 'queued', ':executing': 'executing', ':owner': leaseOwner,
        ':leaseExpiresAt': leaseExpiresAt, ':zero': 0, ':one': 1, ':now': now,
        ':state': 'ATTEMPT_STATE#executing',
        ':recoverySort': `READY#${leaseExpiresAt}#LEASE#${leaseExpiresAt}#${attemptId}`,
      },
      ReturnValues: 'ALL_NEW',
    }));
    return clean<ExecutionAttempt>(result.Attributes as Record<string, unknown>);
  } catch (error) {
    if ((error as { name?: string }).name === 'ConditionalCheckFailedException') return null;
    throw error;
  }
}

async function reclaimDispatchedAttempt(
  client: DynamoDBDocumentClient,
  attemptId: string,
  expectedRevision: number,
  leaseOwner: string,
  now: string,
  leaseExpiresAt: string
): Promise<ExecutionAttempt | null> {
  try {
    const result = await client.send(new UpdateCommand({
      TableName: TABLE_CONVERSATIONAL_STATE,
      Key: { PK: `ATTEMPT#${attemptId}`, SK: 'META' },
      UpdateExpression: 'SET leaseOwner = :owner, leaseExpiresAt = :leaseExpiresAt, leaseGeneration = if_not_exists(leaseGeneration, :zero) + :one, attemptNumber = attemptNumber + :one, revision = revision + :one, updatedAt = :now, readyAt = :leaseExpiresAt, GSI2SK = :recoverySort',
      ConditionExpression: '#status = :executing AND revision = :revision AND leaseExpiresAt <= :now AND attribute_exists(dispatchStartedAt)',
      ExpressionAttributeNames: { '#status': 'status' },
      ExpressionAttributeValues: {
        ':executing': 'executing', ':revision': expectedRevision, ':owner': leaseOwner,
        ':leaseExpiresAt': leaseExpiresAt, ':zero': 0, ':one': 1, ':now': now,
        ':recoverySort': `READY#${leaseExpiresAt}#LEASE#${leaseExpiresAt}#${attemptId}`,
      },
      ReturnValues: 'ALL_NEW',
    }));
    return clean<ExecutionAttempt>(result.Attributes as Record<string, unknown>);
  } catch (error) {
    if (
      ['ConditionalCheckFailedException', 'TransactionCanceledException']
        .includes((error as { name?: string }).name || '')
    ) return null;
    throw error;
  }
}

async function markDispatchStarted(
  client: DynamoDBDocumentClient,
  attempt: ExecutionAttempt,
  now: string,
  dispatchGuard?: DispatchStateGuard
): Promise<ExecutionAttempt | null> {
  const update = {
    TableName: TABLE_CONVERSATIONAL_STATE,
    Key: { PK: `ATTEMPT#${attempt.id}`, SK: 'META' },
    UpdateExpression: 'SET dispatchStartedAt = :now, updatedAt = :now, revision = revision + :one',
    ConditionExpression: '#status = :executing AND leaseOwner = :owner AND leaseGeneration = :generation AND leaseExpiresAt > :now AND attribute_not_exists(dispatchStartedAt)',
    ExpressionAttributeNames: { '#status': 'status' },
    ExpressionAttributeValues: {
      ':executing': 'executing', ':owner': attempt.leaseOwner,
      ':generation': attempt.leaseGeneration, ':now': now, ':one': 1,
    },
  };
  try {
    const typefullyAttempt = attempt.permissionRef === 'typefully:create-saved-draft';
    if (
      typefullyAttempt
      && (
        !attempt.permissionRevision
        || !attempt.resourceKey
        || !attempt.accountConfigDigest
        || !attempt.accountScopeDigest
        || !attempt.deliveryModeDigest
        || !attempt.draftRef
        || !attempt.actorId
        || !attempt.identityChannel
        || !attempt.identityChannelUserId
        || !attempt.identityBindingId
        || !attempt.identityBindingRevision
        || !attempt.channelBindingId
        || !attempt.channelConversationKey
        || !dispatchGuard
      )
    ) return null;
    if (
      process.env.NODE_ENV !== 'test'
      && attempt.permissionRef
      && attempt.permissionRevision
      && attempt.resourceKey
      && attempt.accountConfigDigest
      && attempt.accountScopeDigest
      && attempt.deliveryModeDigest
    ) {
      if (
        typefullyAttempt
        && (
          !dispatchGuard
          || dispatchGuard.kind !== 'typefully_public_source'
          || dispatchGuard.conversationId !== attempt.conversationId
          || dispatchGuard.actorId !== attempt.actorId
          || dispatchGuard.draftId !== attempt.draftRef
        )
      ) return null;
      const payloadChecks: NonNullable<
        ConstructorParameters<typeof TransactWriteCommand>[0]['TransactItems']
      > = dispatchGuard
        ? dispatchGuard.payloads.map((payload) => ({
          ConditionCheck: {
            TableName: TABLE_CONVERSATIONAL_STATE,
            Key: { PK: `PRIVATE_PAYLOAD#${payload.id}`, SK: 'META' },
            ConditionExpression: 'conversationId = :conversationId AND classification = :private AND #content = :content AND expiresAt > :now',
            ExpressionAttributeNames: { '#content': 'content' },
            ExpressionAttributeValues: {
              ':conversationId': dispatchGuard.conversationId,
              ':private': 'private',
              ':content': payload.content,
              ':now': now,
            },
          },
        }))
        : [];
      const sourceChecks: NonNullable<
        ConstructorParameters<typeof TransactWriteCommand>[0]['TransactItems']
      > = dispatchGuard ? [
        {
          ConditionCheck: {
            TableName: TABLE_CONVERSATIONAL_STATE,
            Key: {
              PK: `CONVERSATION#${dispatchGuard.conversationId}`,
              SK: `DRAFT#${dispatchGuard.draftId}`,
            },
            ConditionExpression: 'revision = :revision AND pluginId = :pluginId AND pluginBuild = :pluginBuild AND #data = :data AND expiresAt > :now',
            ExpressionAttributeNames: { '#data': 'data' },
            ExpressionAttributeValues: {
              ':revision': dispatchGuard.draftRevision,
              ':pluginId': 'typefully',
              ':pluginBuild': dispatchGuard.pluginBuild,
              ':data': dispatchGuard.draftData,
              ':now': now,
            },
          },
        },
        ...payloadChecks,
        {
          ConditionCheck: {
            TableName: TABLE_CONVERSATIONAL_STATE,
            Key: { PK: `CONVERSATION#${dispatchGuard.conversationId}`, SK: 'META' },
            ConditionExpression: 'ownerUserId = :actor AND #status = :active AND expiresAt > :now',
            ExpressionAttributeNames: { '#status': 'status' },
            ExpressionAttributeValues: {
              ':actor': dispatchGuard.actorId,
              ':active': 'active',
              ':now': now,
            },
          },
        },
      ] : [];
      await client.send(new TransactWriteCommand({
        TransactItems: [
          { Update: update },
          {
            ConditionCheck: {
              TableName: TABLE_CONVERSATIONAL_STATE,
              Key: {
                PK: `AUTHZ#${attempt.actorId}#${attempt.permissionRef}`,
                SK: 'STATE',
              },
              ConditionExpression: 'enabled = :true AND revision = :revision AND contains(allowedResourceKeys, :resourceKey) AND accountConfigDigest = :accountConfigDigest AND accountScopeDigest = :accountScopeDigest AND deliveryModeDigest = :deliveryModeDigest',
              ExpressionAttributeValues: {
                ':true': true,
                ':revision': attempt.permissionRevision,
                ':resourceKey': attempt.resourceKey,
                ':accountConfigDigest': attempt.accountConfigDigest,
                ':accountScopeDigest': attempt.accountScopeDigest,
                ':deliveryModeDigest': attempt.deliveryModeDigest,
              },
            },
          },
          {
            ConditionCheck: {
              TableName: TABLE_CONVERSATIONAL_STATE,
              Key: {
                PK: `PROPOSAL#${attempt.proposalId}`,
                SK: versionSk(attempt.proposalVersion),
              },
              ConditionExpression: 'canonicalPayloadHash = :payloadHash AND renderedViewHash = :viewHash AND actorId = :actor AND conversationId = :conversationId AND draftId = :draftRef AND spec.actorId = :actor AND spec.conversationId = :conversationId AND spec.draftRef = :draftRef AND spec.proposalId = :proposalId AND spec.proposalVersion = :proposalVersion AND spec.#expiresAt > :now',
              ExpressionAttributeNames: { '#expiresAt': 'expiresAt' },
              ExpressionAttributeValues: {
                ':payloadHash': attempt.canonicalPayloadHash,
                ':viewHash': attempt.renderedViewHash,
                ':actor': attempt.actorId,
                ':conversationId': attempt.conversationId,
                ':draftRef': attempt.draftRef,
                ':proposalId': attempt.proposalId,
                ':proposalVersion': attempt.proposalVersion,
                ':now': now,
              },
            },
          },
          {
            ConditionCheck: {
              TableName: TABLE_USERS,
              Key: { PK: `USER#${attempt.actorId}`, SK: `USER#${attempt.actorId}` },
              ConditionExpression: 'attribute_exists(PK) AND (attribute_not_exists(disabled) OR disabled = :false) AND #role IN (:admin, :operator)',
              ExpressionAttributeNames: { '#role': 'role' },
              ExpressionAttributeValues: {
                ':false': false,
                ':admin': 'admin',
                ':operator': 'operator',
              },
            },
          },
          {
            ConditionCheck: {
              TableName: TABLE_CONVERSATIONAL_STATE,
              Key: {
                PK: `IDENTITY#${attempt.identityChannel}#${attempt.identityChannelUserId}`,
                SK: 'META',
              },
              ConditionExpression: '#status = :active AND userId = :actor AND revision = :identityRevision AND id = :identityId',
              ExpressionAttributeNames: { '#status': 'status' },
              ExpressionAttributeValues: {
                ':active': 'active',
                ':actor': attempt.actorId,
                ':identityRevision': attempt.identityBindingRevision,
                ':identityId': attempt.identityBindingId,
              },
            },
          },
          {
            ConditionCheck: {
              TableName: TABLE_CONVERSATIONAL_STATE,
              Key: {
                PK: `CHANNEL#${attempt.identityChannel}#${attempt.channelConversationKey}`,
                SK: 'BINDING',
              },
              ConditionExpression: 'id = :channelBindingId AND conversationId = :conversationId AND ownerUserId = :actor',
              ExpressionAttributeValues: {
                ':channelBindingId': attempt.channelBindingId,
                ':conversationId': attempt.conversationId,
                ':actor': attempt.actorId,
              },
            },
          },
          ...sourceChecks,
        ],
      }));
      const stored = await client.send(new GetCommand({
        TableName: TABLE_CONVERSATIONAL_STATE,
        Key: { PK: `ATTEMPT#${attempt.id}`, SK: 'META' },
        ConsistentRead: true,
      }));
      return clean<ExecutionAttempt>(stored.Item as Record<string, unknown> | undefined);
    }
    const result = await client.send(new UpdateCommand({ ...update, ReturnValues: 'ALL_NEW' }));
    return clean<ExecutionAttempt>(result.Attributes as Record<string, unknown>);
  } catch (error) {
    if (
      ['ConditionalCheckFailedException', 'TransactionCanceledException']
        .includes((error as { name?: string }).name || '')
    ) return null;
    throw error;
  }
}

async function finalizeAttempt(
  client: DynamoDBDocumentClient,
  attempt: ExecutionAttempt,
  status: Extract<AttemptStatus, 'succeeded' | 'failed_safe' | 'outcome_unknown'>,
  now: string,
  values: {
    errorCode?: string;
    receipt?: SafeExecutionReceipt;
    resultNotification?: { privateResult?: JsonValue };
  } = {}
): Promise<ExecutionAttempt | null> {
  const names: Record<string, string> = { '#status': 'status' };
  const expressionValues: Record<string, unknown> = {
    ':executing': 'executing', ':status': status, ':owner': attempt.leaseOwner,
    ':generation': attempt.leaseGeneration, ':revision': attempt.revision, ':now': now, ':one': 1,
    ':blocked': status === 'outcome_unknown',
    ':state': `ATTEMPT_STATE#${status}`,
    ':recoverySort': `READY#${now}#LEASE#-#${attempt.id}`,
  };
  const sets = [
    '#status = :status', 'updatedAt = :now', 'revision = revision + :one',
    'recoveryBlocked = :blocked', 'GSI2PK = :state', 'GSI2SK = :recoverySort',
  ];
  if (values.errorCode) {
    sets.push('errorCode = :errorCode');
    expressionValues[':errorCode'] = values.errorCode;
  }
  if (values.receipt) {
    validateSafeExecutionReceipt(values.receipt);
    sets.push('resultReceipt = :receipt', 'resultReceiptRef = :receiptRef');
    expressionValues[':receipt'] = values.receipt;
    expressionValues[':receiptRef'] = values.receipt.receiptId;
  }
  const update = {
    TableName: TABLE_CONVERSATIONAL_STATE,
      Key: { PK: `ATTEMPT#${attempt.id}`, SK: 'META' },
      UpdateExpression: `SET ${sets.join(', ')} REMOVE leaseOwner, leaseExpiresAt`,
      ConditionExpression: '#status = :executing AND revision = :revision AND leaseOwner = :owner AND leaseGeneration = :generation AND leaseExpiresAt > :now',
      ExpressionAttributeNames: names,
      ExpressionAttributeValues: expressionValues,
      ReturnValues: 'ALL_NEW',
  } as const;
  try {
    if (values.resultNotification) {
      if (
        !attempt.actorId
        || !attempt.identityChannel
        || !attempt.identityChannelUserId
        || !attempt.identityBindingId
        || !attempt.identityBindingRevision
        || !attempt.channelBindingId
        || !attempt.channelConversationKey
      ) throw new Error('Result notification identity is unavailable');
      const retention = expiryFrom(now, 30);
      const payloadId = `execution-result-${attempt.id}`;
      const notificationId = `result-notification-${attempt.id}`;
      const payload = {
        id: payloadId,
        recordType: 'conversational_private_payload' as const,
        schemaVersion: 1,
        createdAt: now,
        updatedAt: now,
        ...retention,
        conversationId: attempt.conversationId,
        classification: 'private' as const,
        content: {
          kind: 'execution_result',
          executionAttemptId: attempt.id,
          status,
          ...(values.resultNotification.privateResult !== undefined
            ? { result: values.resultNotification.privateResult }
            : {}),
        },
      };
      const notification = {
        id: notificationId,
        recordType: 'result_notification' as const,
        schemaVersion: 1,
        createdAt: now,
        updatedAt: now,
        ...retention,
        conversationId: attempt.conversationId,
        executionAttemptId: attempt.id,
        actorId: attempt.actorId,
        channel: attempt.identityChannel,
        channelConversationKey: attempt.channelConversationKey,
        identityChannelUserId: attempt.identityChannelUserId,
        identityBindingId: attempt.identityBindingId,
        identityBindingRevision: attempt.identityBindingRevision,
        channelBindingId: attempt.channelBindingId,
        privatePayloadRef: payloadId,
        status: 'pending' as const,
        readyAt: now,
        revision: 1,
      };
      validateConversationalRecord(payload);
      validateConversationalRecord(notification);
      const payloadItem = {
        ...payload,
        PK: `PRIVATE_PAYLOAD#${payloadId}`,
        SK: 'META',
        GSI1PK: `CONVERSATION#${attempt.conversationId}`,
        GSI1SK: `PRIVATE_PAYLOAD#${payloadId}`,
      };
      const notificationItem = {
        ...notification,
        PK: `RESULT_NOTIFICATION#${notificationId}`,
        SK: 'META',
        GSI1PK: `CONVERSATION#${attempt.conversationId}`,
        GSI1SK: `RESULT_NOTIFICATION#${now}#${notificationId}`,
        GSI2PK: 'RESULT_NOTIFICATION_STATE#pending',
        GSI2SK: `READY#${now}#${notificationId}`,
      };
      if (process.env.NODE_ENV !== 'test') {
        const { ReturnValues: _returnValues, ...transactionUpdate } = update;
        await client.send(new TransactWriteCommand({
          TransactItems: [
            { Update: transactionUpdate },
            {
              Put: {
                TableName: TABLE_CONVERSATIONAL_STATE,
                Item: payloadItem,
                ConditionExpression: 'attribute_not_exists(PK)',
              },
            },
            {
              Put: {
                TableName: TABLE_CONVERSATIONAL_STATE,
                Item: notificationItem,
                ConditionExpression: 'attribute_not_exists(PK)',
              },
            },
          ],
        }));
        const stored = await client.send(new GetCommand({
          TableName: TABLE_CONVERSATIONAL_STATE,
          Key: { PK: `ATTEMPT#${attempt.id}`, SK: 'META' },
          ConsistentRead: true,
        }));
        return clean<ExecutionAttempt>(stored.Item as Record<string, unknown> | undefined);
      }
      const result = await client.send(new UpdateCommand(update));
      await client.send(new PutCommand({
        TableName: TABLE_CONVERSATIONAL_STATE,
        Item: payloadItem,
        ConditionExpression: 'attribute_not_exists(PK)',
      }));
      await client.send(new PutCommand({
        TableName: TABLE_CONVERSATIONAL_STATE,
        Item: notificationItem,
        ConditionExpression: 'attribute_not_exists(PK)',
      }));
      return clean<ExecutionAttempt>(result.Attributes as Record<string, unknown>);
    }
    const result = await client.send(new UpdateCommand(update));
    return clean<ExecutionAttempt>(result.Attributes as Record<string, unknown>);
  } catch (error) {
    if ((error as { name?: string }).name === 'ConditionalCheckFailedException') return null;
    throw error;
  }
}

async function requeueUndispatchedAttempt(
  client: DynamoDBDocumentClient,
  attempt: ExecutionAttempt,
  now: string,
  readyAt = now
): Promise<ExecutionAttempt | null> {
  try {
    const result = await client.send(new UpdateCommand({
      TableName: TABLE_CONVERSATIONAL_STATE,
      Key: { PK: `ATTEMPT#${attempt.id}`, SK: 'META' },
      UpdateExpression: 'SET #status = :queued, readyAt = :readyAt, updatedAt = :now, revision = revision + :one, GSI2PK = :state, GSI2SK = :recoverySort REMOVE leaseOwner, leaseExpiresAt',
      ConditionExpression: '#status = :executing AND revision = :revision AND leaseExpiresAt <= :now AND attribute_not_exists(dispatchStartedAt)',
      ExpressionAttributeNames: { '#status': 'status' },
      ExpressionAttributeValues: {
        ':queued': 'queued', ':executing': 'executing', ':revision': attempt.revision,
        ':now': now, ':one': 1, ':state': 'ATTEMPT_STATE#queued',
        ':recoverySort': `READY#${readyAt}#LEASE#-#${attempt.id}`,
        ':readyAt': readyAt,
      },
      ReturnValues: 'ALL_NEW',
    }));
    return clean<ExecutionAttempt>(result.Attributes as Record<string, unknown>);
  } catch (error) {
    if ((error as { name?: string }).name === 'ConditionalCheckFailedException') return null;
    throw error;
  }
}

async function releaseUndispatchedAttempt(
  client: DynamoDBDocumentClient,
  attempt: ExecutionAttempt,
  now: string,
  readyAt: string
): Promise<ExecutionAttempt | null> {
  if (!attempt.leaseOwner) return null;
  try {
    const result = await client.send(new UpdateCommand({
      TableName: TABLE_CONVERSATIONAL_STATE,
      Key: { PK: `ATTEMPT#${attempt.id}`, SK: 'META' },
      UpdateExpression: 'SET #status = :queued, readyAt = :readyAt, updatedAt = :now, revision = revision + :one, GSI2PK = :state, GSI2SK = :recoverySort REMOVE leaseOwner, leaseExpiresAt',
      ConditionExpression: '#status = :executing AND revision = :revision AND leaseOwner = :owner AND attribute_not_exists(dispatchStartedAt)',
      ExpressionAttributeNames: { '#status': 'status' },
      ExpressionAttributeValues: {
        ':queued': 'queued', ':executing': 'executing', ':revision': attempt.revision,
        ':owner': attempt.leaseOwner, ':now': now, ':one': 1,
        ':state': 'ATTEMPT_STATE#queued',
        ':recoverySort': `READY#${readyAt}#LEASE#-#${attempt.id}`,
        ':readyAt': readyAt,
      },
      ReturnValues: 'ALL_NEW',
    }));
    return clean<ExecutionAttempt>(result.Attributes as Record<string, unknown>);
  } catch (error) {
    if ((error as { name?: string }).name === 'ConditionalCheckFailedException') return null;
    throw error;
  }
}

async function reconcileUnknownAttempt(
  client: DynamoDBDocumentClient,
  attemptId: string,
  expectedRevision: number,
  status: Extract<AttemptStatus, 'succeeded' | 'failed_safe' | 'outcome_unknown'>,
  now: string,
  receipt?: SafeExecutionReceipt
): Promise<ExecutionAttempt | null> {
  const values: Record<string, unknown> = {
    ':unknown': 'outcome_unknown', ':status': status, ':revision': expectedRevision,
    ':now': now, ':one': 1, ':blocked': status === 'outcome_unknown',
    ':state': `ATTEMPT_STATE#${status}`,
    ':sort': `READY#${now}#LEASE#-#${attemptId}`,
  };
  const sets = [
    '#status = :status', 'updatedAt = :now', 'revision = revision + :one',
    'recoveryBlocked = :blocked', 'GSI2PK = :state', 'GSI2SK = :sort',
  ];
  if (receipt) {
    validateSafeExecutionReceipt(receipt);
    sets.push('resultReceipt = :receipt', 'resultReceiptRef = :receiptRef');
    values[':receipt'] = receipt;
    values[':receiptRef'] = receipt.receiptId;
  }
  try {
    const result = await client.send(new UpdateCommand({
      TableName: TABLE_CONVERSATIONAL_STATE,
      Key: { PK: `ATTEMPT#${attemptId}`, SK: 'META' },
      UpdateExpression: `SET ${sets.join(', ')}`,
      ConditionExpression: '#status = :unknown AND revision = :revision',
      ExpressionAttributeNames: { '#status': 'status' },
      ExpressionAttributeValues: values,
      ReturnValues: 'ALL_NEW',
    }));
    return clean<ExecutionAttempt>(result.Attributes as Record<string, unknown>);
  } catch (error) {
    if ((error as { name?: string }).name === 'ConditionalCheckFailedException') return null;
    throw error;
  }
}

async function manuallyResolveAttempt(
  client: DynamoDBDocumentClient,
  attemptId: string,
  expectedRevision: number,
  resolution: NonNullable<ExecutionAttempt['manualResolution']>,
  privateResult?: JsonValue,
  receipt?: SafeExecutionReceipt
): Promise<ExecutionAttempt | null> {
  if (receipt) validateSafeExecutionReceipt(receipt);
  const existing = privateResult === undefined
    ? null
    : clean<ExecutionAttempt>((await client.send(new GetCommand({
      TableName: TABLE_CONVERSATIONAL_STATE,
      Key: { PK: `ATTEMPT#${attemptId}`, SK: 'META' },
      ConsistentRead: true,
    }))).Item as Record<string, unknown> | undefined);
  const sets = [
    '#status = :resolved',
    'manualResolution = :resolution',
    'updatedAt = :now',
    'revision = revision + :one',
    'recoveryBlocked = :true',
    'GSI2PK = :state',
    'GSI2SK = :sort',
  ];
  const values: Record<string, unknown> = {
    ':resolved': 'manually_resolved', ':unknown': 'outcome_unknown',
    ':resolution': resolution, ':now': resolution.resolvedAt, ':one': 1,
    ':revision': expectedRevision, ':true': true,
    ':state': 'ATTEMPT_STATE#manually_resolved',
    ':sort': `READY#${resolution.resolvedAt}#LEASE#-#${attemptId}`,
  };
  if (receipt) {
    sets.push('resultReceipt = :receipt', 'resultReceiptRef = :receiptRef');
    values[':receipt'] = receipt;
    values[':receiptRef'] = receipt.receiptId;
  }
  const update = {
    TableName: TABLE_CONVERSATIONAL_STATE,
    Key: { PK: `ATTEMPT#${attemptId}`, SK: 'META' },
    UpdateExpression: `SET ${sets.join(', ')}`,
    ConditionExpression: '#status = :unknown AND revision = :revision',
    ExpressionAttributeNames: { '#status': 'status' },
    ExpressionAttributeValues: values,
    ReturnValues: 'ALL_NEW',
  } as const;
  try {
    if (privateResult !== undefined) {
      if (
        !existing
        || existing.status !== 'outcome_unknown'
        || existing.revision !== expectedRevision
        || !existing.actorId
        || !existing.identityChannel
        || !existing.identityChannelUserId
        || !existing.identityBindingId
        || !existing.identityBindingRevision
        || !existing.channelBindingId
        || !existing.channelConversationKey
      ) return null;
      const retention = expiryFrom(resolution.resolvedAt, 30);
      const payloadId = `execution-manual-result-${attemptId}`;
      const notificationId = `result-notification-manual-${attemptId}`;
      const payload = {
        id: payloadId,
        recordType: 'conversational_private_payload' as const,
        schemaVersion: 1,
        createdAt: resolution.resolvedAt,
        updatedAt: resolution.resolvedAt,
        ...retention,
        conversationId: existing.conversationId,
        classification: 'private' as const,
        content: {
          kind: 'execution_result',
          executionAttemptId: attemptId,
          status: 'manually_resolved',
          result: privateResult,
        },
      };
      const notification = {
        id: notificationId,
        recordType: 'result_notification' as const,
        schemaVersion: 1,
        createdAt: resolution.resolvedAt,
        updatedAt: resolution.resolvedAt,
        ...retention,
        conversationId: existing.conversationId,
        executionAttemptId: attemptId,
        actorId: existing.actorId,
        channel: existing.identityChannel,
        channelConversationKey: existing.channelConversationKey,
        identityChannelUserId: existing.identityChannelUserId,
        identityBindingId: existing.identityBindingId,
        identityBindingRevision: existing.identityBindingRevision,
        channelBindingId: existing.channelBindingId,
        privatePayloadRef: payloadId,
        status: 'pending' as const,
        readyAt: resolution.resolvedAt,
        revision: 1,
      };
      validateConversationalRecord(payload);
      validateConversationalRecord(notification);
      const payloadItem = {
        ...payload,
        PK: `PRIVATE_PAYLOAD#${payloadId}`,
        SK: 'META',
        GSI1PK: `CONVERSATION#${existing.conversationId}`,
        GSI1SK: `PRIVATE_PAYLOAD#${payloadId}`,
      };
      const notificationItem = {
        ...notification,
        PK: `RESULT_NOTIFICATION#${notificationId}`,
        SK: 'META',
        GSI1PK: `CONVERSATION#${existing.conversationId}`,
        GSI1SK: `RESULT_NOTIFICATION#${resolution.resolvedAt}#${notificationId}`,
        GSI2PK: 'RESULT_NOTIFICATION_STATE#pending',
        GSI2SK: `READY#${resolution.resolvedAt}#${notificationId}`,
      };
      if (process.env.NODE_ENV !== 'test') {
        const { ReturnValues: _returnValues, ...transactionUpdate } = update;
        await client.send(new TransactWriteCommand({
          TransactItems: [
            { Update: transactionUpdate },
            {
              Put: {
                TableName: TABLE_CONVERSATIONAL_STATE,
                Item: payloadItem,
                ConditionExpression: 'attribute_not_exists(PK)',
              },
            },
            {
              Put: {
                TableName: TABLE_CONVERSATIONAL_STATE,
                Item: notificationItem,
                ConditionExpression: 'attribute_not_exists(PK)',
              },
            },
          ],
        }));
        const stored = await client.send(new GetCommand({
          TableName: TABLE_CONVERSATIONAL_STATE,
          Key: { PK: `ATTEMPT#${attemptId}`, SK: 'META' },
          ConsistentRead: true,
        }));
        return clean<ExecutionAttempt>(stored.Item as Record<string, unknown> | undefined);
      }
      const result = await client.send(new UpdateCommand(update));
      await client.send(new PutCommand({
        TableName: TABLE_CONVERSATIONAL_STATE,
        Item: payloadItem,
        ConditionExpression: 'attribute_not_exists(PK)',
      }));
      await client.send(new PutCommand({
        TableName: TABLE_CONVERSATIONAL_STATE,
        Item: notificationItem,
        ConditionExpression: 'attribute_not_exists(PK)',
      }));
      return clean<ExecutionAttempt>(result.Attributes as Record<string, unknown>);
    }
    const result = await client.send(new UpdateCommand(update));
    return clean<ExecutionAttempt>(result.Attributes as Record<string, unknown>);
  } catch (error) {
    if (
      ['ConditionalCheckFailedException', 'TransactionCanceledException']
        .includes((error as { name?: string }).name || '')
    ) return null;
    throw error;
  }
}

async function queryDueAttempts(
  client: DynamoDBDocumentClient,
  status: 'queued' | 'executing',
  through: string,
  limit = 50
): Promise<ExecutionAttempt[]> {
  const result = await client.send(new QueryCommand({
    TableName: TABLE_CONVERSATIONAL_STATE,
    IndexName: 'GSI2',
    KeyConditionExpression: 'GSI2PK = :state AND GSI2SK <= :through',
    ExpressionAttributeValues: {
      ':state': `ATTEMPT_STATE#${status}`,
      ':through': `READY#${through}#\uffff`,
    },
    Limit: Math.min(Math.max(limit, 1), 100),
  }));
  return ((result.Items || []) as Record<string, unknown>[]).map((item) => clean<ExecutionAttempt>(item)!);
}

export {
  approvalScopeDigest,
  atomicStorePresentedProposal,
  atomicTypefullyRequestChanges,
  atomicApproval,
  claimQueuedAttempt,
  finalizeAttempt,
  getApprovalPermission,
  getCanonicalTarget,
  getProposalVersion,
  manuallyResolveAttempt,
  markDispatchStarted,
  markProposalConflicted,
  putApprovalPermission,
  putCanonicalTarget,
  queryDueAttempts,
  reclaimDispatchedAttempt,
  reconcileUnknownAttempt,
  releaseUndispatchedAttempt,
  requeueUndispatchedAttempt,
};
export type {
  ApprovalPermission,
  AtomicApprovalInput,
  AtomicPresentationInput,
  AtomicTypefullyRequestChangesInput,
  CanonicalTarget,
  DispatchStateGuard,
};
