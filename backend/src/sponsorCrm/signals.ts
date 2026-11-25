import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { listCrmRecords, type CrmRecord } from '../db/sponsorCrm';
import { StoragePaginationError } from '../db/boundedPagination';
import { cursorBinding } from '../crmWorkspace/cursor';
import { queryTargetNotes } from '../crmWorkspace/notes';
import { addDays, isCalendarDate, todayIn } from '../relativeDates';
import { isSignalSource, leadSignalSource, SIGNAL_SOURCES, type SignalSource } from './signalSource';

/**
 * Read-only weekly selection of outbound sponsor signals: where a potential
 * sponsor was seen promoting itself (newsletter issues, paid placements,
 * social, influencers). It creates no prospect, deal or message.
 *
 * Candidates are (1) sourced leads and (2) organization notes explicitly
 * marked as outbound sightings. Ordinary notes are never candidates.
 */
export const SIGNALS_TIMEZONE = 'Europe/Berlin';
export const MAX_WINDOW_DAYS = 93;
/** Organizations whose notes are read per request; beyond it coverage says so. */
export const MAX_NOTE_ORGANIZATIONS = 2000;
const NOTE_CONCURRENCY = 8;

/** `Outbound signal (source=paid): <summary>. Evidence: <text or url>` */
const NOTE_PREFIX = /^\s*Outbound signal \(source=([a-z]+)\):\s*([\s\S]*)$/;
/** Idempotency keys of marked notes: `outbound-signal:<source>:<native key>`. */
const NOTE_KEY_PREFIX = /^outbound-signal:([a-z]+):/;
const EVIDENCE = /\bEvidence:\s*([\s\S]*)$/;
const URL_IN_TEXT = /https:\/\/[^\s<>"')\]]+/;

export interface SignalQuery { from: string; before: string; source: SignalSource | null; limit: number; cursor: string | null }

export const berlinDayOf = (iso: string): string => todayIn(SIGNALS_TIMEZONE, new Date(iso));

export function parseSignalQuery(query: Record<string, string | undefined>): SignalQuery | string {
  const { from, before } = query;
  if (!isCalendarDate(from) || !isCalendarDate(before)) return 'from and before are required as YYYY-MM-DD (Europe/Berlin dates)';
  if (before <= from) return 'before must be after from (from inclusive, before exclusive)';
  let days = 0;
  for (let day = from; day < before && days <= MAX_WINDOW_DAYS; day = addDays(day, 1)) days += 1;
  if (days > MAX_WINDOW_DAYS) return `The window is at most ${MAX_WINDOW_DAYS} days; page by running consecutive windows`;
  const source = query.source || null;
  if (source !== null && !isSignalSource(source)) return `Unsupported source "${source}". One of: ${SIGNAL_SOURCES.join(', ')}`;
  const limit = query.limit === undefined ? 50 : Number(query.limit);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) return 'limit must be 1..100';
  return { from, before, source: source as SignalSource | null, limit, cursor: query.cursor || null };
}

interface Evidence { kind: 'lead' | 'note'; id: string; text: string; url: string | null }
interface Signal {
  id: string;
  nativeType: 'lead' | 'note';
  nativeId: string;
  source: SignalSource | null;
  observedAt: string;
  observedAtBasis: string;
  observedDay: string;
  company: { displayName: string | null; organizationId: string | null; linked: boolean; linkedBy: 'lead' | 'note' | null };
  placement: { newsletter: string | null; subject: string | null; messageId: string | null; url: string | null; summary: string | null };
  evidence: Evidence[];
  leadStatus: string | null;
  missing: string[];
  mergeKey: string;
}

const str = (value: unknown): string => (typeof value === 'string' ? value : '');

export function normalizeEvidenceUrl(url: string): string {
  try {
    const parsed = new URL(url.trim());
    const path = parsed.pathname === '/' ? '' : parsed.pathname.replace(/\/+$/, '');
    return `${parsed.hostname.toLowerCase().replace(/^www\./, '')}${path}${parsed.search}`;
  } catch {
    return '';
  }
}

function leadSignal(lead: CrmRecord): Signal {
  const sponsor = (lead.sponsor || {}) as Record<string, unknown>;
  const newsletter = (lead.newsletter || {}) as Record<string, unknown>;
  const observedAtRaw = str(lead.observedAt);
  const receivedAt = str(newsletter.receivedAt);
  const observedAt = observedAtRaw || receivedAt || str(lead.createdAt);
  const basis = observedAtRaw ? 'lead.observedAt' : receivedAt ? 'newsletter.receivedAt' : 'lead.createdAt';
  const url = str(sponsor.url) || null;
  const source = leadSignalSource(lead);
  const organizationId = str(lead.organizationId) || null;
  const missing = [
    ...(source ? [] : ['source']),
    ...(url ? [] : ['placement.url']),
    ...(str(sponsor.name) ? [] : ['company.displayName']),
  ];
  const text = str(sponsor.blurb) || str(sponsor.context);
  return {
    id: `lead:${lead.id}`, nativeType: 'lead', nativeId: lead.id, source,
    observedAt, observedAtBasis: basis, observedDay: observedAt ? berlinDayOf(observedAt) : '',
    company: { displayName: str(sponsor.name) || null, organizationId, linked: !!organizationId, linkedBy: organizationId ? 'lead' : null },
    placement: { newsletter: str(newsletter.name) || null, subject: str(newsletter.subject) || null, messageId: str(lead.messageId) || null, url, summary: text || null },
    evidence: [{ kind: 'lead', id: lead.id, text, url }],
    leadStatus: str(lead.status) || null,
    missing,
    mergeKey: url && source ? `${source}|${berlinDayOf(observedAt)}|${normalizeEvidenceUrl(url)}` : '',
  };
}

/** The signal a note carries, or null when it is not explicitly marked. */
export function noteSignal(note: Record<string, unknown>, organization: CrmRecord): Signal | null {
  const body = str(note.body);
  const bodyMatch = NOTE_PREFIX.exec(body);
  const keyMatch = NOTE_KEY_PREFIX.exec(str(note.sourceKey));
  const claimed = bodyMatch?.[1] ?? keyMatch?.[1];
  if (!claimed) return null;
  const source = isSignalSource(claimed) ? claimed : null;
  const rest = bodyMatch ? bodyMatch[2] : body;
  const evidenceText = EVIDENCE.exec(rest)?.[1]?.trim() || '';
  const url = URL_IN_TEXT.exec(evidenceText)?.[0].replace(/[.,;]+$/, '') || null;
  const observedAt = str(note.createdAt);
  const missing = [
    ...(source ? [] : [`source (unsupported "${claimed}")`]),
    ...(evidenceText ? [] : ['evidence']),
    ...(url ? [] : ['placement.url']),
  ];
  return {
    id: `note:${str(note.id)}`, nativeType: 'note', nativeId: str(note.id), source,
    observedAt, observedAtBasis: 'note.createdAt', observedDay: berlinDayOf(observedAt),
    company: { displayName: str(organization.displayName) || str(organization.name) || null, organizationId: organization.id, linked: true, linkedBy: 'note' },
    placement: { newsletter: null, subject: null, messageId: null, url, summary: (bodyMatch ? rest.replace(EVIDENCE, '').trim() : body) || null },
    evidence: [{ kind: 'note', id: str(note.id), text: evidenceText, url }],
    leadStatus: null,
    missing,
    mergeKey: url && source ? `${source}|${berlinDayOf(observedAt)}|${normalizeEvidenceUrl(url)}` : '',
  };
}

/**
 * Identical sightings recorded both as a lead and as an explicit note count
 * once: same source, same Berlin day, same normalized landing URL and no
 * conflicting organization. The lead stays primary and the note is kept as
 * corroborating evidence. Distinct placements (another URL or day, or two
 * leads from different issues) are never merged.
 */
export function mergeSignals(signals: Signal[]): { signals: Signal[]; merged: number } {
  const leads = signals.filter((signal) => signal.nativeType === 'lead');
  const byKey = new Map<string, Signal[]>();
  for (const signal of leads) if (signal.mergeKey) byKey.set(signal.mergeKey, [...(byKey.get(signal.mergeKey) || []), signal]);
  const out = [...leads];
  const noteHeads = new Map<string, Signal>();
  let merged = 0;
  for (const note of signals.filter((signal) => signal.nativeType === 'note')) {
    const compatible = (note.mergeKey ? byKey.get(note.mergeKey) || [] : []).filter((lead) =>
      !lead.company.organizationId || lead.company.organizationId === note.company.organizationId);
    const target = compatible.length === 1 ? compatible[0] : undefined;
    if (target) {
      target.evidence.push(...note.evidence);
      if (!target.company.organizationId) target.company = { ...target.company, organizationId: note.company.organizationId, linked: true, linkedBy: 'note' };
      merged += 1;
      continue;
    }
    // The same note evidence recorded twice on one organization is one sighting.
    const noteKey = note.mergeKey ? `${note.mergeKey}|${note.company.organizationId}` : '';
    const head = noteKey ? noteHeads.get(noteKey) : undefined;
    if (head) { head.evidence.push(...note.evidence); merged += 1; continue; }
    if (noteKey) noteHeads.set(noteKey, note);
    out.push(note);
  }
  return { signals: out, merged };
}

const order = (a: Signal, b: Signal) => a.observedAt.localeCompare(b.observedAt) || a.id.localeCompare(b.id);

function decodeKeyset(binding: string, raw: string): { at: string; id: string } | null {
  try {
    const parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
    if (parsed && parsed.h === binding && typeof parsed.at === 'string' && typeof parsed.id === 'string') return { at: parsed.at, id: parsed.id };
  } catch { /* invalid */ }
  return null;
}

async function mapLimit<T, R>(items: T[], limit: number, work: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) { const index = next++; results[index] = await work(items[index]); }
  }));
  return results;
}

export async function selectSignals(client: DynamoDBDocumentClient, query: SignalQuery): Promise<{ status: number; body: unknown }> {
  const binding = cursorBinding(['sponsor-signals', query.from, query.before, query.source]);
  let after: { at: string; id: string } | null = null;
  if (query.cursor) {
    after = decodeKeyset(binding, query.cursor);
    if (!after) return { status: 400, body: { error: 'Invalid cursor or cursor does not match these filters' } };
  }
  let leads: CrmRecord[];
  let organizations: CrmRecord[];
  try {
    [leads, organizations] = await Promise.all([listCrmRecords(client, 'lead'), listCrmRecords(client, 'organization')]);
  } catch (error) {
    if (error instanceof StoragePaginationError) return { status: 503, body: { error: `Signal sources exceed read bounds (${error.reason}); narrow the selection or ask for an indexed read` } };
    throw error;
  }
  const noteOrganizations = organizations.slice(0, MAX_NOTE_ORGANIZATIONS);
  const noteLists = await mapLimit(noteOrganizations, NOTE_CONCURRENCY, async (organization) => ({
    organization, notes: (await queryTargetNotes(client, 'organization', organization.id)).items,
  }));
  const notesScanned = noteLists.reduce((sum, entry) => sum + entry.notes.length, 0);
  const candidates: Signal[] = [
    ...leads.map(leadSignal),
    ...noteLists.flatMap(({ organization, notes }) => notes.map((note) => noteSignal(note, organization)).filter((signal): signal is Signal => !!signal)),
  ];
  const marked = candidates.filter((signal) => signal.nativeType === 'note').length;
  const { signals: unique, merged } = mergeSignals(candidates.filter((signal) => signal.observedDay >= query.from && signal.observedDay < query.before));
  const selected = unique.filter((signal) => !query.source || signal.source === query.source).sort(order);
  const rest = after ? selected.filter((signal) => signal.observedAt > after!.at || (signal.observedAt === after!.at && signal.id > after!.id)) : selected;
  const items = rest.slice(0, query.limit);
  const last = items[items.length - 1];
  const nextCursor = rest.length > query.limit && last
    ? Buffer.from(JSON.stringify({ h: binding, at: last.observedAt, id: last.id }), 'utf8').toString('base64url') : null;
  const notesComplete = organizations.length <= MAX_NOTE_ORGANIZATIONS;
  const bySource = Object.fromEntries([...SIGNAL_SOURCES, 'unknown'].map((name) => [name, selected.filter((signal) => (signal.source || 'unknown') === name).length]));
  return {
    status: 200,
    body: {
      items: items.map(({ mergeKey: _mergeKey, ...signal }) => signal),
      nextCursor,
      complete: !nextCursor && notesComplete,
      coverage: {
        window: { from: query.from, before: query.before, timezone: SIGNALS_TIMEZONE, semantics: 'from inclusive, before exclusive, by the Europe/Berlin calendar day of each signal observation time' },
        source: query.source, supportedSources: SIGNAL_SOURCES,
        sources: {
          leads: { read: leads.length, complete: true, note: 'all leads, linked or not; source defaults to newsletter only for newsletter-intake leads' },
          notes: { organizationsTotal: organizations.length, organizationsRead: noteOrganizations.length, notesScanned, markedSignalNotes: marked, complete: notesComplete, marker: 'Outbound signal (source=<source>): … Evidence: … or note sourceKey outbound-signal:<source>:<key>; only organization notes' },
        },
        matched: selected.length, returned: items.length, mergedDuplicates: merged, bySource,
        withMissingMetadata: selected.filter((signal) => signal.missing.length).length,
        observedAt: 'lead.observedAt, else newsletter.receivedAt, else lead.createdAt; notes use note.createdAt (the note does not store the sighting time)',
      },
    },
  };
}
