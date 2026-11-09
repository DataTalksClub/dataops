/**
 * Read the route (To, Cc, sender, thread) of a message Orin already sent, so a
 * booking whose `email-sponsor` was sent before routes were recorded can adopt
 * it. Uses the same Dapier-held Orin Gmail connection as the sends.
 */
import type { SponsorEmailRoute } from '../db/newsletterIssues';
import { CREDENTIAL_OPERATOR_HINT, DAPIER_AGENT, DAPIER_BASE_URL, readDapierCredential } from '../calendar/dapierBroker';
import { DEFAULT_ORIN_GMAIL_CONNECTION_ID, SPONSOR_DOC_EMAIL_FROM } from './emailDelivery';

const GMAIL_API_BASE = 'https://gmail.googleapis.com/gmail/v1/users/me';
const ADDRESS = /[^\s<>,;"']+@[^\s<>,;"']+\.[^\s<>,;"']+/g;

export class GmailMessageRouteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GmailMessageRouteError';
  }
}

const addresses = (value: string): string[] => (value.match(ADDRESS) || []).map((item) => item.toLowerCase());

export async function resolveGmailMessageRoute(
  messageId: string,
  deps: { fetchImpl?: typeof fetch; credential?: string } = {},
): Promise<SponsorEmailRoute> {
  const runFetch = deps.fetchImpl || fetch;
  let credential = deps.credential || process.env.DAPIER_API_TOKEN;
  if (!credential) {
    const resolved = await readDapierCredential(undefined);
    credential = resolved.credential;
    if (!credential) throw new GmailMessageRouteError(resolved.problem || `No Dapier broker credential. ${CREDENTIAL_OPERATOR_HINT}`);
  }
  const connectionId = (process.env.DATAOPS_ORIN_GMAIL_CONNECTION_ID || DEFAULT_ORIN_GMAIL_CONNECTION_ID).trim();
  const brokerUrl = (process.env.DAPIER_BASE_URL || DAPIER_BASE_URL).replace(/\/$/, '');
  const tokenRes = await runFetch(`${brokerUrl}/api/agent/token`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${credential}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ connection_id: connectionId, agent: DAPIER_AGENT }),
    signal: AbortSignal.timeout(10000),
  }).catch(() => null);
  if (!tokenRes?.ok) throw new GmailMessageRouteError(`The Dapier broker refused the Gmail token for connection "${connectionId}" (HTTP ${tokenRes?.status ?? 'unreachable'}).`);
  const token = (await tokenRes.json().catch(() => ({}))) as { access_token?: string; provider_account_id?: string };
  if (!token.access_token) throw new GmailMessageRouteError(`Dapier connection "${connectionId}" returned no access token.`);
  if (String(token.provider_account_id || '').toLowerCase() !== SPONSOR_DOC_EMAIL_FROM) {
    throw new GmailMessageRouteError(`Dapier connection "${connectionId}" is not verified as ${SPONSOR_DOC_EMAIL_FROM}.`);
  }
  const res = await runFetch(
    `${GMAIL_API_BASE}/messages/${encodeURIComponent(messageId)}?format=metadata&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Cc`,
    { headers: { Authorization: `Bearer ${token.access_token}` }, signal: AbortSignal.timeout(10000) },
  ).catch(() => null);
  if (!res?.ok) throw new GmailMessageRouteError(`Gmail message ${messageId} could not be read from ${SPONSOR_DOC_EMAIL_FROM} (HTTP ${res?.status ?? 'unreachable'}).`);
  const message = (await res.json().catch(() => ({}))) as { threadId?: string; payload?: { headers?: Array<{ name?: string; value?: string }> } };
  const header = (name: string) => message.payload?.headers?.find((item) => item.name?.toLowerCase() === name)?.value || '';
  const [sender] = addresses(header('from'));
  const [to] = addresses(header('to'));
  if (sender !== SPONSOR_DOC_EMAIL_FROM) throw new GmailMessageRouteError(`Gmail message ${messageId} was sent from ${sender || 'an unknown sender'}, not ${SPONSOR_DOC_EMAIL_FROM}.`);
  if (!to || !message.threadId) throw new GmailMessageRouteError(`Gmail message ${messageId} has no recipient or thread id.`);
  return { to, cc: addresses(header('cc')), sender, threadRef: message.threadId };
}
