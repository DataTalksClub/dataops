import {
  DeleteCommand,
  GetCommand,
  PutCommand,
  TransactWriteCommand,
  UpdateCommand,
  type DynamoDBDocumentClient,
} from '@aws-sdk/lib-dynamodb';

import { TABLE_CONVERSATIONAL_STATE, TABLE_USERS } from '../db/tableNames';
import {
  expiryFrom,
  validateConversationalRecord,
  type ExecutionAttempt,
  type IdentityBinding,
  type PluginDraft,
  type ProposalPresentation,
  type ProposalVersion,
} from './types';
import { attemptItem, clean, versionSk } from './executionState';

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

export type {
  AtomicApprovalInput,
  AtomicPresentationInput,
  AtomicTypefullyRequestChangesInput,
};
export {
  atomicApproval,
  atomicStorePresentedProposal,
  atomicTypefullyRequestChanges,
  getProposalVersion,
  markProposalConflicted,
};
