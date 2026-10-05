import { randomUUID } from 'crypto';
import { TransactWriteCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { TABLE_SPONSOR_CRM, TABLE_USERS } from '../db/tableNames';
import { suppressionKey, type HmacKeyring, type SendConfig } from './core';
import { getSponsorItem, itemKey, nowIso } from './repository';

export async function getCurrentConfig(client: DynamoDBDocumentClient): Promise<SendConfig | null> {
  const item = await getSponsorItem<Record<string, unknown>>(client, 'SPONSOR_SEND_CONFIG', 'CURRENT');
  if (!item) return null;
  return {
    enabled: item.enabled === true,
    generation: Number(item.generation),
    templateSetGeneration: String(item.templateSetGeneration),
    templateSetDigest: String(item.templateSetDigest),
    hmacSecretVersionId: String(item.hmacSecretVersionId),
    hmacActiveVersion: String(item.hmacActiveVersion),
    hmacAcceptedVersions: Array.isArray(item.hmacAcceptedVersions) ? item.hmacAcceptedVersions.map(String) : [],
    hmacKeyringDigest: String(item.hmacKeyringDigest),
    sesAccount: String(item.sesAccount),
    sesRegion: String(item.sesRegion),
    sesIdentityArn: String(item.sesIdentityArn),
    from: String(item.from),
    ...(typeof item.replyTo === 'string' ? { replyTo: item.replyTo } : {}),
    configurationSet: String(item.configurationSet),
    configurationSetGeneration: String(item.configurationSetGeneration),
    approverPolicyVersion: String(item.approverPolicyVersion),
    digest: String(item.digest),
  };
}

export async function putConfig(client: DynamoDBDocumentClient, config: SendConfig, actorId: string): Promise<void> {
  const existing = await getCurrentConfig(client);
  if (config.enabled) await assertSuppressionCoverage(client, config.hmacAcceptedVersions, config.hmacActiveVersion);
  await client.send(new TransactWriteCommand({
    TransactItems: [
      {
        Put: {
          TableName: TABLE_SPONSOR_CRM,
          Item: { ...itemKey('SPONSOR_SEND_CONFIG', 'CURRENT'), ...config, recordType: 'sponsor-send-config', updatedAt: nowIso(), updatedBy: actorId },
          ConditionExpression: existing ? 'generation = :previous' : 'attribute_not_exists(PK)',
          ...(existing ? { ExpressionAttributeValues: { ':previous': existing.generation } } : {}),
        },
      },
      {
        Put: {
          TableName: TABLE_SPONSOR_CRM,
          Item: {
            ...itemKey('SPONSOR_COMM_AUDIT', `${nowIso()}#${randomUUID()}`),
            recordType: 'sponsor-communication-audit',
            action: config.enabled ? 'config-enabled' : 'config-disabled',
            actorId,
            configGeneration: config.generation,
            at: nowIso(),
            ttl: Math.floor(Date.now() / 1000) + 365 * 24 * 60 * 60,
          },
        },
      },
    ],
  }));
}

export async function assertSuppressionCoverage(
  client: DynamoDBDocumentClient,
  acceptedVersions: string[],
  requiredOnlyVersion?: string,
): Promise<void> {
  const coverage = await getSponsorItem<Record<string, unknown>>(client, 'SUPPRESSION_COVERAGE', 'CURRENT');
  const liveVersions = coverage?.liveVersions instanceof Set
    ? [...coverage.liveVersions].map(String)
    : Array.isArray(coverage?.liveVersions) ? coverage.liveVersions.map(String) : [];
  if (liveVersions.some((version) => !acceptedVersions.includes(version))) {
    throw new Error('Live suppression key version is not covered by the configured keyring');
  }
  if (requiredOnlyVersion && liveVersions.some((version) => version !== requiredOnlyVersion)) {
    throw new Error('Suppression rotation must finish before sending is enabled');
  }
  for (const version of liveVersions) {
    const count = await getSponsorItem<Record<string, unknown>>(client, 'SUPPRESSION_VERSION_COUNT', version);
    if (!count || Number(count.liveCount) < 1) throw new Error('Suppression coverage count is inconsistent');
  }
}

export async function removeSuppression(
  client: DynamoDBDocumentClient,
  input: { id: string; revision: number; actorId: string; reason: string; allowProtected: boolean },
): Promise<void> {
  const suppression = await getSponsorItem<Record<string, unknown>>(client, 'EMAIL_SUPPRESSION', input.id);
  if (!suppression || suppression.status !== 'active') throw new Error('Suppression not found');
  const category = String(suppression.category);
  if (category !== 'manual' && !input.allowProtected) throw new Error('Provider suppression requires protected reconciliation');
  const version = String(suppression.keyVersion);
  const count = await getSponsorItem<Record<string, unknown>>(client, 'SUPPRESSION_VERSION_COUNT', version);
  if (!count || Number(count.liveCount) < 1) throw new Error('Suppression count is inconsistent');
  const now = nowIso();
  const countOperation = Number(count.liveCount) === 1 ? {
    Delete: {
      TableName: TABLE_SPONSOR_CRM,
      Key: itemKey('SUPPRESSION_VERSION_COUNT', version),
      ConditionExpression: 'liveCount = :one',
      ExpressionAttributeValues: { ':one': 1 },
    },
  } : {
    Update: {
      TableName: TABLE_SPONSOR_CRM,
      Key: itemKey('SUPPRESSION_VERSION_COUNT', version),
      UpdateExpression: 'ADD liveCount :minusOne SET updatedAt = :now',
      ConditionExpression: 'liveCount > :one',
      ExpressionAttributeValues: { ':minusOne': -1, ':one': 1, ':now': now },
    },
  };
  const coverageOperation = Number(count.liveCount) === 1 ? [{
    Update: {
      TableName: TABLE_SPONSOR_CRM,
      Key: itemKey('SUPPRESSION_COVERAGE', 'CURRENT'),
      UpdateExpression: 'DELETE liveVersions :versions SET updatedAt = :now',
      ExpressionAttributeValues: { ':versions': new Set([version]), ':now': now },
    },
  }] : [];
  await client.send(new TransactWriteCommand({
    TransactItems: [
      {
        ConditionCheck: {
          TableName: TABLE_USERS,
          Key: { PK: `USER#${input.actorId}`, SK: `USER#${input.actorId}` },
          ConditionExpression: 'attribute_exists(PK) AND #role = :admin AND (attribute_not_exists(disabled) OR disabled = :false)',
          ExpressionAttributeNames: { '#role': 'role' },
          ExpressionAttributeValues: { ':admin': 'admin', ':false': false },
        },
      },
      {
        Delete: {
          TableName: TABLE_SPONSOR_CRM,
          Key: itemKey('EMAIL_SUPPRESSION', input.id),
          ConditionExpression: 'revision = :revision AND #status = :active AND category = :category',
          ExpressionAttributeNames: { '#status': 'status' },
          ExpressionAttributeValues: { ':revision': input.revision, ':active': 'active', ':category': category },
        },
      },
      countOperation,
      ...coverageOperation,
      {
        Put: {
          TableName: TABLE_SPONSOR_CRM,
          Item: {
            ...itemKey('SPONSOR_COMM_AUDIT', `${now}#${randomUUID()}`),
            recordType: 'sponsor-communication-audit',
            action: category === 'manual' ? 'manual-suppression-removed' : 'provider-suppression-reconciled',
            actorId: input.actorId,
            suppressionId: input.id,
            safeReason: input.reason.slice(0, 240),
            at: now,
            ttl: Math.floor(Date.parse(now) / 1000) + 365 * 24 * 60 * 60,
          },
        },
      },
    ],
  }));
}

export async function addSuppression(
  client: DynamoDBDocumentClient,
  input: { canonicalAddress: string; contactId: string; organizationId: string; category: 'manual' | 'bounce' | 'complaint'; actorId: string; safeReason: string },
  config: SendConfig,
  keyring: HmacKeyring,
): Promise<{ id: string; version: number }> {
  const version = config.hmacActiveVersion;
  const id = suppressionKey(version, input.canonicalAddress, keyring);
  const now = nowIso();
  try {
    await client.send(new TransactWriteCommand({
      TransactItems: [
        {
          ConditionCheck: {
            TableName: TABLE_USERS,
            Key: { PK: `USER#${input.actorId}`, SK: `USER#${input.actorId}` },
            ConditionExpression: 'attribute_exists(PK) AND (#role = :operator OR #role = :admin) AND (attribute_not_exists(disabled) OR disabled = :false)',
            ExpressionAttributeNames: { '#role': 'role' },
            ExpressionAttributeValues: { ':operator': 'operator', ':admin': 'admin', ':false': false },
          },
        },
        {
          Put: {
            TableName: TABLE_SPONSOR_CRM,
            Item: {
              ...itemKey('EMAIL_SUPPRESSION', id),
              id,
              recordType: 'email-suppression',
              keyVersion: version,
              contactId: input.contactId,
              organizationId: input.organizationId,
              category: input.category,
              status: 'active',
              safeReason: input.safeReason.slice(0, 120),
              revision: 1,
              createdAt: now,
              updatedAt: now,
              GSI1PK: `SUPPRESSION_VERSION#${version}`,
              GSI1SK: id,
            },
            ConditionExpression: 'attribute_not_exists(PK)',
          },
        },
        {
          Update: {
            TableName: TABLE_SPONSOR_CRM,
            Key: itemKey('SUPPRESSION_VERSION_COUNT', version),
            UpdateExpression: 'ADD liveCount :one SET keyVersion = :version, recordType = :recordType, updatedAt = :now',
            ExpressionAttributeValues: { ':one': 1, ':version': version, ':recordType': 'suppression-version-count', ':now': now },
          },
        },
        {
          Update: {
            TableName: TABLE_SPONSOR_CRM,
            Key: itemKey('SUPPRESSION_COVERAGE', 'CURRENT'),
            UpdateExpression: 'ADD liveVersions :versions SET recordType = :recordType, updatedAt = :now',
            ExpressionAttributeValues: { ':versions': new Set([version]), ':recordType': 'suppression-coverage', ':now': now },
          },
        },
        {
          Put: {
            TableName: TABLE_SPONSOR_CRM,
            Item: {
              ...itemKey('SPONSOR_COMM_AUDIT', `suppression-add#${id}`),
              recordType: 'sponsor-communication-audit',
              action: input.category === 'manual' ? 'manual-suppression-added' : 'provider-suppression-added',
              actorId: input.actorId,
              suppressionId: id,
              contactId: input.contactId,
              organizationId: input.organizationId,
              category: input.category,
              safeReason: input.safeReason.slice(0, 120),
              at: now,
              ttl: Math.floor(Date.parse(now) / 1000) + 365 * 24 * 60 * 60,
            },
            ConditionExpression: 'attribute_not_exists(PK)',
          },
        },
      ],
    }));
    return { id, version: 1 };
  } catch (error) {
    const existing = await getSponsorItem<Record<string, unknown>>(client, 'EMAIL_SUPPRESSION', id);
    if (existing?.status === 'active') return { id, version: Number(existing.revision) };
    throw error;
  }
}
