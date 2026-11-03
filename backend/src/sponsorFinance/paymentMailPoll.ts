/**
 * Reads recent payment notification mails from Orin's mailbox through the
 * existing Dapier Google connection (same broker, agent and secret as the
 * sponsor-doc email send). No new credentials: when the connection lacks Gmail
 * read access the poll reports `deferred` and the push path still works.
 */
import { DAPIER_AGENT, DAPIER_BASE_URL, dapierTokenProblem, readDapierCredential } from '../calendar/dapierBroker';
import { DEFAULT_ORIN_GMAIL_CONNECTION_ID } from '../sponsorDocs/emailDelivery';
import type { PaymentMail } from './paymentMail';

const GMAIL = 'https://gmail.googleapis.com/gmail/v1/users/me';
const PAGE_SIZE = 100;
const MAX_MESSAGES = 300;
const DETAIL_CONCURRENCY = 8;
export const PAYMENT_MAIL_QUERY = '(from:ramp.com OR from:stripe.com OR from:bill.com) subject:(payment received OR "payment") newer_than:';

export type PollDeps = { fetchImpl?: typeof fetch; credential?: string };
let deps: PollDeps = {};
export function setPaymentMailPollDepsForTests(next: PollDeps) { deps = next; }

export type PollResult = { state: 'ok'; mails: PaymentMail[] } | { state: 'deferred'; reason: string; message: string };

function header(headers: Array<{ name?: string; value?: string }> | undefined, name: string) {
  return headers?.find((h) => (h.name || '').toLowerCase() === name.toLowerCase())?.value || '';
}

function textOf(part: any): string {
  if (!part) return '';
  const own = part.body?.data && /^text\/(plain|html)/.test(part.mimeType || '')
    ? Buffer.from(String(part.body.data), 'base64url').toString('utf8') : '';
  return [own, ...(part.parts || []).map(textOf)].filter(Boolean).join('\n');
}

export async function pollPaymentMail(days = 14): Promise<PollResult> {
  const run = deps.fetchImpl || fetch;
  let credential = deps.credential || process.env.DAPIER_API_TOKEN;
  if (!credential) {
    const resolved = await readDapierCredential(undefined);
    if (!resolved.credential) return { state: 'deferred', reason: 'missing_dapier_credential', message: resolved.problem || 'No Dapier broker credential' };
    credential = resolved.credential;
  }
  const connectionId = (process.env.DATAOPS_ORIN_GMAIL_CONNECTION_ID || '').trim() || DEFAULT_ORIN_GMAIL_CONNECTION_ID;
  const brokerUrl = (process.env.DAPIER_BASE_URL || DAPIER_BASE_URL).replace(/\/$/, '');
  try {
    const tokenRes = await run(`${brokerUrl}/api/agent/token`, {
      method: 'POST', headers: { Authorization: `Bearer ${credential}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ connection_id: connectionId, agent: DAPIER_AGENT }), signal: AbortSignal.timeout(10000),
    });
    if (!tokenRes.ok) return { state: 'deferred', reason: `dapier_token_http_${tokenRes.status}`, message: dapierTokenProblem(tokenRes.status, connectionId) };
    const token = ((await tokenRes.json()) as { access_token?: string }).access_token;
    if (!token) return { state: 'deferred', reason: 'empty_access_token', message: `Dapier connection "${connectionId}" returned no access token.` };
    const auth = { Authorization: `Bearer ${token}` };
    const ids: string[] = [];
    let pageToken = '';
    let pages = 0;
    do {
      const query = new URLSearchParams({
        maxResults: String(Math.min(PAGE_SIZE, MAX_MESSAGES - ids.length)),
        q: `${PAYMENT_MAIL_QUERY}${Math.min(Math.max(days, 1), 60)}d`,
        ...(pageToken ? { pageToken } : {}),
      });
      const list = await run(`${GMAIL}/messages?${query}`, { headers: auth, signal: AbortSignal.timeout(15000) });
      if (!list.ok) return { state: 'deferred', reason: `gmail_list_http_${list.status}`, message: list.status === 403 ? 'The existing Dapier Google connection has no Gmail read scope; use the mailbox ingest route or grant read access to that connection.' : `Gmail list failed (HTTP ${list.status})` };
      const result = (await list.json()) as { messages?: Array<{ id?: string }>; nextPageToken?: string };
      ids.push(...(result.messages || []).map((message) => message.id).filter((id): id is string => !!id));
      pageToken = result.nextPageToken || '';
      pages++;
    } while (pageToken && ids.length < MAX_MESSAGES && pages < MAX_MESSAGES / PAGE_SIZE);
    const mails: PaymentMail[] = [];
    for (let start = 0; start < ids.length; start += DETAIL_CONCURRENCY) {
      const messages = await Promise.all(ids.slice(start, start + DETAIL_CONCURRENCY).map(async (id) => {
        const res = await run(`${GMAIL}/messages/${encodeURIComponent(id)}?format=full`, { headers: auth, signal: AbortSignal.timeout(15000) });
        if (!res.ok) return null;
        const msg = (await res.json()) as any;
        const h = msg.payload?.headers;
        return {
          messageId: header(h, 'Message-ID') || `gmail:${id}`, from: header(h, 'From'), subject: header(h, 'Subject') || '(no subject)',
          body: textOf(msg.payload), receivedAt: new Date(Number(msg.internalDate) || Date.now()).toISOString(),
        } satisfies PaymentMail;
      }));
      mails.push(...messages.filter((mail): mail is PaymentMail => !!mail));
    }
    return { state: 'ok', mails: mails.filter((m) => m.from) };
  } catch {
    return { state: 'deferred', reason: 'dapier_unreachable', message: 'The Dapier token broker or Gmail could not be reached.' };
  }
}
