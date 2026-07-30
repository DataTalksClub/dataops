import { after, before, describe, it } from 'node:test';
import assert from 'node:assert';
import { GetCommand, QueryCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

import { getClient } from '../src/db/client';
import { createTables, TABLE_CONVERSATIONAL_STATE } from '../src/db/setup';
import {
  appendConversationOutbound,
  consumeConversationalActionAndAppend,
  createConversation,
  getConversation,
  getConversationEventByIdempotency,
  getConversationalPrivatePayload,
  putConversationalPrivatePayload,
  transitionStagedMediaAndAppend,
  transitionIdentityBindingWithAudit,
} from '../src/conversation/repository';
import {
  expiryFrom,
  type ConversationEvent,
  type ConversationalPrivatePayload,
  type IdentityBinding,
  type IdentityBindingAudit,
} from '../src/conversation/types';

const NOW = '2026-07-30T12:00:00.000Z';

function privatePayload(
  id: string,
  conversationId: string,
  content: Record<string, unknown>
): ConversationalPrivatePayload {
  return {
    id,
    recordType: 'conversational_private_payload',
    schemaVersion: 1,
    createdAt: NOW,
    updatedAt: NOW,
    ...expiryFrom(NOW, 30),
    conversationId,
    classification: 'private',
    content: content as ConversationalPrivatePayload['content'],
  };
}

function event(
  id: string,
  conversationId: string,
  sequence: number,
  idempotencyKey: string,
  direction: 'inbound' | 'outbound',
  payloadRef: string
): ConversationEvent {
  return {
    id,
    recordType: 'conversation_event',
    schemaVersion: 1,
    createdAt: NOW,
    updatedAt: NOW,
    ...expiryFrom(NOW, 30),
    conversationId,
    sequence,
    channel: 'telegram',
    idempotencyKey,
    eventType: direction === 'outbound'
      ? 'assistant_output'
      : idempotencyKey.endsWith(':message') ? 'message' : 'button_action',
    direction,
    actorId: direction === 'outbound' ? 'conversational-core' : 'operator-transaction',
    provenance: `${direction}:${id}`,
    classification: 'private',
    payloadRef,
  };
}

describe('Telegram production DynamoDB transactions', {
  skip: !process.env.DYNAMODB_ENDPOINT,
}, () => {
  let client: DynamoDBDocumentClient;

  before(async () => {
    assert.strictEqual(process.env.NODE_ENV, 'production');
    client = await getClient();
    await createTables(client);
  });

  after(() => {
    client?.destroy();
  });

  it('atomically writes identity authorization and its one-year audit', async () => {
    const binding: IdentityBinding = {
      id: 'identity-transaction',
      recordType: 'identity_binding',
      schemaVersion: 1,
      createdAt: NOW,
      updatedAt: NOW,
      userId: 'operator-transaction',
      channel: 'telegram',
      channelUserId: '77001',
      status: 'active',
      provisionedBy: 'admin-transaction',
      provisionedAt: NOW,
      revision: 1,
    };
    const audit: IdentityBindingAudit = {
      id: 'identity-audit-transaction',
      recordType: 'identity_binding_audit',
      schemaVersion: 1,
      createdAt: NOW,
      updatedAt: NOW,
      ...expiryFrom(NOW, 365),
      channel: 'telegram',
      channelUserId: '77001',
      userId: 'operator-transaction',
      action: 'created',
      actorId: 'admin-transaction',
      outcome: 'succeeded',
      bindingRevision: 1,
    };
    await transitionIdentityBindingWithAudit(client, binding, audit, null);
    const stored = await client.send(new GetCommand({
      TableName: TABLE_CONVERSATIONAL_STATE,
      Key: { PK: 'IDENTITY#telegram#77001', SK: 'META' },
      ConsistentRead: true,
    }));
    const audits = await client.send(new QueryCommand({
      TableName: TABLE_CONVERSATIONAL_STATE,
      KeyConditionExpression: 'PK = :pk',
      ExpressionAttributeValues: { ':pk': 'IDENTITY_AUDIT#telegram#77001' },
      ConsistentRead: true,
    }));
    assert.strictEqual(stored.Item?.revision, 1);
    assert.strictEqual(audits.Items?.length, 1);
    assert.strictEqual(audits.Items?.[0].bindingRevision, 1);
  });

  it('allows exactly one absent identity transaction and one conditional loser', async () => {
    const channelUserId = '77002';
    const attempts = ['a', 'b'].map((suffix): {
      binding: IdentityBinding;
      audit: IdentityBindingAudit;
    } => ({
      binding: {
        id: `identity-transaction-race-${suffix}`,
        recordType: 'identity_binding',
        schemaVersion: 1,
        createdAt: NOW,
        updatedAt: NOW,
        userId: 'operator-transaction',
        channel: 'telegram',
        channelUserId,
        status: 'active',
        provisionedBy: 'admin-transaction',
        provisionedAt: NOW,
        revision: 1,
      },
      audit: {
        id: `identity-audit-transaction-race-${suffix}`,
        recordType: 'identity_binding_audit',
        schemaVersion: 1,
        createdAt: NOW,
        updatedAt: NOW,
        ...expiryFrom(NOW, 365),
        channel: 'telegram',
        channelUserId,
        userId: 'operator-transaction',
        action: 'created',
        actorId: 'admin-transaction',
        outcome: 'succeeded',
        bindingRevision: 1,
      },
    }));

    const outcomes = await Promise.allSettled(attempts.map(({ binding, audit }) => (
      transitionIdentityBindingWithAudit(client, binding, audit, null)
    )));
    assert.strictEqual(outcomes.filter((outcome) => outcome.status === 'fulfilled').length, 1);
    const rejected = outcomes.filter(
      (outcome): outcome is PromiseRejectedResult => outcome.status === 'rejected'
    );
    assert.strictEqual(rejected.length, 1);
    assert.strictEqual(
      (rejected[0].reason as { name?: string }).name,
      'TransactionCanceledException'
    );

    const stored = await client.send(new GetCommand({
      TableName: TABLE_CONVERSATIONAL_STATE,
      Key: { PK: `IDENTITY#telegram#${channelUserId}`, SK: 'META' },
      ConsistentRead: true,
    }));
    assert.ok(attempts.some(({ binding }) => binding.id === stored.Item?.id));
    const audits = await client.send(new QueryCommand({
      TableName: TABLE_CONVERSATIONAL_STATE,
      KeyConditionExpression: 'PK = :pk',
      ExpressionAttributeValues: { ':pk': `IDENTITY_AUDIT#telegram#${channelUserId}` },
      ConsistentRead: true,
    }));
    assert.strictEqual(audits.Items?.length, 1);
    assert.strictEqual(audits.Items?.[0].bindingRevision, 1);
  });

  it('consumes one of two sibling callbacks with one event and one revision increment', async () => {
    const conversationId = 'telegram-transaction-conversation';
    await createConversation(client, {
      id: conversationId,
      recordType: 'conversation',
      schemaVersion: 1,
      createdAt: NOW,
      updatedAt: NOW,
      ...expiryFrom(NOW, 30),
      ownerUserId: 'operator-transaction',
      audience: 'private',
      status: 'active',
      nextEventSequence: 1,
      revision: 1,
    });
    const actionIds = [
      'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    ];
    const actionRecords = actionIds.map((id, index) => privatePayload(id, conversationId, {
      kind: 'telegram_action',
      status: 'active',
      revision: 1,
      actorId: 'operator-transaction',
      identityBindingId: 'identity-transaction',
      channelBindingId: 'channel-binding-transaction',
      channelConversationKey: '77001',
      expectedConversationRevision: 2,
      sourceUpdateId: 'transaction-preview',
      action: { type: index === 0 ? 'media_use' : 'media_discard' },
      siblingActionIds: [actionIds[index === 0 ? 1 : 0]],
    }));
    const outboundPayload = privatePayload(
      'outbound-transaction',
      conversationId,
      {
        kind: 'telegram_outbound',
        status: 'ready',
        revision: 1,
        text: 'preview',
        buttons: [],
      }
    );
    await appendConversationOutbound(
      client,
      event(
        'outbound-event-transaction',
        conversationId,
        1,
        'telegram:transaction-preview:outbound',
        'outbound',
        outboundPayload.id
      ),
      1,
      'operator-transaction',
      outboundPayload,
      actionRecords
    );

    const attempts = actionIds.map((actionId, index) => {
      const callbackEvent = event(
        `button-event-${index}`,
        conversationId,
        2,
        `telegram:transaction-click-${index}:button_action`,
        'inbound',
        actionId
      );
      return consumeConversationalActionAndAppend(client, {
        actionId,
        siblingActionIds: [actionIds[index === 0 ? 1 : 0]],
        conversationId,
        ownerUserId: 'operator-transaction',
        actorId: 'operator-transaction',
        identityBindingId: 'identity-transaction',
        channelBindingId: 'channel-binding-transaction',
        channelConversationKey: '77001',
        expectedConversationRevision: 2,
        consumedAt: NOW,
      }, callbackEvent);
    });
    const results = await Promise.all(attempts);
    assert.strictEqual(results.filter(Boolean).length, 1);

    const storedActions = await Promise.all(actionIds.map((id) => (
      getConversationalPrivatePayload(client, conversationId, id, 'operator-transaction')
    )));
    assert.deepStrictEqual(
      storedActions.map((record) => (record!.content as Record<string, unknown>).status).sort(),
      ['consumed', 'revoked']
    );
    const conversation = await getConversation(client, conversationId);
    assert.strictEqual(conversation?.revision, 3);
    assert.strictEqual(conversation?.nextEventSequence, 3);

    const events = await client.send(new QueryCommand({
      TableName: TABLE_CONVERSATIONAL_STATE,
      KeyConditionExpression: 'PK = :pk AND begins_with(SK, :prefix)',
      ExpressionAttributeValues: {
        ':pk': `CONVERSATION#${conversationId}`,
        ':prefix': 'EVENT#',
      },
      ConsistentRead: true,
    }));
    assert.strictEqual(events.Items?.length, 2);
    const winning = results.find(Boolean)!;
    assert.ok(await getConversationEventByIdempotency(
      client,
      'telegram',
      winning.event.idempotencyKey,
      conversationId
    ));
    const losingIndex = results.findIndex((result) => !result);
    assert.strictEqual(await getConversationEventByIdempotency(
      client,
      'telegram',
      `telegram:transaction-click-${losingIndex}:button_action`,
      conversationId
    ), null);
  });

  it('allows one production winner across media use, discard, and correction', async () => {
    const conversationId = 'telegram-media-lifecycle-transaction';
    await createConversation(client, {
      id: conversationId,
      recordType: 'conversation',
      schemaVersion: 1,
      createdAt: NOW,
      updatedAt: NOW,
      ...expiryFrom(NOW, 30),
      ownerUserId: 'operator-transaction',
      audience: 'private',
      status: 'active',
      nextEventSequence: 1,
      revision: 1,
    });
    const mediaId = 'media-lifecycle-transaction';
    const actionIds = [
      'sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
      'sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd',
    ];
    await putConversationalPrivatePayload(client, privatePayload(mediaId, conversationId, {
      kind: 'voice_note',
      status: 'staged',
      revision: 2,
      text: 'private provider transcript',
      trust: 'untrusted_provider_derived',
    }));
    const actions = actionIds.map((id, index) => privatePayload(id, conversationId, {
      kind: 'telegram_action',
      status: 'active',
      revision: 1,
      actorId: 'operator-transaction',
      identityBindingId: 'identity-transaction',
      channelBindingId: 'channel-binding-transaction',
      channelConversationKey: '77001',
      expectedConversationRevision: 2,
      sourceUpdateId: 'media-lifecycle-preview',
      action: {
        type: index === 0 ? 'media_use' : 'media_discard',
        payloadRef: mediaId,
      },
      siblingActionIds: [actionIds[index === 0 ? 1 : 0]],
    }));
    const preview = privatePayload('media-lifecycle-preview', conversationId, {
      kind: 'telegram_outbound',
      status: 'ready',
      revision: 1,
      text: 'private provider transcript',
      buttons: [],
    });
    await appendConversationOutbound(
      client,
      event(
        'media-lifecycle-preview-event',
        conversationId,
        1,
        'telegram:media-lifecycle-preview:outbound',
        'outbound',
        preview.id
      ),
      1,
      'operator-transaction',
      preview,
      actions,
      { payloadId: mediaId, expectedPayloadRevision: 2, actionIds }
    );

    const correction = privatePayload('media-lifecycle-correction', conversationId, {
      text: 'operator correction',
      source: 'operator_correction_of_untrusted_media',
      correctedPayloadRef: mediaId,
    });
    const common = {
      conversationId,
      ownerUserId: 'operator-transaction',
      actorId: 'operator-transaction',
      identityBindingId: 'identity-transaction',
      channelBindingId: 'channel-binding-transaction',
      channelConversationKey: '77001',
      expectedConversationRevision: 2,
      consumedAt: NOW,
      mediaPayloadId: mediaId,
      expectedMediaRevision: 2,
    };
    const attempts = [
      transitionStagedMediaAndAppend(client, {
        ...common,
        actionId: actionIds[0],
        siblingActionIds: [actionIds[1]],
        terminalStatus: 'used',
      }, event(
        'media-use-event',
        conversationId,
        2,
        'telegram:media-use:message',
        'inbound',
        actionIds[0]
      )),
      transitionStagedMediaAndAppend(client, {
        ...common,
        actionId: actionIds[1],
        siblingActionIds: [actionIds[0]],
        terminalStatus: 'discarded',
      }, event(
        'media-discard-event',
        conversationId,
        2,
        'telegram:media-discard:button_action',
        'inbound',
        actionIds[1]
      )),
      transitionStagedMediaAndAppend(client, {
        ...common,
        actionId: actionIds[0],
        siblingActionIds: [actionIds[1]],
        terminalStatus: 'corrected',
        correctionPayload: correction,
      }, event(
        'media-correction-event',
        conversationId,
        2,
        'telegram:media-correction:message',
        'inbound',
        correction.id
      )),
    ];
    const results = await Promise.all(attempts);
    assert.strictEqual(results.filter(Boolean).length, 1);
    const winnerIndex = results.findIndex(Boolean);
    const expectedStatus = ['used', 'discarded', 'corrected'][winnerIndex];
    const media = (await getConversationalPrivatePayload(
      client, conversationId, mediaId, 'operator-transaction'
    ))!;
    const mediaContent = media.content as Record<string, unknown>;
    assert.strictEqual(mediaContent.status, expectedStatus);
    assert.strictEqual(
      'text' in mediaContent,
      expectedStatus === 'used'
    );
    const storedActions = await Promise.all(actionIds.map((id) => (
      getConversationalPrivatePayload(client, conversationId, id, 'operator-transaction')
    )));
    const actionStatuses = storedActions.map(
      (stored) => (stored!.content as Record<string, unknown>).status
    ).sort();
    assert.deepStrictEqual(
      actionStatuses,
      expectedStatus === 'corrected' ? ['revoked', 'revoked'] : ['consumed', 'revoked']
    );
    assert.strictEqual(Boolean(await getConversationalPrivatePayload(
      client, conversationId, correction.id, 'operator-transaction'
    )), expectedStatus === 'corrected');
    const conversation = await getConversation(client, conversationId);
    assert.strictEqual(conversation?.revision, 3);
    assert.strictEqual(conversation?.nextEventSequence, 3);
    const events = await client.send(new QueryCommand({
      TableName: TABLE_CONVERSATIONAL_STATE,
      KeyConditionExpression: 'PK = :pk AND begins_with(SK, :prefix)',
      ExpressionAttributeValues: {
        ':pk': `CONVERSATION#${conversationId}`,
        ':prefix': 'EVENT#',
      },
      ConsistentRead: true,
    }));
    assert.strictEqual(events.Items?.length, 2);
  });
});
