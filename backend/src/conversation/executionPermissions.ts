import { createHash } from 'crypto';
import {
  GetCommand,
  PutCommand,
  type DynamoDBDocumentClient,
} from '@aws-sdk/lib-dynamodb';

import { TABLE_CONVERSATIONAL_STATE } from '../db/tableNames';
import { clean } from './executionState';

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

function approvalScopeDigest(resourceKeys: string[]): string {
  const sorted = [...resourceKeys].sort();
  return `sha256:${createHash('sha256').update(JSON.stringify(sorted)).digest('hex')}`;
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

export type { ApprovalPermission, CanonicalTarget };
export {
  approvalScopeDigest,
  getApprovalPermission,
  getCanonicalTarget,
  putApprovalPermission,
  putCanonicalTarget,
};
