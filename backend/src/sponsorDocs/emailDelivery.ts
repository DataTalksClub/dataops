/**
 * Automatic delivery of sponsor content form emails from Orin's mailbox
 * (`orin@datatalks.club`) via Dapier-held Google OAuth tokens.
 *
 * Architecture (DataOps <-> Dapier path):
 * 1. After "prepare / create form" (`POST /api/sponsor-docs`) or an explicit
 *    staff trigger (`POST /api/sponsor-docs/:id/send-email`), DataOps resolves
 *    the sponsor recipient email from the request (`recipientEmail` / `to`) or
 *    the booked sponsor's active CRM contact (`TABLE_SPONSOR_CRM`).
 * 2. DataOps reads the machine credential `personal-scheduler.dapier-api-token`
 *    and exchanges it at `POST https://dapier.dtcdev.click/api/agent/token`
 *    for a short-lived Google access token on Orin's Dapier connection
 *    (`google-calendar-orin` or `DATAOPS_ORIN_GMAIL_CONNECTION_ID`).
 * 3. DataOps verifies that the Dapier connection is bound to
 *    `orin@datatalks.club` before sending, then posts a raw RFC 2822 MIME
 *    message to `POST https://gmail.googleapis.com/gmail/v1/users/me/messages/send`.
 * 4. If no recipient email is known (`state: 'skipped'`), or if the Dapier
 *    connection / `gmail.send` OAuth scope is not yet granted (`state: 'deferred'`),
 *    form creation still succeeds and surfaces the exact blocker in
 *    `doc.emailDelivery`.
 */
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

import {
  CREDENTIAL_OPERATOR_HINT,
  DAPIER_AGENT,
  DAPIER_BASE_URL,
  dapierTokenProblem,
  readDapierCredential,
} from '../calendar/dapierBroker';
import { getCalendarOverlaySettings } from '../db/calendar';
import { listCrmRecords } from '../db/sponsorCrm';
import {
  renderSponsorEmailDraft,
  type SponsorDocTemplateKey,
} from './templates';

export const SPONSOR_DOC_EMAIL_FROM = 'orin@datatalks.club';
export const SPONSOR_DOC_EMAIL_CC = 'valeriia@datatalks.club';
export const DEFAULT_ORIN_GMAIL_CONNECTION_ID = 'google-calendar-orin';

const GMAIL_API_BASE = 'https://gmail.googleapis.com/gmail/v1/users/me';
const GOOGLE_USERINFO_URL = 'https://www.googleapis.com/oauth2/v3/userinfo';
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export interface SponsorDocEmailDelivery {
  state: 'sent' | 'deferred' | 'skipped';
  from: string;
  to?: string;
  cc?: string[];
  recipientName?: string;
  subject: string;
  connectionId?: string;
  messageId?: string;
  threadId?: string;
  sentAt?: string;
  reason?: string;
  message?: string;
}

export interface SponsorDocEmailDeps {
  fetchImpl?: typeof fetch;
  brokerUrl?: string;
  credential?: string;
  agent?: string;
  connectionId?: string;
}

let emailDeps: SponsorDocEmailDeps = {};

export function setSponsorDocEmailDepsForTests(deps: SponsorDocEmailDeps): void {
  emailDeps = deps;
}

function isNewsletterSponsorTemplate(template: SponsorDocTemplateKey): boolean {
  return (
    template === 'newsletter-main'
    || template === 'newsletter-secondary'
    || template === 'newsletter-standalone'
  );
}

export function isAutoSendEligibleTemplate(template: SponsorDocTemplateKey): boolean {
  return (
    isNewsletterSponsorTemplate(template)
    || template === 'webinar'
    || template === 'workshop'
    || template === 'podcast'
  );
}

function sanitizeHeaderValue(value: string): string {
  return String(value || '').replace(/[\r\n]+/g, ' ').trim();
}

export function buildRawMimeEmail(input: {
  from: string;
  to: string;
  cc?: string[];
  subject: string;
  body: string;
}): string {
  const headers: string[] = [
    `From: Orin <${sanitizeHeaderValue(input.from)}>`,
    `To: ${sanitizeHeaderValue(input.to)}`,
  ];
  const ccList = (input.cc || [])
    .map((addr) => sanitizeHeaderValue(addr))
    .filter((addr) => EMAIL_PATTERN.test(addr));
  if (ccList.length > 0) {
    headers.push(`Cc: ${ccList.join(', ')}`);
  }
  headers.push(
    `Subject: ${sanitizeHeaderValue(input.subject)}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset="UTF-8"',
    'Content-Transfer-Encoding: 8bit',
  );
  const message = `${headers.join('\r\n')}\r\n\r\n${String(input.body || '').replace(/\r?\n/g, '\r\n')}\r\n`;
  return Buffer.from(message, 'utf-8').toString('base64url');
}

export async function resolveSponsorDocRecipient(
  client: DynamoDBDocumentClient,
  options: {
    explicitEmail?: string | null;
    explicitName?: string | null;
    organizationId?: string | null;
    sponsorName?: string | null;
  },
): Promise<{ to?: string; recipientName?: string }> {
  const rawExplicit = String(options.explicitEmail || '').trim().toLowerCase();
  const explicitName = String(options.explicitName || '').trim() || undefined;
  if (rawExplicit && EMAIL_PATTERN.test(rawExplicit)) {
    return { to: rawExplicit, recipientName: explicitName };
  }

  const orgIdHint = String(options.organizationId || '').trim();
  const sponsorHint = String(options.sponsorName || '').trim().toLowerCase();
  if (!orgIdHint && !sponsorHint) {
    return { recipientName: explicitName };
  }

  try {
    let targetOrgId = orgIdHint;
    if (!targetOrgId && sponsorHint) {
      const orgs = await listCrmRecords(client, 'organization');
      const matchedOrg = orgs.find(
        (org) =>
          !org.archivedAt
          && String(org.displayName || org.name || '').trim().toLowerCase() === sponsorHint,
      );
      if (matchedOrg) targetOrgId = matchedOrg.id;
    }

    if (targetOrgId) {
      const contacts = await listCrmRecords(client, 'contact');
      const eligible = contacts.find(
        (c) =>
          c.organizationId === targetOrgId
          && !c.archivedAt
          && c.active !== false
          && Array.isArray(c.emails)
          && c.emails.some((e) => typeof e === 'string' && EMAIL_PATTERN.test(e.trim())),
      );
      if (eligible && Array.isArray(eligible.emails)) {
        const email = eligible.emails
          .map((e) => String(e || '').trim().toLowerCase())
          .find((e) => EMAIL_PATTERN.test(e));
        const contactName = explicitName || String(eligible.name || '').trim() || undefined;
        if (email) {
          return { to: email, recipientName: contactName };
        }
      }
    }
  } catch {
    // Non-fatal if CRM table is unavailable; fall back to skipped state.
  }

  return { recipientName: explicitName };
}

function summarizeGmailError(status: number, bodyText: string, connectionId: string): string {
  let detail = '';
  try {
    const parsed = JSON.parse(bodyText) as { error?: { message?: unknown; status?: unknown } };
    if (typeof parsed?.error?.message === 'string') {
      detail = parsed.error.message.trim().slice(0, 180);
    }
  } catch {
    // Keep status-only summary when body is not JSON.
  }
  if (status === 403) {
    return (
      `Gmail API returned HTTP 403${detail ? ` (${detail})` : ''}. `
      + `Dapier connection "${connectionId}" (${SPONSOR_DOC_EMAIL_FROM}) needs the `
      + `https://www.googleapis.com/auth/gmail.send scope granted and re-consented in Dapier.`
    );
  }
  return `Gmail API returned HTTP ${status}${detail ? `: ${detail}` : ''}.`;
}

export async function deliverSponsorDocEmail(
  client: DynamoDBDocumentClient,
  options: {
    template: SponsorDocTemplateKey;
    sponsorName?: string | null;
    publicationDate?: string | null;
    shareUrl: string;
    accessCode: string;
    recipientEmail?: string | null;
    recipientName?: string | null;
    organizationId?: string | null;
    cc?: string[] | string | null;
    connectionId?: string | null;
  },
): Promise<SponsorDocEmailDelivery> {
  const resolvedRecipient = await resolveSponsorDocRecipient(client, {
    explicitEmail: options.recipientEmail,
    explicitName: options.recipientName,
    organizationId: options.organizationId,
    sponsorName: options.sponsorName,
  });

  const draft = renderSponsorEmailDraft({
    template: options.template,
    sponsorName: options.sponsorName,
    publicationDate: options.publicationDate,
    shareUrl: options.shareUrl,
    accessCode: options.accessCode,
    recipientName: resolvedRecipient.recipientName,
  });

  if (!resolvedRecipient.to) {
    return {
      state: 'skipped',
      from: SPONSOR_DOC_EMAIL_FROM,
      ...(resolvedRecipient.recipientName ? { recipientName: resolvedRecipient.recipientName } : {}),
      subject: draft.subject,
      reason: 'missing_recipient_email',
      message:
        'No sponsor recipient email on the request or CRM contact. '
        + 'Pass recipientEmail (or add an active contact email on the sponsor organization in CRM) '
        + `to auto-send from ${SPONSOR_DOC_EMAIL_FROM}.`,
    };
  }

  const to = resolvedRecipient.to;
  const cc = Array.isArray(options.cc)
    ? options.cc.map((item) => String(item || '').trim().toLowerCase()).filter((item) => EMAIL_PATTERN.test(item))
    : typeof options.cc === 'string' && options.cc.trim()
      ? options.cc.split(',').map((item) => item.trim().toLowerCase()).filter((item) => EMAIL_PATTERN.test(item))
      : isNewsletterSponsorTemplate(options.template) && to !== SPONSOR_DOC_EMAIL_CC
        ? [SPONSOR_DOC_EMAIL_CC]
        : [];

  let connectionId = (
    options.connectionId
    || emailDeps.connectionId
    || process.env.DATAOPS_ORIN_GMAIL_CONNECTION_ID
    || ''
  ).trim();
  if (!connectionId) {
    try {
      const settings = await getCalendarOverlaySettings(client);
      connectionId = (settings.connectionId || '').trim();
    } catch {
      // Ignore calendar settings lookup failure and fall back to default Orin connection id.
    }
  }
  if (!connectionId) {
    connectionId = DEFAULT_ORIN_GMAIL_CONNECTION_ID;
  }

  const brokerUrl = (emailDeps.brokerUrl || process.env.DAPIER_BASE_URL || DAPIER_BASE_URL).replace(/\/$/, '');
  const agent = emailDeps.agent || DAPIER_AGENT;
  const runFetch = emailDeps.fetchImpl || fetch;

  let credential = emailDeps.credential || process.env.DAPIER_API_TOKEN;
  let credentialProblem: string | undefined;
  if (!credential) {
    const resolved = await readDapierCredential(undefined);
    credential = resolved.credential;
    credentialProblem = resolved.problem;
  }
  if (!credential) {
    const base = credentialProblem || `No Dapier broker credential in this environment. ${CREDENTIAL_OPERATOR_HINT}`;
    return {
      state: 'deferred',
      from: SPONSOR_DOC_EMAIL_FROM,
      to,
      ...(cc.length > 0 ? { cc } : {}),
      ...(resolvedRecipient.recipientName ? { recipientName: resolvedRecipient.recipientName } : {}),
      subject: draft.subject,
      connectionId,
      reason: 'missing_dapier_credential',
      message: `${base} (form created; sponsor email auto-send deferred)`,
    };
  }

  let tokenRes: Response;
  try {
    tokenRes = await runFetch(`${brokerUrl}/api/agent/token`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${credential}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ connection_id: connectionId, agent }),
      signal: AbortSignal.timeout(10000),
    });
  } catch {
    return {
      state: 'deferred',
      from: SPONSOR_DOC_EMAIL_FROM,
      to,
      ...(cc.length > 0 ? { cc } : {}),
      ...(resolvedRecipient.recipientName ? { recipientName: resolvedRecipient.recipientName } : {}),
      subject: draft.subject,
      connectionId,
      reason: 'dapier_unreachable',
      message: 'The Dapier token broker could not be reached.',
    };
  }

  if (!tokenRes.ok) {
    const msg = dapierTokenProblem(tokenRes.status, connectionId, agent);
    return {
      state: 'deferred',
      from: SPONSOR_DOC_EMAIL_FROM,
      to,
      ...(cc.length > 0 ? { cc } : {}),
      ...(resolvedRecipient.recipientName ? { recipientName: resolvedRecipient.recipientName } : {}),
      subject: draft.subject,
      connectionId,
      reason: `dapier_token_http_${tokenRes.status}`,
      message: msg,
    };
  }

  let tokenData: { access_token?: string; provider_account_id?: string; scope?: string };
  try {
    tokenData = (await tokenRes.json()) as { access_token?: string; provider_account_id?: string; scope?: string };
  } catch {
    return {
      state: 'deferred',
      from: SPONSOR_DOC_EMAIL_FROM,
      to,
      ...(cc.length > 0 ? { cc } : {}),
      ...(resolvedRecipient.recipientName ? { recipientName: resolvedRecipient.recipientName } : {}),
      subject: draft.subject,
      connectionId,
      reason: 'invalid_broker_json',
      message: 'The Dapier token broker returned an invalid JSON response.',
    };
  }

  if (!tokenData.access_token) {
    return {
      state: 'deferred',
      from: SPONSOR_DOC_EMAIL_FROM,
      to,
      ...(cc.length > 0 ? { cc } : {}),
      ...(resolvedRecipient.recipientName ? { recipientName: resolvedRecipient.recipientName } : {}),
      subject: draft.subject,
      connectionId,
      reason: 'empty_access_token',
      message: `Dapier connection "${connectionId}" returned no access token.`,
    };
  }

  const authHeaders = {
    Authorization: `Bearer ${tokenData.access_token}`,
    'Content-Type': 'application/json',
  };

  // Verify the Dapier connection's authenticated Google mailbox is orin@datatalks.club.
  let verifiedAccount = String(tokenData.provider_account_id || '').trim().toLowerCase();
  if (!verifiedAccount) {
    try {
      const profileRes = await runFetch(`${GMAIL_API_BASE}/profile`, {
        method: 'GET',
        headers: authHeaders,
        signal: AbortSignal.timeout(10000),
      }).catch(() => null);
      if (profileRes && profileRes.ok) {
        const profile = (await profileRes.json()) as { emailAddress?: string };
        verifiedAccount = String(profile.emailAddress || '').trim().toLowerCase();
      } else {
        const infoRes = await runFetch(GOOGLE_USERINFO_URL, {
          method: 'GET',
          headers: authHeaders,
          signal: AbortSignal.timeout(10000),
        }).catch(() => null);
        if (infoRes && infoRes.ok) {
          const info = (await infoRes.json()) as { email?: string };
          verifiedAccount = String(info.email || '').trim().toLowerCase();
        }
      }
    } catch {
      // Proceed to send call which will surface any transport or permission error.
    }
  }

  if (verifiedAccount && verifiedAccount !== SPONSOR_DOC_EMAIL_FROM) {
    return {
      state: 'deferred',
      from: SPONSOR_DOC_EMAIL_FROM,
      to,
      ...(cc.length > 0 ? { cc } : {}),
      ...(resolvedRecipient.recipientName ? { recipientName: resolvedRecipient.recipientName } : {}),
      subject: draft.subject,
      connectionId,
      reason: 'wrong_sender_identity',
      message: `Sponsor form emails must be sent from ${SPONSOR_DOC_EMAIL_FROM}, but Dapier connection "${connectionId}" is bound to "${verifiedAccount}".`,
    };
  }

  const raw = buildRawMimeEmail({
    from: SPONSOR_DOC_EMAIL_FROM,
    to,
    cc,
    subject: draft.subject,
    body: draft.body,
  });

  let sendRes: Response;
  try {
    sendRes = await runFetch(`${GMAIL_API_BASE}/messages/send`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({ raw }),
      signal: AbortSignal.timeout(15000),
    });
  } catch {
    return {
      state: 'deferred',
      from: SPONSOR_DOC_EMAIL_FROM,
      to,
      ...(cc.length > 0 ? { cc } : {}),
      ...(resolvedRecipient.recipientName ? { recipientName: resolvedRecipient.recipientName } : {}),
      subject: draft.subject,
      connectionId,
      reason: 'gmail_unreachable',
      message: 'Gmail API could not be reached to send the sponsor email.',
    };
  }

  if (!sendRes.ok) {
    const errText = await sendRes.text().catch(() => '');
    const msg = summarizeGmailError(sendRes.status, errText, connectionId);
    return {
      state: 'deferred',
      from: SPONSOR_DOC_EMAIL_FROM,
      to,
      ...(cc.length > 0 ? { cc } : {}),
      ...(resolvedRecipient.recipientName ? { recipientName: resolvedRecipient.recipientName } : {}),
      subject: draft.subject,
      connectionId,
      reason: sendRes.status === 403 ? 'insufficient_gmail_scope' : `gmail_http_${sendRes.status}`,
      message: msg,
    };
  }

  let sentPayload: { id?: string; threadId?: string } = {};
  try {
    sentPayload = (await sendRes.json()) as { id?: string; threadId?: string };
  } catch {
    // Keep sent state even if response body is minimal.
  }

  return {
    state: 'sent',
    from: SPONSOR_DOC_EMAIL_FROM,
    to,
    ...(cc.length > 0 ? { cc } : {}),
    ...(resolvedRecipient.recipientName ? { recipientName: resolvedRecipient.recipientName } : {}),
    subject: draft.subject,
    connectionId,
    ...(sentPayload.id ? { messageId: sentPayload.id } : {}),
    ...(sentPayload.threadId ? { threadId: sentPayload.threadId } : {}),
    sentAt: new Date().toISOString(),
  };
}
