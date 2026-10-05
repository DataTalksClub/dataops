import {
  GetCommand,
  QueryCommand,
  TransactWriteCommand,
  type DynamoDBDocumentClient,
} from '@aws-sdk/lib-dynamodb';

import { TABLE_CONVERSATIONAL_STATE } from '../db/tableNames';
import {
  isExpired,
  validateConversationalRecord,
  type ExecutionAttempt,
  type ProposalPresentation,
  type ProposalVersion,
} from './types';
import {
  clean,
  putAbsent,
  putTargetAndLinkForLocalTest,
  queryPage,
  relationshipLink,
  storageItem,
  updateState,
  versionSk,
  type Key,
  type Page,
} from './conversationStorage';
import { filterLiveOwners, getConversation, requireConversation } from './conversations';

async function insertProposalVersion(client: DynamoDBDocumentClient, proposal: ProposalVersion): Promise<void> {
  validateConversationalRecord(proposal);
  await requireConversation(client, proposal.conversationId);
  await putAbsent(client, proposal);
}

async function listProposalVersions(
  client: DynamoDBDocumentClient,
  proposalId: string,
  cursor?: Key,
  limit = 50,
  now = new Date()
): Promise<Page<ProposalVersion>> {
  const page = await queryPage<ProposalVersion>(client, {
    KeyConditionExpression: 'PK = :pk AND begins_with(SK, :prefix)',
    ExpressionAttributeValues: { ':pk': `PROPOSAL#${proposalId}`, ':prefix': 'VERSION#' },
  }, cursor, limit);
  page.items = await filterLiveOwners(client, page.items, now);
  return page;
}

async function compareAndSetProposalStatus(
  client: DynamoDBDocumentClient,
  proposalId: string,
  version: number,
  expectedStatus: ProposalVersion['status'],
  status: ProposalVersion['status'],
  updatedAt: string
): Promise<ProposalVersion> {
  return updateState<ProposalVersion>(
    client,
    { PK: `PROPOSAL#${proposalId}`, SK: versionSk(version) },
    expectedStatus,
    status,
    undefined,
    updatedAt
  );
}

async function createPresentation(client: DynamoDBDocumentClient, presentation: ProposalPresentation): Promise<void> {
  validateConversationalRecord(presentation);
  await requireConversation(client, presentation.conversationId);
  const item = storageItem(presentation);
  const link = relationshipLink(presentation.conversationId, presentation.id, item, presentation.expiresAt, presentation.ttl);
  if (process.env.NODE_ENV === 'test') {
    await putTargetAndLinkForLocalTest(client, item, link);
    return;
  }
  await client.send(new TransactWriteCommand({
    TransactItems: [
      {
        Put: {
          TableName: TABLE_CONVERSATIONAL_STATE,
          Item: item,
          ConditionExpression: 'attribute_not_exists(PK)',
        },
      },
      {
        Put: {
          TableName: TABLE_CONVERSATIONAL_STATE,
          Item: link,
          ConditionExpression: 'attribute_not_exists(PK)',
        },
      },
    ],
  }));
}

async function getPresentationByTokenHash(
  client: DynamoDBDocumentClient,
  actionTokenHash: string,
  now = new Date()
): Promise<ProposalPresentation | null> {
  const result = await client.send(new GetCommand({
    TableName: TABLE_CONVERSATIONAL_STATE,
    Key: { PK: `PRESENTATION#${actionTokenHash}`, SK: 'META' },
  }));
  const presentation = clean<ProposalPresentation>(result.Item as Record<string, unknown> | undefined);
  if (!presentation || isExpired(presentation, now)) return null;
  return (await getConversation(client, presentation.conversationId, now)) ? presentation : null;
}

async function compareAndSetPresentation(
  client: DynamoDBDocumentClient,
  actionTokenHash: string,
  expectedStatus: ProposalPresentation['status'],
  status: ProposalPresentation['status'],
  expectedRevision: number,
  updatedAt: string
): Promise<ProposalPresentation> {
  return updateState<ProposalPresentation>(
    client, { PK: `PRESENTATION#${actionTokenHash}`, SK: 'META' },
    expectedStatus, status, expectedRevision, updatedAt
  );
}

async function listProposalRelationships(
  client: DynamoDBDocumentClient,
  proposalId: string,
  version: number,
  cursor?: Key,
  limit = 50,
  now = new Date()
): Promise<Page<ProposalPresentation | ExecutionAttempt>> {
  const page = await queryPage<ProposalPresentation | ExecutionAttempt>(client, {
    IndexName: 'GSI1',
    KeyConditionExpression: 'GSI1PK = :pk',
    ExpressionAttributeValues: { ':pk': `PROPOSAL#${proposalId}#${version}` },
  }, cursor, limit);
  page.items = await filterLiveOwners(client, page.items, now);
  return page;
}

export type { Key, Page };
export {
  compareAndSetPresentation,
  compareAndSetProposalStatus,
  createPresentation,
  getPresentationByTokenHash,
  insertProposalVersion,
  listProposalRelationships,
  listProposalVersions,
};
