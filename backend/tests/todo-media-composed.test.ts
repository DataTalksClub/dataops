import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { mkdir, rm, writeFile } from 'fs/promises';
import path from 'path';
import { encode as encodeJpeg } from 'jpeg-js';
import {
  ScanCommand,
  type DynamoDBDocumentClient,
} from '@aws-sdk/lib-dynamodb';

import { getClient } from '../src/db/client';
import {
  createTables,
  deleteTables,
  TABLE_CONVERSATIONAL_STATE,
  TABLE_TASKS,
} from '../scripts/local-dynamodb';
import { createUserWithId } from '../src/db/users';
import {
  createIdentityBinding,
  getConversationalPrivatePayload,
  getExecutionAttempt,
  getResultNotification,
} from '../src/conversation/repository';
import {
  getProposalVersion,
  putApprovalPermission,
} from '../src/conversation/executionRepository';
import { ExecutorRegistry } from '../src/conversation/execution';
import { processAttempt } from '../src/conversation/executionWorker';
import {
  handleConversationalTelegramWebhook,
  type AdapterConfig,
  type TelegramAdapterDependencies,
} from '../src/conversation/telegramAdapter';
import type {
  PhotoDescriber,
  TelegramClient,
  VoiceTranscriber,
} from '../src/conversation/telegramMedia';
import { TodoConversationalCore } from '../src/conversation/todoCore';
import {
  ActorTodoExecutor,
  ActorTodoWriter,
} from '../src/conversation/todoWriter';
import { dispatchOne } from '../src/conversation/resultDispatcher';
import { TODO_ACTION, TODO_PERMISSION, TODO_PLUGIN_ID } from '../src/conversation/todoPlugin';
import type {
  ConversationalModel,
  ModelRequest,
  ModelResponse,
} from '../src/conversation/zaiClient';
import type { LambdaEvent } from '../src/types';

const NOW = new Date('2026-07-30T12:00:00.000Z');
const ACTOR_ID = 'actor-media-composed';
const CHAT_ID = '9201';
const ROOT = path.resolve('..', '.tmp', 'todo-media-composed');

function validOgg(): Buffer {
  const body = Buffer.concat([Buffer.from('OpusHead'), Buffer.alloc(11)]);
  const page = Buffer.alloc(28 + body.length);
  page.write('OggS', 0, 'ascii');
  page[4] = 0;
  page.writeBigUInt64LE(30n * 48_000n, 6);
  page[26] = 1;
  page[27] = body.length;
  body.copy(page, 28);
  return page;
}

function validJpeg(): Buffer {
  return encodeJpeg({
    width: 32,
    height: 16,
    data: Buffer.alloc(32 * 16 * 4, 127),
  }, 80).data;
}

function event(update: Record<string, unknown>): LambdaEvent {
  return {
    httpMethod: 'POST',
    path: '/api/webhook/telegram',
    headers: { 'x-telegram-bot-api-secret-token': 'test-secret' },
    body: JSON.stringify(update),
  };
}

function message(updateId: number, content: Record<string, unknown>): Record<string, unknown> {
  return {
    update_id: updateId,
    message: {
      message_id: updateId,
      from: { id: Number(CHAT_ID) },
      chat: { id: Number(CHAT_ID), type: 'private' },
      ...content,
    },
  };
}

function callback(updateId: number, data: string, from = CHAT_ID): Record<string, unknown> {
  return {
    update_id: updateId,
    callback_query: {
      id: `callback-${updateId}`,
      from: { id: Number(from) },
      data,
      message: {
        message_id: updateId,
        chat: { id: Number(from), type: 'private' },
      },
    },
  };
}

class FakeTelegram implements TelegramClient {
  readonly sent: Array<{
    chatId: string;
    text: string;
    buttons?: Array<{ text: string; data: string }>;
  }> = [];
  readonly files = new Map<string, { path: string; bytes: Buffer }>();

  async getFile(fileId: string) {
    const file = this.files.get(fileId);
    if (!file) throw new Error('missing test file');
    return { filePath: file.path, fileSize: file.bytes.length };
  }

  async download(filePath: string, targetPath: string, maximumBytes: number) {
    const file = [...this.files.values()].find((candidate) => candidate.path === filePath);
    if (!file || file.bytes.length > maximumBytes) throw new Error('invalid test download');
    await writeFile(targetPath, file.bytes, { mode: 0o600 });
    return file.bytes.length;
  }

  async sendMessage(chatId: string, text: string) {
    this.sent.push({ chatId, text });
  }

  async sendKeyboard(
    chatId: string,
    text: string,
    buttons: Array<{ text: string; data: string }>
  ) {
    this.sent.push({ chatId, text, buttons });
  }

  async answerCallbackQuery() {}
}

describe('confirmed Telegram media composes with the real todo core', {
  skip: !process.env.DYNAMODB_ENDPOINT,
}, () => {
  let client: DynamoDBDocumentClient;

  before(async () => {
    process.env.CONVERSATIONAL_ENABLED_PLUGINS = 'todo';
    process.env.CONVERSATIONAL_EXECUTION_ENABLED = 'true';
    client = await getClient();
    await deleteTables(client);
    await createTables(client);
    await mkdir(ROOT, { recursive: true });
  });

  after(async () => {
    await rm(ROOT, { recursive: true, force: true });
    process.env.CONVERSATIONAL_ENABLED_PLUGINS = 'none';
    process.env.CONVERSATIONAL_EXECUTION_ENABLED = 'false';
  });

  it('keeps voice/photo inert until confirmation and completes approved voice and corrected photo todos', async () => {
    await createUserWithId(client, ACTOR_ID, {
      name: 'Media operator',
      email: 'media-operator@example.test',
      role: 'operator',
    });
    await createIdentityBinding(client, {
      id: 'identity-media-composed',
      recordType: 'identity_binding',
      schemaVersion: 1,
      createdAt: NOW.toISOString(),
      updatedAt: NOW.toISOString(),
      userId: ACTOR_ID,
      channel: 'telegram',
      channelUserId: CHAT_ID,
      status: 'active',
      provisionedBy: 'admin',
      provisionedAt: NOW.toISOString(),
      revision: 1,
    });
    await putApprovalPermission(client, {
      userId: ACTOR_ID,
      permissionRef: TODO_PERMISSION,
      enabled: true,
      revision: 1,
    });

    let modelCalls = 0;
    let candidate = {
      description: 'Call Jane',
      date: '2026-08-04',
    };
    const model: ConversationalModel = {
      async complete(request: ModelRequest): Promise<ModelResponse> {
        modelCalls += 1;
        if (request.expectedTool === 'skill_load') {
          return { kind: 'tool', name: 'skill_load', input: { plugin: TODO_PLUGIN_ID } };
        }
        const nonce = request.system.match(/"loadNonce":"([^"]+)"/)?.[1];
        assert.ok(nonce);
        return {
          kind: 'tool',
          name: 'skill_invoke',
          input: {
            plugin: TODO_PLUGIN_ID,
            action: TODO_ACTION,
            input: candidate,
            load_nonce: nonce,
          },
        };
      },
    };
    const telegram = new FakeTelegram();
    const voice: VoiceTranscriber = {
      async transcribe() {
        return 'Call Jane next Tuesday';
      },
    };
    const photo: PhotoDescriber = {
      async describe() {
        return 'Send the report on 2026-08-05';
      },
    };
    const core = new TodoConversationalCore({ client, model, now: () => NOW });
    const config: AdapterConfig = {
      botToken: 'fake',
      webhookSecret: 'test-secret',
      allowedChatIds: new Set([CHAT_ID]),
      voiceEnabled: true,
      photoEnabled: true,
      tempRoot: ROOT,
      hardDeadlineMs: 28_000,
      telegramApiTimeoutMs: 1_000,
      telegramMaximumResponseBytes: 65_536,
    };
    const dependencies: TelegramAdapterDependencies = {
      client,
      telegram,
      core,
      voice,
      photo,
      now: () => NOW,
      limits: {
        voiceMaximumBytes: 20 * 1024 * 1024,
        voiceMaximumSeconds: 300,
        photoMaximumBytes: 10 * 1024 * 1024,
        photoMaximumPixels: 20_000_000,
        downloadTimeoutMs: 1_000,
        providerTimeoutMs: 1_000,
        providerMaximumResponseBytes: 65_536,
        maximumDerivedTextBytes: 16_384,
      },
    };
    const taskCount = async () => Number(
      (await client.send(new ScanCommand({ TableName: TABLE_TASKS }))).Count || 0
    );
    const initialTasks = await taskCount();

    telegram.files.set('voice-file', { path: 'voice.ogg', bytes: validOgg() });
    await handleConversationalTelegramWebhook(event(message(300, {
      voice: {
        file_id: 'voice-file',
        file_size: validOgg().length,
        duration: 30,
        mime_type: 'audio/ogg',
      },
    })), config, dependencies);
    assert.equal(modelCalls, 0);
    assert.equal(await taskCount(), initialTasks);
    const voiceUse = telegram.sent.at(-1)?.buttons?.find(
      (button) => button.text === 'Use this text'
    )?.data;
    assert.ok(voiceUse);

    await handleConversationalTelegramWebhook(
      event(callback(301, voiceUse, '9202')),
      { ...config, allowedChatIds: new Set([CHAT_ID, '9202']) },
      dependencies
    );
    assert.equal(modelCalls, 0);
    assert.equal(await taskCount(), initialTasks);

    await handleConversationalTelegramWebhook(
      event(callback(302, voiceUse)),
      config,
      dependencies
    );
    assert.equal(modelCalls, 2);
    assert.match(telegram.sent.at(-1)?.text || '', /Call Jane/);
    assert.equal(await taskCount(), initialTasks);
    const approve = telegram.sent.at(-1)?.buttons?.find(
      (button) => button.text === 'Approve todo'
    )?.data;
    assert.ok(approve);

    await handleConversationalTelegramWebhook(
      event(callback(303, voiceUse)),
      config,
      dependencies
    );
    assert.equal(modelCalls, 2);
    assert.equal(await taskCount(), initialTasks);

    await handleConversationalTelegramWebhook(
      event(callback(304, approve)),
      config,
      dependencies
    );
    assert.equal(await taskCount(), initialTasks);
    const attempts = await client.send(new ScanCommand({
      TableName: TABLE_CONVERSATIONAL_STATE,
      FilterExpression: 'recordType = :type AND actorId = :actor',
      ExpressionAttributeValues: {
        ':type': 'execution_attempt',
        ':actor': ACTOR_ID,
      },
    }));
    const attemptId = String(attempts.Items?.find((item) => item.status === 'queued')?.id || '');
    assert.ok(attemptId);

    const writer = new ActorTodoWriter(client, () => NOW);
    const registry = new ExecutorRegistry([
      new ActorTodoExecutor(client, writer, () => NOW),
    ]);
    const previousNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      await processAttempt(attemptId, {
        client,
        registry,
        now: () => NOW,
        leaseOwner: () => 'media-worker',
      });
    } finally {
      process.env.NODE_ENV = previousNodeEnv;
    }
    assert.equal(await taskCount(), initialTasks + 1);
    const notification = await getResultNotification(
      client,
      `result-notification-${attemptId}`,
      NOW
    );
    assert.ok(notification);
    const delivered: string[] = [];
    assert.equal(await dispatchOne(notification, {
      client,
      now: () => NOW,
      transport: {
        async sendPrivateMessage(destination, text) {
          assert.equal(destination, CHAT_ID);
          delivered.push(text);
        },
      },
    }), 'delivered');
    assert.match(delivered[0], /Todo created/);
    assert.match(delivered[0], /Call Jane/);

    candidate = {
      description: 'Send the corrected report',
      date: '2026-08-05',
    };
    telegram.files.set('discarded-photo', {
      path: 'discarded.jpg',
      bytes: validJpeg(),
    });
    await handleConversationalTelegramWebhook(event(message(310, {
      photo: [{
        file_id: 'discarded-photo',
        file_size: validJpeg().length,
        width: 32,
        height: 16,
      }],
    })), config, dependencies);
    const discardPhoto = telegram.sent.at(-1)?.buttons?.find(
      (button) => button.text === 'Discard'
    )?.data;
    assert.ok(discardPhoto);
    await handleConversationalTelegramWebhook(
      event(callback(311, discardPhoto)),
      config,
      dependencies
    );
    assert.equal(modelCalls, 2);
    assert.equal(await taskCount(), initialTasks + 1);

    telegram.files.set('used-photo', { path: 'used.jpg', bytes: validJpeg() });
    await handleConversationalTelegramWebhook(event(message(312, {
      photo: [{
        file_id: 'used-photo',
        file_size: validJpeg().length,
        width: 32,
        height: 16,
      }],
    })), config, dependencies);
    const usePhoto = telegram.sent.at(-1)?.buttons?.find(
      (button) => button.text === 'Use this text'
    )?.data;
    assert.ok(usePhoto);

    await handleConversationalTelegramWebhook(
      event(callback(313, usePhoto, '9202')),
      { ...config, allowedChatIds: new Set([CHAT_ID, '9202']) },
      dependencies
    );
    assert.equal(modelCalls, 2);
    assert.equal(await taskCount(), initialTasks + 1);

    await handleConversationalTelegramWebhook(event(message(314, {
      text: 'Send the corrected report tomorrow at 09:00',
    })), config, dependencies);
    assert.equal(modelCalls, 3);
    assert.match(telegram.sent.at(-1)?.text || '', /confirm date only/i);
    assert.equal(await taskCount(), initialTasks + 1);

    await handleConversationalTelegramWebhook(
      event(callback(315, usePhoto)),
      config,
      dependencies
    );
    assert.equal(modelCalls, 3);
    assert.equal(await taskCount(), initialTasks + 1);

    await handleConversationalTelegramWebhook(event(message(316, {
      text: 'confirm date only',
    })), config, dependencies);
    assert.equal(modelCalls, 5);
    assert.match(telegram.sent.at(-1)?.text || '', /Send the corrected report/);
    assert.match(telegram.sent.at(-1)?.text || '', /2026-08-05/);
    assert.equal(await taskCount(), initialTasks + 1);
    const photoApprove = telegram.sent.at(-1)?.buttons?.find(
      (button) => button.text === 'Approve todo'
    )?.data;
    assert.ok(photoApprove);

    await handleConversationalTelegramWebhook(
      event(callback(317, photoApprove, '9202')),
      { ...config, allowedChatIds: new Set([CHAT_ID, '9202']) },
      dependencies
    );
    assert.equal(await taskCount(), initialTasks + 1);

    await handleConversationalTelegramWebhook(
      event(callback(318, photoApprove)),
      config,
      dependencies
    );
    assert.equal(await taskCount(), initialTasks + 1);
    const photoAttempts = await client.send(new ScanCommand({
      TableName: TABLE_CONVERSATIONAL_STATE,
      FilterExpression: 'recordType = :type AND actorId = :actor',
      ExpressionAttributeValues: {
        ':type': 'execution_attempt',
        ':actor': ACTOR_ID,
      },
    }));
    const photoAttemptId = String(
      photoAttempts.Items?.find((item) => item.status === 'queued')?.id || ''
    );
    assert.ok(photoAttemptId);

    await handleConversationalTelegramWebhook(
      event(callback(319, photoApprove)),
      config,
      dependencies
    );
    const queuedAfterReplay = await client.send(new ScanCommand({
      TableName: TABLE_CONVERSATIONAL_STATE,
      FilterExpression: 'recordType = :type AND actorId = :actor AND #status = :queued',
      ExpressionAttributeNames: { '#status': 'status' },
      ExpressionAttributeValues: {
        ':type': 'execution_attempt',
        ':actor': ACTOR_ID,
        ':queued': 'queued',
      },
    }));
    assert.equal(queuedAfterReplay.Count, 1);

    process.env.NODE_ENV = 'production';
    try {
      await processAttempt(photoAttemptId, {
        client,
        registry,
        now: () => NOW,
        leaseOwner: () => 'photo-media-worker',
      });
    } finally {
      process.env.NODE_ENV = previousNodeEnv;
    }
    assert.equal(await taskCount(), initialTasks + 2);
    const tasks = await client.send(new ScanCommand({ TableName: TABLE_TASKS }));
    const photoTask = tasks.Items?.find(
      (item) => item.description === 'Send the corrected report'
    );
    assert.ok(photoTask);
    assert.equal(photoTask.date, '2026-08-05');
    assert.equal(photoTask.assigneeId, ACTOR_ID);
    const provenance = JSON.stringify(photoTask.assistantExecutionRef);
    assert.doesNotMatch(provenance, new RegExp(`${CHAT_ID}|used-photo|photo|telegram`, 'i'));
    const photoAttempt = await getExecutionAttempt(client, photoAttemptId, NOW);
    assert.equal(photoAttempt?.status, 'succeeded');
    const photoProposal = await getProposalVersion(
      client,
      photoAttempt!.proposalId,
      photoAttempt!.proposalVersion
    );
    assert.deepEqual(photoProposal?.spec.proposedContent, {
      description: 'Send the corrected report',
      date: '2026-08-05',
      status: 'todo',
      source: 'conversational-agent',
      timeZone: 'Europe/Berlin',
      actorId: ACTOR_ID,
      ownerId: ACTOR_ID,
      assigneeId: ACTOR_ID,
    });
    assert.doesNotMatch(
      JSON.stringify(photoProposal?.spec.sourceRefs),
      new RegExp(`${CHAT_ID}|used-photo|photo|telegram`, 'i')
    );
    assert.doesNotMatch(
      JSON.stringify(photoAttempt?.resultReceipt),
      new RegExp(`${CHAT_ID}|used-photo|photo|telegram`, 'i')
    );
    const photoNotification = await getResultNotification(
      client,
      `result-notification-${photoAttemptId}`,
      NOW
    );
    assert.ok(photoNotification);
    const photoPrivateResult = await getConversationalPrivatePayload(
      client,
      photoNotification.conversationId,
      photoNotification.privatePayloadRef,
      ACTOR_ID,
      NOW
    );
    assert.match(JSON.stringify(photoPrivateResult?.content), /Send the corrected report/);
    await assert.rejects(() => getConversationalPrivatePayload(
      client,
      photoNotification.conversationId,
      photoNotification.privatePayloadRef,
      'other-actor',
      NOW
    ));
    const photoDelivered: string[] = [];
    assert.equal(await dispatchOne(photoNotification, {
      client,
      now: () => NOW,
      transport: {
        async sendPrivateMessage(destination, text) {
          assert.equal(destination, CHAT_ID);
          photoDelivered.push(text);
        },
      },
    }), 'delivered');
    assert.equal(photoDelivered.length, 1);
    assert.match(photoDelivered[0], /Send the corrected report/);
  });
});
