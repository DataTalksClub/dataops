import { GetCommand, ScanCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { getCardConsistent } from '../db/cards';
import { getPodcastEpisode } from '../db/podcastEpisodes';
import { TABLE_CALENDAR } from '../db/tableNames';
import { parseCardTitle } from '../cards/cardTitleStructure';
import { getSponsorDocTemplate, type SponsorDocTemplateKey } from './templates';

export interface DocumentEventMetadata {
  title: string;
  date: string | null;
  time: string | null;
  timeZone: string;
  state: 'tentative' | 'confirmed' | 'released' | 'unscheduled';
  label: string;
  holdId?: string;
  version: number;
}

interface StoredEventAuthority {
  id: string;
  cardId?: string;
  title?: string;
  renderValues?: { title?: string; guestNames?: string };
  status: 'tentative' | 'confirmed' | 'released' | 'expired' | 'proposed' | 'approved';
  startIso?: string;
  timeZone?: string;
  documentUrl?: string;
  version?: number;
  updatedAt?: string;
  expiresAt?: string;
}

function isActiveAuthority(status: StoredEventAuthority['status']): boolean {
  return status === 'tentative' || status === 'confirmed' || status === 'proposed' || status === 'approved';
}

function authorityState(status: StoredEventAuthority['status'] | undefined): 'tentative' | 'confirmed' | 'released' {
  if (status === 'tentative' || status === 'proposed') return 'tentative';
  if (status === 'confirmed' || status === 'approved') return 'confirmed';
  return 'released';
}

export function isEventDocumentTemplate(template: SponsorDocTemplateKey): boolean {
  return getSponsorDocTemplate(template).metadataSource === 'card-event';
}

/** Read-only: resolve current authority, including released holds and episode-linked docs. No document writes. */
export async function readDocumentEventMetadata(
  client: DynamoDBDocumentClient,
  cardOrOwnerId: string,
  required: boolean,
  docId?: string,
): Promise<DocumentEventMetadata | null> {
  let card = await getCardConsistent(client, cardOrOwnerId);
  const episode = !card ? await getPodcastEpisode(client, cardOrOwnerId) : null;
  if (!card && episode?.cardId) {
    card = await getCardConsistent(client, episode.cardId);
  }
  const ownerIds = new Set([cardOrOwnerId, ...(card ? [card.id] : []), ...(episode ? [episode.id] : [])]);
  let holds: StoredEventAuthority[] = [];
  if (card?.eventTime?.eventKey.startsWith('hold_')) {
    const id = card.eventTime.eventKey;
    const key = `CALHOLD#${id}`;
    const result = await client.send(new GetCommand({ TableName: TABLE_CALENDAR, Key: { PK: key, SK: key }, ConsistentRead: true }));
    if (!result.Item || (result.Item.cardId && !ownerIds.has(String(result.Item.cardId)))) {
      throw new Error('Card event authority is missing or belongs to another Card');
    }
    holds = [result.Item as unknown as StoredEventAuthority];
  } else if (!card?.eventTime) {
    let cursor: Record<string, unknown> | undefined;
    do {
      const page = await client.send(new ScanCommand({
        TableName: TABLE_CALENDAR,
        ConsistentRead: true,
        FilterExpression: 'begins_with(PK, :prefix)',
        ExpressionAttributeValues: { ':prefix': 'CALHOLD#' },
        ...(cursor ? { ExclusiveStartKey: cursor } : {}),
      }));
      for (const raw of page.Items || []) {
        const item = raw as unknown as StoredEventAuthority;
        const matchesOwner = Boolean(item.cardId && ownerIds.has(item.cardId));
        const matchesDocUrl = Boolean(docId && typeof item.documentUrl === 'string' && item.documentUrl.includes(docId));
        if (matchesOwner || matchesDocUrl) holds.push(item);
      }
      cursor = page.LastEvaluatedKey;
    } while (cursor);
  }
  if (!card && !episode && !holds.length) {
    if (required) throw new Error('Event document must link its owning Card; reconcile the document relationship');
    return null;
  }
  const active = holds.filter((h) => isActiveAuthority(h.status));
  if (active.length > 1) throw new Error('Multiple event authorities link this Card; reconcile before rendering event metadata');
  const hold = active[0] || holds.sort((a, b) =>
    String(b.updatedAt || b.expiresAt || '').localeCompare(String(a.updatedAt || a.expiresAt || ''))
    || Number(b.version || 0) - Number(a.version || 0),
  )[0];
  if (!required && !hold && !card?.eventTime && !card?.templateDefinitionSnapshot.eventPolicy) return null;
  const rawTitle = card?.title || hold?.title || hold?.renderValues?.title || episode?.title || '';
  const parsed = parseCardTitle(rawTitle);
  const episodeGuests = episode?.guests?.map((g) => g.name).filter(Boolean) || [];
  const title = parsed.cleanTitle
    || card?.people?.join(', ')
    || episodeGuests.join(', ')
    || hold?.renderValues?.guestNames
    || parsed.people.join(', ')
    || 'Event';
  const state = hold
    ? authorityState(hold.status)
    : card?.eventTime
      ? authorityState(card.eventTime.status || 'confirmed')
      : (card?.anchorDate || episode?.recordingDate)
        ? 'tentative'
        : 'unscheduled';
  const startIso = hold?.startIso || card?.eventTime?.startIso || (episode as { recordingStartIso?: string | null } | null)?.recordingStartIso || undefined;
  const timeZone = hold?.timeZone || card?.eventTime?.timeZone || card?.templateDefinitionSnapshot.eventPolicy?.timeZone || 'Europe/Berlin';
  let date = card?.anchorDate?.slice(0, 10) || episode?.recordingDate?.slice(0, 10) || null;
  let time: string | null = null;
  let label = 'Unscheduled';
  if (startIso) {
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
      timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    }).formatToParts(new Date(startIso)).map((p) => [p.type, p.value]));
    date = `${parts.year}-${parts.month}-${parts.day}`;
    time = `${parts.hour}:${parts.minute}`;
    label = new Intl.DateTimeFormat('en-GB', { timeZone, weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' }).format(new Date(startIso));
    label += ` ${time} ${timeZone} (${state})`;
  } else if (date) {
    label = `${date} (${state}; time not set)`;
  }
  return {
    title,
    date,
    time,
    timeZone,
    state,
    label,
    ...(hold ? { holdId: hold.id } : {}),
    version: hold?.version || card?.version || episode?.version || 1,
  };
}

/** Fields returned by views are derived and never written into the document row. */
export function stripDerivedDocumentFields<
  T extends {
    template: SponsorDocTemplateKey;
    content?: Record<string, string>;
    eventMetadata?: DocumentEventMetadata;
    title?: string;
    publicationDate?: string | null;
  },
>(doc: T): T {
  const next = structuredClone(doc);
  if (!doc.eventMetadata && !isEventDocumentTemplate(doc.template)) return next;
  delete next.title;
  delete next.publicationDate;
  delete next.eventMetadata;
  if (next.content) {
    for (const field of getSponsorDocTemplate(doc.template).sections.flatMap((s) => s.fields)) {
      if (field.derived) delete next.content[field.key];
    }
  }
  return next;
}

export async function projectDocumentEvent<
  T extends {
    id?: string;
    cardId: string;
    template: SponsorDocTemplateKey;
    title: string;
    publicationDate: string | null;
    content?: Record<string, string>;
    eventMetadata?: DocumentEventMetadata;
  },
>(client: DynamoDBDocumentClient, doc: T): Promise<T> {
  const metadata = await readDocumentEventMetadata(client, doc.cardId, isEventDocumentTemplate(doc.template), doc.id);
  if (!metadata) return doc;
  const content = doc.content ? { ...doc.content } : undefined;
  if (content) {
    for (const field of getSponsorDocTemplate(doc.template).sections.flatMap((s) => s.fields)) {
      if (field.derived === 'event-title') content[field.key] = metadata.title;
      if (field.derived === 'event-datetime') content[field.key] = metadata.label;
    }
  }
  return {
    ...doc,
    title: `${metadata.title} · ${metadata.label}`,
    publicationDate: null,
    eventMetadata: metadata,
    ...(content ? { content } : {}),
  };
}
