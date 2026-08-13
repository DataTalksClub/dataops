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
  suppressionKey,
  validateSendConfig,
  type HmacKeyring,
} from '../src/sponsorCommunications/core';
import {
  addSuppression,
  approveDraft,
  assertSuppressionCoverage,
  cancelQueuedAttempt,
  getDraft,
  getPrivatePayload,
  listBookingCommunications,
  migrateSuppressions,
  reconcileAbandonedSponsorPayloads,
  reconcileSuppressionMigrationOrphan,
  storeDraft,
  type ApprovalInput,
} from '../src/sponsorCommunications/repository';
import { executeAttempt, leaseAttempt, processDueSponsorSends } from '../src/sponsorCommunications/worker';
import { ingestSanitizedSesEvent } from '../src/sponsorCommunications/sesEvents';
import { handleSponsorCommunicationRoutes } from '../src/routes/sponsorCommunications';
import {
  exportSponsorCommunications,
  restoreSponsorPrivateArchive,
  validateSponsorPrivateArchive,
} from '../src/sponsorCommunications/privateArchive';
import { validateTemplateBundle } from '../src/sponsorCommunications/secrets';
import type {
  CommunicationDraftVersion,
  CommunicationPresentation,
  CommunicationPrivatePayload,
  SponsorSendAttempt,
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
const templateBundle = {
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
const templateBundleDigest = validateTemplateBundle(templateBundle).digest;
let config = validateSendConfig({
  enabled: true,
  generation: 1,
  templateBundleGeneration: 'templates-1',
  templateBundleDigest,
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

async function seedApproval(sequence: number): Promise<ApprovalInput> {
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
    templateBundleGeneration: config.templateBundleGeneration,
    bookingId: `booking-${sequence}`,
    bookingVersion: 1,
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
    bookingId: `booking-${sequence}`,
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
    bookingId: `booking-${sequence}`,
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
    put('BOOKING', `booking-${sequence}`, { id: `booking-${sequence}`, version: 1, organizationId: `organization-${sequence}`, primaryContactId: `contact-${sequence}`, status: 'confirmed', active: true }),
    put('ORGANIZATION', `organization-${sequence}`, { id: `organization-${sequence}`, version: 1, displayName: 'Synthetic Sponsor', active: true }),
    put('CONTACT', `contact-${sequence}`, { id: `contact-${sequence}`, version: 1, organizationId: `organization-${sequence}`, emails: [`recipient-${sequence}@example.invalid`], active: true }),
    put('COMMUNICATION_SUGGESTION', `suggestion-${sequence}`, {
      id: `suggestion-${sequence}`,
      recordType: 'communication-suggestion',
      version: 1,
      bookingId: `booking-${sequence}`,
      bookingVersion: 1,
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
    put('BOOKING', bookingId, {
      id: bookingId, recordType: 'booking', version: 1, organizationId, status: 'confirmed',
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
      bookingId,
      bookingVersion: 1,
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

describe('real DynamoDB sponsor reviewed-send transactions', { skip: !enabled }, () => {
  before(async () => {
    process.env.SPONSOR_COMMUNICATION_SEND_ENABLED = 'true';
    process.env.SPONSOR_COMMUNICATIONS_TEST_HMAC_KEYRING = JSON.stringify(hmac);
    process.env.SPONSOR_COMMUNICATIONS_TEST_TEMPLATE_CARD = JSON.stringify(templateBundle);
    await raw.send(new CreateTableCommand({
      TableName: TABLE,
      BillingMode: 'PAY_PER_REQUEST',
      AttributeDefinitions: [
        { AttributeName: 'PK', AttributeType: 'S' }, { AttributeName: 'SK', AttributeType: 'S' },
        { AttributeName: 'GSI1PK', AttributeType: 'S' }, { AttributeName: 'GSI1SK', AttributeType: 'S' },
        { AttributeName: 'GSI2PK', AttributeType: 'S' }, { AttributeName: 'GSI2SK', AttributeType: 'S' },
        { AttributeName: 'GSI3PK', AttributeType: 'S' }, { AttributeName: 'GSI3SK', AttributeType: 'S' },
        { AttributeName: 'GSI4PK', AttributeType: 'S' }, { AttributeName: 'GSI4SK', AttributeType: 'S' },
      ],
      KeySchema: [{ AttributeName: 'PK', KeyType: 'HASH' }, { AttributeName: 'SK', KeyType: 'RANGE' }],
      GlobalSecondaryIndexes: [
        { IndexName: 'GSI-Communication', KeySchema: [{ AttributeName: 'GSI1PK', KeyType: 'HASH' }, { AttributeName: 'GSI1SK', KeyType: 'RANGE' }], Projection: { ProjectionType: 'ALL' } },
        { IndexName: 'GSI-SponsorSendDue', KeySchema: [{ AttributeName: 'GSI2PK', KeyType: 'HASH' }, { AttributeName: 'GSI2SK', KeyType: 'RANGE' }], Projection: { ProjectionType: 'ALL' } },
        { IndexName: 'GSI-SponsorSendLookup', KeySchema: [{ AttributeName: 'GSI3PK', KeyType: 'HASH' }, { AttributeName: 'GSI3SK', KeyType: 'RANGE' }], Projection: { ProjectionType: 'ALL' } },
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

  it('atomically resolves 25 approvals to one attempt and revokes siblings', async () => {
    const input = await seedApproval(1);
    for (let sibling = 1; sibling <= 2; sibling++) {
      const id = `presentation-1-sibling-${sibling}`;
      await put('COMMUNICATION_PRESENTATION', id, {
        ...input.presentation,
        id,
        tokenHash: sha256(`sibling-${sibling}`),
        GSI1PK: 'COMMUNICATION#communication-1',
        GSI1SK: `PRESENTATION#${input.presentation.createdAt}#${id}`,
      });
    }
    const results = await Promise.all(Array.from({ length: 25 }, () => approveDraft(client, input)));
    assert.equal(new Set(results.map((item) => item.id)).size, 1);
    const all = (await client.send(new ScanCommand({ TableName: TABLE }))).Items || [];
    assert.equal(all.filter((item) => item.recordType === 'sponsor-send-attempt' && item.communicationId === 'communication-1').length, 1);
    assert.equal(all.filter((item) => item.recordType === 'sponsor-communication-audit' && item.communicationId === 'communication-1').length, 1);
    assert.equal(all.filter((item) => item.recordType === 'sponsor-send-correlation' && item.communicationId === 'communication-1').length, 1);
    const presentations = all.filter((item) => item.recordType === 'communication-presentation' && item.communicationId === 'communication-1');
    assert.equal(presentations.filter((item) => item.state === 'consumed').length, 1);
    assert.equal(presentations.filter((item) => item.state === 'revoked').length, 2);
  });

  it('condition-checks the current Users role in the approval transaction', async () => {
    const input = await seedApproval(2);
    await client.send(new UpdateCommand({
      TableName: USERS,
      Key: { PK: 'USER#admin-1', SK: 'USER#admin-1' },
      UpdateExpression: 'SET #role = :operator',
      ExpressionAttributeNames: { '#role': 'role' },
      ExpressionAttributeValues: { ':operator': 'operator' },
    }));
    await assert.rejects(() => approveDraft(client, input));
    await client.send(new UpdateCommand({
      TableName: USERS,
      Key: { PK: 'USER#admin-1', SK: 'USER#admin-1' },
      UpdateExpression: 'SET #role = :admin',
      ExpressionAttributeNames: { '#role': 'role' },
      ExpressionAttributeValues: { ':admin': 'admin' },
    }));
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
    const forbidden = await handleSponsorCommunicationRoutes('/api/sponsor-crm/communications/hidden/approve', 'POST', event({ 'x-user-id': 'operator-1' }, JSON.stringify({ presentationId: 'hidden', token: 'x'.repeat(40), version: 1 })), client);
    assert.equal(forbidden.statusCode, 403);
    assert.deepEqual(JSON.parse(forbidden.body), { error: 'Forbidden' });
  });

  it('linearizes suppression against the dispatch marker with at most one SES call', async () => {
    const input = await seedApproval(3);
    const attempt = await approveDraft(client, input);
    let sends = 0;
    const [suppression, execution] = await Promise.allSettled([
      addSuppression(client, {
        canonicalAddress: input.payload.payload.to,
        contactId: input.payload.payload.contactId,
        organizationId: input.payload.payload.organizationId,
        category: 'manual',
        actorId: 'operator-1',
        safeReason: 'synthetic suppression race',
      }, config, hmac),
      executeAttempt(client, attempt.id, async () => { sends++; return { MessageId: 'synthetic-message-3' }; }),
    ]);
    assert.equal(suppression.status, 'fulfilled');
    assert.ok(sends === 0 || sends === 1);
    if (sends === 0) assert.equal(execution.status === 'fulfilled' && execution.value, 'failed_safe');
    else assert.equal(execution.status === 'fulfilled' && execution.value, 'accepted');
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
    assert.equal(staleApproval.statusCode, 409, staleApproval.body);
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

  it('approves a canonical one-recipient draft backed by a mixed-case CRM address', async () => {
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
    const approved = await handleSponsorCommunicationRoutes(
      `/api/sponsor-crm/communications/${source.suggestionId}/approve`, 'POST',
      apiEvent('POST', '', 'admin-1', { version: 1, presentationId: review.presentationId, token: review.token }), client,
    );
    assert.equal(approved.statusCode, 202, approved.body);
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
    const transferred = await handleSponsorCommunicationRoutes(
      `/api/sponsor-crm/communications/${source.suggestionId}/approve`,
      'POST',
      apiEvent('POST', '', 'admin-1', {
        version: 1,
        presentationId: operatorReview.presentationId,
        token: operatorReview.token,
      }),
      client,
    );
    assert.equal(transferred.statusCode, 403, transferred.body);

    let cursor: string | undefined;
    const operatorHistory: Record<string, unknown>[] = [];
    let operatorPermissions: Record<string, unknown> | undefined;
    do {
      const response = await handleSponsorCommunicationRoutes(
        `/api/sponsor-crm/bookings/${source.bookingId}/communications`,
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
      canCancel: false,
      canReconcile: false,
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
      `/api/sponsor-crm/bookings/${source.bookingId}/communications`,
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
    const approved = await handleSponsorCommunicationRoutes(
      `/api/sponsor-crm/communications/${source.suggestionId}/approve`,
      'POST',
      apiEvent('POST', '', 'admin-1', {
        version: 1,
        presentationId: adminReview.presentationId,
        token: adminReview.token,
      }),
      client,
    );
    assert.equal(approved.statusCode, 202, approved.body);
    const attempts = ((await client.send(new ScanCommand({ TableName: TABLE }))).Items || [])
      .filter((item) => item.recordType === 'sponsor-send-attempt' && item.communicationId === source.suggestionId);
    assert.equal(attempts.length, 1);
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
      Key: keys('BOOKING', drifted.bookingId),
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

  it('migrates suppressions while disabled with exact coverage, idempotency, and orphan reconciliation', async () => {
    const orphan = await seedRouteSource(26);
    await addSuppression(client, {
      canonicalAddress: orphan.recipient,
      contactId: orphan.contactId,
      organizationId: orphan.organizationId,
      category: 'manual',
      actorId: 'operator-1',
      safeReason: 'orphan migration test',
    }, config, hmac);
    await client.send(new UpdateCommand({
      TableName: TABLE,
      Key: keys('CONTACT', orphan.contactId),
      UpdateExpression: 'SET emails = :emails, #version = :version',
      ExpressionAttributeNames: { '#version': 'version' },
      ExpressionAttributeValues: { ':emails': [], ':version': 2 },
    }));
    const resolved = await seedRouteSource(27);
    await addSuppression(client, {
      canonicalAddress: resolved.recipient,
      contactId: resolved.contactId,
      organizationId: resolved.organizationId,
      category: 'manual',
      actorId: 'operator-1',
      safeReason: 'resolved migration test',
    }, config, hmac);
    const hmac2: HmacKeyring = {
      secretVersionId: 'synthetic-secret-version-2',
      activeVersion: 'v2',
      acceptedVersions: ['v1', 'v2'],
      keys: { ...hmac.keys, v2: Buffer.alloc(32, 11).toString('base64') },
    };
    const { digest: _previousDigest, ...configWithoutDigest } = config;
    const disabledConfig = validateSendConfig({
      ...configWithoutDigest,
      enabled: false,
      generation: 2,
      hmacSecretVersionId: hmac2.secretVersionId,
      hmacActiveVersion: hmac2.activeVersion,
      hmacAcceptedVersions: hmac2.acceptedVersions,
      hmacKeyringDigest: keyringDigest(hmac2),
    }, hmac2);
    process.env.SPONSOR_COMMUNICATION_SEND_ENABLED = 'false';
    process.env.SPONSOR_COMMUNICATIONS_TEST_HMAC_KEYRING = JSON.stringify(hmac2);
    await put('SPONSOR_SEND_CONFIG', 'CURRENT', { ...disabledConfig, recordType: 'sponsor-send-config' });

    let cursor: string | undefined;
    let migrated = 0;
    let orphaned = 0;
    do {
      const page = await migrateSuppressions(client, {
        actorId: 'admin-1',
        fromVersion: 'v1',
        limit: 2,
        cursor,
      }, disabledConfig, hmac2);
      migrated += page.migrated;
      orphaned += page.orphaned;
      cursor = page.nextCursor || undefined;
    } while (cursor);
    assert.ok(migrated >= 1);
    assert.ok(orphaned >= 1);
    assert.ok(await client.send(new GetCommand({
      TableName: TABLE,
      Key: keys('EMAIL_SUPPRESSION', suppressionKey('v2', resolved.recipient, hmac2)),
    })));
    await assert.rejects(() => assertSuppressionCoverage(client, ['v1', 'v2'], 'v2'));
    const orphanListResponse = await handleSponsorCommunicationRoutes(
      '/api/sponsor-crm/communications/suppressions/orphans', 'GET',
      apiEvent('GET', '', 'admin-1'), client,
    );
    assert.equal(orphanListResponse.statusCode, 200, orphanListResponse.body);
    const orphanReceipt = JSON.parse(orphanListResponse.body).items
      .find((item: Record<string, unknown>) => item.contactId === orphan.contactId);
    assert.ok(orphanReceipt?.id);
    assert.equal(JSON.stringify(orphanReceipt).includes(orphan.recipient), false);
    const orphanId = String(orphanReceipt.id);
    const orphanRecord = (await client.send(new GetCommand({
      TableName: TABLE,
      Key: keys('SUPPRESSION_MIGRATION_ORPHAN', orphanId),
    }))).Item;
    assert.equal(orphanRecord?.status, 'unresolved');
    await reconcileSuppressionMigrationOrphan(client, {
      id: orphanId,
      actorId: 'admin-1',
      reason: 'Synthetic contact address was retired',
    });
    const retirement = await migrateSuppressions(client, {
      actorId: 'admin-1',
      fromVersion: 'v1',
      limit: 10,
    }, disabledConfig, hmac2);
    assert.equal(retirement.nextCursor, null);
    assert.equal(retirement.retired, true);
    await assertSuppressionCoverage(client, ['v2'], 'v2');
    const repeat = await migrateSuppressions(client, {
      actorId: 'admin-1',
      fromVersion: 'v1',
      limit: 10,
    }, disabledConfig, hmac2);
    assert.deepEqual(
      { migrated: repeat.migrated, existing: repeat.existing, orphaned: repeat.orphaned },
      { migrated: 0, existing: 0, orphaned: 0 },
    );

    const retiredKeyring: HmacKeyring = {
      secretVersionId: hmac2.secretVersionId,
      activeVersion: 'v2',
      acceptedVersions: ['v2'],
      keys: { v2: hmac2.keys.v2 },
    };
    const { digest: _disabledDigest, ...disabledWithoutDigest } = disabledConfig;
    config = validateSendConfig({
      ...disabledWithoutDigest,
      enabled: true,
      generation: 3,
      hmacAcceptedVersions: ['v2'],
      hmacKeyringDigest: keyringDigest(retiredKeyring),
    }, retiredKeyring);
    hmac = retiredKeyring;
    process.env.SPONSOR_COMMUNICATION_SEND_ENABLED = 'true';
    process.env.SPONSOR_COMMUNICATIONS_TEST_HMAC_KEYRING = JSON.stringify(hmac);
    await put('SPONSOR_SEND_CONFIG', 'CURRENT', { ...config, recordType: 'sponsor-send-config' });
  });

  it('linearizes queued cancel and makes deployment kill-switch-off fail safe', async () => {
    const cancelInput = await seedApproval(4);
    const cancelAttempt = await approveDraft(client, cancelInput);
    let cancelSends = 0;
    const [cancel, execute] = await Promise.allSettled([
      cancelQueuedAttempt(client, cancelAttempt, 'admin-1'),
      executeAttempt(client, cancelAttempt.id, async () => { cancelSends++; return { MessageId: 'synthetic-message-4' }; }),
    ]);
    assert.ok(cancel.status === 'fulfilled' || execute.status === 'fulfilled');
    assert.ok(cancelSends === 0 || cancelSends === 1);

    const disabledInput = await seedApproval(5);
    const disabledAttempt = await approveDraft(client, disabledInput);
    process.env.SPONSOR_COMMUNICATION_SEND_ENABLED = 'false';
    let disabledSends = 0;
    assert.equal(await executeAttempt(client, disabledAttempt.id, async () => { disabledSends++; return { MessageId: 'never' }; }), 'failed_safe');
    assert.equal(disabledSends, 0);
    process.env.SPONSOR_COMMUNICATION_SEND_ENABLED = 'true';
  });

  it('uses one provider attempt and never retries an ambiguous post-marker result', async () => {
    const input = await seedApproval(6);
    const attempt = await approveDraft(client, input);
    let sends = 0;
    const ambiguous = Object.assign(new Error('synthetic transport loss'), { name: 'TimeoutError' });
    const outcome = await executeAttempt(client, attempt.id, async () => { sends++; throw ambiguous; });
    const afterOutcome = (await client.send(new GetCommand({ TableName: TABLE, Key: keys('SPONSOR_SEND_ATTEMPT', attempt.id) }))).Item!;
    assert.equal(outcome, 'outcome_unknown', JSON.stringify({ reason: afterOutcome.safeReasonCode, status: afterOutcome.status }));
    assert.equal(await executeAttempt(client, attempt.id, async () => { sends++; return { MessageId: 'must-not-send' }; }), 'skipped');
    assert.equal(sends, 1);
    const stored = (await client.send(new GetCommand({ TableName: TABLE, Key: keys('SPONSOR_SEND_ATTEMPT', attempt.id) }))).Item!;
    assert.equal(stored.status, 'outcome_unknown');
    assert.equal(stored.recoveryBlocked, false);
    assert.ok(stored.payloadDeleteAt);
    assert.equal(stored.correlationToken, undefined);
  });

  it('classifies only documented definitive authenticated 4xx as failed safe', async () => {
    const input = await seedApproval(7);
    const attempt = await approveDraft(client, input);
    let sends = 0;
    const rejection = Object.assign(new Error('synthetic rejection'), {
      name: 'MessageRejected',
      $metadata: { httpStatusCode: 400 },
    });
    const outcome = await executeAttempt(client, attempt.id, async () => { sends++; throw rejection; });
    const afterOutcome = (await client.send(new GetCommand({ TableName: TABLE, Key: keys('SPONSOR_SEND_ATTEMPT', attempt.id) }))).Item!;
    assert.equal(outcome, 'failed_safe', JSON.stringify({ reason: afterOutcome.safeReasonCode, status: afterOutcome.status }));
    assert.equal(sends, 1);
  });

  it('records event-before-receipt, duplicates and out-of-order facts without a resend', async () => {
    const input = await seedApproval(8);
    const attempt = await approveDraft(client, input);
    const rawAttempt = (await client.send(new GetCommand({ TableName: TABLE, Key: keys('SPONSOR_SEND_ATTEMPT', attempt.id) }))).Item!;
    const correlation = String(rawAttempt.correlationToken);
    let sends = 0;
    const event = (eventType: string, eventId: string, eventTime: string) => ({
      schemaVersion: '1',
      eventId,
      eventTime,
      eventType,
      messageId: 'synthetic-message-8',
      awsAccount: config.sesAccount,
      awsRegion: config.sesRegion,
      configurationSet: config.configurationSet,
      configurationSetGeneration: config.configurationSetGeneration,
      attemptCorrelation: correlation,
      communicationId: attempt.communicationId,
      configGeneration: String(config.generation),
    });
    let earlyEvent: unknown;
    let earlyEventError: unknown;
    const executionOutcome = await executeAttempt(client, attempt.id, async () => {
      sends++;
      try {
        earlyEvent = await ingestSanitizedSesEvent(client, event('DELIVERY', 'event-8-delivery', '2026-07-30T12:02:00.000Z'));
      } catch (error) {
        earlyEventError = error;
        throw error;
      }
      return { MessageId: 'synthetic-message-8' };
    });
    const afterExecution = (await client.send(new GetCommand({ TableName: TABLE, Key: keys('SPONSOR_SEND_ATTEMPT', attempt.id) }))).Item!;
    assert.equal(executionOutcome, 'accepted', JSON.stringify({ reason: afterExecution.safeReasonCode, status: afterExecution.status, earlyEvent, earlyEventError: String(earlyEventError) }));
    assert.equal(sends, 1);
    assert.deepEqual(await ingestSanitizedSesEvent(client, event('DELIVERY', 'event-8-delivery', '2026-07-30T12:02:00.000Z')), { accepted: true, reasonCode: 'duplicate' });
    assert.equal((await ingestSanitizedSesEvent(client, event('SEND', 'event-8-send', '2026-07-30T12:00:00.000Z'))).accepted, true);
    assert.equal((await ingestSanitizedSesEvent(client, event('BOUNCE', 'event-8-bounce', '2026-07-30T12:03:00.000Z'))).accepted, true);
    assert.equal((await ingestSanitizedSesEvent(client, event('COMPLAINT', 'event-8-complaint', '2026-07-30T12:04:00.000Z'))).accepted, true);
    const stored = (await client.send(new GetCommand({ TableName: TABLE, Key: keys('SPONSOR_SEND_ATTEMPT', attempt.id) }))).Item!;
    assert.equal(stored.status, 'provider_observed');
    assert.equal(stored.derivedStatus, 'complained');
    assert.equal(stored.providerFacts.DELIVERY.count, 1);
    assert.equal(stored.providerFacts.SEND.count, 1);
    assert.ok((await client.send(new GetCommand({ TableName: TABLE, Key: keys('PENDING_SPONSOR_SEND_EVENTS', attempt.id) }))).Item);
    await processDueSponsorSends(client);
    assert.equal((await client.send(new GetCommand({ TableName: TABLE, Key: keys('PENDING_SPONSOR_SEND_EVENTS', attempt.id) }))).Item, undefined);
    const mismatch = await ingestSanitizedSesEvent(client, { ...event('DELIVERY', 'event-8-wrong', '2026-07-30T12:05:00.000Z'), messageId: 'wrong-message' });
    assert.deepEqual(mismatch, { accepted: false, reasonCode: 'message-mismatch' });
  });

  it('preserves all simultaneous distinct SES facts and exposes redacted paginated booking history', async () => {
    const input = await seedApproval(23);
    const attempt = await approveDraft(client, input);
    const rawAttempt = (await client.send(new GetCommand({
      TableName: TABLE,
      Key: keys('SPONSOR_SEND_ATTEMPT', attempt.id),
    }))).Item!;
    const { digest: _oldDigest, ...rotatedBase } = config;
    const rotated = validateSendConfig({
      ...rotatedBase,
      generation: config.generation + 1,
      configurationSet: 'rotated-reviewed-send',
      configurationSetGeneration: 'rotated-generation',
    }, hmac);
    await put('SPONSOR_SEND_CONFIG', 'CURRENT', { ...rotated, recordType: 'sponsor-send-config' });
    const eventTypes = ['SEND', 'DELIVERY', 'DELIVERY_DELAY', 'REJECT', 'RENDERING_FAILURE', 'BOUNCE', 'COMPLAINT'];
    const outcomes = await Promise.all(eventTypes.map((eventType, index) => ingestSanitizedSesEvent(client, {
      schemaVersion: '1',
      eventId: `simultaneous-23-${eventType}`,
      eventTime: `2026-07-30T12:${String(index).padStart(2, '0')}:00.000Z`,
      eventType,
      messageId: 'simultaneous-message-23',
      awsAccount: config.sesAccount,
      awsRegion: config.sesRegion,
      configurationSet: config.configurationSet,
      configurationSetGeneration: config.configurationSetGeneration,
      attemptCorrelation: String(rawAttempt.correlationToken),
      communicationId: attempt.communicationId,
      configGeneration: String(config.generation),
    })));
    assert.ok(outcomes.every((outcome) => outcome.accepted));
    const stored = (await client.send(new GetCommand({
      TableName: TABLE,
      Key: keys('SPONSOR_SEND_ATTEMPT', attempt.id),
    }))).Item!;
    assert.equal(stored.derivedStatus, 'complained');
    for (const eventType of eventTypes) assert.equal(stored.providerFacts[eventType].count, 1);
    const facts = ((await client.send(new ScanCommand({ TableName: TABLE }))).Items || [])
      .filter((item) => item.recordType === 'sponsor-send-event-fact' && item.attemptId === attempt.id);
    assert.equal(facts.length, eventTypes.length);
    await put('SPONSOR_SEND_CONFIG', 'CURRENT', { ...config, recordType: 'sponsor-send-config' });

    let historyItems: Record<string, unknown>[] = [];
    for (let retry = 0; retry < 20; retry++) {
      let history = await listBookingCommunications(client, input.draft.bookingId, { limit: 2 });
      historyItems = [...history.items];
      while (history.nextCursor) {
        history = await listBookingCommunications(client, input.draft.bookingId, { limit: 2, cursor: history.nextCursor });
        historyItems.push(...history.items);
      }
      if (historyItems.some((item) => item.recordType === 'sponsor-send-attempt')) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.ok(
      historyItems.some((item) => item.recordType === 'sponsor-send-attempt'),
      JSON.stringify({ attemptIndex: [rawAttempt.GSI4PK, rawAttempt.GSI4SK], historyItems }),
    );
    assert.equal(JSON.stringify(historyItems).includes('correlationToken'), false);
    assert.equal(JSON.stringify(historyItems).includes('correlationHash'), false);
    assert.equal(JSON.stringify(historyItems).includes(String(rawAttempt.correlationToken)), false);
    await client.send(new UpdateCommand({
      TableName: TABLE,
      Key: keys('SPONSOR_SEND_ATTEMPT', attempt.id),
      UpdateExpression: 'SET leaseOwner = :owner, leaseExpiresAt = :expiry, resolutionReason = :reason',
      ExpressionAttributeValues: { ':owner': 'private-worker', ':expiry': '2099-01-01T00:00:00Z', ':reason': 'private operator reason' },
    }));
    const redacted = await listBookingCommunications(client, input.draft.bookingId, { limit: 50 });
    const encodedHistory = JSON.stringify(redacted);
    for (const forbidden of [
      'leaseOwner', 'leaseExpiresAt', 'resolutionReason', 'private-worker', 'private operator reason',
      'payloadHash', 'previewHash', 'providerMessageId', 'messageId',
      String(stored.payloadHash), String(stored.previewHash), String(stored.providerMessageId),
      String(facts[0].id), String(facts[0].messageId),
    ]) {
      assert.equal(encodedHistory.includes(forbidden), false);
    }
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

  it('constructs one exact SES Simple plain-text request and never exposes unsupported fields', async () => {
    const input = await seedApproval(9);
    const attempt = await approveDraft(client, input);
    let request: any;
    assert.equal(await executeAttempt(client, attempt.id, async (candidate) => {
      request = candidate;
      return { MessageId: 'synthetic-message-9' };
    }), 'accepted');
    assert.deepEqual(request.Destination, { ToAddresses: ['recipient-9@example.invalid'] });
    assert.equal(request.FromEmailAddress, 'sender@example.invalid');
    assert.equal(request.FromEmailAddressIdentityArn, config.sesIdentityArn);
    assert.deepEqual(request.Content.Simple.Subject, { Charset: 'UTF-8', Data: 'Synthetic confirmation 9' });
    assert.deepEqual(request.Content.Simple.Body.Text, { Charset: 'UTF-8', Data: 'Synthetic message body.\n' });
    assert.equal(request.Content.Simple.Body.Html, undefined);
    assert.equal(request.Content.Raw, undefined);
    assert.equal(request.Content.Template, undefined);
    assert.equal(request.Destination.CcAddresses, undefined);
    assert.equal(request.Destination.BccAddresses, undefined);
    assert.equal(request.ConfigurationSetName, config.configurationSet);
    assert.deepEqual(request.EmailTags.map((tag: any) => tag.Name).sort(), [
      'attempt', 'communication', 'config-generation', 'configuration-set-generation',
    ]);
  });

  it('keeps the approved provider binding when CURRENT rotates after the dispatch marker', async () => {
    const input = await seedApproval(29);
    const attempt = await approveDraft(client, input);
    const rawAttempt = (await client.send(new GetCommand({
      TableName: TABLE,
      Key: keys('SPONSOR_SEND_ATTEMPT', attempt.id),
    }))).Item!;
    const approvedConfig = config;
    const { digest: _digest, ...rotatedBase } = approvedConfig;
    const rotated = validateSendConfig({
      ...rotatedBase,
      generation: approvedConfig.generation + 1,
      sesRegion: 'us-east-1',
      sesIdentityArn: 'arn:aws:ses:us-east-1:123456789012:identity/rotated.example.invalid',
      from: 'rotated@example.invalid',
      configurationSet: 'rotated-after-marker',
      configurationSetGeneration: 'rotated-after-marker-1',
    }, hmac);
    let sends = 0;
    try {
      assert.equal(await executeAttempt(client, attempt.id, async (request, _signal, binding) => {
        sends++;
        await put('SPONSOR_SEND_CONFIG', 'CURRENT', { ...rotated, recordType: 'sponsor-send-config' });
        assert.equal(binding.region, approvedConfig.sesRegion);
        assert.equal(binding.identityArn, approvedConfig.sesIdentityArn);
        assert.equal(binding.configurationSet, approvedConfig.configurationSet);
        assert.equal(request.FromEmailAddress, approvedConfig.from);
        assert.equal(request.FromEmailAddressIdentityArn, approvedConfig.sesIdentityArn);
        assert.equal(request.ConfigurationSetName, approvedConfig.configurationSet);
        return { MessageId: 'marker-rotation-message-29' };
      }), 'accepted');
      assert.equal(sends, 1);
      const late = await ingestSanitizedSesEvent(client, {
        schemaVersion: '1',
        eventId: 'marker-rotation-delivery-29',
        eventTime: new Date().toISOString(),
        eventType: 'DELIVERY',
        messageId: 'marker-rotation-message-29',
        awsAccount: approvedConfig.sesAccount,
        awsRegion: approvedConfig.sesRegion,
        configurationSet: approvedConfig.configurationSet,
        configurationSetGeneration: approvedConfig.configurationSetGeneration,
        attemptCorrelation: String(rawAttempt.correlationToken),
        communicationId: attempt.communicationId,
        configGeneration: String(approvedConfig.generation),
      });
      assert.equal(late.accepted, true);
    } finally {
      await put('SPONSOR_SEND_CONFIG', 'CURRENT', { ...approvedConfig, recordType: 'sponsor-send-config' });
    }
  });

  it('recovers a crash after the dispatch marker as unknown without calling SES', async () => {
    const input = await seedApproval(10);
    const attempt = await approveDraft(client, input);
    const leased = await leaseAttempt(client, attempt.id, 'synthetic-crashed-worker');
    assert.ok(leased);
    await client.send(new UpdateCommand({
      TableName: TABLE,
      Key: keys('SPONSOR_SEND_ATTEMPT', attempt.id),
      UpdateExpression: 'SET dispatchStartedAt = :now, dispatchGeneration = :generation',
      ConditionExpression: '#status = :executing AND leaseOwner = :owner',
      ExpressionAttributeNames: { '#status': 'status' },
      ExpressionAttributeValues: {
        ':now': new Date().toISOString(),
        ':generation': 1,
        ':executing': 'executing',
        ':owner': 'synthetic-crashed-worker',
      },
    }));
    let sends = 0;
    assert.equal(await executeAttempt(client, attempt.id, async () => { sends++; return { MessageId: 'must-not-send' }; }), 'outcome_unknown');
    assert.equal(sends, 0);
  });

  it('exports an expired-payload evidence graph, rejects semantic tampering, and restores it non-dispatchable', async () => {
    const expiredInput = await seedApproval(30);
    const expiredAttempt = await approveDraft(client, expiredInput);
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
      item.communicationId === expiredAttempt.communicationId
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
    crossBookingAttempt.bookingId = 'semantically-wrong-booking';
    assert.throws(() => validateSponsorPrivateArchive(resealArchive(crossBooking)));

    const crossSource = structuredClone(archive);
    const sourceDraft = crossSource.records.find((item) => item.recordType === 'communication-draft-version')!;
    const sourceSuggestion = crossSource.records.find((item) => (
      item.recordType === 'communication-suggestion' && item.id === sourceDraft.suggestionId
    ))!;
    sourceSuggestion.bookingId = 'semantically-wrong-source-booking';
    assert.throws(() => validateSponsorPrivateArchive(resealArchive(crossSource)));

    const wrongProvider = structuredClone(archive);
    const wrongProviderAttempt = wrongProvider.records.find((item) => item.recordType === 'sponsor-send-attempt')!;
    wrongProviderAttempt.sesRegion = 'semantically-wrong-region';
    assert.throws(() => validateSponsorPrivateArchive(resealArchive(wrongProvider)));

    const crossEvent = structuredClone(archive);
    const eventRecord = crossEvent.records.find((item) => item.recordType === 'sponsor-send-event-fact');
    assert.ok(eventRecord);
    eventRecord.bookingId = 'semantically-wrong-event-booking';
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
      item.recordType === 'sponsor-send-attempt' && item.id === expiredAttempt.id
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
