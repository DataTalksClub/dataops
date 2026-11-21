/**
 * Client for the DataQnA audience Q&A service (https://qna.dtcdev.click,
 * DataTalksClub/dataqna). Authenticates with the API key kept in the team
 * secret store as `<stack>.dataqna-api-key`; the key is never logged.
 */
import { readRuntimeSecret } from '../secrets/reader';

export const QNA_BASE_URL = 'https://qna.dtcdev.click';

export interface QnaRoom {
  roomId: string;
  slug: string;
  url: string;
  presentUrl: string;
  state: string;
}

export interface QnaQuestion {
  questionId: string;
  text: string;
  authorName: string | null;
  status: string;
  score: number;
  pinned: boolean;
  createdAt: string;
  answeredAt: string | null;
}

export interface QnaClient {
  createRoom(input: { title: string; slug: string; description: string; idempotencyKey: string }): Promise<QnaRoom>;
  addRoomAdmin(roomId: string, email: string): Promise<void>;
  closeRoom(roomId: string): Promise<QnaRoom>;
  listQuestions(roomId: string): Promise<QnaQuestion[]>;
}

export class QnaServiceError extends Error {}

function secretName(): string {
  return process.env.DATAQNA_API_KEY_SECRET_NAME || 'dataops-v1.dataqna-api-key';
}

function toRoom(raw: Record<string, unknown>): QnaRoom {
  return {
    roomId: String(raw.room_id),
    slug: String(raw.slug),
    url: String(raw.url),
    presentUrl: String(raw.present_url || ''),
    state: String(raw.state),
  };
}

function toQuestion(raw: Record<string, unknown>): QnaQuestion {
  return {
    questionId: String(raw.question_id),
    text: String(raw.text),
    authorName: raw.anonymous || !raw.author_name ? null : String(raw.author_name),
    status: String(raw.status),
    score: Number(raw.score) || 0,
    pinned: raw.pinned === true,
    createdAt: String(raw.created_at),
    answeredAt: raw.answered_at ? String(raw.answered_at) : null,
  };
}

export function createQnaClient(
  fetchImpl: typeof fetch = fetch,
  readKey: () => Promise<string> = () => readRuntimeSecret(secretName()),
): QnaClient {
  async function call(method: string, path: string, body?: unknown): Promise<Record<string, unknown>> {
    const key = (await readKey()).trim();
    const response = await fetchImpl(`${QNA_BASE_URL}/api/v1${path}`, {
      method,
      headers: { authorization: `Bearer ${key}`, ...(body ? { 'content-type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const text = await response.text();
    let parsed: Record<string, unknown> = {};
    try { parsed = text ? JSON.parse(text) : {}; } catch { /* non-JSON error body */ }
    if (!response.ok) {
      const detail = (parsed.error as { message?: string } | undefined)?.message || text.slice(0, 200);
      throw new QnaServiceError(`Q&A service ${method} ${path} failed (${response.status}): ${detail}`);
    }
    return parsed;
  }
  return {
    async createRoom(input) {
      return toRoom(await call('POST', '/rooms', {
        title: input.title,
        slug: input.slug,
        description: input.description,
        state: 'open',
        idempotency_key: input.idempotencyKey,
      }));
    },
    async addRoomAdmin(roomId, email) {
      await call('POST', `/rooms/${encodeURIComponent(roomId)}/admins`, { email });
    },
    async closeRoom(roomId) {
      return toRoom(await call('PATCH', `/rooms/${encodeURIComponent(roomId)}`, { state: 'closed' }));
    },
    async listQuestions(roomId) {
      const items: QnaQuestion[] = [];
      let cursor: string | null = null;
      do {
        const qs: string = `status=visible&status=answered&limit=500${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
        const page = await call('GET', `/rooms/${encodeURIComponent(roomId)}/questions?${qs}`);
        for (const item of (page.items as Record<string, unknown>[]) || []) items.push(toQuestion(item));
        cursor = typeof page.next_cursor === 'string' && page.next_cursor ? page.next_cursor : null;
      } while (cursor);
      return items;
    },
  };
}
