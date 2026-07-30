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
  type ProposalPresentation,
  type ProposalVersion,
  type SafeExecutionReceipt,
} from './types';

interface ApprovalPermission {
  userId: string;
  permissionRef: string;
  enabled: boolean;
  revision: number;
}

interface CanonicalTarget {
  targetRef: string;
  revision: string;
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

type AttemptStatus = ExecutionAttempt['status'];

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
  await client.send(new PutCommand({
    TableName: TABLE_CONVERSATIONAL_STATE,
    Item: {
      PK: `AUTHZ#${permission.userId}#${permission.permissionRef}`,
      SK: 'STATE',
      recordType: 'execution_authorization_state',
      ...permission,
    },
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
        ConditionExpression: 'attribute_exists(PK) AND (attribute_not_exists(disabled) OR disabled = :false)',
        ExpressionAttributeValues: { ':false': false },
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
        ConditionExpression: 'enabled = :true',
        ExpressionAttributeValues: { ':true': true },
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
    if ((error as { name?: string }).name === 'ConditionalCheckFailedException') return null;
    throw error;
  }
}

async function markDispatchStarted(
  client: DynamoDBDocumentClient,
  attempt: ExecutionAttempt,
  now: string
): Promise<ExecutionAttempt | null> {
  try {
    const result = await client.send(new UpdateCommand({
      TableName: TABLE_CONVERSATIONAL_STATE,
      Key: { PK: `ATTEMPT#${attempt.id}`, SK: 'META' },
      UpdateExpression: 'SET dispatchStartedAt = :now, updatedAt = :now, revision = revision + :one',
      ConditionExpression: '#status = :executing AND leaseOwner = :owner AND leaseGeneration = :generation AND leaseExpiresAt > :now AND attribute_not_exists(dispatchStartedAt)',
      ExpressionAttributeNames: { '#status': 'status' },
      ExpressionAttributeValues: {
        ':executing': 'executing', ':owner': attempt.leaseOwner,
        ':generation': attempt.leaseGeneration, ':now': now, ':one': 1,
      },
      ReturnValues: 'ALL_NEW',
    }));
    return clean<ExecutionAttempt>(result.Attributes as Record<string, unknown>);
  } catch (error) {
    if ((error as { name?: string }).name === 'ConditionalCheckFailedException') return null;
    throw error;
  }
}

async function finalizeAttempt(
  client: DynamoDBDocumentClient,
  attempt: ExecutionAttempt,
  status: Extract<AttemptStatus, 'succeeded' | 'failed_safe' | 'outcome_unknown'>,
  now: string,
  values: { errorCode?: string; receipt?: SafeExecutionReceipt } = {}
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
  try {
    const result = await client.send(new UpdateCommand({
      TableName: TABLE_CONVERSATIONAL_STATE,
      Key: { PK: `ATTEMPT#${attempt.id}`, SK: 'META' },
      UpdateExpression: `SET ${sets.join(', ')} REMOVE leaseOwner, leaseExpiresAt`,
      ConditionExpression: '#status = :executing AND revision = :revision AND leaseOwner = :owner AND leaseGeneration = :generation AND leaseExpiresAt > :now',
      ExpressionAttributeNames: names,
      ExpressionAttributeValues: expressionValues,
      ReturnValues: 'ALL_NEW',
    }));
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
  resolution: NonNullable<ExecutionAttempt['manualResolution']>
): Promise<ExecutionAttempt | null> {
  try {
    const result = await client.send(new UpdateCommand({
      TableName: TABLE_CONVERSATIONAL_STATE,
      Key: { PK: `ATTEMPT#${attemptId}`, SK: 'META' },
      UpdateExpression: 'SET #status = :resolved, manualResolution = :resolution, updatedAt = :now, revision = revision + :one, recoveryBlocked = :true, GSI2PK = :state, GSI2SK = :sort',
      ConditionExpression: '#status = :unknown AND revision = :revision',
      ExpressionAttributeNames: { '#status': 'status' },
      ExpressionAttributeValues: {
        ':resolved': 'manually_resolved', ':unknown': 'outcome_unknown',
        ':resolution': resolution, ':now': resolution.resolvedAt, ':one': 1,
        ':revision': expectedRevision, ':true': true,
        ':state': 'ATTEMPT_STATE#manually_resolved',
        ':sort': `READY#${resolution.resolvedAt}#LEASE#-#${attemptId}`,
      },
      ReturnValues: 'ALL_NEW',
    }));
    return clean<ExecutionAttempt>(result.Attributes as Record<string, unknown>);
  } catch (error) {
    if ((error as { name?: string }).name === 'ConditionalCheckFailedException') return null;
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
  atomicStorePresentedProposal,
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
  requeueUndispatchedAttempt,
};
export type { ApprovalPermission, AtomicApprovalInput, AtomicPresentationInput, CanonicalTarget };
