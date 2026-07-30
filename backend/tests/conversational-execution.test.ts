import { after, before, describe, it } from 'node:test';
import assert from 'node:assert';
import { GetCommand, QueryCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

import { startLocal, stopLocal, getClient } from '../src/db/client';
import { createTables, TABLE_CONVERSATIONAL_STATE } from '../src/db/setup';
import { createUserWithId, updateUser } from '../src/db/users';
import {
  createChannelBinding,
  createConversation,
  createIdentityBinding,
  createPresentation,
  getExecutionAttempt,
  getIdentityBinding,
  getPresentationByTokenHash,
  listProposalRelationships,
  listProposalVersions,
  compareAndSetExecutionAttempt,
  revokeIdentityBinding,
} from '../src/conversation/repository';
import {
  atomicApproval,
  atomicStorePresentedProposal,
  claimQueuedAttempt,
  finalizeAttempt,
  markDispatchStarted,
  putApprovalPermission,
  putCanonicalTarget,
  reclaimDispatchedAttempt,
  requeueUndispatchedAttempt,
} from '../src/conversation/executionRepository';
import {
  ApprovalUnavailableError,
  ExecutorRegistry,
  ProposalConflictError,
  approvePresentation,
  canonicalProposalSpec,
  deterministicAttemptIdentity,
  presentProposal,
  renderDeterministically,
  sha256,
  type CapabilityExecutor,
} from '../src/conversation/execution';
import {
  FakeCapabilityExecutor,
  preDispatchCheck,
  processAttempt,
  recoverExecutingAttempt,
  runRecovery,
} from '../src/conversation/executionWorker';
import { handleConversationalExecutionRoutes, publicAttempt } from '../src/routes/conversationalExecution';
import { expiryFrom, type ExecutionAttempt, type ProposalSpec } from '../src/conversation/types';
import type { LambdaEvent } from '../src/types';

const NOW = new Date('2026-07-30T12:00:00.000Z');
const LATER = new Date('2026-07-30T12:02:00.000Z');
const BUILD_A = `sha256:${'a'.repeat(64)}`;
const BUILD_B = `sha256:${'b'.repeat(64)}`;
const BUILD_C = `sha256:${'c'.repeat(64)}`;
const BUILD_UNSAFE = `sha256:${'f'.repeat(64)}`;
const SCHEMA = `sha256:${'d'.repeat(64)}`;
const POLICY = `sha256:${'e'.repeat(64)}`;
const PERMISSION = 'todo:create:self';

function recordBase(id: string, recordType: string, timestamp = NOW.toISOString()) {
  return {
    id,
    recordType,
    schemaVersion: 1,
    createdAt: timestamp,
    updatedAt: timestamp,
    ...expiryFrom(timestamp, 30),
  };
}

function spec(effect = 'fake.provider', buildDigest = BUILD_A): ProposalSpec {
  return {
    pluginId: 'fake.plugin',
    pluginBuildDigest: buildDigest,
    schemaDigest: SCHEMA,
    policyDigest: POLICY,
    action: 'propose',
    operation: 'create',
    effect,
    targetRef: 'target-1',
    destinationRef: 'fake-destination',
    proposedContent: { title: 'Synthetic approved effect', nested: { count: 1 } },
    baseRevision: 'revision-1',
    sourceRefs: [{ ref: 'source-1', revision: 'source-revision-1', classification: 'internal' }],
    permissionRef: PERMISSION,
    expiresAt: '2026-08-29T12:00:00.000Z',
  };
}

function event(
  method: string,
  path: string,
  actorId: string,
  requestBody?: Record<string, unknown>
): LambdaEvent {
  return {
    httpMethod: method,
    path,
    headers: { 'x-user-id': actorId },
    body: requestBody ? JSON.stringify(requestBody) : null,
  };
}

describe('transactional conversational approval and durable execution', () => {
  let client: DynamoDBDocumentClient;
  let sequence = 0;

  const provider = new FakeCapabilityExecutor('fake.provider', BUILD_A, PERMISSION, 'provider_idempotency', () => NOW);
  const correlation = new FakeCapabilityExecutor('fake.correlation', BUILD_B, PERMISSION, 'correlation_lookup', () => NOW);
  const operatorOnly = new FakeCapabilityExecutor('fake.operator', BUILD_C, PERMISSION, 'operator_reconciliation_only', () => NOW);
  const unsafeExecutor: CapabilityExecutor = {
    effect: 'fake.unsafe',
    buildDigest: BUILD_UNSAFE,
    permissionRef: PERMISSION,
    deliveryMode: 'provider_idempotency',
    render: (proposalSpec) => ({ effect: proposalSpec.effect, proposedContent: proposalSpec.proposedContent }),
    execute: async () => ({
      outcome: 'succeeded',
      receipt: {
        receiptId: 'Bearer should-never-persist',
        effectHash: `sha256:${'7'.repeat(64)}`,
        recordedAt: NOW.toISOString(),
        metadata: { apiKey: 'super-secret-marker' },
      },
    }),
  };
  const registry = new ExecutorRegistry([provider, correlation, operatorOnly, unsafeExecutor]);

  before(async () => {
    const port = await startLocal();
    client = await getClient(port);
    await createTables(client);
    await createUserWithId(client, 'owner-1', {
      name: 'Owner',
      email: 'owner@example.test',
      role: 'operator',
    });
    await createUserWithId(client, 'admin-1', {
      name: 'Admin',
      email: 'admin@example.test',
      role: 'admin',
    });
    await createUserWithId(client, 'wrong-owner', {
      name: 'Wrong owner',
      email: 'wrong@example.test',
      role: 'operator',
    });
    await createIdentityBinding(client, {
      ...(() => {
        const { expiresAt: _expiresAt, ttl: _ttl, ...identityBase } = recordBase('identity-owner', 'identity_binding');
        return identityBase;
      })(),
      recordType: 'identity_binding',
      userId: 'owner-1',
      channel: 'web',
      channelUserId: 'web-owner-1',
      status: 'active',
      provisionedBy: 'admin-1',
      provisionedAt: NOW.toISOString(),
      revision: 1,
    });
    await putApprovalPermission(client, {
      userId: 'owner-1',
      permissionRef: PERMISSION,
      enabled: true,
      revision: 1,
    });
    await putCanonicalTarget(client, { targetRef: 'target-1', revision: 'revision-1' });
  });

  after(async () => {
    await stopLocal();
  });

  async function context(
    effect = 'fake.provider',
    buildDigest = BUILD_A,
    presentationNow = NOW
  ) {
    sequence += 1;
    const suffix = String(sequence);
    const conversationId = `execution-conversation-${suffix}`;
    await createConversation(client, {
      ...recordBase(conversationId, 'conversation', presentationNow.toISOString()),
      recordType: 'conversation',
      ownerUserId: 'owner-1',
      audience: 'private',
      status: 'active',
      nextEventSequence: 1,
      revision: 1,
    });
    await createChannelBinding(client, {
      ...recordBase(`channel-${suffix}`, 'channel_binding', presentationNow.toISOString()),
      recordType: 'channel_binding',
      conversationId,
      ownerUserId: 'owner-1',
      channel: 'web',
      channelConversationKey: `web-conversation-${suffix}`,
    });
    const presented = await presentProposal({
      proposalId: `execution-proposal-${suffix}`,
      version: 1,
      conversationId,
      actorId: 'owner-1',
      identityBindingId: 'identity-owner',
      channelBindingId: `channel-${suffix}`,
      channel: 'web',
      channelConversationKey: `web-conversation-${suffix}`,
      spec: spec(effect, buildDigest),
    }, {
      client,
      registry,
      now: () => presentationNow,
      token: () => Buffer.alloc(32, sequence),
    });
    const provenance = {
      actorId: 'owner-1',
      channel: 'web',
      channelUserId: 'web-owner-1',
      channelConversationKey: `web-conversation-${suffix}`,
    };
    return { ...presented, provenance };
  }

  it('canonicalizes every semantic proposal field and rejects nondeterministic rendering', async () => {
    const original = spec();
    const reordered = {
      expiresAt: original.expiresAt,
      permissionRef: original.permissionRef,
      sourceRefs: original.sourceRefs,
      baseRevision: original.baseRevision,
      proposedContent: { nested: { count: 1 }, title: 'Synthetic approved effect' },
      destinationRef: original.destinationRef,
      targetRef: original.targetRef,
      effect: original.effect,
      operation: original.operation,
      action: original.action,
      policyDigest: original.policyDigest,
      schemaDigest: original.schemaDigest,
      pluginBuildDigest: original.pluginBuildDigest,
      pluginId: original.pluginId,
    } as ProposalSpec;
    assert.strictEqual(canonicalProposalSpec(original), canonicalProposalSpec(reordered));
    const semanticFields: Array<keyof ProposalSpec> = [
      'destinationRef', 'proposedContent', 'permissionRef', 'policyDigest',
      'schemaDigest', 'pluginBuildDigest', 'sourceRefs', 'baseRevision', 'expiresAt',
    ];
    const originalViewHash = renderDeterministically(provider, original).hash;
    for (const field of semanticFields) {
      const changed: ProposalSpec = { ...original };
      if (field === 'proposedContent') changed.proposedContent = { title: 'Changed' };
      else if (field === 'permissionRef') changed.permissionRef = 'typefully:create-saved-draft';
      else if (field === 'policyDigest') changed.policyDigest = `sha256:${'1'.repeat(64)}`;
      else if (field === 'schemaDigest') changed.schemaDigest = `sha256:${'2'.repeat(64)}`;
      else if (field === 'pluginBuildDigest') changed.pluginBuildDigest = `sha256:${'3'.repeat(64)}`;
      else if (field === 'sourceRefs') changed.sourceRefs = [{ ref: 'changed', classification: 'private' }];
      else if (field === 'expiresAt') changed.expiresAt = '2026-08-30T12:00:00.000Z';
      else if (field === 'baseRevision') changed.baseRevision = 'revision-2';
      else if (field === 'destinationRef') changed.destinationRef = 'changed-destination';
      assert.notStrictEqual(canonicalProposalSpec(original), canonicalProposalSpec(changed));
      assert.notStrictEqual(
        renderDeterministically(provider, changed).hash,
        originalViewHash,
        `${field} must change the rendered view hash`
      );
    }
    let counter = 0;
    assert.throws(
      () => renderDeterministically({ ...provider, render: () => ({ counter: counter += 1 }) }, original),
      /nondeterministic/
    );
    const presented = await context();
    assert.match(presented.actionToken, /^[A-Za-z0-9_-]{43}$/);
    assert.strictEqual(presented.presentation.actionTokenHash, sha256(presented.actionToken));
    assert.strictEqual(presented.presentation.actionExpiresAt, '2026-07-30T12:30:00.000Z');
    assert.doesNotMatch(JSON.stringify(presented.presentation), new RegExp(presented.actionToken));
    const revised = await presentProposal({
      proposalId: presented.proposal.proposalId,
      version: 2,
      conversationId: presented.proposal.conversationId,
      actorId: 'owner-1',
      identityBindingId: 'identity-owner',
      channelBindingId: presented.presentation.channelBindingId!,
      channel: 'web',
      channelConversationKey: presented.provenance.channelConversationKey,
      spec: { ...spec(), proposedContent: { title: 'Semantic revision' } },
    }, {
      client,
      registry,
      now: () => NOW,
      token: () => Buffer.alloc(32, 254),
    });
    assert.strictEqual(revised.proposal.version, 2);
    assert.strictEqual(
      (await getPresentationByTokenHash(client, presented.presentation.actionTokenHash, NOW))?.status,
      'revoked'
    );
    assert.strictEqual(
      (await listProposalVersions(client, presented.proposal.proposalId)).items
        .find((version) => version.version === 1)?.status,
      'superseded'
    );
  });

  it('stores a new version and supersedes stale controls in one production transaction', async () => {
    const old = await context();
    const proposal = {
      ...old.proposal,
      id: `${old.proposal.proposalId}-v2`,
      version: 2,
      revision: 1,
      spec: { ...old.proposal.spec, proposedContent: { title: 'Next version' } },
      canonicalPayloadHash: sha256(canonicalProposalSpec({
        ...old.proposal.spec,
        proposedContent: { title: 'Next version' },
      })),
    };
    const rendered = renderDeterministically(provider, proposal.spec);
    proposal.renderedViewHash = rendered.hash;
    const presentation = {
      ...old.presentation,
      id: `${old.presentation.id}-v2`,
      proposalVersion: 2,
      actionTokenHash: sha256('new-version-token'),
      renderedViewHash: rendered.hash,
      revision: 1,
    };
    const commands: unknown[] = [];
    const fakeClient = {
      send: async (command: unknown) => {
        commands.push(command);
        return {};
      },
    } as DynamoDBDocumentClient;
    const previous = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      await atomicStorePresentedProposal(fakeClient, {
        proposal,
        presentation,
        supersededProposals: [old.proposal],
        supersededPresentations: [old.presentation],
      });
    } finally {
      process.env.NODE_ENV = previous;
    }
    assert.strictEqual(commands.length, 1);
    assert.strictEqual(commands[0]!.constructor.name, 'TransactWriteCommand');
    const items = (commands[0] as { input: { TransactItems: Array<Record<string, unknown>> } }).input.TransactItems;
    assert.strictEqual(items.filter((item) => item.Put).length, 3);
    assert.strictEqual(items.filter((item) => item.Update).length, 2);
  });

  it('consumes one presentation and revokes every active sibling in the approval transaction', async () => {
    const presented = await context();
    const sibling = {
      ...presented.presentation,
      id: `${presented.presentation.id}-sibling`,
      actionTokenHash: sha256('sibling-action-token'),
      revision: 1,
    };
    await createPresentation(client, sibling);
    await approvePresentation(
      presented.actionToken,
      presented.provenance,
      { client, registry, now: () => NOW }
    );
    assert.strictEqual(
      (await getPresentationByTokenHash(client, sibling.actionTokenHash, NOW))?.status,
      'revoked'
    );
  });

  it('atomically handles 25 simultaneous approvals as one deterministic queued attempt', async () => {
    const presented = await context();
    const callsBefore = provider.calls.length;
    const results = await Promise.all(Array.from({ length: 25 }, () => approvePresentation(
      presented.actionToken,
      presented.provenance,
      { client, registry, now: () => NOW }
    )));
    const ids = new Set(results.map((result) => result.attempt.id));
    assert.strictEqual(ids.size, 1);
    assert.ok(results.every((result) => result.interaction === 'execution_pending'));
    assert.strictEqual(provider.calls.length, callsBefore);
    const relationships = await listProposalRelationships(client, presented.proposal.proposalId, 1);
    assert.strictEqual(relationships.items.filter((item) => item.recordType === 'execution_attempt').length, 1);
    const storedPresentation = await getPresentationByTokenHash(client, presented.presentation.actionTokenHash, NOW);
    assert.strictEqual(storedPresentation?.status, 'consumed');
    assert.strictEqual((await listProposalVersions(client, presented.proposal.proposalId)).items[0].status, 'claimed');
    await assert.rejects(
      () => approvePresentation(
        presented.actionToken,
        { ...presented.provenance, actorId: 'wrong-owner' },
        { client, registry, now: () => NOW }
      ),
      ApprovalUnavailableError
    );
  });

  it('uses one production transaction for every approval condition and state change', async () => {
    const presented = await context();
    const attemptIdentity = deterministicAttemptIdentity(presented.proposal);
    const attempt: ExecutionAttempt = {
      id: attemptIdentity.id,
      recordType: 'execution_attempt',
      schemaVersion: 1,
      createdAt: NOW.toISOString(),
      updatedAt: NOW.toISOString(),
      ...expiryFrom(NOW.toISOString(), 365),
      proposalId: presented.proposal.proposalId,
      proposalVersion: presented.proposal.version,
      conversationId: presented.proposal.conversationId,
      actorId: 'owner-1',
      permissionRef: PERMISSION,
      canonicalPayloadHash: presented.proposal.canonicalPayloadHash,
      renderedViewHash: presented.proposal.renderedViewHash,
      executorBuildDigest: BUILD_A,
      status: 'queued',
      deliveryMode: 'provider_idempotency',
      idempotencyRef: attemptIdentity.idempotencyKey,
      attemptNumber: 1,
      readyAt: NOW.toISOString(),
      leaseGeneration: 0,
      recoveryBlocked: false,
      revision: 1,
    };
    const identity = await getIdentityBinding(client, 'web', 'web-owner-1');
    const commands: unknown[] = [];
    const fakeClient = {
      send: async (command: unknown) => {
        commands.push(command);
        return {};
      },
    } as DynamoDBDocumentClient;
    const previous = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      await atomicApproval(fakeClient, {
        presentation: presented.presentation,
        proposal: presented.proposal,
        identity: identity!,
        channelUserId: 'web-owner-1',
        channelConversationKey: presented.provenance.channelConversationKey,
        attempt,
        auditId: 'audit-production-approval',
        now: NOW.toISOString(),
      });
    } finally {
      process.env.NODE_ENV = previous;
    }
    assert.strictEqual(commands.length, 1);
    assert.strictEqual(commands[0]!.constructor.name, 'TransactWriteCommand');
    const items = (commands[0] as { input: { TransactItems: Array<Record<string, unknown>> } }).input.TransactItems;
    assert.strictEqual(items.length, 11);
    assert.strictEqual(items.filter((item) => item.ConditionCheck).length, 6);
    assert.strictEqual(items.filter((item) => item.Update).length, 2);
    assert.strictEqual(items.filter((item) => item.Put).length, 3);
    const conditions = JSON.stringify(items);
    for (const field of [
      'channelBindingId',
      'pluginBuildDigest',
      'schemaDigest',
      'policyDigest',
      'permissionRef',
      'specExpiresAt',
    ]) {
      assert.match(conditions, new RegExp(field));
    }
  });

  it('atomically resolves 25 full approvals against transaction-capable DynamoDB Local', {
    skip: !process.env.DYNAMODB_ENDPOINT,
  }, async () => {
    const presented = await context();
    const attemptIdentity = deterministicAttemptIdentity(presented.proposal);
    const siblingPresentations = [1, 2].map((index) => ({
      ...presented.presentation,
      id: `${presented.presentation.id}-transaction-sibling-${index}`,
      actionTokenHash: sha256(`transaction-sibling-token-${index}`),
      revision: 1,
    }));
    for (const sibling of siblingPresentations) await createPresentation(client, sibling);

    const previous = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    let results: Awaited<ReturnType<typeof approvePresentation>>[];
    try {
      results = await Promise.all(Array.from({ length: 25 }, () => approvePresentation(
        presented.actionToken,
        presented.provenance,
        { client, registry, now: () => NOW }
      )));
    } finally {
      process.env.NODE_ENV = previous;
    }

    assert.deepStrictEqual(new Set(results!.map((result) => result.attempt.id)), new Set([attemptIdentity.id]));
    assert.ok(results!.every((result) => (
      result.interaction === 'execution_pending'
      && result.attempt.idempotencyRef === attemptIdentity.idempotencyKey
    )));

    const proposal = (await listProposalVersions(client, presented.proposal.proposalId)).items
      .find((candidate) => candidate.version === presented.proposal.version);
    const selected = await getPresentationByTokenHash(
      client,
      presented.presentation.actionTokenHash,
      NOW
    );
    const siblings = await Promise.all(siblingPresentations.map((sibling) => (
      getPresentationByTokenHash(client, sibling.actionTokenHash, NOW)
    )));
    const relationships = await listProposalRelationships(
      client,
      presented.proposal.proposalId,
      presented.proposal.version
    );
    const attempts = relationships.items.filter((item) => item.recordType === 'execution_attempt');
    const audits = await client.send(new QueryCommand({
      TableName: TABLE_CONVERSATIONAL_STATE,
      KeyConditionExpression: 'PK = :pk',
      ExpressionAttributeValues: { ':pk': `AUDIT#execution_attempt#${attemptIdentity.id}` },
      ConsistentRead: true,
    }));
    const link = await client.send(new GetCommand({
      TableName: TABLE_CONVERSATIONAL_STATE,
      Key: {
        PK: `CONVERSATION#${presented.proposal.conversationId}`,
        SK: `RELATIONSHIP#execution_attempt#${attemptIdentity.id}`,
      },
      ConsistentRead: true,
    }));
    const attemptLinks = await client.send(new QueryCommand({
      TableName: TABLE_CONVERSATIONAL_STATE,
      KeyConditionExpression: 'PK = :pk AND begins_with(SK, :prefix)',
      ExpressionAttributeValues: {
        ':pk': `CONVERSATION#${presented.proposal.conversationId}`,
        ':prefix': 'RELATIONSHIP#execution_attempt#',
      },
      ConsistentRead: true,
    }));

    assert.strictEqual(proposal?.status, 'claimed');
    assert.strictEqual(selected?.status, 'consumed');
    assert.ok(siblings.every((sibling) => sibling?.status === 'revoked'));
    assert.strictEqual(attempts.length, 1);
    assert.strictEqual(attempts[0]?.id, attemptIdentity.id);
    assert.strictEqual(attempts[0]?.status, 'queued');
    assert.strictEqual(audits.Count, 1);
    assert.strictEqual(audits.Items?.[0]?.action, 'approval_claimed');
    assert.strictEqual(attemptLinks.Count, 1);
    assert.strictEqual(link.Item?.recordType, 'conversation_relationship_link');
    assert.strictEqual(link.Item?.targetPK, `ATTEMPT#${attemptIdentity.id}`);
    assert.ok(
      proposal?.status === 'claimed' && attempts.length === 1,
      'claimed proposal and deterministic attempt must exist together'
    );
  });

  it('fails closed for wrong provenance, revoked permission, and target drift', async () => {
    const wrong = await context();
    await assert.rejects(
      () => approvePresentation(wrong.actionToken, { ...wrong.provenance, actorId: 'wrong-owner' }, { client, registry, now: () => NOW }),
      ApprovalUnavailableError
    );
    assert.strictEqual((await listProposalRelationships(client, wrong.proposal.proposalId, 1)).items.filter((item) => item.recordType === 'execution_attempt').length, 0);

    const denied = await context();
    await putApprovalPermission(client, { userId: 'owner-1', permissionRef: PERMISSION, enabled: false, revision: 2 });
    await assert.rejects(
      () => approvePresentation(denied.actionToken, denied.provenance, { client, registry, now: () => NOW }),
      ApprovalUnavailableError
    );
    await putApprovalPermission(client, { userId: 'owner-1', permissionRef: PERMISSION, enabled: true, revision: 3 });

    const drifted = await context();
    await putCanonicalTarget(client, { targetRef: 'target-1', revision: 'revision-2' });
    await assert.rejects(
      () => approvePresentation(drifted.actionToken, drifted.provenance, { client, registry, now: () => NOW }),
      ProposalConflictError
    );
    assert.strictEqual((await listProposalVersions(client, drifted.proposal.proposalId)).items[0].status, 'conflicted');
    assert.strictEqual((await getPresentationByTokenHash(client, drifted.presentation.actionTokenHash, NOW))?.status, 'revoked');
    await putCanonicalTarget(client, { targetRef: 'target-1', revision: 'revision-1' });
  });

  it('allows one worker lease and one fake effect under duplicate stream delivery', async () => {
    const presented = await context();
    const approved = await approvePresentation(presented.actionToken, presented.provenance, { client, registry, now: () => NOW });
    provider.behavior = 'success';
    const callsBefore = provider.calls.length;
    const results = await Promise.all(Array.from({ length: 25 }, (_, index) => processAttempt(
      approved.attempt.id,
      {
        client,
        registry,
        now: () => NOW,
        leaseOwner: () => `worker-${index}`,
      }
    )));
    const stored = await getExecutionAttempt(client, approved.attempt.id, NOW);
    assert.strictEqual(stored?.status, 'succeeded');
    assert.strictEqual(provider.calls.length - callsBefore, 1);
    assert.strictEqual(new Set(provider.calls.slice(callsBefore).map((call) => call.idempotencyKey)).size, 1);
    assert.ok(results.every((result) => (
      result && ['executing', 'succeeded'].includes(result.status)
    )));
  });

  it('never persists or exposes unsafe executor receipt fields', async () => {
    const presented = await context('fake.unsafe', BUILD_UNSAFE);
    const approved = await approvePresentation(
      presented.actionToken,
      presented.provenance,
      { client, registry, now: () => NOW }
    );
    const result = await processAttempt(approved.attempt.id, {
      client,
      registry,
      now: () => NOW,
      leaseOwner: () => 'unsafe-receipt-worker',
    });
    assert.strictEqual(result?.status, 'outcome_unknown');
    assert.strictEqual(result?.errorCode, 'unsafe_executor_receipt');
    assert.strictEqual(result?.resultReceipt, undefined);
    const publicJson = JSON.stringify(publicAttempt(result!));
    assert.doesNotMatch(publicJson, /Bearer|should-never-persist|apiKey|super-secret-marker/i);
  });

  it('survives all five durable crash boundaries without a duplicate fake effect', async () => {
    provider.behavior = 'success';

    // (a) Approval committed, but no worker invocation happened.
    const afterApproval = await context();
    const queued = await approvePresentation(afterApproval.actionToken, afterApproval.provenance, {
      client, registry, now: () => NOW,
    });
    assert.strictEqual(queued.attempt.status, 'queued');
    await runRecovery({ client, registry, now: () => NOW, leaseOwner: () => 'after-approval-recovery' });
    assert.strictEqual((await getExecutionAttempt(client, queued.attempt.id, NOW))?.status, 'succeeded');

    // (b) Lease committed, dispatch marker absent.
    const afterLease = await context();
    const leaseApproved = await approvePresentation(afterLease.actionToken, afterLease.provenance, {
      client, registry, now: () => NOW,
    });
    await assert.rejects(
      () => processAttempt(leaseApproved.attempt.id, {
        client, registry, now: () => NOW, leaseOwner: () => 'lease-crash', crashAfter: 'lease',
      }),
      /synthetic crash after lease/
    );
    const expiredLease = await getExecutionAttempt(client, leaseApproved.attempt.id, LATER);
    assert.strictEqual(expiredLease?.dispatchStartedAt, undefined);
    const requeued = await recoverExecutingAttempt(expiredLease!, {
      client, registry, now: () => LATER, leaseOwner: () => 'lease-recovery',
    });
    assert.strictEqual(requeued?.status, 'queued');
    const afterLeaseBackoff = new Date('2026-07-30T12:02:02.000Z');
    await runRecovery({
      client, registry, now: () => afterLeaseBackoff, leaseOwner: () => 'lease-retry',
    });
    assert.strictEqual(
      (await getExecutionAttempt(client, leaseApproved.attempt.id, afterLeaseBackoff))?.status,
      'succeeded'
    );

    // (c) Dispatch marker committed, fake call not started.
    const afterMarker = await context();
    const markerApproved = await approvePresentation(afterMarker.actionToken, afterMarker.provenance, {
      client, registry, now: () => NOW,
    });
    const markerCalls = provider.calls.length;
    await assert.rejects(
      () => processAttempt(markerApproved.attempt.id, {
        client, registry, now: () => NOW, leaseOwner: () => 'marker-crash', crashAfter: 'dispatch_marker',
      }),
      /synthetic crash after dispatch marker/
    );
    assert.strictEqual(provider.calls.length, markerCalls);
    await recoverExecutingAttempt(
      (await getExecutionAttempt(client, markerApproved.attempt.id, LATER))!,
      { client, registry, now: () => LATER, leaseOwner: () => 'marker-recovery' }
    );
    assert.strictEqual(provider.calls.length - markerCalls, 1);

    // (d) Fake effect applied, but its response was lost.
    const afterEffect = await context();
    const effectApproved = await approvePresentation(afterEffect.actionToken, afterEffect.provenance, {
      client, registry, now: () => NOW,
    });
    const effectCalls = provider.calls.length;
    provider.behavior = 'lost_after_effect';
    await processAttempt(effectApproved.attempt.id, {
      client, registry, now: () => NOW, leaseOwner: () => 'effect-crash',
    });
    provider.behavior = 'success';
    await recoverExecutingAttempt(
      (await getExecutionAttempt(client, effectApproved.attempt.id, LATER))!,
      { client, registry, now: () => LATER, leaseOwner: () => 'effect-recovery' }
    );
    assert.strictEqual(provider.calls.length - effectCalls, 2);
    assert.strictEqual(
      new Set(provider.calls.slice(effectCalls).map((call) => call.idempotencyKey)).size,
      1
    );

    // (e) Executor response returned, but the durable result write did not happen.
    const afterResponse = await context();
    const responseApproved = await approvePresentation(afterResponse.actionToken, afterResponse.provenance, {
      client, registry, now: () => NOW,
    });
    const responseCalls = provider.calls.length;
    await processAttempt(responseApproved.attempt.id, {
      client, registry, now: () => NOW, leaseOwner: () => 'response-crash',
      crashAfter: 'executor_response',
    });
    assert.strictEqual(
      (await getExecutionAttempt(client, responseApproved.attempt.id, LATER))?.status,
      'executing'
    );
    await recoverExecutingAttempt(
      (await getExecutionAttempt(client, responseApproved.attempt.id, LATER))!,
      { client, registry, now: () => LATER, leaseOwner: () => 'response-recovery' }
    );
    assert.strictEqual(provider.calls.length - responseCalls, 2);
    assert.strictEqual(
      new Set(provider.calls.slice(responseCalls).map((call) => call.idempotencyKey)).size,
      1
    );
  });

  it('recovers provider-idempotent, correlation, and operator-only lost responses conservatively', async () => {
    const cases = [
      { effect: 'fake.provider', build: BUILD_A, executor: provider, expected: 'succeeded', calls: 2 },
      { effect: 'fake.correlation', build: BUILD_B, executor: correlation, expected: 'succeeded', calls: 1 },
      { effect: 'fake.operator', build: BUILD_C, executor: operatorOnly, expected: 'outcome_unknown', calls: 1 },
    ] as const;
    for (const entry of cases) {
      const presented = await context(entry.effect, entry.build);
      const approved = await approvePresentation(presented.actionToken, presented.provenance, { client, registry, now: () => NOW });
      const before = entry.executor.calls.length;
      entry.executor.behavior = 'lost_after_effect';
      await processAttempt(approved.attempt.id, {
        client,
        registry,
        now: () => NOW,
        leaseOwner: () => `crash-${entry.effect}`,
      });
      const expired = await getExecutionAttempt(client, approved.attempt.id, LATER);
      assert.strictEqual(expired?.status, 'executing');
      entry.executor.behavior = 'success';
      await recoverExecutingAttempt(expired!, {
        client,
        registry,
        now: () => LATER,
        leaseOwner: () => `recovery-${entry.effect}`,
      });
      const recovered = await getExecutionAttempt(client, approved.attempt.id, LATER);
      assert.strictEqual(recovered?.status, entry.expected);
      assert.strictEqual(entry.executor.calls.length - before, entry.calls);
      assert.strictEqual(new Set(entry.executor.calls.slice(before).map((call) => call.idempotencyKey)).size, 1);
    }
  });

  it('requeues an expired pre-dispatch lease and rejects a stale lease result', async () => {
    const presented = await context();
    const approved = await approvePresentation(presented.actionToken, presented.provenance, { client, registry, now: () => NOW });
    const leased = await claimQueuedAttempt(
      client,
      approved.attempt.id,
      'crashed-before-dispatch',
      NOW.toISOString(),
      '2026-07-30T12:01:00.000Z'
    );
    assert.strictEqual(leased?.status, 'executing');
    const requeued = await requeueUndispatchedAttempt(client, leased!, LATER.toISOString());
    assert.strictEqual(requeued?.status, 'queued');

    const crashPresented = await context();
    const crashApproved = await approvePresentation(crashPresented.actionToken, crashPresented.provenance, { client, registry, now: () => NOW });
    const staleLease = await claimQueuedAttempt(
      client,
      crashApproved.attempt.id,
      'stale-worker',
      NOW.toISOString(),
      '2026-07-30T12:01:00.000Z'
    );
    const staleDispatched = await markDispatchStarted(client, staleLease!, NOW.toISOString());
    const currentLease = await reclaimDispatchedAttempt(
      client,
      crashApproved.attempt.id,
      staleDispatched!.revision,
      'current-worker',
      LATER.toISOString(),
      '2026-07-30T12:03:00.000Z'
    );
    assert.ok(currentLease);
    assert.strictEqual(await finalizeAttempt(
      client,
      staleDispatched!,
      'succeeded',
      LATER.toISOString(),
      {
        receipt: {
          receiptId: 'stale-receipt',
          effectHash: `sha256:${'9'.repeat(64)}`,
          recordedAt: LATER.toISOString(),
        },
      }
    ), null);
    assert.strictEqual((await finalizeAttempt(
      client,
      currentLease!,
      'succeeded',
      LATER.toISOString(),
      {
        receipt: {
          receiptId: 'current-receipt',
          effectHash: `sha256:${'8'.repeat(64)}`,
          recordedAt: LATER.toISOString(),
        },
      }
    ))?.status, 'succeeded');

    // The scheduled path proves queued attempts are found through GSI2, not a
    // table scan, and eventually executed.
    provider.behavior = 'success';
    const afterBackoff = new Date('2026-07-30T12:02:03.000Z');
    const recovery = await runRecovery({ client, registry, now: () => afterBackoff, leaseOwner: () => 'scheduled-worker' });
    assert.ok(recovery.attempted >= 1);
    assert.strictEqual((await getExecutionAttempt(client, approved.attempt.id, afterBackoff))?.status, 'succeeded');
  });

  it('rejects finalization from an otherwise-current lease after its expiry', async () => {
    const presented = await context();
    const approved = await approvePresentation(
      presented.actionToken,
      presented.provenance,
      { client, registry, now: () => NOW }
    );
    const leased = await claimQueuedAttempt(
      client,
      approved.attempt.id,
      'expired-current-worker',
      NOW.toISOString(),
      '2026-07-30T12:01:00.000Z'
    );
    const dispatched = await markDispatchStarted(client, leased!, NOW.toISOString());
    const finalized = await finalizeAttempt(
      client,
      dispatched!,
      'succeeded',
      LATER.toISOString(),
      {
        receipt: {
          receiptId: 'too-late-receipt',
          effectHash: `sha256:${'6'.repeat(64)}`,
          recordedAt: LATER.toISOString(),
        },
      }
    );
    assert.strictEqual(finalized, null);
    assert.strictEqual(
      (await getExecutionAttempt(client, approved.attempt.id, LATER))?.status,
      'executing'
    );
  });

  it('rechecks authorization and target revision immediately before dispatch', async () => {
    const presented = await context();
    const approved = await approvePresentation(presented.actionToken, presented.provenance, { client, registry, now: () => NOW });
    await putApprovalPermission(client, { userId: 'owner-1', permissionRef: PERMISSION, enabled: false, revision: 4 });
    const before = provider.calls.length;
    const failed = await processAttempt(approved.attempt.id, {
      client,
      registry,
      now: () => NOW,
      leaseOwner: () => 'authorization-worker',
    });
    assert.strictEqual(failed?.status, 'failed_safe');
    assert.strictEqual(failed?.errorCode, 'pre_dispatch_check_failed');
    assert.strictEqual(provider.calls.length, before);
    await putApprovalPermission(client, { userId: 'owner-1', permissionRef: PERMISSION, enabled: true, revision: 5 });

    const disabledPresented = await context();
    const disabledApproved = await approvePresentation(
      disabledPresented.actionToken,
      disabledPresented.provenance,
      { client, registry, now: () => NOW }
    );
    await updateUser(client, 'owner-1', { disabled: true });
    const disabledCalls = provider.calls.length;
    const disabled = await processAttempt(disabledApproved.attempt.id, {
      client,
      registry,
      now: () => NOW,
      leaseOwner: () => 'disabled-user-worker',
    });
    assert.strictEqual(disabled?.status, 'failed_safe');
    assert.strictEqual(provider.calls.length, disabledCalls);
    await updateUser(client, 'owner-1', { disabled: false });
  });

  it('enforces owner/admin status and revision-checked manual resolution without execution', async () => {
    const presented = await context('fake.operator', BUILD_C);
    const approved = await approvePresentation(presented.actionToken, presented.provenance, { client, registry, now: () => NOW });
    const unknown = await compareAndSetExecutionAttempt(
      client,
      approved.attempt.id,
      'queued',
      'outcome_unknown',
      1,
      NOW.toISOString()
    );
    const path = `/api/conversational/execution-attempts/${unknown.id}`;
    const ownerStatus = await handleConversationalExecutionRoutes(path, 'GET', event('GET', path, 'owner-1'), client);
    assert.strictEqual(ownerStatus?.statusCode, 200);
    assert.doesNotMatch(ownerStatus!.body, /idempotencyRef|canonicalPayloadHash|renderedViewHash|proposal body|token/i);
    assert.strictEqual((await handleConversationalExecutionRoutes(path, 'GET', event('GET', path, 'wrong-owner'), client))?.statusCode, 404);
    assert.strictEqual((await handleConversationalExecutionRoutes(
      `${path}/resolve`,
      'POST',
      event('POST', `${path}/resolve`, 'owner-1', { revision: unknown.revision, outcome: 'no_effect', reason: 'Verified no effect' }),
      client
    ))?.statusCode, 404);
    assert.strictEqual((await handleConversationalExecutionRoutes(
      `${path}/resolve`,
      'POST',
      event('POST', `${path}/resolve`, 'admin-1', {
        revision: unknown.revision,
        outcome: 'no_effect',
        reason: 'authorization=Bearer forbidden',
      }),
      client
    ))?.statusCode, 400);
    const callsBefore = operatorOnly.calls.length;
    const resolved = await handleConversationalExecutionRoutes(
      `${path}/resolve`,
      'POST',
      event('POST', `${path}/resolve`, 'admin-1', {
        revision: unknown.revision,
        outcome: 'no_effect',
        reason: 'Operator verified the fake ledger has no effect',
      }),
      client,
      { now: () => LATER }
    );
    assert.strictEqual(resolved?.statusCode, 200);
    assert.match(resolved!.body, /manually_resolved/);
    assert.strictEqual(operatorOnly.calls.length, callsBefore);
    const duplicate = await handleConversationalExecutionRoutes(
      `${path}/resolve`,
      'POST',
      event('POST', `${path}/resolve`, 'admin-1', {
        revision: unknown.revision,
        outcome: 'effect_applied',
        reason: 'Duplicate delivery returns stored truth',
      }),
      client,
      { now: () => LATER }
    );
    assert.strictEqual(duplicate?.statusCode, 200);
    assert.match(duplicate!.body, /no_effect/);
  });

  it('allows only admin read-only reconciliation and rejects caller-supplied provider results', async () => {
    const presented = await context('fake.correlation', BUILD_B);
    const approved = await approvePresentation(presented.actionToken, presented.provenance, { client, registry, now: () => NOW });
    const unknown = await compareAndSetExecutionAttempt(
      client,
      approved.attempt.id,
      'queued',
      'outcome_unknown',
      1,
      NOW.toISOString()
    );
    const path = `/api/conversational/execution-attempts/${unknown.id}/reconcile`;
    assert.strictEqual((await handleConversationalExecutionRoutes(
      path,
      'POST',
      event('POST', path, 'owner-1', { revision: unknown.revision }),
      client,
      { registry, now: () => LATER }
    ))?.statusCode, 404);
    assert.strictEqual((await handleConversationalExecutionRoutes(
      path,
      'POST',
      event('POST', path, 'admin-1', { revision: unknown.revision, providerResult: 'applied' }),
      client,
      { registry, now: () => LATER }
    ))?.statusCode, 400);
    correlation.reconciliationOutcome = 'not_applied';
    const executeCalls = correlation.calls.length;
    const reconciled = await handleConversationalExecutionRoutes(
      path,
      'POST',
      event('POST', path, 'admin-1', { revision: unknown.revision }),
      client,
      { registry, now: () => LATER }
    );
    assert.strictEqual(reconciled?.statusCode, 200);
    assert.match(reconciled!.body, /failed_safe/);
    assert.strictEqual(correlation.calls.length, executeCalls);
  });

  it('binds dispatch to the exact approved identity and channel records', async () => {
    const presented = await context();
    const approved = await approvePresentation(
      presented.actionToken,
      presented.provenance,
      { client, registry, now: () => NOW }
    );
    assert.strictEqual(
      await preDispatchCheck(
        { ...approved.attempt, channelBindingId: 'a-different-channel-binding' },
        { client, registry, now: () => NOW }
      ),
      null
    );
    await createIdentityBinding(client, {
      ...(() => {
        const { expiresAt: _expiresAt, ttl: _ttl, ...base } =
          recordBase('identity-sibling', 'identity_binding');
        return base;
      })(),
      recordType: 'identity_binding',
      userId: 'owner-1',
      channel: 'telegram',
      channelUserId: 'telegram-owner-1',
      status: 'active',
      provisionedBy: 'admin-1',
      provisionedAt: NOW.toISOString(),
      revision: 1,
    });
    await revokeIdentityBinding(
      client,
      'web',
      'web-owner-1',
      1,
      'admin-1',
      NOW.toISOString()
    );
    const callsBefore = provider.calls.length;
    const failed = await processAttempt(approved.attempt.id, {
      client,
      registry,
      now: () => NOW,
      leaseOwner: () => 'exact-binding-worker',
    });
    assert.strictEqual(failed?.status, 'failed_safe');
    assert.strictEqual(failed?.errorCode, 'pre_dispatch_check_failed');
    assert.strictEqual(provider.calls.length, callsBefore);
  });
});
