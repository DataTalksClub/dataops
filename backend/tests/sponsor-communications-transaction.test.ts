import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import { CreateTableCommand, DeleteTableCommand, DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  ScanCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import {
  canonicalJson,
  canonicalPayload,
  keyringDigest,
  sha256,
  validateSendConfig,
  type HmacKeyring,
} from '../src/sponsorCommunications/core';
import {
  getDraft,
  getPrivatePayload,
  listBookingCommunications,
  storeDraft,
} from '../src/sponsorCommunications/repository';
import { addSuppression } from '../src/sponsorCommunications/repositoryConfig';
import { reconcileAbandonedSponsorPayloads } from '../src/sponsorCommunications/repositoryMaintenance';
import { handleSponsorCommunicationRoutes } from '../src/routes/sponsorCommunications';
import {
  exportSponsorCommunications,
  restoreSponsorPrivateArchive,
  validateSponsorPrivateArchive,
} from '../src/sponsorCommunications/privateArchive';
import { validateTemplateSet } from '../src/sponsorCommunications/secrets';
import type {
  CommunicationDraftVersion,
  CommunicationPresentation,
  CommunicationPrivatePayload,
} from '../src/sponsorCommunications/types';

const enabled = !!process.env.DYNAMODB_ENDPOINT;
const TABLE = process.env.DATAOPS_SPONSOR_CRM_TABLE || 'SponsorCrmTransaction';
const USERS = process.env.DATAOPS_USERS_TABLE || 'UsersTransaction';
const RESTORE = 'SponsorCommunicationRestoreTransaction';
const raw = new DynamoDBClient({
  endpoint: process.env.DYNAMODB_ENDPOINT,
  region: process.env.AWS_REGION || 'us-east-1',
  credentials: { accessKeyId: 'local', secretAccessKey: 'local' },
});
const client = DynamoDBDocumentClient.from(raw, { marshallOptions: { removeUndefinedValues: true } });
let hmac: HmacKeyring = {
  secretVersionId: 'synthetic-secret-version',
  activeVersion: 'v1',
  acceptedVersions: ['v1'],
  keys: { v1: Buffer.alloc(32, 7).toString('base64') },
};
const templateSet = {
  schemaVersion: '1' as const,
  generation: 'templates-1',
  templates: [
    'booking-confirmation',
    'materials-reminder',
    'publication-live',
    'performance-follow-up',
  ].map((id) => ({
    id,
    version: '1',
    subject: `Synthetic ${id} for {{organizationName}}`,
    body: 'Synthetic body for {{organizationName}}.\n',
    placeholders: ['organizationName'],
  })),
};
const templateSetDigest = validateTemplateSet(templateSet).digest;
let config = validateSendConfig({
  enabled: true,
  generation: 1,
  templateSetGeneration: 'templates-1',
  templateSetDigest,
  hmacSecretVersionId: hmac.secretVersionId,
  hmacActiveVersion: hmac.activeVersion,
  hmacAcceptedVersions: hmac.acceptedVersions,
  hmacKeyringDigest: keyringDigest(hmac),
  sesAccount: '123456789012',
  sesRegion: 'eu-west-1',
  sesIdentityArn: 'arn:aws:ses:eu-west-1:123456789012:identity/example.invalid',
  from: 'sender@example.invalid',
  configurationSet: 'reviewed-send',
  configurationSetGeneration: 'generation-1',
  approverPolicyVersion: 'admin-v1',
}, hmac);

const keys = (kind: string, id: string) => ({ PK: `${kind}#${id}`, SK: `${kind}#${id}` });
const put = (kind: string, id: string, value: Record<string, unknown>) =>
  client.send(new PutCommand({ TableName: TABLE, Item: { ...keys(kind, id), ...value } }));

function resealArchive(archive: SponsorPrivateArchive): SponsorPrivateArchive {
  archive.records.sort((a, b) => `${a.PK}\0${a.SK}`.localeCompare(`${b.PK}\0${b.SK}`));
  archive.manifest.count = archive.records.length;
  archive.manifest.recordsSha256 = createHash('sha256')
    .update(archive.records.map(canonicalJson).join('\n') + (archive.records.length ? '\n' : ''))
    .digest('hex');
  archive.manifest.configVersions = [...new Set(archive.records
    .filter((item) => item.recordType === 'sponsor-send-config')
    .map((item) => Number(item.generation)))].sort((a, b) => a - b);
  archive.manifest.configDigests = [...new Set(archive.records
    .filter((item) => item.recordType === 'sponsor-send-config')
    .map((item) => String(item.digest)))].sort();
  const recordCounts = archive.records.reduce<Record<string, number>>((counts, record) => {
    counts[String(record.recordType)] = (counts[String(record.recordType)] || 0) + 1;
    return counts;
  }, {});
  archive.manifest.recordCounts = Object.fromEntries(
    Object.entries(recordCounts).sort(([a], [b]) => a.localeCompare(b)),
  );
  return archive;
}

async function assertArchiveRejectedAtEveryRestoreBoundary(
  archive: SponsorPrivateArchive,
): Promise<void> {
  assert.throws(() => validateSponsorPrivateArchive(archive));
  await assert.rejects(
    restoreSponsorPrivateArchive(client, archive, { dryRun: true, targetTable: RESTORE }),
  );
  await assert.rejects(
    restoreSponsorPrivateArchive(client, archive, { dryRun: false, targetTable: RESTORE }),
  );
}

type SeededApproval = {
  actorId: string;
  presentation: CommunicationPresentation;
  draft: CommunicationDraftVersion;
  payload: CommunicationPrivatePayload;
  config: typeof config;
  keyring: HmacKeyring;
  token: string;
};

async function seedApproval(sequence: number): Promise<SeededApproval> {
  const communicationId = `communication-${sequence}`;
  const payloadId = `${communicationId}#1`;
  const canonical = canonicalPayload({
    from: config.from,
    to: `recipient-${sequence}@example.invalid`,
    communicationType: 'booking-confirmation',
    communicationId,
    version: 1,
    subject: `Synthetic confirmation ${sequence}`,
    body: 'Synthetic message body.\n',
    publicLinks: [],
    templateId: 'booking-confirmation',
    templateVersion: '1',
    templateDigest: 'b'.repeat(64),
    templateSetGeneration: config.templateSetGeneration,
    dealId: `booking-${sequence}`,
    dealVersion: 1,
    organizationId: `organization-${sequence}`,
    organizationVersion: 1,
    contactId: `contact-${sequence}`,
    contactVersion: 1,
    suggestionId: `suggestion-${sequence}`,
    suggestionVersion: 1,
    approverPolicyVersion: config.approverPolicyVersion,
    sesAccount: config.sesAccount,
    sesRegion: config.sesRegion,
    sesIdentityArn: config.sesIdentityArn,
    configurationSet: config.configurationSet,
    configurationSetGeneration: config.configurationSetGeneration,
    hmacKeyringDigest: config.hmacKeyringDigest,
    sendConfigGeneration: config.generation,
    sendConfigDigest: config.digest,
  });
  const createdAt = new Date(Date.now() + sequence).toISOString();
  const token = `review-token-${sequence}-${'x'.repeat(32)}`;
  const draft: CommunicationDraftVersion = {
    id: payloadId,
    recordType: 'communication-draft-version',
    communicationId,
    dealId: `booking-${sequence}`,
    version: 1,
    suggestionId: `suggestion-${sequence}`,
    payloadRef: payloadId,
    payloadHash: canonical.hash,
    previewHash: canonical.previewHash,
    configDigest: config.digest,
    createdBy: 'admin-1',
    createdAt,
  };
  const payload: CommunicationPrivatePayload = {
    id: payloadId,
    recordType: 'communication-private-payload',
    communicationId,
    version: 1,
    payload: canonical.payload,
    payloadHash: canonical.hash,
    createdAt,
  };
  const presentation: CommunicationPresentation = {
    id: `presentation-${sequence}`,
    recordType: 'communication-presentation',
    communicationId,
    dealId: `booking-${sequence}`,
    payloadRef: payloadId,
    draftVersion: 1,
    payloadHash: canonical.hash,
    previewHash: canonical.previewHash,
    tokenHash: sha256(token),
    state: 'active',
    expiresAt: new Date(Date.now() + 600_000).toISOString(),
    ttl: Math.floor(Date.now() / 1000) + 86_400,
    revision: 1,
    createdBy: 'admin-1',
    createdAt,
  };
  await Promise.all([
    put('DEAL', `booking-${sequence}`, { id: `booking-${sequence}`, version: 1, organizationId: `organization-${sequence}`, primaryContactId: `contact-${sequence}`, status: 'agreed', active: true }),
    put('ORGANIZATION', `organization-${sequence}`, { id: `organization-${sequence}`, version: 1, displayName: 'Synthetic Sponsor', active: true }),
    put('CONTACT', `contact-${sequence}`, { id: `contact-${sequence}`, version: 1, organizationId: `organization-${sequence}`, emails: [`recipient-${sequence}@example.invalid`], active: true }),
    put('COMMUNICATION_SUGGESTION', `suggestion-${sequence}`, {
      id: `suggestion-${sequence}`,
      recordType: 'communication-suggestion',
      version: 1,
      dealId: `booking-${sequence}`,
      dealVersion: 1,
      organizationId: `organization-${sequence}`,
      communicationType: 'booking-confirmation',
      occurrenceKey: `synthetic-${sequence}`,
      eligible: true,
      safeReason: 'synthetic test suggestion',
      status: 'open',
      createdAt,
      updatedAt: createdAt,
    }),
    put('COMMUNICATION_DRAFT', `${communicationId}#1`, { ...draft, GSI1PK: `COMMUNICATION#${communicationId}`, GSI1SK: 'DRAFT#0000000001' }),
    put('COMMUNICATION_PAYLOAD', payloadId, payload),
    put('COMMUNICATION_PRESENTATION', presentation.id, { ...presentation, GSI1PK: `COMMUNICATION#${communicationId}`, GSI1SK: `PRESENTATION#${createdAt}#${presentation.id}` }),
  ]);
  return { actorId: 'admin-1', presentation, draft, payload, config, keyring: hmac, token };
}

const apiEvent = (method: string, path: string, actorId: string, body: Record<string, unknown> = {}) => ({
  httpMethod: method,
  path,
  headers: { 'x-user-id': actorId },
  body: JSON.stringify(body),
});

async function seedRouteSource(sequence: number) {
  const bookingId = `route-booking-${sequence}`;
  const organizationId = `route-organization-${sequence}`;
  const contactId = `route-contact-${sequence}`;
  const suggestionId = `route-suggestion-${sequence}`;
  const recipient = `route-${sequence}@example.invalid`;
  const createdAt = new Date().toISOString();
  await Promise.all([
    put('DEAL', bookingId, {
      id: bookingId, recordType: 'deal', version: 1, organizationId, status: 'agreed',
      plannedPublicationDate: '2026-08-15', active: true,
    }),
    put('ORGANIZATION', organizationId, {
      id: organizationId, recordType: 'organization', version: 1, displayName: `Route Sponsor ${sequence}`, active: true,
    }),
    put('CONTACT', contactId, {
      id: contactId, recordType: 'contact', version: 1, organizationId, emails: [recipient], active: true,
    }),
    put('COMMUNICATION_SUGGESTION', suggestionId, {
      id: suggestionId,
      recordType: 'communication-suggestion',
      occurrenceKey: `route-${sequence}`,
      communicationType: 'booking-confirmation',
      dealId: bookingId,
      dealVersion: 1,
      organizationId,
      version: 1,
      eligible: true,
      safeReason: 'synthetic route suggestion',
      status: 'open',
      createdAt,
      updatedAt: createdAt,
    }),
  ]);
  return { bookingId, organizationId, contactId, suggestionId, recipient };
}

/**
 * A historical send attempt as it exists after DataOps stopped sending:
 * written directly, the way the removed approval worker used to write it.
 * `observed` attaches the provider delivery graph (event fact, pending set,
 * correlation); otherwise the attempt stays providerless.
 */
async function seedHistoricalAttempt(sequence: number, observed: boolean): Promise<{ attemptId: string; messageId: string }> {
  const seeded = await seedApproval(sequence);
  const createdAt = new Date(Date.now() + sequence).toISOString();
  const attemptId = `historical-attempt-${sequence}`;
  const messageId = `synthetic-message-${sequence}`;
  const correlationHash = sha256(`synthetic-correlation-${sequence}`);
  await put('SPONSOR_SEND_ATTEMPT', attemptId, {
    id: attemptId,
    recordType: 'sponsor-send-attempt',
    communicationId: seeded.draft.communicationId,
    dealId: seeded.draft.dealId,
    draftVersion: seeded.draft.version,
    payloadRef: seeded.draft.payloadRef,
    payloadHash: seeded.draft.payloadHash,
    previewHash: seeded.draft.previewHash,
    approverId: 'admin-1',
    roleSnapshot: 'admin',
    status: observed ? 'provider_observed' : 'outcome_unknown',
    derivedStatus: observed ? 'delivered' : 'outcome_unknown',
    configDigest: config.digest,
    configGeneration: config.generation,
    sesAccount: config.sesAccount,
    sesRegion: config.sesRegion,
    sesIdentityArn: config.sesIdentityArn,
    from: config.from,
    configurationSet: config.configurationSet,
    configurationSetGeneration: config.configurationSetGeneration,
    correlationHash,
    revision: 1,
    recoveryBlocked: true,
    ...(observed ? { providerMessageId: messageId } : {}),
    createdAt,
    updatedAt: createdAt,
    ttl: Math.floor(Date.now() / 1000) + 365 * 24 * 60 * 60,
    GSI1PK: `COMMUNICATION#${seeded.draft.communicationId}`,
    GSI1SK: `ATTEMPT#${createdAt}#${attemptId}`,
    GSI4PK: `DEAL_COMMUNICATION#${seeded.draft.dealId}`,
    GSI4SK: `ATTEMPT#${createdAt}#${attemptId}`,
  });
  if (observed) {
    await put('SPONSOR_SEND_EVENT', `event-${sequence}-delivery`, {
      id: `event-${sequence}-delivery`,
      recordType: 'sponsor-send-event-fact',
      attemptId,
      communicationId: seeded.draft.communicationId,
      dealId: seeded.draft.dealId,
      eventType: 'DELIVERY',
      eventTime: createdAt,
      messageId,
      configurationSetGeneration: config.configurationSetGeneration,
      createdAt,
      ttl: Math.floor(Date.now() / 1000) + 365 * 24 * 60 * 60,
      GSI1PK: `COMMUNICATION#${seeded.draft.communicationId}`,
      GSI1SK: `EVENT#${createdAt}#event-${sequence}-delivery`,
      GSI4PK: `DEAL_COMMUNICATION#${seeded.draft.dealId}`,
      GSI4SK: `EVENT#${createdAt}#event-${sequence}-delivery`,
    });
    await put('PENDING_SPONSOR_SEND_EVENTS', attemptId, {
      id: attemptId,
      recordType: 'pending-sponsor-send-event-set',
      attemptId,
      candidateMessageId: messageId,
      revision: 2,
      updatedAt: createdAt,
      ttl: Math.floor(Date.now() / 1000) + 365 * 24 * 60 * 60,
    });
    await put('SPONSOR_SEND_CORRELATION', correlationHash, {
      id: correlationHash,
      recordType: 'sponsor-send-correlation',
      attemptId,
      communicationId: seeded.draft.communicationId,
      configGeneration: config.generation,
      correlationHash,
      createdAt,
      ttl: Math.floor(Date.now() / 1000) + 365 * 24 * 60 * 60,
    });
  }
  return { attemptId, messageId };
}

describe('real DynamoDB sponsor reviewed-send transactions', { skip: !enabled }, () => {
  before(async () => {
    process.env.SPONSOR_COMMUNICATION_SEND_ENABLED = 'true';
    process.env.SPONSOR_COMMUNICATIONS_TEST_HMAC_KEYRING = JSON.stringify(hmac);
    process.env.SPONSOR_COMMUNICATIONS_TEST_TEMPLATE_CARD = JSON.stringify(templateSet);
    await raw.send(new CreateTableCommand({
      TableName: TABLE,
      BillingMode: 'PAY_PER_REQUEST',
      AttributeDefinitions: [
        { AttributeName: 'PK', AttributeType: 'S' }, { AttributeName: 'SK', AttributeType: 'S' },
        { AttributeName: 'GSI1PK', AttributeType: 'S' }, { AttributeName: 'GSI1SK', AttributeType: 'S' },
        { AttributeName: 'GSI2PK', AttributeType: 'S' }, { AttributeName: 'GSI2SK', AttributeType: 'S' },
        { AttributeName: 'GSI4PK', AttributeType: 'S' }, { AttributeName: 'GSI4SK', AttributeType: 'S' },
      ],
      KeySchema: [{ AttributeName: 'PK', KeyType: 'HASH' }, { AttributeName: 'SK', KeyType: 'RANGE' }],
      GlobalSecondaryIndexes: [
        { IndexName: 'GSI-Communication', KeySchema: [{ AttributeName: 'GSI1PK', KeyType: 'HASH' }, { AttributeName: 'GSI1SK', KeyType: 'RANGE' }], Projection: { ProjectionType: 'ALL' } },
        { IndexName: 'GSI-SponsorSendDue', KeySchema: [{ AttributeName: 'GSI2PK', KeyType: 'HASH' }, { AttributeName: 'GSI2SK', KeyType: 'RANGE' }], Projection: { ProjectionType: 'ALL' } },
        { IndexName: 'GSI-SponsorBookingCommunication', KeySchema: [{ AttributeName: 'GSI4PK', KeyType: 'HASH' }, { AttributeName: 'GSI4SK', KeyType: 'RANGE' }], Projection: { ProjectionType: 'ALL' } },
      ],
    }));
    await raw.send(new CreateTableCommand({
      TableName: RESTORE,
      BillingMode: 'PAY_PER_REQUEST',
      AttributeDefinitions: [{ AttributeName: 'PK', AttributeType: 'S' }, { AttributeName: 'SK', AttributeType: 'S' }],
      KeySchema: [{ AttributeName: 'PK', KeyType: 'HASH' }, { AttributeName: 'SK', KeyType: 'RANGE' }],
    }));
    await raw.send(new CreateTableCommand({
      TableName: USERS,
      BillingMode: 'PAY_PER_REQUEST',
      AttributeDefinitions: [{ AttributeName: 'PK', AttributeType: 'S' }, { AttributeName: 'SK', AttributeType: 'S' }],
      KeySchema: [{ AttributeName: 'PK', KeyType: 'HASH' }, { AttributeName: 'SK', KeyType: 'RANGE' }],
    }));
    await client.send(new PutCommand({ TableName: USERS, Item: { PK: 'USER#admin-1', SK: 'USER#admin-1', id: 'admin-1', role: 'admin', disabled: false } }));
    await client.send(new PutCommand({ TableName: USERS, Item: { PK: 'USER#operator-1', SK: 'USER#operator-1', id: 'operator-1', role: 'operator', disabled: false } }));
    await put('SPONSOR_SEND_CONFIG', 'CURRENT', { ...config, recordType: 'sponsor-send-config' });
  });

  after(async () => {
    await raw.send(new DeleteTableCommand({ TableName: TABLE })).catch(() => undefined);
    await raw.send(new DeleteTableCommand({ TableName: USERS })).catch(() => undefined);
    await raw.send(new DeleteTableCommand({ TableName: RESTORE })).catch(() => undefined);
  });

  it('uses only verified identity headers and no-store private responses', async () => {
    const event = (headers: Record<string, string>, body = '{}') => ({
      httpMethod: 'GET',
      path: '/api/sponsor-crm/communications/config',
      headers,
      body,
    });
    const missing = await handleSponsorCommunicationRoutes('/api/sponsor-crm/communications/config', 'GET', event({}, JSON.stringify({ actorId: 'admin-1', role: 'admin' })), client);
    assert.equal(missing.statusCode, 401);
    assert.equal(missing.headers?.['Cache-Control'], 'no-store');
    assert.equal(JSON.stringify(missing).includes('admin-1'), false);
    const sentinel = await handleSponsorCommunicationRoutes('/api/sponsor-crm/communications/config', 'GET', event({ 'x-user-id': 'portal-admin' }), client);
    assert.equal(sentinel.statusCode, 401);
    const allowed = await handleSponsorCommunicationRoutes('/api/sponsor-crm/communications/config', 'GET', event({ 'x-user-id': 'admin-1' }), client);
    assert.equal(allowed.statusCode, 200);
    assert.equal(allowed.headers?.['X-Content-Type-Options'], 'nosniff');
    await client.send(new PutCommand({ TableName: USERS, Item: { PK: 'USER#operator-1', SK: 'USER#operator-1', id: 'operator-1', role: 'operator', disabled: false } }));
    const forbidden = await handleSponsorCommunicationRoutes('/api/sponsor-crm/communications/config', 'PUT', event({ 'x-user-id': 'operator-1' }, JSON.stringify({ enabled: false })), client);
    assert.equal(forbidden.statusCode, 403);
    assert.deepEqual(JSON.parse(forbidden.body), { error: 'Forbidden' });
  });

  it('no longer exposes the removed send endpoints', async () => {
    const event = (headers: Record<string, string>, body = '{}') => ({
      httpMethod: 'POST',
      path: '/api/sponsor-crm/communications/communication-1/approve',
      headers,
      body,
    });
    for (const path of [
      '/api/sponsor-crm/communications/communication-1/approve',
      '/api/sponsor-crm/communications/attempts/attempt-1/cancel',
      '/api/sponsor-crm/communications/attempts/attempt-1/reconcile',
    ]) {
      const response = await handleSponsorCommunicationRoutes(path, 'POST', event({ 'x-user-id': 'admin-1' }, '{}'), client);
      assert.equal(response.statusCode, 404, path);
    }
  });

  it('revalidates presentation state and makes an edited draft invalidate the old review control', async () => {
    const source = await seedRouteSource(20);
    await client.send(new UpdateCommand({
      TableName: TABLE,
      Key: keys('CONTACT', source.contactId),
      UpdateExpression: 'SET emails = :emails',
      ExpressionAttributeValues: { ':emails': ['Route-20@Example.INVALID'] },
    }));
    const draftResponse = await handleSponsorCommunicationRoutes(
      `/api/sponsor-crm/communication-suggestions/${source.suggestionId}/drafts`,
      'POST',
      apiEvent('POST', `/api/sponsor-crm/communication-suggestions/${source.suggestionId}/drafts`, 'operator-1', {
        contactId: source.contactId,
        recipient: source.recipient,
      }),
      client,
    );
    assert.equal(draftResponse.statusCode, 201, draftResponse.body);
    const draftResult = JSON.parse(draftResponse.body);
    const presentationResponse = await handleSponsorCommunicationRoutes(
      `/api/sponsor-crm/communications/${source.suggestionId}/presentations`,
      'POST',
      apiEvent('POST', `/api/sponsor-crm/communications/${source.suggestionId}/presentations`, 'admin-1', { version: 1 }),
      client,
    );
    assert.equal(presentationResponse.statusCode, 201, presentationResponse.body);
    const review = JSON.parse(presentationResponse.body);
    const firstDraft = (await getDraft(client, source.suggestionId, 1))!;
    const firstPayload = (await getPrivatePayload(client, `${source.suggestionId}#1`))!;
    const canonical = canonicalPayload({ ...firstPayload.payload, version: 2 });
    const createdAt = new Date(Date.now() + 1_000).toISOString();
    await storeDraft(client, {
      ...firstDraft,
      id: `${source.suggestionId}#2`,
      version: 2,
      payloadRef: `${source.suggestionId}#2`,
      payloadHash: canonical.hash,
      previewHash: canonical.previewHash,
      createdAt,
    }, {
      ...firstPayload,
      id: `${source.suggestionId}#2`,
      version: 2,
      payload: canonical.payload,
      payloadHash: canonical.hash,
      createdAt,
    });
    const staleApproval = await handleSponsorCommunicationRoutes(
      `/api/sponsor-crm/communications/${source.suggestionId}/approve`,
      'POST',
      apiEvent('POST', `/api/sponsor-crm/communications/${source.suggestionId}/approve`, 'admin-1', {
        presentationId: review.presentationId,
        token: review.token,
        version: 1,
      }),
      client,
    );
    assert.equal(staleApproval.statusCode, 404, staleApproval.body);
    const storedPresentation = (await client.send(new GetCommand({
      TableName: TABLE,
      Key: keys('COMMUNICATION_PRESENTATION', review.presentationId),
    }))).Item!;
    assert.equal(storedPresentation.state, 'revoked');
    assert.equal(storedPresentation.tokenHash, undefined);
    const oldPayload = (await client.send(new GetCommand({
      TableName: TABLE,
      Key: keys('COMMUNICATION_PAYLOAD', `${source.suggestionId}#1`),
    }))).Item!;
    assert.ok(oldPayload.retentionAnchoredAt);
    assert.ok(oldPayload.ttl);
    assert.ok(draftResult.payloadHash);
  });

  it('presents a canonical one-recipient preview backed by a mixed-case CRM address', async () => {
    const source = await seedRouteSource(28);
    await client.send(new UpdateCommand({
      TableName: TABLE,
      Key: keys('CONTACT', source.contactId),
      UpdateExpression: 'SET emails = :emails',
      ExpressionAttributeValues: { ':emails': ['Route-28@Example.INVALID'] },
    }));
    assert.equal((await handleSponsorCommunicationRoutes(
      `/api/sponsor-crm/communication-suggestions/${source.suggestionId}/drafts`, 'POST',
      apiEvent('POST', '', 'operator-1', { contactId: source.contactId, recipient: 'route-28@example.invalid' }), client,
    )).statusCode, 201);
    const presented = await handleSponsorCommunicationRoutes(
      `/api/sponsor-crm/communications/${source.suggestionId}/presentations`, 'POST',
      apiEvent('POST', '', 'admin-1', { version: 1 }), client,
    );
    assert.equal(presented.statusCode, 201, presented.body);
    const review = JSON.parse(presented.body);
    assert.equal(review.preview.to, 'route-28@example.invalid');
  });

  it('requires an admin to mint a fresh review and exposes only paginated safe draft state', async () => {
    const source = await seedRouteSource(31);
    const created = await handleSponsorCommunicationRoutes(
      `/api/sponsor-crm/communication-suggestions/${source.suggestionId}/drafts`,
      'POST',
      apiEvent('POST', '', 'operator-1', {
        contactId: source.contactId,
        recipient: source.recipient,
        subject: 'Operator exact draft',
        body: 'Private draft body that must not appear in history.',
      }),
      client,
    );
    assert.equal(created.statusCode, 201, created.body);
    const operatorPresentation = await handleSponsorCommunicationRoutes(
      `/api/sponsor-crm/communications/${source.suggestionId}/presentations`,
      'POST',
      apiEvent('POST', '', 'operator-1', { version: 1 }),
      client,
    );
    assert.equal(operatorPresentation.statusCode, 201, operatorPresentation.body);
    const operatorReview = JSON.parse(operatorPresentation.body);

    let cursor: string | undefined;
    const operatorHistory: Record<string, unknown>[] = [];
    let operatorPermissions: Record<string, unknown> | undefined;
    do {
      const response = await handleSponsorCommunicationRoutes(
        `/api/sponsor-crm/deals/${source.bookingId}/communications`,
        'GET',
        {
          ...apiEvent('GET', '', 'operator-1'),
          queryStringParameters: { limit: '1', ...(cursor ? { cursor } : {}) },
        },
        client,
      );
      assert.equal(response.statusCode, 200, response.body);
      const page = JSON.parse(response.body);
      operatorHistory.push(...page.items);
      operatorPermissions = page.permissions;
      cursor = page.nextCursor || undefined;
    } while (cursor);
    const draftDto = operatorHistory.find((item) => item.recordType === 'communication-draft-version');
    assert.deepEqual(operatorPermissions, {
      role: 'operator',
      canApprove: false,
    });
    assert.equal(draftDto?.version, 1);
    assert.equal(draftDto?.reviewState, 'awaiting_review');
    assert.equal(draftDto?.reviewable, true);
    const encodedHistory = JSON.stringify(operatorHistory);
    for (const forbidden of [
      'Private draft body',
      'payloadHash',
      'previewHash',
      'payloadRef',
      'token',
      operatorReview.token,
    ]) assert.equal(encodedHistory.includes(forbidden), false);
    const foreignCursor = Buffer.from(JSON.stringify({
      PK: 'COMMUNICATION_DRAFT#other#1',
      SK: 'COMMUNICATION_DRAFT#other#1',
      GSI4PK: 'BOOKING_COMMUNICATION#other-booking',
      GSI4SK: 'DRAFT#2026-01-01T00:00:00.000Z#other#1',
    })).toString('base64url');
    const crossBookingPage = await handleSponsorCommunicationRoutes(
      `/api/sponsor-crm/deals/${source.bookingId}/communications`,
      'GET',
      {
        ...apiEvent('GET', '', 'operator-1'),
        queryStringParameters: { limit: '1', cursor: foreignCursor },
      },
      client,
    );
    assert.equal(crossBookingPage.statusCode, 400, crossBookingPage.body);

    const adminPresentation = await handleSponsorCommunicationRoutes(
      `/api/sponsor-crm/communications/${source.suggestionId}/presentations`,
      'POST',
      apiEvent('POST', '', 'admin-1', { version: 1 }),
      client,
    );
    assert.equal(adminPresentation.statusCode, 201, adminPresentation.body);
    const adminReview = JSON.parse(adminPresentation.body);
    assert.notEqual(adminReview.presentationId, operatorReview.presentationId);
    assert.notEqual(adminReview.token, operatorReview.token);
    const retrySafeRevoke = await handleSponsorCommunicationRoutes(
      `/api/sponsor-crm/communications/${source.suggestionId}/presentations/${operatorReview.presentationId}/reject`,
      'POST',
      apiEvent('POST', '', 'operator-1'),
      client,
    );
    assert.equal(retrySafeRevoke.statusCode, 200, retrySafeRevoke.body);
  });

  it('blocks presentation when suppression or a source version changes after drafting', async () => {
    const suppressed = await seedRouteSource(21);
    const createSuppressed = await handleSponsorCommunicationRoutes(
      `/api/sponsor-crm/communication-suggestions/${suppressed.suggestionId}/drafts`,
      'POST',
      apiEvent('POST', '', 'operator-1', { contactId: suppressed.contactId, recipient: suppressed.recipient }),
      client,
    );
    assert.equal(createSuppressed.statusCode, 201, createSuppressed.body);
    await addSuppression(client, {
      canonicalAddress: suppressed.recipient,
      contactId: suppressed.contactId,
      organizationId: suppressed.organizationId,
      category: 'manual',
      actorId: 'operator-1',
      safeReason: 'presentation boundary test',
    }, config, hmac);
    const blockedSuppression = await handleSponsorCommunicationRoutes(
      `/api/sponsor-crm/communications/${suppressed.suggestionId}/presentations`,
      'POST',
      apiEvent('POST', '', 'operator-1', { version: 1 }),
      client,
    );
    assert.equal(blockedSuppression.statusCode, 409, blockedSuppression.body);

    const drifted = await seedRouteSource(22);
    const createDrifted = await handleSponsorCommunicationRoutes(
      `/api/sponsor-crm/communication-suggestions/${drifted.suggestionId}/drafts`,
      'POST',
      apiEvent('POST', '', 'operator-1', { contactId: drifted.contactId, recipient: drifted.recipient }),
      client,
    );
    assert.equal(createDrifted.statusCode, 201, createDrifted.body);
    await client.send(new UpdateCommand({
      TableName: TABLE,
      Key: keys('DEAL', drifted.bookingId),
      UpdateExpression: 'SET #version = :version',
      ExpressionAttributeNames: { '#version': 'version' },
      ExpressionAttributeValues: { ':version': 2 },
    }));
    const blockedDrift = await handleSponsorCommunicationRoutes(
      `/api/sponsor-crm/communications/${drifted.suggestionId}/presentations`,
      'POST',
      apiEvent('POST', '', 'operator-1', { version: 1 }),
      client,
    );
    assert.equal(blockedDrift.statusCode, 409, blockedDrift.body);
  });

  it('anchors abandoned and expired-review payload TTL once without later extension', async () => {
    const abandoned = await seedRouteSource(24);
    const abandonedDraft = await handleSponsorCommunicationRoutes(
      `/api/sponsor-crm/communication-suggestions/${abandoned.suggestionId}/drafts`,
      'POST',
      apiEvent('POST', '', 'operator-1', { contactId: abandoned.contactId, recipient: abandoned.recipient }),
      client,
    );
    assert.equal(abandonedDraft.statusCode, 201, abandonedDraft.body);
    const future = new Date(Date.now() + 25 * 60 * 60_000).toISOString();
    for (let retry = 0; retry < 5; retry++) {
      await reconcileAbandonedSponsorPayloads(client, future, 20);
      const draft = (await client.send(new GetCommand({
        TableName: TABLE,
        Key: keys('COMMUNICATION_DRAFT', `${abandoned.suggestionId}#1`),
      }))).Item;
      if (draft?.abandonedAt) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const abandonedPayload = (await client.send(new GetCommand({
      TableName: TABLE,
      Key: keys('COMMUNICATION_PAYLOAD', `${abandoned.suggestionId}#1`),
    }))).Item!;
    assert.ok(abandonedPayload.retentionAnchoredAt);
    assert.ok(abandonedPayload.ttl);
    const anchoredTtl = abandonedPayload.ttl;
    await reconcileAbandonedSponsorPayloads(client, new Date(Date.now() + 10 * 24 * 60 * 60_000).toISOString(), 20);
    const unchanged = (await client.send(new GetCommand({
      TableName: TABLE,
      Key: keys('COMMUNICATION_PAYLOAD', `${abandoned.suggestionId}#1`),
    }))).Item!;
    assert.equal(unchanged.ttl, anchoredTtl);

    const expired = await seedRouteSource(25);
    assert.equal((await handleSponsorCommunicationRoutes(
      `/api/sponsor-crm/communication-suggestions/${expired.suggestionId}/drafts`,
      'POST',
      apiEvent('POST', '', 'operator-1', { contactId: expired.contactId, recipient: expired.recipient }),
      client,
    )).statusCode, 201);
    assert.equal((await handleSponsorCommunicationRoutes(
      `/api/sponsor-crm/communications/${expired.suggestionId}/presentations`,
      'POST',
      apiEvent('POST', '', 'operator-1', { version: 1 }),
      client,
    )).statusCode, 201);
    await reconcileAbandonedSponsorPayloads(client, new Date(Date.now() + 60 * 60_000).toISOString(), 20);
    const expiredPayload = (await client.send(new GetCommand({
      TableName: TABLE,
      Key: keys('COMMUNICATION_PAYLOAD', `${expired.suggestionId}#1`),
    }))).Item!;
    assert.ok(expiredPayload.retentionAnchoredAt);
    assert.ok(expiredPayload.ttl);
  });

  it('exposes redacted historical attempts in paginated booking history', async () => {
    const { attemptId } = await seedHistoricalAttempt(23, true);
    const rawAttempt = (await client.send(new GetCommand({
      TableName: TABLE,
      Key: keys('SPONSOR_SEND_ATTEMPT', attemptId),
    }))).Item!;
    let historyItems: Record<string, unknown>[] = [];
    let history = await listBookingCommunications(client, 'booking-23', { limit: 2 });
    historyItems = [...history.items];
    while (history.nextCursor) {
      history = await listBookingCommunications(client, 'booking-23', { limit: 2, cursor: history.nextCursor });
      historyItems.push(...history.items);
    }
    assert.ok(
      historyItems.some((item) => item.recordType === 'sponsor-send-attempt'),
      JSON.stringify({ historyItems }),
    );
    const redacted = await listBookingCommunications(client, 'booking-23', { limit: 50 });
    const encodedHistory = JSON.stringify(redacted);
    for (const forbidden of [
      'payloadHash', 'previewHash', 'providerMessageId', 'messageId',
      String(rawAttempt.payloadHash), String(rawAttempt.previewHash), 'synthetic-message-23',
    ]) {
      assert.equal(encodedHistory.includes(forbidden), false);
    }
  });

  it('exports an expired-payload evidence graph, rejects semantic tampering, and restores it non-dispatchable', async () => {
    const expiredInput = await seedApproval(30);
    await seedHistoricalAttempt(30, true);
    await seedHistoricalAttempt(31, false);
    const expiredAttemptId = 'historical-attempt-30';
    await client.send(new UpdateCommand({
      TableName: TABLE,
      Key: keys('COMMUNICATION_PAYLOAD', expiredInput.payload.id),
      UpdateExpression: 'SET #ttl = :expired',
      ExpressionAttributeNames: { '#ttl': 'ttl' },
      ExpressionAttributeValues: { ':expired': 1 },
    }));
    const archive = await exportSponsorCommunications(client, '2035-07-30T15:00:00.000Z');
    validateSponsorPrivateArchive(archive);
    assert.ok(archive.manifest.count > 0);
    const archivedAttempts = new Map(archive.records
      .filter((item) => item.recordType === 'sponsor-send-attempt')
      .map((item) => [String(item.id), item]));
    for (const fact of archive.records.filter((item) => item.recordType === 'sponsor-send-event-fact')) {
      const factAttempt = archivedAttempts.get(String(fact.attemptId));
      assert.ok(factAttempt);
      assert.equal(fact.messageId, factAttempt.providerMessageId);
      assert.equal(fact.configurationSetGeneration, factAttempt.configurationSetGeneration);
    }
    for (const pending of archive.records.filter((item) => item.recordType === 'pending-sponsor-send-event-set')) {
      const pendingAttempt = archivedAttempts.get(String(pending.attemptId));
      assert.ok(pendingAttempt);
      assert.equal(pending.candidateMessageId, pendingAttempt.providerMessageId);
    }
    const providerlessUnknown = [...archivedAttempts.values()].find((item) => (
      item.status === 'outcome_unknown' && item.providerMessageId === undefined
    ));
    assert.ok(providerlessUnknown);
    assert.equal(archive.records.some((item) => (
      ['sponsor-send-event-fact', 'pending-sponsor-send-event-set'].includes(String(item.recordType))
      && item.attemptId === providerlessUnknown.id
    )), false);
    assert.equal(
      archive.records.some((item) => item.recordType === 'communication-private-payload' && item.id === expiredInput.payload.id),
      false,
    );
    for (const record of archive.records.filter((item) => (
      item.communicationId === 'communication-30'
      && ['communication-draft-version', 'communication-presentation', 'sponsor-send-attempt'].includes(String(item.recordType))
    ))) {
      assert.equal(record.payloadExpired, true);
      assert.equal(record.payloadRef, undefined);
      assert.ok(record.payloadHash);
      assert.ok(record.previewHash);
    }
    const encoded = JSON.stringify(archive);
    for (const forbidden of ['tokenHash', 'correlationToken', 'leaseOwner', '"keys"']) assert.equal(encoded.includes(forbidden), false);

    const crossBooking = structuredClone(archive);
    const crossBookingAttempt = crossBooking.records.find((item) => item.recordType === 'sponsor-send-attempt')!;
    crossBookingAttempt.dealId = 'semantically-wrong-booking';
    assert.throws(() => validateSponsorPrivateArchive(resealArchive(crossBooking)));

    const crossSource = structuredClone(archive);
    const sourceDraft = crossSource.records.find((item) => item.recordType === 'communication-draft-version')!;
    const sourceSuggestion = crossSource.records.find((item) => (
      item.recordType === 'communication-suggestion' && item.id === sourceDraft.suggestionId
    ))!;
    sourceSuggestion.dealId = 'semantically-wrong-source-booking';
    assert.throws(() => validateSponsorPrivateArchive(resealArchive(crossSource)));

    const wrongProvider = structuredClone(archive);
    const wrongProviderAttempt = wrongProvider.records.find((item) => item.recordType === 'sponsor-send-attempt')!;
    wrongProviderAttempt.sesRegion = 'semantically-wrong-region';
    assert.throws(() => validateSponsorPrivateArchive(resealArchive(wrongProvider)));

    const crossEvent = structuredClone(archive);
    const eventRecord = crossEvent.records.find((item) => item.recordType === 'sponsor-send-event-fact');
    assert.ok(eventRecord);
    eventRecord.dealId = 'semantically-wrong-event-booking';
    assert.throws(() => validateSponsorPrivateArchive(resealArchive(crossEvent)));

    const wrongEventMessage = structuredClone(archive);
    const wrongMessageEvent = wrongEventMessage.records.find((item) => item.recordType === 'sponsor-send-event-fact');
    assert.ok(wrongMessageEvent);
    wrongMessageEvent.messageId = 'semantically-wrong-provider-message';
    await assertArchiveRejectedAtEveryRestoreBoundary(resealArchive(wrongEventMessage));

    const wrongEventConfiguration = structuredClone(archive);
    const wrongConfigurationEvent = wrongEventConfiguration.records.find((item) => item.recordType === 'sponsor-send-event-fact');
    assert.ok(wrongConfigurationEvent);
    wrongConfigurationEvent.configurationSetGeneration = 'semantically-wrong-configuration-generation';
    await assertArchiveRejectedAtEveryRestoreBoundary(resealArchive(wrongEventConfiguration));

    const wrongPendingMessage = structuredClone(archive);
    const pendingRecord = wrongPendingMessage.records.find((item) => item.recordType === 'pending-sponsor-send-event-set');
    assert.ok(pendingRecord);
    pendingRecord.candidateMessageId = 'semantically-wrong-pending-message';
    await assertArchiveRejectedAtEveryRestoreBoundary(resealArchive(wrongPendingMessage));

    const crossCorrelation = structuredClone(archive);
    const correlationRecord = crossCorrelation.records.find((item) => item.recordType === 'sponsor-send-correlation')!;
    correlationRecord.communicationId = 'semantically-wrong-communication';
    assert.throws(() => validateSponsorPrivateArchive(resealArchive(crossCorrelation)));

    const wrongCorrelationId = structuredClone(archive);
    const correlationWithWrongId = wrongCorrelationId.records.find((item) => item.recordType === 'sponsor-send-correlation')!;
    correlationWithWrongId.id = 'semantically-wrong-correlation-id';
    await assertArchiveRejectedAtEveryRestoreBoundary(resealArchive(wrongCorrelationId));

    const wrongCorrelationHash = structuredClone(archive);
    const correlationWithWrongHash = wrongCorrelationHash.records.find((item) => item.recordType === 'sponsor-send-correlation')!;
    correlationWithWrongHash.correlationHash = 'semantically-wrong-correlation-hash';
    await assertArchiveRejectedAtEveryRestoreBoundary(resealArchive(wrongCorrelationHash));

    const wrongCorrelationGeneration = structuredClone(archive);
    const correlationWithWrongGeneration = wrongCorrelationGeneration.records.find((item) => item.recordType === 'sponsor-send-correlation')!;
    correlationWithWrongGeneration.configGeneration = Number(correlationWithWrongGeneration.configGeneration) + 1;
    await assertArchiveRejectedAtEveryRestoreBoundary(resealArchive(wrongCorrelationGeneration));

    const wrongCorrelationKey = structuredClone(archive);
    const correlationWithWrongKey = wrongCorrelationKey.records.find((item) => item.recordType === 'sponsor-send-correlation')!;
    correlationWithWrongKey.PK = 'SPONSOR_SEND_CORRELATION#semantically-wrong-key';
    correlationWithWrongKey.SK = 'SPONSOR_SEND_CORRELATION#semantically-wrong-key';
    await assertArchiveRejectedAtEveryRestoreBoundary(resealArchive(wrongCorrelationKey));

    const unknownVersion = structuredClone(archive);
    const suppression = unknownVersion.records.find((item) => item.recordType === 'email-suppression');
    assert.ok(suppression);
    suppression.keyVersion = 'retired-unknown';
    assert.throws(() => validateSponsorPrivateArchive(resealArchive(unknownVersion)));

    const incoherentExpiry = structuredClone(archive);
    const expiredArchivedAttempt = incoherentExpiry.records.find((item) => (
      item.recordType === 'sponsor-send-attempt' && item.id === expiredAttemptId
    ))!;
    expiredArchivedAttempt.payloadRef = expiredInput.payload.id;
    assert.throws(() => validateSponsorPrivateArchive(resealArchive(incoherentExpiry)));

    assert.equal((await restoreSponsorPrivateArchive(client, archive, { dryRun: true, targetTable: RESTORE })).dryRun, true);
    const result = await restoreSponsorPrivateArchive(client, archive, { dryRun: false, targetTable: RESTORE });
    assert.equal(result.count, archive.manifest.count);
    const restored = (await client.send(new ScanCommand({ TableName: RESTORE }))).Items || [];
    assert.ok(restored.filter((item) => item.recordType === 'communication-presentation').every((item) => item.state === 'revoked' && item.tokenHash === undefined));
    assert.ok(restored.filter((item) => item.recordType === 'sponsor-send-attempt').every((item) => item.recoveryBlocked === true && item.GSI2PK === undefined && item.leaseOwner === undefined));
    assert.ok(restored.filter((item) => item.recordType === 'sponsor-send-config').every((item) => item.enabled === false));
  });
});
