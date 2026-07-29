import { after, before, describe, it } from 'node:test';
import assert from 'node:assert';
import fs from 'fs/promises';
import path from 'path';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

import { startLocal, stopLocal, getClient } from '../src/db/client';
import { createTables } from '../src/db/setup';
import { createUserWithId } from '../src/db/users';
import {
  appendConversationAuditEvent,
  appendConversationEvent,
  cleanupDeletedConversation,
  compareAndSetExecutionAttempt,
  compareAndSetPresentation,
  createChannelBinding,
  createConversation,
  createExecutionAttempt,
  createIdentityBinding,
  createPresentation,
  getChannelBinding,
  getCheckpoint,
  getConversation,
  getIdentityBinding,
  getPluginDraft,
  getPresentationByTokenHash,
  insertProposalVersion,
  listConversationEvents,
  listIdentityBindings,
  listOwnerConversations,
  listProposalRelationships,
  listProposalVersions,
  listRecoveryCandidates,
  markConversationDeleted,
  putConversationalPrivatePayload,
  revokeIdentityBinding,
  saveCheckpoint,
  savePluginDraft,
} from '../src/conversation/repository';
import {
  expiryFrom,
  validateConversationalRecord,
  type Conversation,
  type ExecutionAttempt,
  type IdentityBinding,
  type PluginDraft,
  type ProposalPresentation,
  type ProposalVersion,
} from '../src/conversation/types';
import { writePortableExport, validatePortableExport, dryRunImport } from '../src/export/portable';
import { writePortableExportArchive, writeRestoreEvidence } from '../src/export/archive';
import { validateConversationalEntities } from '../src/conversation/portable';

const NOW = '2026-07-30T12:00:00.000Z';
const NOW_DATE = new Date(NOW);
const HASH_A = `sha256:${'a'.repeat(64)}`;
const HASH_B = `sha256:${'b'.repeat(64)}`;

function tmpDir(name: string): string {
  return path.join(__dirname, '..', '..', '.tmp', 'exports', `${name}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
}

function base(id: string, recordType: string, days = 30) {
  return {
    id,
    recordType,
    schemaVersion: 1,
    createdAt: NOW,
    updatedAt: NOW,
    ...expiryFrom(NOW, days),
  };
}

function conversation(id: string, ownerUserId: string): Conversation {
  return {
    ...base(id, 'conversation'),
    recordType: 'conversation',
    ownerUserId,
    audience: 'private',
    status: 'active',
    objective: `Objective for ${id}`,
    nextEventSequence: 1,
    revision: 1,
  };
}

function identity(id: string, userId: string, channelUserId: string): IdentityBinding {
  const { expiresAt: _expiresAt, ttl: _ttl, ...withoutExpiry } = base(id, 'identity_binding');
  return {
    ...withoutExpiry,
    recordType: 'identity_binding',
    userId,
    channel: 'telegram',
    channelUserId,
    status: 'active',
    provisionedBy: 'operator-1',
    provisionedAt: NOW,
    revision: 1,
  };
}

function proposal(conversationId: string): ProposalVersion {
  return {
    ...base('proposal-1-v1', 'proposal_version'),
    recordType: 'proposal_version',
    proposalId: 'proposal-1',
    version: 1,
    conversationId,
    draftId: 'draft-1',
    status: 'presented',
    spec: {
      pluginId: 'todo',
      pluginBuildDigest: HASH_A,
      schemaDigest: HASH_A,
      policyDigest: HASH_A,
      action: 'propose',
      operation: 'create',
      effect: 'create_todo',
      proposedContent: { title: 'Synthetic todo' },
      sourceRefs: [],
      permissionRef: 'todo:create',
      expiresAt: expiryFrom(NOW, 30).expiresAt,
    },
    canonicalPayloadHash: HASH_A,
    renderedViewHash: HASH_B,
    actorId: 'user-1',
    channel: 'telegram',
    revision: 1,
  };
}

function presentation(conversationId: string): ProposalPresentation {
  return {
    ...base('presentation-1', 'proposal_presentation'),
    recordType: 'proposal_presentation',
    proposalId: 'proposal-1',
    proposalVersion: 1,
    conversationId,
    actorId: 'user-1',
    channel: 'telegram',
    status: 'active',
    actionTokenHash: HASH_A,
    revision: 1,
  };
}

function attempt(conversationId: string): ExecutionAttempt {
  return {
    ...base('attempt-1', 'execution_attempt', 365),
    recordType: 'execution_attempt',
    proposalId: 'proposal-1',
    proposalVersion: 1,
    conversationId,
    status: 'queued',
    deliveryMode: 'provider_idempotency',
    idempotencyRef: 'todo-proposal-1-v1',
    attemptNumber: 1,
    readyAt: NOW,
    recoveryBlocked: false,
    revision: 1,
  };
}

describe('conversational state persistence', () => {
  let client: DynamoDBDocumentClient;
  const generatedDirs: string[] = [];

  before(async () => {
    const port = await startLocal();
    client = await getClient(port);
    await createTables(client);
    await createUserWithId(client, 'user-1', { name: 'User one', email: 'user-1@example.test' });
    await createUserWithId(client, 'user-2', { name: 'User two', email: 'user-2@example.test' });
    await createUserWithId(client, 'user-export', { name: 'Export user', email: 'user-export@example.test' });
  });

  after(async () => {
    await Promise.all(generatedDirs.map((dir) => fs.rm(dir, { recursive: true, force: true })));
    await stopLocal();
  });

  it('rejects invalid, unbounded, binary, secret-like, and raw-token record data', () => {
    assert.throws(
      () => validateConversationalRecord({
        ...conversation('invalid-conversation', 'user-invalid'),
        status: 'sleeping',
      } as unknown as Conversation),
      /status/
    );
    assert.throws(
      () => validateConversationalRecord({
        ...base('private-invalid', 'conversational_private_payload'),
        recordType: 'conversational_private_payload',
        conversationId: 'conversation-invalid',
        classification: 'private',
        content: { apiKey: 'do-not-store' },
      }),
      /forbidden secret-like field/
    );
    assert.throws(
      () => validateConversationalRecord({
        ...base('event-invalid', 'conversation_event'),
        recordType: 'conversation_event',
        conversationId: 'conversation-invalid',
        sequence: 1,
        channel: 'telegram',
        idempotencyKey: 'update-1',
        eventType: 'voice',
        direction: 'inbound',
        actorId: 'user-invalid',
        provenance: 'telegram',
        classification: 'private',
        payload: { media: Buffer.from('binary') },
      }),
      /binary media/
    );
    assert.throws(
      () => validateConversationalRecord({
        ...base('draft-invalid', 'plugin_draft'),
        recordType: 'plugin_draft',
        conversationId: 'conversation-invalid',
        pluginId: 'todo',
        pluginBuild: 'build',
        status: 'collecting',
        data: { text: 'x'.repeat(70_000) },
        revision: 1,
      }),
      /bounded JSON/
    );
    assert.throws(
      () => validateConversationalRecord({
        ...conversation('raw-token-conversation', 'user-invalid'),
        rawToken: 'must-never-be-stored',
      } as Conversation),
      /forbidden secret-like field/
    );
  });

  it('rejects missing required fields and wrong retention before any repository request', async () => {
    let requests = 0;
    const noRequestClient = {
      send: async () => {
        requests += 1;
        throw new Error('repository request must not occur');
      },
    } as unknown as DynamoDBDocumentClient;

    const noExpiryEvent = {
      ...base('no-expiry-event', 'conversation_event'),
      recordType: 'conversation_event' as const,
      conversationId: 'conversation-invalid',
      sequence: 1,
      channel: 'telegram',
      idempotencyKey: 'no-expiry',
      eventType: 'message',
      direction: 'inbound' as const,
      actorId: 'user-invalid',
      provenance: 'telegram.update',
      classification: 'private' as const,
      payload: { text: 'synthetic' },
    };
    delete (noExpiryEvent as { expiresAt?: string }).expiresAt;
    delete (noExpiryEvent as { ttl?: number }).ttl;
    await assert.rejects(
      () => appendConversationEvent(noRequestClient, noExpiryEvent, 1),
      /expiresAt/
    );

    await assert.rejects(
      () => putConversationalPrivatePayload(noRequestClient, {
        ...base('long-private', 'conversational_private_payload', 365),
        recordType: 'conversational_private_payload',
        conversationId: 'conversation-invalid',
        classification: 'private',
        content: { text: 'synthetic' },
      }),
      /30-day retention/
    );

    const invalidIdentity = {
      ...identity('expiring-identity', 'user-invalid', 'invalid-channel-user'),
      ...expiryFrom(NOW, 30),
      provisionedBy: '',
      provisionedAt: '',
    };
    await assert.rejects(
      () => createIdentityBinding(noRequestClient, invalidIdentity),
      /must not have expiresAt or ttl/
    );

    await assert.rejects(
      () => appendConversationAuditEvent(noRequestClient, {
        ...base('short-audit', 'conversation_audit_event', 30),
        recordType: 'conversation_audit_event',
        conversationId: 'conversation-invalid',
        subjectType: 'proposal',
        subjectId: 'proposal-invalid',
        action: 'presented',
        actorId: 'user-invalid',
        outcome: 'success',
      }),
      /365-day retention/
    );

    assert.throws(
      () => validateConversationalRecord({
        ...noExpiryEvent,
        ...expiryFrom(NOW, 30),
        channel: '',
        eventType: '',
        actorId: '',
        provenance: '',
      }),
      /(channel|eventType|actorId|provenance)/
    );
    assert.strictEqual(requests, 0);
  });

  it('reports unsafe portable paths and broken relationships without echoing values', () => {
    const errors: string[] = [];
    validateConversationalEntities({
      conversations: [],
      conversation_events: [{
        id: 'unsafe-event',
        recordType: 'conversation_event',
        schemaVersion: 1,
        createdAt: NOW,
        updatedAt: NOW,
        conversationId: 'missing-conversation',
        sequence: 1,
        direction: 'inbound',
        classification: 'private',
        rawToken: 'never-echo-this-value',
      }],
    }, errors);
    assert.ok(errors.some((error) => /missing conversation/.test(error)));
    assert.ok(errors.some((error) => /rawToken is forbidden/.test(error)));
    assert.doesNotMatch(errors.join('\n'), /never-echo-this-value/);
  });

  it('rejects malformed portable proposals, expiry, ownership, and out-of-order events', () => {
    const malformedErrors: string[] = [];
    const validPortableConversation = conversation('portable-conversation', 'portable-owner');
    validateConversationalEntities({
      conversations: [{
        ...validPortableConversation,
        ownerUserId: '',
      }],
    }, malformedErrors, NOW);
    validateConversationalEntities({
      conversations: [{
        ...validPortableConversation,
        expiresAt: 'not-a-timestamp',
        ttl: 1,
      }],
    }, malformedErrors, NOW);
    validateConversationalEntities({
      conversations: [validPortableConversation],
      proposal_versions: [{
        id: 'portable-proposal',
        recordType: 'proposal_version',
        schemaVersion: 1,
        createdAt: NOW,
        updatedAt: NOW,
        ...expiryFrom(NOW, 30),
        proposalId: 'proposal-portable',
        version: 1,
        conversationId: 'portable-conversation',
        status: 'presented',
        canonicalPayloadHash: HASH_A,
        renderedViewHash: HASH_B,
      }],
    }, malformedErrors, NOW);
    const invalidActorProposal = proposal('portable-conversation') as ProposalVersion & {
      actorId?: string;
      channel?: string;
    };
    delete invalidActorProposal.actorId;
    delete invalidActorProposal.channel;
    validateConversationalEntities({
      conversations: [validPortableConversation],
      proposal_versions: [invalidActorProposal as unknown as Record<string, never>],
    }, malformedErrors, NOW);
    const invalidChannelProposal = proposal('portable-conversation') as ProposalVersion & {
      channel?: string;
    };
    delete invalidChannelProposal.channel;
    validateConversationalEntities({
      conversations: [validPortableConversation],
      proposal_versions: [invalidChannelProposal as unknown as Record<string, never>],
    }, malformedErrors, NOW);
    assert.ok(malformedErrors.some((error) => /ownerUserId/.test(error)));
    assert.ok(malformedErrors.some((error) => /expiresAt/.test(error)));
    assert.ok(malformedErrors.some((error) => /spec/.test(error)));
    assert.ok(malformedErrors.some((error) => /actorId/.test(error)));
    assert.ok(malformedErrors.some((error) => /channel/.test(error)));

    const orderErrors: string[] = [];
    const portableConversation = conversation('ordered-conversation', 'user-ordered');
    const portableEvent = (id: string, sequence: number) => ({
      ...base(id, 'conversation_event'),
      recordType: 'conversation_event',
      conversationId: portableConversation.id,
      sequence,
      channel: 'telegram',
      idempotencyKey: `ordered-${id}`,
      eventType: 'message',
      direction: 'inbound',
      actorId: 'user-ordered',
      provenance: 'telegram.update',
      classification: 'private',
      payload: { text: 'synthetic' },
    });
    validateConversationalEntities({
      conversations: [{ ...portableConversation, nextEventSequence: 3 }],
      conversation_events: [
        portableEvent('event-second', 2),
        portableEvent('event-first', 1),
      ],
    }, orderErrors, NOW);
    assert.ok(orderErrors.some((error) => /out of deterministic conversation\/sequence order/.test(error)));
  });

  it('rejects dangling exported ownership and active/private payload references', () => {
    const danglingProposal = proposal('dangling-conversation');
    danglingProposal.id = 'dangling-proposal-version';
    danglingProposal.proposalId = 'dangling-proposal';
    danglingProposal.draftId = undefined;
    danglingProposal.spec = {
      ...danglingProposal.spec,
      proposedContent: undefined,
      privatePayloadRef: 'missing-proposal-payload',
    };
    const records = {
      users: [],
      identity_bindings: [identity('dangling-identity', 'missing-identity-user', '999')],
      conversations: [{
        ...conversation('dangling-conversation', 'missing-owner-user'),
        activeDraftId: 'missing-draft',
        activeProposalId: 'missing-proposal',
        nextEventSequence: 2,
      }],
      conversation_events: [{
        ...base('dangling-event', 'conversation_event'),
        recordType: 'conversation_event',
        conversationId: 'dangling-conversation',
        sequence: 1,
        channel: 'telegram',
        idempotencyKey: 'dangling-event-key',
        eventType: 'message',
        direction: 'inbound',
        actorId: 'missing-owner-user',
        provenance: 'telegram.update',
        classification: 'private',
        payloadRef: 'missing-event-payload',
      }],
      proposal_versions: [danglingProposal],
    };
    const before = JSON.stringify(records);
    const errors: string[] = [];

    validateConversationalEntities(records as unknown as Record<string, Record<string, never>[]>, errors, NOW);

    assert.ok(errors.some((error) => /identity_bindings\[0\]\.userId references missing exported user/.test(error)));
    assert.ok(errors.some((error) => /conversations\[0\]\.ownerUserId references missing exported user/.test(error)));
    assert.ok(errors.some((error) => /conversations\[0\]\.activeDraftId references missing draft/.test(error)));
    assert.ok(errors.some((error) => /conversations\[0\]\.activeProposalId references missing proposal/.test(error)));
    assert.ok(errors.some((error) => /conversation_events\[0\]\.payloadRef references missing private payload/.test(error)));
    assert.ok(errors.some((error) => /proposal_versions\[0\]\.spec\.privatePayloadRef references missing private payload/.test(error)));
    assert.strictEqual(JSON.stringify(records), before);
  });

  it('rejects active and private payload references across conversations', () => {
    const otherDraft: PluginDraft = {
      ...base('other-draft', 'plugin_draft'),
      recordType: 'plugin_draft',
      conversationId: 'other-conversation',
      pluginId: 'todo',
      pluginBuild: 'build-1',
      status: 'ready',
      data: { title: 'Synthetic todo' },
      revision: 1,
    };
    const referencedProposal = {
      ...proposal('other-conversation'),
      id: 'other-proposal-version',
      proposalId: 'other-proposal',
      draftId: 'other-draft',
    };
    const crossPayloadProposal = {
      ...proposal('primary-conversation'),
      id: 'primary-proposal-version',
      proposalId: 'primary-proposal',
      draftId: undefined,
      spec: {
        ...proposal('primary-conversation').spec,
        proposedContent: undefined,
        privatePayloadRef: 'other-private-payload',
      },
    };
    const errors: string[] = [];

    validateConversationalEntities({
      users: [{ user_id: 'user-1' }],
      conversations: [
        {
          ...conversation('primary-conversation', 'user-1'),
          activeDraftId: 'other-draft',
          activeProposalId: 'other-proposal',
          nextEventSequence: 2,
        },
        conversation('other-conversation', 'user-1'),
      ],
      plugin_drafts: [otherDraft as unknown as Record<string, never>],
      proposal_versions: [
        crossPayloadProposal as unknown as Record<string, never>,
        referencedProposal as unknown as Record<string, never>,
      ],
      conversation_events: [{
        ...base('cross-payload-event', 'conversation_event'),
        recordType: 'conversation_event',
        conversationId: 'primary-conversation',
        sequence: 1,
        channel: 'telegram',
        idempotencyKey: 'cross-payload-event-key',
        eventType: 'message',
        direction: 'inbound',
        actorId: 'user-1',
        provenance: 'telegram.update',
        classification: 'private',
        payloadRef: 'other-private-payload',
      }],
      conversational_private_payloads: [{
        ...base('other-private-payload', 'conversational_private_payload'),
        recordType: 'conversational_private_payload',
        conversationId: 'other-conversation',
        classification: 'private',
        content: { text: 'Synthetic private content' },
      }],
    }, errors, NOW);

    assert.ok(errors.some((error) => /conversations\[0\]\.activeDraftId must reference a draft in the same conversation/.test(error)));
    assert.ok(errors.some((error) => /conversations\[0\]\.activeProposalId must reference a proposal in the same conversation/.test(error)));
    assert.ok(errors.some((error) => /conversation_events\[0\]\.payloadRef must reference a private payload in the same conversation/.test(error)));
    assert.ok(errors.some((error) => /proposal_versions\[0\]\.spec\.privatePayloadRef must reference a private payload in the same conversation/.test(error)));
  });

  it('resolves identities and channels without display-name identity or cross-user leakage', async () => {
    await createIdentityBinding(client, identity('identity-1', 'user-1', '111'));
    await createIdentityBinding(client, identity('identity-2', 'user-2', '222'));
    await createConversation(client, conversation('conversation-1', 'user-1'));
    await createConversation(client, conversation('conversation-2', 'user-2'));
    await createChannelBinding(client, {
      ...base('channel-binding-1', 'channel_binding'),
      recordType: 'channel_binding',
      conversationId: 'conversation-1',
      ownerUserId: 'user-1',
      channel: 'telegram',
      channelConversationKey: 'private:111',
    });

    assert.strictEqual((await getIdentityBinding(client, 'telegram', '111'))?.userId, 'user-1');
    assert.deepStrictEqual((await listIdentityBindings(client, 'user-1')).items.map((item) => item.id), ['identity-1']);
    assert.strictEqual((await getChannelBinding(client, 'telegram', 'private:111', NOW_DATE))?.conversationId, 'conversation-1');
    assert.deepStrictEqual((await listOwnerConversations(client, 'user-1', undefined, 10, NOW_DATE)).items.map((item) => item.id), ['conversation-1']);
    await assert.rejects(
      () => createChannelBinding(client, {
        ...base('bad-binding', 'channel_binding'),
        recordType: 'channel_binding',
        conversationId: 'conversation-1',
        ownerUserId: 'user-2',
        channel: 'telegram',
        channelConversationKey: 'private:222',
      }),
      /unavailable/
    );

    const revoked = await revokeIdentityBinding(client, 'telegram', '111', 1, 'operator-1', NOW);
    assert.strictEqual(revoked.status, 'revoked');
    assert.strictEqual(revoked.revision, 2);
    await assert.rejects(
      () => revokeIdentityBinding(client, 'telegram', '111', 1, 'operator-1', NOW),
      /ConditionalCheckFailed/
    );
  });

  it('appends one ordered event atomically and makes duplicates idempotent', async () => {
    const event = {
      ...base('event-1', 'conversation_event'),
      recordType: 'conversation_event' as const,
      conversationId: 'conversation-1',
      sequence: 1,
      channel: 'telegram',
      idempotencyKey: 'update-100',
      eventType: 'message',
      direction: 'inbound' as const,
      actorId: 'user-1',
      provenance: 'telegram.update',
      classification: 'private' as const,
      payload: { text: 'Create a synthetic todo' },
    };
    const first = await appendConversationEvent(client, event, 1);
    const duplicate = await appendConversationEvent(client, event, 1);
    assert.strictEqual(first.duplicate, false);
    assert.strictEqual(duplicate.duplicate, true);
    assert.strictEqual(duplicate.event.id, event.id);
    assert.strictEqual((await getConversation(client, 'conversation-1', NOW_DATE))?.revision, 2);

    await createConversation(client, conversation('conversation-concurrent-duplicate', 'user-1'));
    const concurrentDuplicateEvent = {
      ...event,
      id: 'event-concurrent-duplicate',
      conversationId: 'conversation-concurrent-duplicate',
      idempotencyKey: 'update-concurrent-duplicate',
    };
    const duplicateResults = await Promise.all([
      appendConversationEvent(client, concurrentDuplicateEvent, 1),
      appendConversationEvent(client, concurrentDuplicateEvent, 1),
    ]);
    assert.deepStrictEqual(duplicateResults.map((result) => result.duplicate).sort(), [false, true]);
    assert.strictEqual((await getConversation(client, 'conversation-concurrent-duplicate', NOW_DATE))?.revision, 2);

    await createConversation(client, conversation('conversation-concurrent-conflict', 'user-1'));
    const conflictResults = await Promise.allSettled([
      appendConversationEvent(client, {
        ...event,
        id: 'event-concurrent-a',
        conversationId: 'conversation-concurrent-conflict',
        idempotencyKey: 'update-concurrent-a',
      }, 1),
      appendConversationEvent(client, {
        ...event,
        id: 'event-concurrent-b',
        conversationId: 'conversation-concurrent-conflict',
        idempotencyKey: 'update-concurrent-b',
      }, 1),
    ]);
    assert.strictEqual(conflictResults.filter((result) => result.status === 'fulfilled').length, 1);
    assert.strictEqual(conflictResults.filter((result) => result.status === 'rejected').length, 1);
    assert.strictEqual((await getConversation(client, 'conversation-concurrent-conflict', NOW_DATE))?.revision, 2);
    assert.deepStrictEqual(
      (await listConversationEvents(client, 'conversation-1', 'user-1', undefined, 10, NOW_DATE)).items.map((item) => item.sequence),
      [1]
    );
    await assert.rejects(
      () => appendConversationEvent(client, { ...event, id: 'event-2', sequence: 2, idempotencyKey: 'update-101' }, 1),
      /TransactionCanceled/
    );
    assert.strictEqual((await getConversation(client, 'conversation-1', NOW_DATE))?.revision, 2);
  });

  it('uses one production transaction for marker, event, sequence, and revision', async () => {
    const previous = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    const commands: unknown[] = [];
    const fakeClient = {
      send: async (command: unknown) => {
        commands.push(command);
        return {};
      },
    } as DynamoDBDocumentClient;
    try {
      await appendConversationEvent(fakeClient, {
        ...base('event-production', 'conversation_event'),
        recordType: 'conversation_event',
        conversationId: 'conversation-production',
        sequence: 1,
        channel: 'telegram',
        idempotencyKey: 'production-update',
        eventType: 'message',
        direction: 'inbound',
        actorId: 'user-production',
        provenance: 'telegram.update',
        classification: 'private',
        payload: { text: 'Synthetic production transaction' },
      }, 1);
      assert.strictEqual(commands.length, 1);
      assert.strictEqual(commands[0]!.constructor.name, 'TransactWriteCommand');
      const input = (commands[0] as { input: { TransactItems: unknown[] } }).input;
      assert.strictEqual(input.TransactItems.length, 4);
    } finally {
      process.env.NODE_ENV = previous;
    }
  });

  it('enforces optimistic drafts/checkpoints, immutable proposals, state CAS, and indexed recovery', async () => {
    const draft: PluginDraft = {
      ...base('draft-1', 'plugin_draft'),
      recordType: 'plugin_draft',
      conversationId: 'conversation-1',
      pluginId: 'todo',
      pluginBuild: 'todo-build-1',
      status: 'ready',
      data: { title: 'Synthetic todo' },
      revision: 1,
    };
    await savePluginDraft(client, draft, null);
    await savePluginDraft(client, { ...draft, data: { title: 'Revised synthetic todo' }, revision: 2 }, 1);
    await assert.rejects(
      () => savePluginDraft(client, { ...draft, revision: 3 }, 1),
      /ConditionalCheckFailed/
    );
    await saveCheckpoint(client, {
      ...base('summary-1', 'summary_checkpoint'),
      recordType: 'summary_checkpoint',
      conversationId: 'conversation-1',
      fromSequence: 1,
      throughSequence: 1,
      summary: 'The operator requested a synthetic todo.',
      revision: 1,
    }, null);
    assert.strictEqual((await getPluginDraft(client, 'conversation-1', 'draft-1', 'user-1', NOW_DATE))?.revision, 2);
    assert.strictEqual((await getCheckpoint(client, 'conversation-1', 'user-1', NOW_DATE))?.throughSequence, 1);

    const proposalRecord = proposal('conversation-1');
    await insertProposalVersion(client, proposalRecord);
    await assert.rejects(() => insertProposalVersion(client, proposalRecord), /ConditionalCheckFailed/);
    assert.deepStrictEqual((await listProposalVersions(client, 'proposal-1', undefined, 10, NOW_DATE)).items.map((item) => item.version), [1]);

    await createPresentation(client, presentation('conversation-1'));
    await createExecutionAttempt(client, attempt('conversation-1'));
    const relationships = await listProposalRelationships(client, 'proposal-1', 1, undefined, 10, NOW_DATE);
    assert.deepStrictEqual(relationships.items.map((item) => item.recordType).sort(), ['execution_attempt', 'proposal_presentation']);
    const consumed = await compareAndSetPresentation(client, HASH_A, 'active', 'consumed', 1, NOW);
    assert.strictEqual(consumed.revision, 2);
    await assert.rejects(
      () => compareAndSetPresentation(client, HASH_A, 'active', 'revoked', 1, NOW),
      /ConditionalCheckFailed/
    );
    assert.strictEqual((await getPresentationByTokenHash(client, HASH_A, NOW_DATE))?.status, 'consumed');

    const executing = await compareAndSetExecutionAttempt(client, 'attempt-1', 'queued', 'executing', 1, NOW);
    assert.strictEqual(executing.status, 'executing');
    assert.strictEqual((await listRecoveryCandidates(client, 'executing', NOW, undefined, 10, NOW_DATE)).items.length, 1);
    await assert.rejects(
      () => compareAndSetExecutionAttempt(client, 'attempt-1', 'queued', 'succeeded', 1, NOW),
      /ConditionalCheckFailed/
    );
  });

  it('fails closed on expiry and performs tombstone-first paginated idempotent cleanup', async () => {
    assert.strictEqual(await getConversation(client, 'conversation-1', new Date('2026-09-01T00:00:00.000Z')), null);
    assert.strictEqual((await getIdentityBinding(client, 'telegram', '111'))?.id, 'identity-1');

    await appendConversationAuditEvent(client, {
      ...base('audit-1', 'conversation_audit_event', 365),
      recordType: 'conversation_audit_event',
      conversationId: 'conversation-1',
      subjectType: 'proposal',
      subjectId: 'proposal-1',
      action: 'presented',
      actorId: 'user-1',
      payloadHash: HASH_A,
      outcome: 'success',
    });
    await putConversationalPrivatePayload(client, {
      ...base('private-1', 'conversational_private_payload'),
      recordType: 'conversational_private_payload',
      conversationId: 'conversation-1',
      classification: 'private',
      content: { providerResult: 'bounded synthetic result' },
    });
    await markConversationDeleted(client, 'conversation-1', 'user-1', 2, NOW);
    assert.strictEqual(await getConversation(client, 'conversation-1', NOW_DATE), null);
    assert.deepStrictEqual((await listProposalVersions(client, 'proposal-1', undefined, 10, NOW_DATE)).items, []);
    assert.deepStrictEqual((await listProposalRelationships(client, 'proposal-1', 1, undefined, 10, NOW_DATE)).items, []);
    let cursor: Record<string, unknown> | undefined;
    let deleted = 0;
    do {
      const page = await cleanupDeletedConversation(client, 'conversation-1', cursor, 2);
      deleted += page.deleted;
      cursor = page.cursor;
    } while (cursor);
    assert.ok(deleted >= 8);
    const retry = await cleanupDeletedConversation(client, 'conversation-1', undefined, 10);
    assert.strictEqual(retry.deleted, 0);
    assert.strictEqual((await getIdentityBinding(client, 'telegram', '111'))?.id, 'identity-1');
  });

  it('exports typed JSONL without replay material and produces replay-safe dry-run/restore evidence', async () => {
    const exportConversation = conversation('conversation-export', 'user-export');
    await createConversation(client, exportConversation);
    const { draftId: _draftId, ...proposalWithoutDraft } = proposal('conversation-export');
    const exportDraft = { ...proposalWithoutDraft, proposalId: 'proposal-export', id: 'proposal-export-v1' };
    await insertProposalVersion(client, exportDraft);
    const exportPresentation = {
      ...presentation('conversation-export'),
      id: 'presentation-export',
      proposalId: 'proposal-export',
      actionTokenHash: HASH_B,
    };
    await createPresentation(client, exportPresentation);
    await createExecutionAttempt(client, {
      ...attempt('conversation-export'),
      id: 'attempt-export',
      proposalId: 'proposal-export',
    });
    await putConversationalPrivatePayload(client, {
      ...base('expired-private-export', 'conversational_private_payload'),
      recordType: 'conversational_private_payload',
      conversationId: 'conversation-export',
      classification: 'private',
      content: { note: 'This fixture is already expired at export time.' },
      createdAt: '2026-06-01T12:00:00.000Z',
      updatedAt: '2026-06-01T12:00:00.000Z',
      expiresAt: '2026-07-01T12:00:00.000Z',
      ttl: 1782907200,
    });

    const exportDir = tmpDir('conversational-state');
    generatedDirs.push(exportDir);
    const result = await writePortableExport(client, exportDir, {
      generatedAt: NOW,
      sourceEnvironment: 'test',
    });
    assert.strictEqual(result.manifest.entity_files.conversations, 'conversations.jsonl');
    assert.strictEqual(result.manifest.entity_files.proposal_presentations, 'proposal_presentations.jsonl');
    assert.ok(result.manifest.redactions.includes('proposal_presentations.action_token_hash'));
    assert.ok(result.manifest.omitted_entities.includes('sessions'));
    assert.strictEqual(result.manifest.entity_counts.conversational_private_payloads, 0);
    assert.strictEqual(result.manifest.entity_counts.execution_attempts, 1);
    const presentationJsonl = await fs.readFile(path.join(exportDir, 'proposal_presentations.jsonl'), 'utf8');
    assert.doesNotMatch(presentationJsonl, /actionTokenHash|action_token_hash|sha256:b{64}/);
    assert.doesNotMatch(presentationJsonl, /signed[_-]?url|credential|mediaBytes/i);

    const validation = await validatePortableExport(exportDir);
    assert.deepStrictEqual(validation.errors, []);
    assert.strictEqual(validation.valid, true);
    const dryRun = await dryRunImport(exportDir);
    assert.strictEqual(dryRun.valid, true);
    assert.strictEqual(dryRun.effectsExecuted, 0);
    assert.strictEqual(dryRun.wouldUpdateForRestoreSafety.proposal_presentations, 1);
    assert.strictEqual(dryRun.wouldUpdateForRestoreSafety.execution_attempts, 1);

    const archiveRoot = tmpDir('conversational-archive');
    generatedDirs.push(archiveRoot);
    const archive = await writePortableExportArchive(client, {
      environment: 'test',
      localArchiveDir: path.join(archiveRoot, 'store'),
      tempDir: path.join(archiveRoot, 'working'),
    });
    const evidence = await writeRestoreEvidence({
      archiveUri: archive.archiveUri,
      expectedArchiveChecksum: archive.archiveChecksum,
      outputDir: path.join(archiveRoot, 'restore'),
      targetEnvironment: 'staging',
      timestamp: NOW,
    });
    assert.strictEqual(evidence.report.validation.valid, true);
    assert.strictEqual(evidence.report.dry_run_import.effectsExecuted, 0);
    assert.ok(evidence.report.dry_run_import.wouldUpdateForRestoreSafety.proposal_presentations >= 1);
    assert.ok(evidence.report.dry_run_import.wouldUpdateForRestoreSafety.execution_attempts >= 1);
    assert.match(evidence.report.production_write_gate, /No restore\/import\/write action/);
  });

  it('uses no request-path table scans', async () => {
    const source = await fs.readFile(path.join(__dirname, '..', 'src', 'conversation', 'repository.ts'), 'utf8');
    assert.doesNotMatch(source, /ScanCommand/);
  });
});
