import { randomUUID } from 'crypto';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

import { getUser } from '../db/users';
import {
  getIdentityBinding,
  listIdentityBindingsByChannel,
  transitionIdentityBindingWithAudit,
} from '../conversation/repository';
import { expiryFrom, type IdentityBinding, type IdentityBindingAudit } from '../conversation/types';
import type { LambdaEvent, LambdaResponse } from '../types';

const HEADERS = { 'Content-Type': 'application/json' };
const TELEGRAM_ID = /^[1-9]\d{0,19}$/;

function response(statusCode: number, body: unknown): LambdaResponse {
  return { statusCode, headers: HEADERS, body: JSON.stringify(body) };
}

function header(event: LambdaEvent, name: string): string {
  return String(Object.entries(event.headers || {})
    .find(([key]) => key.toLowerCase() === name.toLowerCase())?.[1] || '');
}

function parseBody(event: LambdaEvent): Record<string, unknown> | null {
  try {
    const value = typeof event.body === 'string' ? JSON.parse(event.body) : event.body;
    return value && typeof value === 'object' && !Array.isArray(value)
      ? value as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

async function requireAdmin(
  client: DynamoDBDocumentClient,
  event: LambdaEvent
): Promise<{ actorId: string } | LambdaResponse> {
  const actorId = header(event, 'x-user-id');
  if (!actorId) return response(401, { error: 'Unauthorized' });
  const actor = await getUser(client, actorId);
  if (!actor || actor.disabled || actor.role !== 'admin') {
    return response(403, { error: 'Admin access required' });
  }
  return { actorId };
}

function publicBinding(binding: IdentityBinding): Record<string, unknown> {
  return {
    id: binding.id,
    userId: binding.userId,
    channel: binding.channel,
    channelUserId: binding.channelUserId,
    status: binding.status,
    provisionedBy: binding.provisionedBy,
    provisionedAt: binding.provisionedAt,
    revokedBy: binding.revokedBy,
    revokedAt: binding.revokedAt,
    revision: binding.revision,
  };
}

function auditRecord(
  binding: IdentityBinding,
  actorId: string,
  action: IdentityBindingAudit['action'],
  now: string
): IdentityBindingAudit {
  return {
    id: randomUUID(),
    recordType: 'identity_binding_audit',
    schemaVersion: 1,
    createdAt: now,
    updatedAt: now,
    ...expiryFrom(now, 365),
    channel: binding.channel,
    channelUserId: binding.channelUserId,
    userId: binding.userId,
    action,
    actorId,
    outcome: 'succeeded',
    bindingRevision: binding.revision,
  };
}

async function handleConversationalIdentityBindingRoutes(
  path: string,
  method: string,
  event: LambdaEvent,
  client: DynamoDBDocumentClient,
  now: () => Date = () => new Date()
): Promise<LambdaResponse | null> {
  if (!path.startsWith('/api/conversational/identity-bindings')) return null;
  const gate = await requireAdmin(client, event);
  if ('statusCode' in gate) return gate;

  if (path === '/api/conversational/identity-bindings' && method === 'GET') {
    const channel = event.queryStringParameters?.channel;
    if (channel !== 'telegram') return response(400, { error: 'channel must be telegram' });
    const bindings = await listIdentityBindingsByChannel(client, channel, 50);
    return response(200, { bindings: bindings.map(publicBinding) });
  }

  if (path === '/api/conversational/identity-bindings' && method === 'POST') {
    const body = parseBody(event);
    const userId = typeof body?.userId === 'string' ? body.userId.trim() : '';
    const channel = body?.channel;
    const channelUserId = typeof body?.channelUserId === 'string' ? body.channelUserId.trim() : '';
    if (!userId || channel !== 'telegram' || !TELEGRAM_ID.test(channelUserId)) {
      return response(400, { error: 'A valid userId and canonical Telegram numeric user ID are required' });
    }
    const user = await getUser(client, userId);
    if (!user) return response(404, { error: 'User not found' });
    if (user.disabled) return response(409, { error: 'Disabled users cannot be linked' });
    const existing = await getIdentityBinding(client, 'telegram', channelUserId);
    if (existing?.status === 'active') {
      if (existing.userId !== userId) return response(409, { error: 'Telegram identity is already linked' });
      return response(200, { binding: publicBinding(existing), duplicate: true });
    }
    if (existing && existing.userId !== userId) {
      return response(409, { error: 'Telegram identity requires explicit conflict resolution' });
    }
    const timestamp = new Date(Math.max(
      now().getTime(),
      existing ? Date.parse(existing.updatedAt) : 0
    )).toISOString();
    let binding: IdentityBinding;
    let action: IdentityBindingAudit['action'];
    try {
      if (existing) {
        binding = {
          ...existing,
          status: 'active',
          provisionedBy: gate.actorId,
          provisionedAt: timestamp,
          updatedAt: timestamp,
          revision: existing.revision + 1,
          revokedBy: undefined,
          revokedAt: undefined,
        };
        action = 'reactivated';
      } else {
        binding = {
          id: randomUUID(),
          recordType: 'identity_binding',
          schemaVersion: 1,
          createdAt: timestamp,
          updatedAt: timestamp,
          userId,
          channel: 'telegram',
          channelUserId,
          status: 'active',
          provisionedBy: gate.actorId,
          provisionedAt: timestamp,
          revision: 1,
        };
        action = 'created';
      }
      await transitionIdentityBindingWithAudit(
        client,
        binding,
        auditRecord(binding, gate.actorId, action, timestamp),
        existing ? { status: 'revoked', revision: existing.revision } : null
      );
      return response(existing ? 200 : 201, { binding: publicBinding(binding) });
    } catch (error) {
      if (['ConditionalCheckFailedException', 'TransactionCanceledException'].includes((error as { name?: string }).name || '')) {
        return response(409, { error: 'Identity binding changed; reload and try again' });
      }
      throw error;
    }
  }

  const revoke = path.match(/^\/api\/conversational\/identity-bindings\/telegram\/([1-9]\d{0,19})\/revoke$/);
  if (revoke && method === 'POST') {
    const existing = await getIdentityBinding(client, 'telegram', revoke[1]);
    if (!existing) return response(404, { error: 'Identity binding not found' });
    if (existing.status === 'revoked') return response(200, { binding: publicBinding(existing), duplicate: true });
    const body = parseBody(event);
    const expectedRevision = Number(body?.revision);
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision !== existing.revision) {
      return response(409, { error: 'Identity binding revision changed' });
    }
    const timestamp = new Date(Math.max(now().getTime(), Date.parse(existing.updatedAt))).toISOString();
    try {
      const binding: IdentityBinding = {
        ...existing,
        status: 'revoked',
        revokedBy: gate.actorId,
        revokedAt: timestamp,
        updatedAt: timestamp,
        revision: existing.revision + 1,
      };
      await transitionIdentityBindingWithAudit(
        client,
        binding,
        auditRecord(binding, gate.actorId, 'revoked', timestamp),
        { status: 'active', revision: expectedRevision }
      );
      return response(200, { binding: publicBinding(binding) });
    } catch (error) {
      if (['ConditionalCheckFailedException', 'TransactionCanceledException'].includes((error as { name?: string }).name || '')) {
        return response(409, { error: 'Identity binding changed; reload and try again' });
      }
      throw error;
    }
  }

  return response(405, { error: 'Method not allowed' });
}

export { handleConversationalIdentityBindingRoutes };
