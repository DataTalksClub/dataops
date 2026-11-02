/** Contract signing-link email delivery, reusing the sponsor content form
 * path: the Dapier-held Google OAuth token for orin@datatalks.club sends a
 * raw RFC 2822 message through the Gmail API. Like the form path, failures
 * degrade to a deferred state with a reason instead of failing the request. */
import { DAPIER_AGENT, DAPIER_BASE_URL, dapierTokenProblem, readDapierCredential } from '../calendar/dapierBroker';
import { buildRawMimeEmail, SPONSOR_DOC_EMAIL_FROM } from '../sponsorDocs/emailDelivery';

export interface ContractEmailDelivery {
  state: 'sent' | 'deferred' | 'skipped';
  from: string;
  to?: string;
  subject: string;
  messageId?: string;
  sentAt?: string;
  reason?: string;
  message?: string;
}

export interface ContractEmailDeps {
  fetchImpl?: typeof fetch;
  brokerUrl?: string;
  credential?: string;
  agent?: string;
}

let emailDeps: ContractEmailDeps = {};

export function setContractEmailDepsForTests(deps: ContractEmailDeps): void {
  emailDeps = deps;
}

export async function deliverContractEmail(options: { to?: string | null; subject: string; body: string }): Promise<ContractEmailDelivery> {
  const from = SPONSOR_DOC_EMAIL_FROM;
  const to = String(options.to || '').trim().toLowerCase() || undefined;
  if (!to) {
    return { state: 'skipped', from, subject: options.subject, reason: 'missing_recipient_email', message: 'No sponsor signer email is known; share the signing link manually.' };
  }
  const brokerUrl = (emailDeps.brokerUrl || process.env.DAPIER_BASE_URL || DAPIER_BASE_URL).replace(/\/$/, '');
  const agent = emailDeps.agent || DAPIER_AGENT;
  const runFetch = emailDeps.fetchImpl || fetch;
  let credential = emailDeps.credential || process.env.DAPIER_API_TOKEN || '';
  if (!credential) credential = (await readDapierCredential()).credential || '';
  if (!credential) {
    return { state: 'deferred', from, to, subject: options.subject, reason: 'missing_dapier_credential', message: 'No Dapier broker credential in this environment; the signing link email was not sent.' };
  }
  let tokenRes: Response;
  try {
    tokenRes = await runFetch(brokerUrl + '/api/agent/token', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + credential, 'Content-Type': 'application/json' },
      body: JSON.stringify({ connection_id: process.env.DATAOPS_ORIN_GMAIL_CONNECTION_ID || 'google-calendar-orin', agent }),
      signal: AbortSignal.timeout(10000),
    });
  } catch {
    return { state: 'deferred', from, to, subject: options.subject, reason: 'dapier_unreachable', message: 'The Dapier token broker could not be reached.' };
  }
  if (!tokenRes.ok) {
    return { state: 'deferred', from, to, subject: options.subject, reason: 'dapier_token_http_' + tokenRes.status, message: dapierTokenProblem(tokenRes.status, 'google-calendar-orin', agent) };
  }
  let tokenData: { access_token?: string } = {};
  try {
    tokenData = (await tokenRes.json()) as { access_token?: string };
  } catch {
    return { state: 'deferred', from, to, subject: options.subject, reason: 'invalid_broker_json', message: 'The Dapier token broker returned invalid JSON.' };
  }
  if (!tokenData.access_token) {
    return { state: 'deferred', from, to, subject: options.subject, reason: 'empty_access_token', message: 'The Dapier connection returned no access token.' };
  }
  const raw = buildRawMimeEmail({ from, to, subject: options.subject, body: options.body });
  let sendRes: Response;
  try {
    sendRes = await runFetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + tokenData.access_token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ raw }),
      signal: AbortSignal.timeout(15000),
    });
  } catch {
    return { state: 'deferred', from, to, subject: options.subject, reason: 'gmail_unreachable', message: 'Gmail API could not be reached to send the signing link.' };
  }
  if (!sendRes.ok) {
    const detail = await sendRes.text().catch(() => '');
    return { state: 'deferred', from, to, subject: options.subject, reason: 'gmail_http_' + sendRes.status, message: 'Gmail API returned HTTP ' + sendRes.status + ': ' + detail.slice(0, 180) };
  }
  let sentPayload: { id?: string } = {};
  try {
    sentPayload = (await sendRes.json()) as { id?: string };
  } catch {
    // Keep sent state even if the response body is minimal.
  }
  return { state: 'sent', from, to, subject: options.subject, ...(sentPayload.id ? { messageId: sentPayload.id } : {}), sentAt: new Date().toISOString() };
}
