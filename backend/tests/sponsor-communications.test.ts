import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createHash } from 'node:crypto';
import {
  canonicalJson,
  canonicalPayload,
  derivedStatus,
  keyringDigest,
  mergeProviderFact,
  normalizeContent,
  normalizeEmail,
  payloadDeleteAt,
  suppressionKey,
  validateKeyring,
  validateSendConfig,
  type HmacKeyring,
} from '../src/sponsorCommunications/core';
import { communicationCandidates } from '../src/sponsorCommunications/suggestions';
import { renderTemplate, validateTemplateSet } from '../src/sponsorCommunications/secrets';
import { validateSanitizedSesEvent } from '../src/sponsorCommunications/sesEvents';
import { validateSponsorPrivateArchive, type SponsorPrivateArchive } from '../src/sponsorCommunications/privateArchive';

const keyring: HmacKeyring = {
  secretVersionId: 'secret-version-1',
  activeVersion: 'v2',
  acceptedVersions: ['v1', 'v2'],
  keys: {
    v1: Buffer.alloc(32, 1).toString('base64'),
    v2: Buffer.alloc(32, 2).toString('base64'),
  },
};
const configInput = {
  enabled: false,
  generation: 1,
  templateSetGeneration: 'templates-1',
  templateSetDigest: 'a'.repeat(64),
  hmacSecretVersionId: keyring.secretVersionId,
  hmacActiveVersion: keyring.activeVersion,
  hmacAcceptedVersions: keyring.acceptedVersions,
  hmacKeyringDigest: keyringDigest(keyring),
  sesAccount: '123456789012',
  sesRegion: 'eu-west-1',
  sesIdentityArn: 'arn:aws:ses:eu-west-1:123456789012:identity/example.invalid',
  from: 'Sender@Example.Invalid',
  replyTo: 'Replies@Example.Invalid',
  configurationSet: 'reviewed-send',
  configurationSetGeneration: 'config-1',
  approverPolicyVersion: 'admin-v1',
};

describe('sponsor reviewed communication core', () => {
  it('normalizes exactly one 7-bit ASCII address once', () => {
    assert.equal(normalizeEmail(' \tPerson+Tag@Example.Invalid\t '), 'person+tag@example.invalid');
    for (const invalid of [
      'Name <person@example.invalid>',
      'one@example.invalid,two@example.invalid',
      'person@éxample.invalid',
      'person@example.invalid\r\nBcc:x@example.invalid',
      'person(comment)@example.invalid',
      'person@example',
      `${'a'.repeat(250)}@example.invalid`,
    ]) assert.throws(() => normalizeEmail(invalid));
  });

  it('normalizes line endings only at draft creation and rejects subject controls', () => {
    assert.deepEqual(normalizeContent('One subject', 'line 1\r\nline 2\rline 3'), {
      subject: 'One subject',
      body: 'line 1\nline 2\nline 3',
    });
    assert.throws(() => normalizeContent('Injected\r\nBcc: x', 'body'));
  });

  it('uses deterministic canonical JSON and rejects non-finite values', () => {
    assert.equal(canonicalJson({ z: 1, a: ['x', true] }), '{"a":["x",true],"z":1}');
    assert.throws(() => canonicalJson({ unsafe: Number.NaN }));
  });

  it('validates dual-read one-write HMAC keyrings without exposing an address', () => {
    const valid = validateKeyring(keyring);
    const first = suppressionKey('v1', 'person@example.invalid', valid);
    const second = suppressionKey('v2', 'person@example.invalid', valid);
    assert.notEqual(first, second);
    assert.doesNotMatch(first, /person|example/i);
    assert.throws(() => validateKeyring({ ...keyring, acceptedVersions: ['v0', 'v1', 'v2'], keys: { ...keyring.keys, v0: keyring.keys.v1 } }));
  });

  it('binds all immutable payload fields and byte lengths into the hash', () => {
    const config = validateSendConfig(configInput, keyring);
    const base = {
      from: config.from,
      replyTo: config.replyTo,
      to: 'recipient@example.invalid',
      communicationType: 'publication-live' as const,
      communicationId: 'communication-1',
      version: 1,
      subject: 'Publication is live',
      body: 'Synthetic body\n',
      publicLinks: ['https://example.invalid/public'],
      templateId: 'publication-live' as const,
      templateVersion: '1',
      templateDigest: 'b'.repeat(64),
      templateSetGeneration: config.templateSetGeneration,
      bookingId: 'booking-1',
      bookingVersion: 3,
      organizationId: 'organization-1',
      organizationVersion: 2,
      contactId: 'contact-1',
      contactVersion: 4,
      suggestionId: 'suggestion-1',
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
    };
    const first = canonicalPayload(base);
    const changed = canonicalPayload({ ...base, configurationSetGeneration: 'config-2' });
    assert.notEqual(first.hash, changed.hash);
    assert.equal(first.payload.bodyBytes, Buffer.byteLength(base.body));
    assert.equal(first.payload.to, 'recipient@example.invalid');
  });

  it('anchors private payload retention to exactly 30 days without event-dependent extension', () => {
    const anchor = '2026-07-30T12:00:00.000Z';
    assert.equal(payloadDeleteAt(anchor), Math.floor(Date.parse(anchor) / 1000) + 30 * 86_400);
  });

  it('creates only deterministic milestone candidates, never executable work', () => {
    const booking = {
      id: 'booking-1',
      version: 3,
      organizationId: 'organization-1',
      primaryContactId: 'contact-1',
      status: 'confirmed',
      plannedPublicationDate: '2026-08-13',
      artifactUrls: [],
    };
    assert.deepEqual(communicationCandidates(booking, '2026-07-30').map((item) => item.type), [
      'booking-confirmation',
      'materials-reminder',
    ]);
    assert.deepEqual(communicationCandidates({ ...booking, status: 'cancelled' }, '2026-07-30'), []);
  });

  it('validates exactly four allowlisted templates and only declared placeholders', () => {
    const card = validateTemplateSet({
      schemaVersion: '1',
      generation: 'synthetic-1',
      templates: [
        ['booking-confirmation', 'Confirmed for {{organizationName}}'],
        ['materials-reminder', 'Materials for {{organizationName}}'],
        ['publication-live', 'Live: {{publicLink}}'],
        ['performance-follow-up', 'Results for {{organizationName}}'],
      ].map(([id, body]) => ({ id, version: '1', subject: `Synthetic ${id}`, body, placeholders: body.includes('publicLink') ? ['publicLink'] : ['organizationName'] })),
    });
    assert.equal(card.card.templates.length, 4);
    assert.deepEqual(renderTemplate(card.card.templates[2], {
      organizationName: 'Synthetic Sponsor',
      publicLink: 'https://example.invalid/live',
    }), { subject: 'Synthetic publication-live', body: 'Live: https://example.invalid/live' });
  });

  it('derives monotonic provider precedence from immutable facts', () => {
    let facts = {};
    facts = mergeProviderFact(facts, 'DELIVERY', 'event-delivery', '2026-07-30T12:02:00.000Z');
    facts = mergeProviderFact(facts, 'SEND', 'event-send', '2026-07-30T12:00:00.000Z');
    assert.equal(derivedStatus(facts, 'accepted'), 'delivered');
    facts = mergeProviderFact(facts, 'COMPLAINT', 'event-complaint', '2026-07-30T12:03:00.000Z');
    facts = mergeProviderFact(facts, 'DELIVERY', 'event-delivery', '2026-07-30T12:02:00.000Z');
    assert.equal(derivedStatus(facts, 'accepted'), 'complained');
    assert.equal((facts as any).DELIVERY.count, 1);
  });

  it('accepts only the strict sanitized SES envelope', () => {
    const envelope = {
      schemaVersion: '1',
      eventId: 'event-1',
      eventTime: '2026-07-30T12:00:00.000Z',
      eventType: 'DELIVERY',
      messageId: 'message-1',
      awsAccount: '123456789012',
      awsRegion: 'eu-west-1',
      configurationSet: 'reviewed-send',
      configurationSetGeneration: 'config-1',
      attemptCorrelation: 'a'.repeat(43),
      communicationId: 'communication-1',
      configGeneration: '1',
    };
    assert.equal(validateSanitizedSesEvent(envelope).eventType, 'DELIVERY');
    assert.throws(() => validateSanitizedSesEvent({ ...envelope, recipient: 'private@example.invalid' }));
    assert.throws(() => validateSanitizedSesEvent({ ...envelope, eventType: 'OPEN' }));
  });

  it('validates private archive checksum/order and rejects action material', () => {
    const records = [{
      PK: 'SPONSOR_COMM_AUDIT#one',
      SK: 'SPONSOR_COMM_AUDIT#one',
      recordType: 'sponsor-communication-audit',
      action: 'synthetic-archive-check',
      at: '2026-07-30T12:00:00.000Z',
    }];
    const lines = records.map(canonicalJson).join('\n') + '\n';
    const checksum = createHash('sha256').update(lines).digest('hex');
    const archive: SponsorPrivateArchive = {
      manifest: {
        schemaVersion: '1',
        classification: 'private-sponsor-communications',
        generatedAt: '2026-07-30T12:00:00.000Z',
        count: 1,
        recordsSha256: checksum,
        configVersions: [],
        configDigests: [],
        recordCounts: { 'sponsor-communication-audit': 1 },
      },
      records,
    };
    assert.doesNotThrow(() => validateSponsorPrivateArchive(archive));
    const unsafe = structuredClone(archive);
    unsafe.records[0].tokenHash = 'forbidden';
    assert.throws(() => validateSponsorPrivateArchive(unsafe));
    const badVersions = structuredClone(archive);
    badVersions.manifest.configVersions = [999];
    assert.throws(() => validateSponsorPrivateArchive(badVersions));
    const badDigests = structuredClone(archive);
    badDigests.manifest.configDigests = ['f'.repeat(64)];
    assert.throws(() => validateSponsorPrivateArchive(badDigests));
    const badCounts = structuredClone(archive);
    badCounts.manifest.recordCounts = {};
    assert.throws(() => validateSponsorPrivateArchive(badCounts));
  });
});
