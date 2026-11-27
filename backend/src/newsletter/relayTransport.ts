/**
 * Relay as transport only: hand the owner-approved, frozen newsletter payload
 * to Relay's native campaign API and let Relay test-send or schedule it.
 *
 * DataOps never sends blocks, never asks Relay to render, and never reads
 * content back. The only Relay endpoints used are the client campaign API
 * (`docs/api.md` "Campaign API" in DataTalksClub/relay):
 *
 *   GET  /api/campaigns/<key>            status of the campaign DataOps created
 *   PUT  /api/campaigns/<key>            save the payload as a draft campaign
 *   POST /api/campaigns/<key>/test-send  send the draft to allow-listed testers
 *   POST /api/campaigns/<key>/queue      confirm a future `scheduled_at`
 *   POST /api/campaigns/<key>/cancel     cancel before sending starts
 *
 * Guards: every call needs a current owner approval and the frozen payload
 * whose hash it names (nothing reaches Relay before approval); scheduling takes
 * a lock on the draft with an optimistic write before any Relay call, so a
 * double click or a second tab cannot schedule twice; a retry after a lost
 * response adopts a campaign Relay already holds with the same payload hash
 * instead of creating another; a test send is recorded under its request id so
 * replaying it returns the first result instead of sending again.
 *
 * The API key is read from the DataOps secret store, sent only as a header,
 * and never logged or returned.
 */
import { createHash } from 'crypto';
import { GetCommand, PutCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { TABLE_ARTIFACTS } from '../db/tableNames';
import { readRuntimeSecret } from '../secrets/reader';
import type { DraftDelivery, IssueBlockSet } from './blocks';
import { BlocksError } from './blocksErrors';
import {
  appendBlockRevisions,
  BlockSetVersionConflict,
  deleteWebView,
  getFrozenPayload,
  putBlockSet,
  putWebView,
  type FrozenPayload,
} from './blocksStore';
import { requireBlockSet, type BlockActor } from './blocksEdit';
import { approvalState, payloadHashOf, renderDraft } from './draftApproval';

export type RelayTarget = 'production' | 'dev';

export const RELAY_TARGET_CONFIG: Record<RelayTarget, { url: string; secret: string; secretField?: string }> = {
  production: { url: 'https://relay.datatalks.club', secret: 'relay-production.dtc-newsletter-api-key' },
  // The dev secret's value is a JSON object of keys; the API key is RELAY_API_KEY.
  dev: { url: 'https://dev.relay.datatalks.club', secret: 'relay-dev.api-keys', secretField: 'RELAY_API_KEY' },
};

/** The newsletter's Relay client and audience (`docs/public-signup/README.md` in Relay). */
export const RELAY_CLIENT = 'dtc-newsletter';
export const DEFAULT_RELAY_AUDIENCE = 'dtc';
export const RELAY_TIMEOUT_MS = 20_000;
/** Relay test sends accept at most two addresses per request. */
export const MAX_TEST_RECIPIENTS = 2;
/** A schedule must leave Relay time to treat it as future, never as "send now". */
export const MIN_SCHEDULE_LEAD_MS = 15 * 60_000;
export const MAX_SCHEDULE_AHEAD_MS = 60 * 86_400_000;

export function relayTarget(): RelayTarget {
  return process.env.RELAY_NEWSLETTER_TARGET === 'dev' ? 'dev' : 'production';
}

export function relayAudience(): string {
  return (process.env.RELAY_NEWSLETTER_AUDIENCE || DEFAULT_RELAY_AUDIENCE).trim();
}

export class RelayError extends Error {
  constructor(message: string, public readonly status = 502, public readonly code = 'relay_error', public readonly relayStatus = 0) {
    super(message);
  }
}

export interface RelayDeps {
  fetchImpl: typeof fetch;
  readSecret: (name: string) => Promise<string>;
  now: () => number;
}

const deps: RelayDeps = { fetchImpl: (...args) => globalThis.fetch(...args), readSecret: readRuntimeSecret, now: () => Date.now() };

/** Tests swap the network, the secret store and the clock; returns a restore function. */
export function setRelayDepsForTests(next: Partial<RelayDeps>): () => void {
  const previous = { ...deps };
  Object.assign(deps, next);
  return () => Object.assign(deps, previous);
}

async function relayKey(target: RelayTarget): Promise<string> {
  const config = RELAY_TARGET_CONFIG[target];
  let raw: string;
  try {
    raw = await deps.readSecret(config.secret);
  } catch (error) {
    throw new RelayError(
      `Relay ${target} API key unavailable: DataOps secret ${config.secret} could not be read (${(error as Error).message}).`,
      503,
      'relay_credentials_missing',
    );
  }
  let key = raw.trim();
  if (config.secretField) {
    try {
      key = String((JSON.parse(raw) as Record<string, unknown>)[config.secretField] || '').trim();
    } catch {
      key = '';
    }
  }
  if (!key) throw new RelayError(`DataOps secret ${config.secret} has no Relay API key.`, 503, 'relay_credentials_missing');
  return key;
}

export interface RelayCampaign {
  external_key: string;
  status: string;
  subject?: string;
  preview_text?: string;
  html_body?: string;
  text_body?: string;
  scheduled_at?: string | null;
  sent_at?: string | null;
  metadata?: Record<string, unknown>;
  recipient_count?: number;
  sent_count?: number;
}

export interface CampaignBody {
  subject: string;
  preview_text: string;
  html_body: string;
  text_body: string;
  scheduled_at?: string;
  metadata: Record<string, unknown>;
}

export interface TestSendResult {
  status: string;
  sent_count?: number;
  recipients?: { email: string; message_id?: string }[];
  not_attempted?: string[];
  unconfirmed_email?: string;
}

export interface QueueResult {
  campaign: RelayCampaign;
  queued?: boolean;
  already_queued?: boolean;
  scheduled?: boolean;
}

export interface RelayCampaignClient {
  target: RelayTarget;
  getCampaign(key: string): Promise<RelayCampaign | null>;
  putCampaign(key: string, body: CampaignBody): Promise<RelayCampaign>;
  testSend(key: string, emails: string[]): Promise<TestSendResult>;
  queue(key: string): Promise<QueueResult>;
  cancel(key: string): Promise<{ campaign: RelayCampaign; cancelled: boolean }>;
}

export async function relayCampaignClient(target: RelayTarget = relayTarget()): Promise<RelayCampaignClient> {
  const config = RELAY_TARGET_CONFIG[target];
  const key = await relayKey(target);
  const scope = { client: RELAY_CLIENT, audience: relayAudience() };

  async function call<T>(method: string, path: string, body?: unknown): Promise<{ status: number; data: T }> {
    const label = `Relay ${target} ${method} ${path.split('?')[0]}`;
    const payload = body === undefined ? undefined : JSON.stringify(body);
    let response: Response;
    try {
      response = await deps.fetchImpl(`${config.url}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${key}`,
          accept: 'application/json',
          ...(payload ? { 'content-type': 'application/json' } : {}),
        },
        body: payload,
        signal: AbortSignal.timeout(RELAY_TIMEOUT_MS),
      });
    } catch (error) {
      const name = (error as { name?: string })?.name;
      const reason = name === 'TimeoutError' || name === 'AbortError' ? `timed out after ${RELAY_TIMEOUT_MS / 1000}s` : (error as Error)?.message || 'network error';
      throw new RelayError(`${label} failed: ${reason}. The outcome is unknown; check the delivery status before retrying.`, 504, 'relay_unreachable');
    }
    const text = await response.text();
    let data: unknown = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = null;
    }
    if (!response.ok) {
      const hint = response.status === 403 && !text.trim().startsWith('{')
        ? " (a bare 403 is Relay's CloudFront WAF body-size rule: the campaign path must be exempt for authenticated API writes)"
        : '';
      throw new RelayError(`${label} returned HTTP ${response.status}: ${text.slice(0, 300)}${hint}`, response.status === 404 ? 404 : 502, 'relay_http_error', response.status);
    }
    if (data === null) throw new RelayError(`${label} returned a non-JSON body.`, 502, 'relay_bad_response', response.status);
    return { status: response.status, data: data as T };
  }

  const path = (campaignKey: string, suffix = '') => `/api/campaigns/${encodeURIComponent(campaignKey)}${suffix}`;
  return {
    target,
    async getCampaign(campaignKey) {
      try {
        const query = `?client=${encodeURIComponent(scope.client)}&audience=${encodeURIComponent(scope.audience)}`;
        return (await call<{ campaign: RelayCampaign }>('GET', `${path(campaignKey)}${query}`)).data.campaign;
      } catch (error) {
        if (error instanceof RelayError && error.relayStatus === 404) return null;
        throw error;
      }
    },
    async putCampaign(campaignKey, body) {
      return (await call<{ campaign: RelayCampaign }>('PUT', path(campaignKey), { ...scope, ...body })).data.campaign;
    },
    async testSend(campaignKey, emails) {
      return (await call<TestSendResult>('POST', path(campaignKey, '/test-send'), { ...scope, emails })).data;
    },
    async queue(campaignKey) {
      return (await call<QueueResult>('POST', path(campaignKey, '/queue'), scope)).data;
    },
    async cancel(campaignKey) {
      return (await call<{ campaign: RelayCampaign; cancelled: boolean }>('POST', path(campaignKey, '/cancel'), scope)).data;
    },
  };
}

// ------------------------------------------------------------------ guards

/** One Relay campaign per delivery attempt; a cancelled campaign cannot be edited again in Relay. */
export function campaignKeyFor(set: Pick<IssueBlockSet, 'issueId'>, issueNumber: number | undefined, attempt: number): string {
  const base = `dataops-newsletter-${issueNumber ? `${issueNumber}-` : ''}${set.issueId.slice(0, 12)}`;
  return attempt > 1 ? `${base}-r${attempt}` : base;
}

function currentAttempt(set: IssueBlockSet): number {
  const delivery = set.delivery;
  if (!delivery) return 1;
  const attempt = delivery.attempt || 1;
  return delivery.state === 'cancelled' ? attempt + 1 : attempt;
}

/** The frozen payload of the current approval, re-verified byte for byte. */
async function approvedPayload(client: DynamoDBDocumentClient, set: IssueBlockSet): Promise<FrozenPayload> {
  const render = renderDraft(set);
  if (approvalState(set, render) !== 'current' || !set.approval) {
    throw new BlocksError(
      set.approval
        ? 'The approval is stale: the draft changed after it was approved. Review and approve the current email first.'
        : 'The draft has no owner approval. Review the email and approve it first; nothing goes to Relay before that.',
      409,
      'approval_required',
    );
  }
  const payload = await getFrozenPayload(client, set.issueId, set.approval.payloadHash);
  if (!payload || payloadHashOf(payload) !== set.approval.payloadHash) {
    throw new BlocksError('The approved payload is missing or does not match its hash; approve the draft again.', 409, 'approval_payload_invalid');
  }
  return payload;
}

const metadataFor = (payload: FrozenPayload) => ({
  source_system: 'dataops-newsletter',
  dataops_issue_id: payload.issueId,
  dataops_payload_sha256: payload.payloadHash,
  dataops_draft_version: payload.draftVersion,
});

const campaignBody = (payload: FrozenPayload, scheduledAt?: string): CampaignBody => ({
  subject: payload.subject,
  preview_text: payload.previewText,
  html_body: payload.html,
  text_body: payload.text,
  ...(scheduledAt ? { scheduled_at: scheduledAt } : {}),
  metadata: metadataFor(payload),
});

const sameHtml = (campaign: RelayCampaign, payload: FrozenPayload) =>
  createHash('sha256').update(campaign.html_body || '').digest('hex') === createHash('sha256').update(payload.html).digest('hex');

function holdsPayload(campaign: RelayCampaign, payload: FrozenPayload): boolean {
  return campaign.metadata?.dataops_payload_sha256 === payload.payloadHash;
}

// ------------------------------------------------------------------ test send

const testKey = (issueId: string, requestId: string) => ({ PK: `NL_DELIVERY#${issueId}`, SK: `TEST#${requestId}` });

export interface TestSendOutcome {
  campaignKey: string;
  emails: string[];
  status: string;
  sentCount: number;
  replayed: boolean;
  detail: TestSendResult | null;
}

function cleanEmails(input: unknown): string[] {
  if (!Array.isArray(input) || !input.length) throw new BlocksError('Give one or two test addresses.', 400, 'test_recipients_missing');
  const emails = [...new Set(input.map((item) => String(item || '').trim().toLowerCase()).filter(Boolean))];
  if (!emails.length) throw new BlocksError('Give one or two test addresses.', 400, 'test_recipients_missing');
  if (emails.length > MAX_TEST_RECIPIENTS) throw new BlocksError(`Relay test sends take at most ${MAX_TEST_RECIPIENTS} addresses.`, 400, 'test_recipients_too_many');
  const bad = emails.find((email) => !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email));
  if (bad) throw new BlocksError(`${bad} is not an email address.`, 400, 'test_recipients_invalid');
  return emails;
}

function cleanRequestId(input: unknown): string {
  const value = String(input || '').trim();
  if (!/^[A-Za-z0-9_-]{8,80}$/.test(value)) throw new BlocksError('requestId (8-80 letters, digits, - or _) is required so a retry never sends twice.', 400, 'request_id_missing');
  return value;
}

/**
 * Send the approved payload to one or two allow-listed test addresses through
 * Relay. The draft campaign it needs is created (or refreshed) with exactly the
 * approved bytes; nothing is queued.
 */
export async function testSendApproved(
  client: DynamoDBDocumentClient,
  issue: { id: string; issueNumber?: number },
  input: { emails: unknown; requestId: unknown },
  actor: BlockActor,
): Promise<TestSendOutcome> {
  const emails = cleanEmails(input.emails);
  const requestId = cleanRequestId(input.requestId);
  const set = await requireBlockSet(client, issue.id);
  if (set.delivery && (set.delivery.state === 'scheduling' || set.delivery.state === 'scheduled')) {
    throw new BlocksError('The approved email is already scheduled in Relay; test sends go before scheduling.', 409, 'draft_locked');
  }
  const payload = await approvedPayload(client, set);
  const campaignKey = campaignKeyFor(set, issue.issueNumber, currentAttempt(set));
  const now = new Date().toISOString();
  try {
    await client.send(new PutCommand({
      TableName: TABLE_ARTIFACTS,
      Item: { ...testKey(issue.id, requestId), state: 'sending', campaignKey, emails, payloadHash: payload.payloadHash, requestedAt: now, requestedBy: actor.id },
      ConditionExpression: 'attribute_not_exists(PK)',
    }));
  } catch (error) {
    if ((error as { name?: string })?.name !== 'ConditionalCheckFailedException') throw error;
    const prior = (await client.send(new GetCommand({ TableName: TABLE_ARTIFACTS, Key: testKey(issue.id, requestId), ConsistentRead: true }))).Item || {};
    return {
      campaignKey: String(prior.campaignKey || campaignKey),
      emails: (prior.emails as string[]) || emails,
      status: String(prior.state || 'unknown'),
      sentCount: Number(prior.sentCount || 0),
      replayed: true,
      detail: (prior.detail as TestSendResult) || null,
    };
  }
  let detail: TestSendResult | null = null;
  let status = 'failed';
  let error = '';
  try {
    const relay = await relayCampaignClient();
    const existing = await relay.getCampaign(campaignKey);
    if (existing && existing.status !== 'draft') {
      throw new BlocksError(`Relay campaign ${campaignKey} is ${existing.status}, not a draft; it cannot take a test send.`, 409, 'relay_campaign_not_draft');
    }
    const saved = await relay.putCampaign(campaignKey, campaignBody(payload));
    if (!sameHtml(saved, payload)) throw new RelayError(`Relay stored different HTML for ${campaignKey} than the approved payload; nothing was sent.`, 502, 'relay_payload_mismatch');
    detail = await relay.testSend(campaignKey, emails);
    status = detail.status || 'unknown';
  } catch (failure) {
    error = (failure as Error).message;
    throw failure;
  } finally {
    const done = new Date().toISOString();
    await client.send(new UpdateCommand({
      TableName: TABLE_ARTIFACTS,
      Key: testKey(issue.id, requestId),
      UpdateExpression: 'SET #state = :state, sentCount = :sent, detail = :detail, finishedAt = :at, #error = :error',
      ExpressionAttributeNames: { '#state': 'state', '#error': 'error' },
      ExpressionAttributeValues: { ':state': error ? 'failed' : status, ':sent': detail?.sent_count || 0, ':detail': detail, ':at': done, ':error': error },
    }));
    await appendBlockRevisions(client, issue.id, [{
      blockId: '',
      blockType: 'draft',
      origin: 'test-send',
      createdAt: done,
      actorUserId: actor.id,
      actorName: actor.name,
      detail: error
        ? `test send of payload ${payload.payloadHash.slice(0, 12)} to ${emails.join(', ')} failed: ${error}`
        : `test send of payload ${payload.payloadHash.slice(0, 12)} to ${emails.join(', ')} via Relay campaign ${campaignKey}: ${status}`,
      before: null,
      after: null,
    }]).catch(() => undefined);
  }
  return { campaignKey, emails, status, sentCount: detail?.sent_count || 0, replayed: false, detail };
}

// ------------------------------------------------------------------ schedule / cancel

function cleanScheduledAt(input: unknown): string {
  const raw = String(input || '').trim();
  if (!/(?:Z|[+-]\d{2}:\d{2})$/.test(raw)) throw new BlocksError('scheduledAt must be an ISO timestamp with a UTC offset, e.g. 2027-01-10T08:00:00Z.', 400, 'schedule_invalid');
  const at = Date.parse(raw);
  if (!Number.isFinite(at)) throw new BlocksError('scheduledAt is not a valid timestamp.', 400, 'schedule_invalid');
  const lead = at - deps.now();
  if (lead < MIN_SCHEDULE_LEAD_MS) {
    throw new BlocksError(`scheduledAt must be at least ${MIN_SCHEDULE_LEAD_MS / 60_000} minutes in the future, so Relay schedules it instead of sending now.`, 400, 'schedule_too_soon');
  }
  if (lead > MAX_SCHEDULE_AHEAD_MS) throw new BlocksError('scheduledAt is more than 60 days ahead.', 400, 'schedule_too_far');
  return new Date(at).toISOString();
}

async function writeDelivery(client: DynamoDBDocumentClient, set: IssueBlockSet, delivery: DraftDelivery): Promise<IssueBlockSet> {
  const next: IssueBlockSet = { ...set, delivery, version: set.version + 1, updatedAt: delivery.updatedAt };
  await putBlockSet(client, next, set.version);
  return next;
}

/**
 * Schedule the approved payload in Relay for `scheduledAt`. `payloadHash` is
 * the hash the owner confirmed; `expectedVersion` the draft version on screen.
 */
export async function scheduleApproved(
  client: DynamoDBDocumentClient,
  issue: { id: string; issueNumber?: number },
  input: { scheduledAt: unknown; payloadHash: unknown; expectedVersion: unknown; requestId: unknown },
  actor: BlockActor,
): Promise<{ set: IssueBlockSet; delivery: DraftDelivery; adopted: boolean; replayed: boolean }> {
  const requestId = cleanRequestId(input.requestId);
  const scheduledAt = cleanScheduledAt(input.scheduledAt);
  let set = await requireBlockSet(client, issue.id);
  const current = set.delivery;
  if (current && (current.state === 'scheduling' || current.state === 'scheduled')) {
    if (current.requestId === requestId) return { set, delivery: current, adopted: false, replayed: true };
    throw new BlocksError(`The approved email is already ${current.state} in Relay (campaign ${current.campaignKey}).`, 409, 'already_scheduled', { delivery: current });
  }
  if (input.expectedVersion !== set.version) {
    throw new BlocksError(`The draft is at version ${set.version}, not ${String(input.expectedVersion)}: reload before scheduling.`, 409, 'draft_version_conflict', { currentVersion: set.version });
  }
  const payload = await approvedPayload(client, set);
  if (input.payloadHash !== payload.payloadHash) {
    throw new BlocksError('The confirmed payload is not the approved one; review the approved email again.', 409, 'payload_not_confirmed');
  }
  const attempt = currentAttempt(set);
  const campaignKey = campaignKeyFor(set, issue.issueNumber, attempt);
  const now = new Date().toISOString();
  const base = {
    draftVersion: set.version,
    payloadHash: payload.payloadHash,
    campaignKey,
    audience: relayAudience(),
    scheduledAt,
    requestedAt: now,
    requestedBy: actor.id,
    requestedByName: actor.name,
    attempt,
    requestId,
  };
  // The lock: only one writer moves the draft into "scheduling".
  try {
    set = await writeDelivery(client, set, { ...base, state: 'scheduling', updatedAt: now } as DraftDelivery);
  } catch (error) {
    if (error instanceof BlockSetVersionConflict) {
      throw new BlocksError('Another change reached the draft first; reload before scheduling.', 409, 'draft_version_conflict');
    }
    throw error;
  }

  let adopted = false;
  let relayStatus = '';
  let failure: Error | null = null;
  try {
    const relay = await relayCampaignClient();
    const existing = await relay.getCampaign(campaignKey);
    if (existing && existing.status !== 'draft') {
      if (!holdsPayload(existing, payload)) {
        throw new RelayError(`Relay campaign ${campaignKey} is ${existing.status} with a different payload; nothing was changed.`, 409, 'relay_campaign_conflict');
      }
      adopted = true; // A lost response from an earlier attempt: Relay already holds this payload.
      relayStatus = existing.status;
    } else {
      const saved = await relay.putCampaign(campaignKey, campaignBody(payload, scheduledAt));
      if (!sameHtml(saved, payload) || !saved.scheduled_at || Date.parse(saved.scheduled_at) !== Date.parse(scheduledAt)) {
        throw new RelayError(`Relay stored a different payload or time for ${campaignKey}; it was not queued.`, 502, 'relay_payload_mismatch');
      }
      const queued = await relay.queue(campaignKey);
      relayStatus = queued.campaign?.status || '';
      if (!queued.scheduled && !queued.already_queued) {
        throw new RelayError(`Relay did not confirm a schedule for ${campaignKey} (status ${relayStatus || 'unknown'}). Check the campaign in Relay.`, 502, 'relay_schedule_unconfirmed');
      }
    }
  } catch (error) {
    failure = error as Error;
  }

  const done = new Date().toISOString();
  const delivery = {
    ...base,
    state: failure ? 'failed' : 'scheduled',
    relayStatus: relayStatus || undefined,
    ...(failure ? { error: failure.message } : {}),
    updatedAt: done,
  } as DraftDelivery;
  const fresh = await requireBlockSet(client, issue.id);
  set = await writeDelivery(client, fresh, delivery);
  if (!failure) await putWebView(client, payload.webViewToken, issue.id, payload.payloadHash);
  await appendBlockRevisions(client, issue.id, [{
    blockId: '',
    blockType: 'draft',
    origin: 'schedule',
    createdAt: done,
    actorUserId: actor.id,
    actorName: actor.name,
    detail: failure
      ? `scheduling payload ${payload.payloadHash.slice(0, 12)} for ${scheduledAt} failed: ${failure.message}`
      : `payload ${payload.payloadHash.slice(0, 12)} ${adopted ? 'already held' : 'scheduled'} in Relay campaign ${campaignKey} for ${scheduledAt} (audience ${base.audience})`,
    before: null,
    after: null,
  }]);
  if (failure) throw failure;
  return { set, delivery, adopted, replayed: false };
}

/** Cancel a scheduled delivery before Relay starts sending; the draft becomes editable again. */
export async function cancelScheduled(
  client: DynamoDBDocumentClient,
  issue: { id: string },
  actor: BlockActor,
): Promise<{ set: IssueBlockSet; delivery: DraftDelivery }> {
  const set = await requireBlockSet(client, issue.id);
  const delivery = set.delivery;
  if (!delivery || (delivery.state !== 'scheduled' && delivery.state !== 'failed')) {
    throw new BlocksError('Nothing is scheduled for this draft.', 409, 'nothing_scheduled');
  }
  const relay = await relayCampaignClient();
  const existing = await relay.getCampaign(delivery.campaignKey);
  let relayStatus = existing?.status || 'missing';
  if (existing && existing.status !== 'cancelled') {
    const result = await relay.cancel(delivery.campaignKey);
    relayStatus = result.campaign?.status || relayStatus;
    if (relayStatus !== 'cancelled') {
      throw new RelayError(`Relay did not cancel campaign ${delivery.campaignKey} (status ${relayStatus}); it may already be sending.`, 409, 'relay_cancel_refused');
    }
  }
  const now = new Date().toISOString();
  const next = await writeDelivery(client, set, { ...delivery, state: 'cancelled', relayStatus, updatedAt: now });
  await deleteWebView(client, set.webViewToken).catch(() => undefined);
  await appendBlockRevisions(client, issue.id, [{
    blockId: '',
    blockType: 'draft',
    origin: 'cancel',
    createdAt: now,
    actorUserId: actor.id,
    actorName: actor.name,
    detail: `Relay campaign ${delivery.campaignKey} ${existing ? 'cancelled' : 'not found in Relay'}; the draft is editable again`,
    before: null,
    after: null,
  }]);
  return { set: next, delivery: next.delivery as DraftDelivery };
}

/** Read the campaign's current status from Relay (after scheduling only). */
export async function refreshDelivery(client: DynamoDBDocumentClient, issue: { id: string }): Promise<DraftDelivery | null> {
  const set = await requireBlockSet(client, issue.id);
  const delivery = set.delivery;
  if (!delivery || delivery.state === 'cancelled') return delivery || null;
  const campaign = await (await relayCampaignClient()).getCampaign(delivery.campaignKey);
  const relayStatus = campaign?.status || 'missing';
  if (relayStatus === delivery.relayStatus) return delivery;
  try {
    const next = await writeDelivery(client, set, { ...delivery, relayStatus, updatedAt: new Date().toISOString() });
    return next.delivery || null;
  } catch (error) {
    if (error instanceof BlockSetVersionConflict) return { ...delivery, relayStatus };
    throw error;
  }
}
