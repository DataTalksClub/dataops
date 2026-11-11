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
  readDapierCredential,
} from '../calendar/dapierBroker';
import { listCrmRecords } from '../db/sponsorCrm';
import {
  KnowledgeEmailTemplateError,
  renderNewsletterSponsorEmail,
} from './knowledgeEmailTemplate';
import {
  renderSponsorEmailDraft,
  type SponsorDocTemplateKey,
} from './templates';
import { PODCAST_FIRST_CONTACT_CC } from '../podcast/firstContact';

export const SPONSOR_DOC_EMAIL_FROM = 'orin@datatalks.club';
export const SPONSOR_DOC_EMAIL_CC = 'valeriia@datatalks.club';
/** Orin's Gmail grants live on her Google connection in Dapier (the one that also holds calendar). */
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
  taskId?: string;
  templateId?: string;
  templateRevision?: string;
  threadId?: string;
  sentAt?: string;
  reason?: string;
  message?: string;
}

export interface TemplatedEmailDraft {
  subject: string;
  body: string;
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
  /** Continue an existing Gmail thread: the Message-ID of its last message. */
  inReplyTo?: string;
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
    ...(input.inReplyTo
      ? [`In-Reply-To: ${sanitizeHeaderValue(input.inReplyTo)}`, `References: ${sanitizeHeaderValue(input.inReplyTo)}`]
      : []),
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
      + `https://www.googleapis.com/auth/gmail.send scope granted and re-consented in Dapier `
      + `(set DATAOPS_ORIN_GMAIL_CONNECTION_ID to the Dapier connection holding ${SPONSOR_DOC_EMAIL_FROM}).`
    );
  }
  return `Gmail API returned HTTP ${status}${detail ? `: ${detail}` : ''}.`;
}

function summarizeDapierGmailTokenProblem(status: number, connectionId: string, agent: string): string {
  if (status === 403) {
    return `Dapier denied access to Gmail connection "${connectionId}". Grant agent "${agent}" use access to this connection.`;
  }
  if (status === 401) {
    return 'Dapier rejected the Gmail machine credential. A platform operator must repair the machine credential; Google refresh tokens stay in Dapier.';
  }
  if (status === 404) {
    return `Dapier Gmail connection "${connectionId}" does not exist. Create or select a dedicated Google Gmail connection.`;
  }
  if (status === 409 || status === 502) {
    return `Dapier cannot obtain a Google token for Gmail connection "${connectionId}". Reconnect it in Dapier and verify the Gmail permissions.`;
  }
  return `The Dapier Gmail token broker refused the request (HTTP ${status}).`;
}

/** The thread's subject (as a reply) and the Message-ID of its last message; null when Gmail cannot read it. */
async function readGmailThreadHeaders(
  runFetch: typeof fetch,
  authHeaders: Record<string, string>,
  threadId: string,
): Promise<{ subject: string; messageId: string } | null> {
  let res: Response;
  try {
    res = await runFetch(
      `${GMAIL_API_BASE}/threads/${encodeURIComponent(threadId)}?format=metadata&metadataHeaders=Message-ID&metadataHeaders=Subject`,
      { method: 'GET', headers: authHeaders, signal: AbortSignal.timeout(10000) },
    );
  } catch {
    return null;
  }
  if (!res.ok) return null;
  const thread = (await res.json().catch(() => null)) as
    | { messages?: Array<{ payload?: { headers?: Array<{ name?: string; value?: string }> } }> }
    | null;
  const messages = thread?.messages || [];
  const header = (index: number, name: string) => messages[index]?.payload?.headers
    ?.find((item) => item.name?.toLowerCase() === name)?.value?.trim() || '';
  const first = header(0, 'subject');
  const messageId = header(messages.length - 1, 'message-id');
  if (!first || !messageId) return null;
  return { subject: /^re:/i.test(first) ? first : `Re: ${first}`, messageId };
}

export async function deliverRenderedEmail(
  client: DynamoDBDocumentClient,
  options: {
    draft: TemplatedEmailDraft;
    recipientEmail?: string | null;
    recipientName?: string | null;
    taskId?: string | null;
    organizationId?: string | null;
    sponsorName?: string | null;
    connectionId?: string | null;
    /** Domain-owned recipients; sponsor content requests keep their default CC. */
    cc?: string[];
    /** Reply in this Gmail thread instead of starting a new one; the subject is taken from the thread. */
    threadId?: string;
  },
): Promise<SponsorDocEmailDelivery> {
  const resolvedRecipient = await resolveSponsorDocRecipient(client, {
    explicitEmail: options.recipientEmail,
    explicitName: options.recipientName,
    organizationId: options.organizationId,
    sponsorName: options.sponsorName,
  });

  const subject = options.draft.subject;

  if (resolvedRecipient.to?.toLowerCase() === 'grace@datatalks.club') {
    return {
      state: 'skipped',
      from: SPONSOR_DOC_EMAIL_FROM,
      ...(resolvedRecipient.recipientName ? { recipientName: resolvedRecipient.recipientName } : {}),
      subject,
      reason: 'blocked_recipient',
      message: 'Sponsor form emails are never sent to grace@datatalks.club; no email was sent.',
    };
  }

  if (!resolvedRecipient.to) {
    return {
      state: 'skipped',
      from: SPONSOR_DOC_EMAIL_FROM,
      ...(resolvedRecipient.recipientName ? { recipientName: resolvedRecipient.recipientName } : {}),
      subject,
      reason: 'missing_recipient_email',
      message:
        'No sponsor recipient email on the request or CRM contact. '
        + 'Pass recipientEmail (or add an active contact email on the sponsor organization in CRM) '
        + `to auto-send from ${SPONSOR_DOC_EMAIL_FROM}.`,
    };
  }

  if (!options.taskId?.trim()) {
    return {
      state: 'deferred',
      from: SPONSOR_DOC_EMAIL_FROM,
      to: resolvedRecipient.to,
      cc: options.cc ?? [SPONSOR_DOC_EMAIL_CC],
      ...(resolvedRecipient.recipientName ? { recipientName: resolvedRecipient.recipientName } : {}),
      subject,
      reason: 'task_required',
      message: 'A linked owning task is required before sending; the email was not sent.',
    };
  }

  const to = resolvedRecipient.to;
  const cc = options.cc ?? [SPONSOR_DOC_EMAIL_CC];

  const explicitConnectionId = (
    options.connectionId
    || emailDeps.connectionId
    || process.env.DATAOPS_ORIN_GMAIL_CONNECTION_ID
    || DEFAULT_ORIN_GMAIL_CONNECTION_ID
  ).trim();
  const candidateConnectionIds = explicitConnectionId
    ? [explicitConnectionId]
    : [DEFAULT_ORIN_GMAIL_CONNECTION_ID];
  const primaryConnectionId = candidateConnectionIds[0] || DEFAULT_ORIN_GMAIL_CONNECTION_ID;

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
      subject,
      connectionId: primaryConnectionId,
      reason: 'missing_dapier_credential',
      message: `${base} (form created; sponsor email auto-send deferred)`,
    };
  }

  let preferredDeferred: SponsorDocEmailDelivery | null = null;

  for (const connectionId of candidateConnectionIds) {
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
        subject,
        connectionId,
        reason: 'dapier_unreachable',
        message: 'The Dapier token broker could not be reached.',
      };
    }

    if (!tokenRes.ok) {
      const msg = summarizeDapierGmailTokenProblem(tokenRes.status, connectionId, agent);
      const failure: SponsorDocEmailDelivery = {
        state: 'deferred',
        from: SPONSOR_DOC_EMAIL_FROM,
        to,
        ...(cc.length > 0 ? { cc } : {}),
        ...(resolvedRecipient.recipientName ? { recipientName: resolvedRecipient.recipientName } : {}),
        subject,
        connectionId,
        reason: `dapier_token_http_${tokenRes.status}`,
        message: msg,
      };
      if (!preferredDeferred) preferredDeferred = failure;
      continue;
    }

    let tokenData: { access_token?: string; provider_account_id?: string; scope?: string };
    try {
      tokenData = (await tokenRes.json()) as { access_token?: string; provider_account_id?: string; scope?: string };
    } catch {
      const failure: SponsorDocEmailDelivery = {
        state: 'deferred',
        from: SPONSOR_DOC_EMAIL_FROM,
        to,
        ...(cc.length > 0 ? { cc } : {}),
        ...(resolvedRecipient.recipientName ? { recipientName: resolvedRecipient.recipientName } : {}),
        subject,
        connectionId,
        reason: 'invalid_broker_json',
        message: 'The Dapier token broker returned an invalid JSON response.',
      };
      if (!preferredDeferred) preferredDeferred = failure;
      continue;
    }

    if (!tokenData.access_token) {
      const failure: SponsorDocEmailDelivery = {
        state: 'deferred',
        from: SPONSOR_DOC_EMAIL_FROM,
        to,
        ...(cc.length > 0 ? { cc } : {}),
        ...(resolvedRecipient.recipientName ? { recipientName: resolvedRecipient.recipientName } : {}),
        subject,
        connectionId,
        reason: 'empty_access_token',
        message: `Dapier connection "${connectionId}" returned no access token.`,
      };
      if (!preferredDeferred) preferredDeferred = failure;
      continue;
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
      const failure: SponsorDocEmailDelivery = {
        state: 'deferred',
        from: SPONSOR_DOC_EMAIL_FROM,
        to,
        ...(cc.length > 0 ? { cc } : {}),
        ...(resolvedRecipient.recipientName ? { recipientName: resolvedRecipient.recipientName } : {}),
        subject,
        connectionId,
        reason: 'wrong_sender_identity',
        message: `Sponsor form emails must be sent from ${SPONSOR_DOC_EMAIL_FROM}, but Dapier connection "${connectionId}" is bound to "${verifiedAccount}".`,
      };
      if (!preferredDeferred) preferredDeferred = failure;
      continue;
    }

    if (!verifiedAccount) {
      const failure: SponsorDocEmailDelivery = {
        state: 'deferred',
        from: SPONSOR_DOC_EMAIL_FROM,
        to,
        ...(cc.length > 0 ? { cc } : {}),
        ...(resolvedRecipient.recipientName ? { recipientName: resolvedRecipient.recipientName } : {}),
        subject,
        connectionId,
        reason: 'sender_identity_unverified',
        message: `DataOps could not verify that Dapier connection "${connectionId}" belongs to ${SPONSOR_DOC_EMAIL_FROM}; no email was sent.`,
      };
      if (!preferredDeferred) preferredDeferred = failure;
      continue;
    }

    let replySubject = subject;
    let inReplyTo: string | undefined;
    if (options.threadId) {
      const thread = await readGmailThreadHeaders(runFetch, authHeaders, options.threadId);
      if (!thread) {
        return {
          state: 'deferred',
          from: SPONSOR_DOC_EMAIL_FROM,
          to,
          ...(cc.length > 0 ? { cc } : {}),
          subject,
          connectionId,
          reason: 'thread_not_found',
          message: `Gmail thread ${options.threadId} could not be read from ${SPONSOR_DOC_EMAIL_FROM}; no email was sent.`,
        };
      }
      replySubject = thread.subject;
      inReplyTo = thread.messageId;
    }
    const raw = buildRawMimeEmail({
      from: SPONSOR_DOC_EMAIL_FROM,
      to,
      cc,
      subject: replySubject,
      body: options.draft.body,
      inReplyTo,
    });

    let sendRes: Response;
    try {
      sendRes = await runFetch(`${GMAIL_API_BASE}/messages/send`, {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({ raw, ...(options.threadId ? { threadId: options.threadId } : {}) }),
        signal: AbortSignal.timeout(15000),
      });
    } catch {
      return {
        state: 'deferred',
        from: SPONSOR_DOC_EMAIL_FROM,
        to,
        ...(cc.length > 0 ? { cc } : {}),
        ...(resolvedRecipient.recipientName ? { recipientName: resolvedRecipient.recipientName } : {}),
        subject,
        connectionId,
        reason: 'gmail_unreachable',
        message: 'Gmail API could not be reached to send the sponsor email.',
      };
    }

    if (!sendRes.ok) {
      const errText = await sendRes.text().catch(() => '');
      const msg = summarizeGmailError(sendRes.status, errText, connectionId);
      const failure: SponsorDocEmailDelivery = {
        state: 'deferred',
        from: SPONSOR_DOC_EMAIL_FROM,
        to,
        ...(cc.length > 0 ? { cc } : {}),
        ...(resolvedRecipient.recipientName ? { recipientName: resolvedRecipient.recipientName } : {}),
        subject,
        connectionId,
        reason: sendRes.status === 403 ? 'insufficient_gmail_scope' : `gmail_http_${sendRes.status}`,
        message: msg,
      };
      if (!preferredDeferred || preferredDeferred.reason !== 'insufficient_gmail_scope') {
        preferredDeferred = failure;
      }
      continue;
    }

    let sentPayload: { id?: string; threadId?: string } = {};
    try {
      sentPayload = (await sendRes.json()) as { id?: string; threadId?: string };
    } catch {
      // Keep sent state even if response body is minimal.
    }

    if (!sentPayload.id) {
      return {
        state: 'deferred',
        from: SPONSOR_DOC_EMAIL_FROM,
        to,
        ...(cc.length > 0 ? { cc } : {}),
        ...(resolvedRecipient.recipientName ? { recipientName: resolvedRecipient.recipientName } : {}),
        subject,
        connectionId,
        reason: 'gmail_message_id_missing',
        message: 'Gmail accepted the send but returned no message ID; task evidence was not recorded.',
      };
    }

    return {
      state: 'sent',
      from: SPONSOR_DOC_EMAIL_FROM,
      to,
      ...(cc.length > 0 ? { cc } : {}),
      ...(resolvedRecipient.recipientName ? { recipientName: resolvedRecipient.recipientName } : {}),
      subject,
      connectionId,
      ...(sentPayload.id ? { messageId: sentPayload.id } : {}),
      ...(sentPayload.threadId ? { threadId: sentPayload.threadId } : {}),
      sentAt: new Date().toISOString(),
    };
  }

  return (
    preferredDeferred || {
      state: 'deferred',
      from: SPONSOR_DOC_EMAIL_FROM,
      to,
      ...(cc.length > 0 ? { cc } : {}),
      ...(resolvedRecipient.recipientName ? { recipientName: resolvedRecipient.recipientName } : {}),
      subject,
      connectionId: primaryConnectionId,
      reason: 'dapier_unreachable',
      message: 'The Dapier token broker could not be reached.',
    }
  );
}

export async function renderSponsorDocEmailDraft(options: {
  template: SponsorDocTemplateKey;
  sponsorName?: string | null;
  publicationDate?: string | null;
  shareUrl: string;
  accessCode: string;
  recipientName?: string | null;
}): Promise<TemplatedEmailDraft & { templateId?: string; templateRevision?: string }> {
  if (isNewsletterSponsorTemplate(options.template)) {
    const rendered = await renderNewsletterSponsorEmail(options);
    return {
      subject: rendered.subject,
      body: rendered.body,
      templateId: rendered.id,
      templateRevision: rendered.revision,
    };
  }
  return renderSponsorEmailDraft(options);
}

export function defaultCcForSponsorDocTemplate(template: SponsorDocTemplateKey): string[] {
  if (template === 'podcast' || template.startsWith('podcast-')) {
    return [...PODCAST_FIRST_CONTACT_CC];
  }
  if (template === 'webinar' || template === 'workshop') {
    return [];
  }
  return [SPONSOR_DOC_EMAIL_CC];
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
    taskId?: string | null;
    organizationId?: string | null;
    connectionId?: string | null;
    cc?: string[];
    threadId?: string;
  },
): Promise<SponsorDocEmailDelivery> {
  const resolvedRecipient = await resolveSponsorDocRecipient(client, {
    explicitEmail: options.recipientEmail,
    explicitName: options.recipientName,
    organizationId: options.organizationId,
    sponsorName: options.sponsorName,
  });
  const cc = options.cc ?? defaultCcForSponsorDocTemplate(options.template);

  let draft: TemplatedEmailDraft & { templateId?: string; templateRevision?: string };
  try {
    draft = await renderSponsorDocEmailDraft({
      template: options.template,
      sponsorName: options.sponsorName,
      publicationDate: options.publicationDate,
      shareUrl: options.shareUrl,
      accessCode: options.accessCode,
      recipientName: resolvedRecipient.recipientName,
    });
  } catch (error) {
    return {
      state: 'deferred',
      from: SPONSOR_DOC_EMAIL_FROM,
      ...(resolvedRecipient.to ? { to: resolvedRecipient.to, ...(cc.length > 0 ? { cc } : {}) } : {}),
      ...(resolvedRecipient.recipientName ? { recipientName: resolvedRecipient.recipientName } : {}),
      subject: '',
      reason: error instanceof KnowledgeEmailTemplateError ? 'knowledge_template_unavailable' : 'template_render_failed',
      message: 'The sponsor email template could not be loaded or rendered; no email was sent.',
    };
  }

  const delivery = await deliverRenderedEmail(client, {
    draft,
    recipientEmail: resolvedRecipient.to,
    recipientName: resolvedRecipient.recipientName,
    taskId: options.taskId,
    organizationId: options.organizationId,
    sponsorName: options.sponsorName,
    connectionId: options.connectionId,
    cc,
    ...(options.threadId ? { threadId: options.threadId } : {}),
  });
  return {
    ...delivery,
    ...(draft.templateId ? { templateId: draft.templateId } : {}),
    ...(draft.templateRevision ? { templateRevision: draft.templateRevision } : {}),
  };
}
