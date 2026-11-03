/**
 * Payment notification mails (Ramp, Stripe, BILL) -> receive-payment candidates.
 *
 * Pure parsing and matching plus a small store. A candidate is never a
 * payment: Orin confirms it, and confirmation goes through the normal
 * receive-payment route. Mail arrives from Orin's mailbox through the
 * existing Dapier connection (see `pollPaymentMail` in paymentMailPoll.ts) or
 * is pushed by an agent that already read it; both paths share `ingestPaymentMail`
 * and are idempotent per mail message id.
 */
import { createHash } from 'crypto';
import { GetCommand, PutCommand, UpdateCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { scanCrmPrefix } from '../db/sponsorCrm';
import { TABLE_SPONSOR_CRM } from '../db/tableNames';
import { CURRENCY, MONEY } from './core';
import type { LedgerRow } from './ledger';

export type PaymentProvider = 'ramp' | 'stripe' | 'bill';

export type PaymentMail = {
  messageId: string;
  from: string;
  subject: string;
  body: string;
  receivedAt: string;
};

export type ParsedPayment = {
  provider: PaymentProvider;
  invoiceNumber?: string;
  amount?: string;
  currency?: string;
  payer?: string;
};

const SENDER_HOSTS: Array<[PaymentProvider, RegExp]> = [
  ['ramp', /(^|[.@])ramp\.com$/i],
  ['stripe', /(^|[.@])stripe\.com$/i],
  ['bill', /(^|[.@])(bill\.com|billpay\.com|hq\.bill\.com)$/i],
];

const SYMBOLS: Record<string, string> = { '$': 'USD', '€': 'EUR', '£': 'GBP' };
const CODE = '(?:EUR|USD|GBP|CHF|CAD|AUD|SEK|NOK|DKK|PLN)';
const NUMBER = '\\d{1,3}(?:[,.\\s\\u00a0]\\d{3})*(?:[.,]\\d{1,2})?|\\d+(?:[.,]\\d{1,2})?';
const INVOICE = '#?\\s*([A-Za-z0-9][A-Za-z0-9/_.-]{1,40})';

export function providerForSender(from: string): PaymentProvider | null {
  const host = (from.match(/@([^>\s]+)/)?.[1] || '').toLowerCase().replace(/>$/, '');
  return SENDER_HOSTS.find(([, pattern]) => pattern.test(host))?.[0] || null;
}

/** "1,500.00" / "1.500,00" / "1500" -> "1500.00" style decimal string, or undefined. */
export function normalizeAmount(raw: string): string | undefined {
  let value = raw.replace(/[\s ]/g, '');
  const lastComma = value.lastIndexOf(','), lastDot = value.lastIndexOf('.');
  if (lastComma > lastDot) value = value.replace(/\./g, '').replace(',', '.');
  else value = value.replace(/,/g, '');
  if (!/^\d+(\.\d{1,4})?$/.test(value)) return undefined;
  value = value.replace(/^0+(?=\d)/, '');
  return MONEY.test(value) && Number(value) > 0 ? value : undefined;
}

function findMoney(text: string): { amount: string; currency: string } | undefined {
  const patterns: Array<[RegExp, (m: RegExpMatchArray) => [string, string]]> = [
    [new RegExp(`([$€£])\\s?(${NUMBER})(?:\\s?(${CODE}))?`, 'i'), (m) => [m[2], (m[3] || SYMBOLS[m[1]]).toUpperCase()]],
    [new RegExp(`\\b(${CODE})\\s?(${NUMBER})`, 'i'), (m) => [m[2], m[1].toUpperCase()]],
    [new RegExp(`(${NUMBER})\\s?(${CODE})\\b`, 'i'), (m) => [m[1], m[2].toUpperCase()]],
  ];
  for (const [pattern, pick] of patterns) {
    const match = text.match(pattern);
    if (!match) continue;
    const [rawAmount, currency] = pick(match);
    const amount = normalizeAmount(rawAmount);
    if (amount && CURRENCY.test(currency)) return { amount, currency };
  }
  return undefined;
}

function cleanInvoice(value: string | undefined): string | undefined {
  const cleaned = (value || '').replace(/[.,;:)]+$/, '');
  return cleaned && /\d/.test(cleaned) ? cleaned : undefined;
}

function plain(text: string): string {
  return text
    .replace(/<(style|script)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>|<\/(p|div|tr|li|h\d)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&euro;/g, '€').replace(/&#36;|&dollar;/g, '$')
    .replace(/[ \t ]+/g, ' ').replace(/\n\s*/g, '\n').trim();
}

/** Returns null when the mail is not a received-payment notification. */
export function parsePaymentMail(mail: Pick<PaymentMail, 'from' | 'subject' | 'body'>): ParsedPayment | null {
  const provider = providerForSender(mail.from);
  if (!provider) return null;
  const subject = mail.subject.replace(/^\s*((re|fwd?):\s*)+/i, '').trim();
  const body = plain(mail.body);
  const text = `${subject}\n${body}`;
  const received = /payment (received|successful|confirmed)|you('| ha)ve (been paid|received a payment)|received (a )?payment|paid (you|invoice)|payment (was )?(sent|deposited)/i;
  if (!received.test(subject) && !received.test(body.slice(0, 800))) return null;
  if (/payment (failed|declined|refunded|reversed)|refund|dispute/i.test(subject)) return null;

  const result: ParsedPayment = { provider };
  const fromSubject = subject.match(new RegExp(`payment received[:\\s-]+${INVOICE}`, 'i'))
    || subject.match(new RegExp(`invoice\\s*(?:no\\.?|number)?\\s*${INVOICE}`, 'i'));
  const fromBody = body.match(new RegExp(`invoice\\s*(?:no\\.?|number|#)?[:\\s]*${INVOICE}`, 'i'))
    || body.match(/#\s*([A-Za-z0-9][A-Za-z0-9/_.-]{1,40})/);
  const invoiceNumber = cleanInvoice(fromSubject?.[1]) || cleanInvoice(fromBody?.[1]);
  if (invoiceNumber) result.invoiceNumber = invoiceNumber;

  const money = findMoney(body) || findMoney(subject);
  if (money) Object.assign(result, money);

  const payer = text.match(/(?:from|payer|paid by|customer|vendor)[:\s]+([^\n<]{2,80}?)(?:\s+(?:has|paid|for|via|on|sent|\(|-|—)|\n|$)/i)
    || body.match(/^([A-Z][^\n]{1,60}?) (?:has )?paid (?:you |invoice|your)/m);
  if (payer) result.payer = payer[1].trim();
  return result;
}

export type CandidateMatch = {
  dealId: string;
  organizationName: string;
  dealTitle?: string;
  invoiceNumber?: string;
  outstanding?: string;
  currency?: string;
  confidence: 'exact' | 'invoice' | 'amount' | 'sponsor';
  reasons: string[];
};

const norm = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, '');
const invoiceKey = (value: string) => value.trim().toUpperCase().replace(/\s+/g, '');

const DAY_MS = 86_400_000;

/**
 * Already-paid fallback for deals whose finance state predates the stored
 * invoice number (or never recorded one): a single paid row with the exact
 * amount, currency and sponsor name, near the payment date. Never guesses
 * between ties, and never fires while an open row still matches (open
 * matching runs first). Informational only: nothing is marked paid.
 */
export function matchPaidRow(parsed: ParsedPayment, receivedOn: string, rows: LedgerRow[]): LedgerRow | null {
  if (!parsed.amount || !parsed.currency || !parsed.payer) return null;
  const payer = norm(parsed.payer);
  if (payer.length < 3) return null;
  const hits = rows.filter((row) => {
    if (row.paymentState !== 'paid') return false;
    if (!row.currency || row.currency !== parsed.currency) return false;
    if (![row.paid, row.amountDue].some((value) => value && Number(value) === Number(parsed.amount))) return false;
    const organization = norm(row.organizationName || '');
    if (organization.length < 3 || (!organization.includes(payer) && !payer.includes(organization))) return false;
    if (row.lastPaymentOn && receivedOn) {
      const days = Math.abs(Math.round((Date.parse(receivedOn) - Date.parse(row.lastPaymentOn)) / DAY_MS));
      if (!Number.isFinite(days) || days > 14) return false;
    }
    return true;
  });
  return hits.length === 1 ? hits[0] : null;
}

/** Invoice number first, then amount + sponsor name; never guesses between ties. */
export function matchPayment(parsed: ParsedPayment, rows: LedgerRow[]): CandidateMatch | null {
  const open = rows.filter((row) => row.paymentState !== 'paid' && row.paymentState !== 'not-applicable');
  const describe = (row: LedgerRow, confidence: CandidateMatch['confidence'], reasons: string[]): CandidateMatch => ({
    dealId: row.dealId, organizationName: row.organizationName,
    ...(row.dealTitle ? { dealTitle: row.dealTitle } : {}),
    ...(row.invoiceNumber ? { invoiceNumber: row.invoiceNumber } : {}),
    ...(row.outstanding ? { outstanding: row.outstanding } : {}),
    ...(row.currency ? { currency: row.currency } : {}),
    confidence, reasons,
  });
  const amountOk = (row: LedgerRow) => !!parsed.amount && [row.outstanding, row.amountDue].some((v) => v && Number(v) === Number(parsed.amount))
    && (!parsed.currency || !row.currency || row.currency === parsed.currency);
  const exactAmountOk = (row: LedgerRow) => !!parsed.amount
    && Number(row.outstanding || row.amountDue) === Number(parsed.amount);
  const nameOk = (row: LedgerRow) => {
    const payer = norm(parsed.payer || ''), organization = norm(row.organizationName || '');
    return payer.length >= 3 && organization.length >= 3
      && (organization.includes(payer) || payer.includes(organization));
  };

  if (parsed.invoiceNumber) {
    const byInvoice = open.filter((row) => row.invoiceNumber && invoiceKey(row.invoiceNumber) === invoiceKey(parsed.invoiceNumber!));
    if (byInvoice.length > 1) return null;
    if (byInvoice.length === 1) {
      const row = byInvoice[0];
      const reasons = ['invoice number'];
      if (amountOk(row)) reasons.push('amount', ...(parsed.currency ? ['currency'] : []));
      if (nameOk(row)) reasons.push('sponsor');
      const exact = exactAmountOk(row) && !!parsed.currency && row.currency === parsed.currency;
      return describe(row, exact ? 'exact' : 'invoice', reasons);
    }
  }
  const byAmount = open.filter((row) => amountOk(row) && nameOk(row));
  if (byAmount.length === 1) return describe(byAmount[0], 'amount', ['amount', 'sponsor']);
  const byName = open.filter((row) => nameOk(row));
  if (byName.length === 1) return describe(byName[0], 'sponsor', ['sponsor']);
  return null;
}

export type PaymentMailStatus = 'candidate' | 'unmatched' | 'confirmed' | 'dismissed' | 'already-paid';

export type PaymentMailCandidate = {
  id: string;
  recordType: 'payment-mail-candidate';
  messageId: string;
  provider: PaymentProvider;
  from: string;
  subject: string;
  receivedAt: string;
  receivedOn: string;
  invoiceNumber?: string;
  amount?: string;
  currency?: string;
  payer?: string;
  status: PaymentMailStatus;
  match?: CandidateMatch;
  decidedAt?: string;
  decidedBy?: string;
  createdAt: string;
  updatedAt: string;
};

export const candidateId = (messageId: string) => `pmc-${createHash('sha256').update(messageId.trim()).digest('hex').slice(0, 32)}`;
const key = (id: string) => ({ PK: `PAYMENT_MAIL#${id}`, SK: `PAYMENT_MAIL#${id}` });
const strip = (item: Record<string, unknown>) => { const { PK: _p, SK: _s, ...rest } = item; return rest as unknown as PaymentMailCandidate; };

export function validateMail(value: unknown): PaymentMail {
  const mail = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>;
  const text = (name: string, max: number) => {
    const v = mail[name];
    if (typeof v !== 'string' || !v.trim() || v.length > max) throw Object.assign(new Error(`Invalid mail.${name}`), { statusCode: 400 });
    return v;
  };
  const receivedAt = text('receivedAt', 40);
  if (Number.isNaN(Date.parse(receivedAt))) throw Object.assign(new Error('Invalid mail.receivedAt'), { statusCode: 400 });
  return { messageId: text('messageId', 300), from: text('from', 320), subject: text('subject', 500), body: typeof mail.body === 'string' ? mail.body.slice(0, 50_000) : '', receivedAt };
}

export type IngestOutcome = { messageId: string; outcome: 'created' | 'duplicate' | 'ignored'; candidate?: PaymentMailCandidate };

function describePaidRow(row: LedgerRow): CandidateMatch {
  return {
    dealId: row.dealId, organizationName: row.organizationName,
    ...(row.dealTitle ? { dealTitle: row.dealTitle } : {}),
    ...(row.invoiceNumber ? { invoiceNumber: row.invoiceNumber } : {}),
    ...(row.currency ? { currency: row.currency } : {}),
    confidence: row.invoiceNumber ? 'invoice' : 'amount',
    reasons: row.invoiceNumber ? ['invoice number', 'already paid'] : ['amount', 'currency', 'sponsor', 'already paid'],
  };
}

/** Idempotent per message id: a re-ingested mail never overwrites a decided candidate. */
export async function ingestPaymentMail(client: DynamoDBDocumentClient, mails: PaymentMail[], rows: LedgerRow[]): Promise<IngestOutcome[]> {
  const out: IngestOutcome[] = [];
  for (const mail of mails) {
    const parsed = parsePaymentMail(mail);
    if (!parsed) { out.push({ messageId: mail.messageId, outcome: 'ignored' }); continue; }
    const id = candidateId(mail.messageId);
    const match = matchPayment(parsed, rows);
    const paidByInvoice = parsed.invoiceNumber ? rows.find((r) => r.invoiceNumber && invoiceKey(r.invoiceNumber) === invoiceKey(parsed.invoiceNumber!) && r.paymentState === 'paid') : undefined;
    const receivedAt = new Date(mail.receivedAt).toISOString();
    const paidFallback = !match && !paidByInvoice ? matchPaidRow(parsed, receivedAt.slice(0, 10), rows) : null;
    const alreadyPaid = !!paidByInvoice || !!paidFallback;
    const paidRow = paidByInvoice || paidFallback || undefined;
    const now = new Date().toISOString();
    const status: PaymentMailStatus = alreadyPaid ? 'already-paid' : match ? 'candidate' : 'unmatched';
    const candidate: PaymentMailCandidate = {
      id, recordType: 'payment-mail-candidate', messageId: mail.messageId.trim(), provider: parsed.provider,
      from: mail.from.slice(0, 320), subject: mail.subject.slice(0, 500), receivedAt, receivedOn: receivedAt.slice(0, 10),
      ...(parsed.invoiceNumber ? { invoiceNumber: parsed.invoiceNumber } : {}),
      ...(parsed.amount ? { amount: parsed.amount } : {}),
      ...(parsed.currency ? { currency: parsed.currency } : {}),
      ...(parsed.payer ? { payer: parsed.payer } : {}),
      status,
      ...(match ? { match } : paidRow ? { match: describePaidRow(paidRow) } : {}),
      createdAt: now, updatedAt: now,
    };
    try {
      await client.send(new PutCommand({ TableName: TABLE_SPONSOR_CRM, Item: { ...key(id), ...candidate }, ConditionExpression: 'attribute_not_exists(PK)' }));
      out.push({ messageId: mail.messageId, outcome: 'created', candidate });
    } catch (error) {
      if ((error as { name?: string }).name !== 'ConditionalCheckFailedException') throw error;
      out.push({ messageId: mail.messageId, outcome: 'duplicate' });
    }
  }
  return out;
}

export async function listPaymentMailCandidates(client: DynamoDBDocumentClient, status?: string): Promise<PaymentMailCandidate[]> {
  if (status && !['candidate', 'unmatched', 'confirmed', 'dismissed', 'already-paid'].includes(status)) {
    throw Object.assign(new Error('Invalid payment mail status'), { statusCode: 400 });
  }
  const items = (await scanCrmPrefix(client, 'PAYMENT_MAIL#')).map(strip);
  return items.filter((item) => !status || item.status === status)
    .sort((a, b) => b.receivedAt.localeCompare(a.receivedAt) || a.id.localeCompare(b.id));
}

export async function getPaymentMailCandidate(client: DynamoDBDocumentClient, id: string) {
  const item = (await client.send(new GetCommand({ TableName: TABLE_SPONSOR_CRM, Key: key(id), ConsistentRead: true }))).Item;
  return item ? strip(item) : null;
}

/** Only an undecided candidate can be decided; a repeat of the same decision is a no-op. */
export async function decidePaymentMailCandidate(client: DynamoDBDocumentClient, id: string, decision: 'confirmed' | 'dismissed', actorId: string) {
  const current = await getPaymentMailCandidate(client, id);
  if (!current) throw Object.assign(new Error('Payment mail candidate not found'), { statusCode: 404 });
  if (current.status === decision) return current;
  if (current.status === 'confirmed' || current.status === 'dismissed') {
    throw Object.assign(new Error(`Candidate already ${current.status}`), { statusCode: 409 });
  }
  if (decision === 'confirmed' && current.status !== 'candidate') {
    throw Object.assign(new Error('Only a matched candidate can be confirmed'), { statusCode: 409 });
  }
  const now = new Date().toISOString();
  try {
    await client.send(new UpdateCommand({
      TableName: TABLE_SPONSOR_CRM, Key: key(id),
      UpdateExpression: 'SET #status = :status, decidedAt = :now, decidedBy = :actor, updatedAt = :now',
      ConditionExpression: 'attribute_exists(PK) AND #status = :previous',
      ExpressionAttributeNames: { '#status': 'status' },
      ExpressionAttributeValues: { ':status': decision, ':now': now, ':actor': actorId, ':previous': current.status },
    }));
  } catch (error) {
    if ((error as { name?: string }).name === 'ConditionalCheckFailedException') {
      throw Object.assign(new Error('Candidate was changed; reload and retry'), { statusCode: 409 });
    }
    throw error;
  }
  return { ...current, status: decision, decidedAt: now, decidedBy: actorId, updatedAt: now };
}
