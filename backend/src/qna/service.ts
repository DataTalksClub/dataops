import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { updateCardAdditive } from '../db/cards';
import { getTemplate } from '../db/templates';
import type { Card, CardQna, CardQnaQuestion } from '../types';
import { createQnaClient, type QnaClient } from './client';

/** Event formats that get an audience Q&A room (sponsorship is only a flag). */
export const QNA_EVENT_TYPES = ['podcast', 'webinar', 'workshop'] as const;

let client: QnaClient | null = null;
export function setQnaClientForTests(next: QnaClient | null): void {
  client = next;
}
function qna(): QnaClient {
  return client ?? (client = createQnaClient());
}

export function isQnaEventType(type: string | null | undefined): boolean {
  return (QNA_EVENT_TYPES as readonly string[]).includes(String(type || '').toLowerCase());
}

export async function cardHasQnaEventType(db: DynamoDBDocumentClient, card: Card): Promise<boolean> {
  const template = await getTemplate(db, card.templateId);
  return isQnaEventType(template?.type);
}

function slugFor(card: Card): string {
  const base = String(card.title || 'event').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/g, '');
  return `${base || 'event'}-${card.id.replace(/[^a-z0-9]/gi, '').slice(0, 8).toLowerCase()}`;
}

/** Host account granted admin access on every DataOps-created Q&A room. */
export function hostAdminEmail(): string {
  return (process.env.DATAQNA_HOST_ADMIN_EMAIL || 'alexey@datatalks.club').trim().toLowerCase();
}

/** Create the Card's Q&A room once; the room's idempotency key is the Card id, so retries return the same room. */
export async function ensureCardQna(db: DynamoDBDocumentClient, card: Card): Promise<Card> {
  if (card.qna) return card;
  const room = await qna().createRoom({
    title: `${card.title || 'Event'} — live Q&A`,
    slug: slugFor(card),
    description: 'Ask your questions for the live event. Upvote the ones you want answered.',
    idempotencyKey: `dataops-card-${card.id}`,
  });
  const adminEmail = hostAdminEmail();
  if (adminEmail) await qna().addRoomAdmin(room.roomId, adminEmail);
  const created: CardQna = { roomId: room.roomId, slug: room.slug, url: room.url, presentUrl: room.presentUrl, createdAt: new Date().toISOString() };
  return updateCardAdditive(db, card, (current) => ({ qna: current.qna ?? created }));
}

/** Best-effort variant for card creation: a Q&A outage must never block the Card. */
export async function ensureCardQnaQuietly(db: DynamoDBDocumentClient, card: Card): Promise<Card> {
  try {
    return await ensureCardQna(db, card);
  } catch (error) {
    console.warn(`Q&A room for Card ${card.id} was not created: ${(error as Error).message}`);
    return card;
  }
}

/** Auto-create the Q&A room once an event Card has a date (`anchorDate`); never blocks the caller. */
export async function ensureCardQnaForDatedEvent(db: DynamoDBDocumentClient, card: Card): Promise<Card> {
  if (card.qna || !card.anchorDate || card.status === 'archived' || card.stage === 'done') return card;
  if (!(await cardHasQnaEventType(db, card))) return card;
  return ensureCardQnaQuietly(db, card);
}

/** Close the room and keep every audience question on the Card. Idempotent: a saved Card is returned unchanged. */
export async function closeCardQna(db: DynamoDBDocumentClient, card: Card): Promise<Card> {
  const base = card.qna ? card : await ensureCardQna(db, card);
  const current = base.qna!;
  if (current.questionsSavedAt) return base;
  await qna().closeRoom(current.roomId);
  const questions = await qna().listQuestions(current.roomId);
  const now = new Date().toISOString();
  return updateCardAdditive(db, base, (fresh) => ({
    qna: { ...(fresh.qna ?? current), closedAt: now, questionsSavedAt: now, questions },
  }));
}

export interface CardQnaQuestions {
  roomUrl: string;
  presentUrl: string;
  state: 'open' | 'closed';
  /** `live` while the room is open, `saved` once the Card holds the permanent copy. */
  source: 'live' | 'saved';
  savedAt: string | null;
  questions: CardQnaQuestion[];
}

/** The stable read model behind the Card's live-questions preview. */
export async function readCardQnaQuestions(card: Card): Promise<CardQnaQuestions | null> {
  const room = card.qna;
  if (!room) return null;
  if (room.questionsSavedAt) {
    return { roomUrl: room.url, presentUrl: room.presentUrl, state: 'closed', source: 'saved', savedAt: room.questionsSavedAt, questions: room.questions ?? [] };
  }
  const questions = await qna().listQuestions(room.roomId);
  return { roomUrl: room.url, presentUrl: room.presentUrl, state: 'open', source: 'live', savedAt: null, questions };
}

export interface CardQnaAnnouncement {
  qnaUrl: string;
  registrationUrl: string | null;
  text: string;
}

/** Build the event announcement snippet with the Card's Q&A room link filled in automatically. */
export function buildCardAnnouncement(card: Card): CardQnaAnnouncement | null {
  const qnaUrl = card.qna?.url?.trim();
  if (!qnaUrl) return null;
  const regLink = (card.cardLinks || []).find((link) => {
    const name = String(link.name || '').trim().toLowerCase();
    return Boolean(link.url?.trim()) && (name === 'luma' || name === 'event page');
  });
  const registrationUrl = regLink?.url?.trim() || null;
  const datePart = card.anchorDate ? ` on ${String(card.anchorDate).slice(0, 10)}` : '';
  const lines = [`Join us for ${card.title || 'our upcoming event'}${datePart}!`];
  if (registrationUrl) lines.push('', `Register here: ${registrationUrl}`);
  lines.push(registrationUrl ? `Ask questions live: ${qnaUrl}` : `\nAsk questions live: ${qnaUrl}`);
  return { qnaUrl, registrationUrl, text: lines.join('\n') };
}

export interface QnaBackfillResult { created: string[]; skipped: number; failed: Array<{ cardId: string; error: string }> }

/** Give every upcoming dated event Card a Q&A room. */
export async function backfillCardQna(db: DynamoDBDocumentClient, cards: Card[]): Promise<QnaBackfillResult> {
  const result: QnaBackfillResult = { created: [], skipped: 0, failed: [] };
  for (const card of cards) {
    if (
      card.qna
      || !card.anchorDate
      || card.status === 'archived'
      || card.stage === 'done'
      || card.stage === 'after-event'
      || !(await cardHasQnaEventType(db, card))
    ) {
      result.skipped += 1;
      continue;
    }
    try {
      await ensureCardQna(db, card);
      result.created.push(card.id);
    } catch (error) {
      result.failed.push({ cardId: card.id, error: (error as Error).message });
    }
  }
  return result;
}
