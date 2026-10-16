import { randomUUID } from 'crypto';
import {
  BatchGetCommand,
  GetCommand,
  QueryCommand,
  ScanCommand,
  TransactGetCommand,
  TransactWriteCommand,
  type DynamoDBDocumentClient,
} from '@aws-sdk/lib-dynamodb';
import { settlementBalance, validateSettlementAdjustment } from './settlementAdjustment';
import { documentLinkItem } from '../db/bookkeeping';
import { TABLE_BOOKKEEPING, TABLE_SPONSOR_CRM, TABLE_USERS } from '../db/tableNames';
import {
  CURRENCY,
  IDEMPOTENCY,
  MAX_PAYMENT_LINK_TRANSACTION_ACTIONS,
  OPAQUE,
  PAYMENT_LINK_LIMIT,
  berlinDate,
  claimKey,
  digest,
  displayMoney,
  financeKey,
  invoiceIdentity,
  linkKey,
  paymentIdentity,
  realDate,
  scaledMoney,
  sourceKey,
  recordedPaymentKey,
  INVOICE_NUMBER,
  MAX_EVIDENCE,
  boundedText,
} from './core';
import { daysBetween, deriveFollowUp, deriveStates } from './followUp';
import {
  EVIDENCE_KINDS,
  RECORDED_PAYMENT_METHODS,
  WAITING_PARTIES,
  WAITING_REASONS,
  type FinanceEvidence,
  type FinanceLink,
  type FinancePayment,
  type FinanceProjection,
  type FinanceState,
  type RecordedPayment,
  type WaitingOn,
} from './types';

const singleton = (key: string) => ({ PK: key, SK: key });
const clean = <T>(item?: Record<string, unknown>): T | null => {
  if (!item) return null;
  const { PK: _pk, SK: _sk, ...value } = item;
  return value as T;
};
const userKey = (id: string) => ({ PK: `USER#${id}`, SK: `USER#${id}` });
const dealKey = (id: string) => singleton(`DEAL#${id}`);
const nowIso = () => new Date().toISOString();
export const safeConflict = () => Object.assign(new Error('Finance state changed; reload and retry'), { statusCode: 409 });
const DISCOVERY_MAX_ITEMS = 5_000;
const DISCOVERY_MAX_PAGES = 100;
const DISCOVERY_DEADLINE_MS = 2_000;

export function financeEnabled(): boolean {
  return process.env.SPONSOR_FINANCE_ENABLED === 'true';
}

export async function financeActor(client: DynamoDBDocumentClient, actorId: string, admin = false) {
  if (!OPAQUE.test(actorId) || ['authenticated-operator', 'portal-admin'].includes(actorId)) {
    throw Object.assign(new Error('Unauthorized'), { statusCode: 401 });
  }
  const result = await client.send(new GetCommand({ TableName: TABLE_USERS, Key: userKey(actorId), ConsistentRead: true }));
  const user = result.Item;
  if (!user || user.disabled === true || !['admin', 'operator'].includes(String(user.role))) {
    throw Object.assign(new Error('Forbidden'), { statusCode: 403 });
  }
  if (admin && user.role !== 'admin') throw Object.assign(new Error('Forbidden'), { statusCode: 403 });
  return { id: actorId, role: user.role as 'admin' | 'operator' };
}

export async function getFinanceState(client: DynamoDBDocumentClient, dealId: string): Promise<FinanceState | null> {
  return clean<FinanceState>((await client.send(new GetCommand({
    TableName: TABLE_SPONSOR_CRM,
    Key: singleton(financeKey(dealId)),
    ConsistentRead: true,
  }))).Item as Record<string, unknown>);
}

function identityCondition(kind: 'document' | 'transaction', source: Record<string, unknown>) {
  if (kind === 'document') return {
    ConditionExpression: '#status = :active AND documentType = :invoice AND id = :source AND sha256 = :hash AND objectVersionId = :objectVersion AND verifiedByteSize = :bytes',
    ExpressionAttributeNames: { '#status': 'status' },
    ExpressionAttributeValues: {
      ':active': 'active', ':invoice': 'invoice', ':source': source.id, ':hash': source.sha256,
      ':objectVersion': source.objectVersionId, ':bytes': source.verifiedByteSize,
    },
  };
  return {
    ConditionExpression: 'id = :source AND updatedAt = :updatedAt AND amount = :amount AND currency = :currency',
    ExpressionAttributeValues: {
      ':source': source.id, ':updatedAt': source.updatedAt, ':amount': source.amount, ':currency': source.currency,
    },
  };
}

export function adminCheck(actorId: string) {
  return {
    ConditionCheck: {
      TableName: TABLE_USERS,
      Key: userKey(actorId),
      ConditionExpression: 'attribute_exists(PK) AND #role = :admin AND (attribute_not_exists(disabled) OR disabled = :false)',
      ExpressionAttributeNames: { '#role': 'role' },
      ExpressionAttributeValues: { ':admin': 'admin', ':false': false },
    },
  };
}

export function dealCheck(dealId: string, version: number) {
  return {
    ConditionCheck: {
      TableName: TABLE_SPONSOR_CRM,
      Key: dealKey(dealId),
      ConditionExpression: '#version = :version AND attribute_not_exists(archivedAt) AND active = :true AND #status <> :lost',
      ExpressionAttributeNames: { '#version': 'version', '#status': 'status' },
      ExpressionAttributeValues: { ':version': version, ':true': true, ':lost': 'lost' },
    },
  };
}

const receiptKey = (actorId: string, operation: string, dealId: string, idempotencyKey: string) =>
  `SPONSOR_FINANCE_RECEIPT#${digest({ actorId, operation, dealId, idempotencyKey })}`;

type MutationResult = { financeVersion: number; recordId: string; outcome?: string };
async function existingReceipt(
  client: DynamoDBDocumentClient,
  key: string,
  requestDigest: string,
): Promise<MutationResult | null> {
  const item = (await client.send(new GetCommand({ TableName: TABLE_SPONSOR_CRM, Key: singleton(key), ConsistentRead: true }))).Item;
  if (!item) return null;
  if (item.requestDigest !== requestDigest) throw safeConflict();
  return { financeVersion: Number(item.financeVersion), recordId: String(item.recordId), outcome: 'replayed' };
}

export async function replayMutation(
  client: DynamoDBDocumentClient,
  input: { actorId: string; operation: string; dealId: string; idempotencyKey: string; request: unknown },
): Promise<MutationResult | null> {
  if (!IDEMPOTENCY.test(input.idempotencyKey)) {
    throw Object.assign(new Error('Invalid Idempotency-Key'), { statusCode: 400 });
  }
  return existingReceipt(
    client,
    receiptKey(input.actorId, input.operation, input.dealId, input.idempotencyKey),
    digest(input.request),
  );
}

/** The receipt and history rows every finance mutation commits with its change. */
export function financeMutationTail(input: {
  actorId: string;
  operation: string;
  dealId: string;
  idempotencyKey: string;
  request: unknown;
  financeVersion: number;
  recordId: string;
  eventCode: string;
  sourceId?: string;
  linkId?: string;
  details?: Record<string, unknown>;
}) {
  const at = nowIso();
  const requestDigest = digest(input.request);
  const key = receiptKey(input.actorId, input.operation, input.dealId, input.idempotencyKey);
  const receipt = {
    ...singleton(key),
    id: key.slice('SPONSOR_FINANCE_RECEIPT#'.length),
    recordType: 'sponsor-finance-receipt',
    actorId: input.actorId,
    operation: input.operation,
    dealId: input.dealId,
    requestDigest,
    recordId: input.recordId,
    financeVersion: input.financeVersion,
    createdAt: at,
  };
  const historyId = `${at}#${randomUUID()}`;
  const history = {
    PK: `SPONSOR_FINANCE_HISTORY#${input.dealId}`,
    SK: historyId,
    id: historyId,
    recordType: 'sponsor-finance-history',
    dealId: input.dealId,
    actorId: input.actorId,
    eventCode: input.eventCode,
    financeVersion: input.financeVersion,
    ...(input.sourceId ? { sourceId: input.sourceId } : {}),
    ...(input.linkId ? { linkId: input.linkId } : {}),
    ...(input.details ? { details: input.details } : {}),
    createdAt: at,
  };
  return { key, requestDigest, receipt, history };
}

export async function executeMutation(
  client: DynamoDBDocumentClient,
  input: {
    actorId: string;
    operation: string;
    dealId: string;
    idempotencyKey: string;
    request: unknown;
    financeVersion: number;
    recordId: string;
    transactItems: any[];
    eventCode: string;
    sourceId?: string;
    linkId?: string;
    details?: Record<string, unknown>;
  },
): Promise<MutationResult> {
  if (!IDEMPOTENCY.test(input.idempotencyKey)) throw Object.assign(new Error('Invalid Idempotency-Key'), { statusCode: 400 });
  const prior = await existingReceipt(client, receiptKey(input.actorId, input.operation, input.dealId, input.idempotencyKey), digest(input.request));
  if (prior) return prior;
  const tail = financeMutationTail(input);
  try {
    await client.send(new TransactWriteCommand({
      TransactItems: [
        ...input.transactItems,
        { Put: { TableName: TABLE_SPONSOR_CRM, Item: tail.receipt, ConditionExpression: 'attribute_not_exists(PK)' } },
        {
          Put: {
            TableName: TABLE_SPONSOR_CRM,
            Item: tail.history,
            ConditionExpression: 'attribute_not_exists(PK) AND attribute_not_exists(SK)',
          },
        },
      ],
      ClientRequestToken: digest({ key: tail.key, requestDigest: tail.requestDigest }).slice(0, 36),
    }));
    return { financeVersion: input.financeVersion, recordId: input.recordId };
  } catch (error) {
    const receipt = await existingReceipt(client, tail.key, tail.requestDigest).catch(() => null);
    if (receipt) return receipt;
    const candidate = error as Error & { CancellationReasons?: Array<{ Code?: string }> };
    const reasons = candidate.CancellationReasons || [];
    const provenConditionFailure = candidate.name === 'ConditionalCheckFailedException'
      || (candidate.name === 'TransactionCanceledException'
        && reasons.some((reason) => reason.Code === 'ConditionalCheckFailed')
        && reasons.every((reason) => !reason.Code || reason.Code === 'None' || reason.Code === 'ConditionalCheckFailed'));
    if (provenConditionFailure) throw safeConflict();
    throw Object.assign(new Error('Finance outcome unknown; reload or retry with the same Idempotency-Key'), {
      statusCode: 503,
      outcome: 'outcome_unknown',
    });
  }
}

export function validateClassification(body: Record<string, unknown>) {
  if (!['required', 'not-required'].includes(String(body.invoiceRequirement))) throw Object.assign(new Error('Invalid finance classification'), { statusCode: 400 });
  if (body.invoiceRequirement === 'not-required') return {
    invoiceRequirement: 'not-required' as const,
  };
  scaledMoney(body.amountDue);
  if (!CURRENCY.test(String(body.currency))) throw Object.assign(new Error('Invalid finance classification'), { statusCode: 400 });
  if (!['unknown', 'included', 'added', 'not-applicable'].includes(String(body.taxMode))) throw Object.assign(new Error('Invalid finance classification'), { statusCode: 400 });
  if (body.taxAmount !== undefined && scaledMoney(body.taxAmount, true) > scaledMoney(body.amountDue)) {
    throw Object.assign(new Error('Invalid finance classification'), { statusCode: 400 });
  }
  for (const date of ['requestBy', 'expectedInvoiceBy'] as const) {
    if (body[date] !== undefined && !realDate(body[date])) throw Object.assign(new Error('Invalid finance classification'), { statusCode: 400 });
  }
  if (body.requestBy && body.expectedInvoiceBy && String(body.requestBy) > String(body.expectedInvoiceBy)) {
    throw Object.assign(new Error('Invalid finance chronology'), { statusCode: 400 });
  }
  return {
    invoiceRequirement: 'required' as const,
    amountDue: String(body.amountDue),
    currency: String(body.currency),
    taxMode: String(body.taxMode) as FinanceState['taxMode'],
    ...(body.taxAmount !== undefined ? { taxAmount: String(body.taxAmount) } : {}),
    ...(body.requestBy ? { requestBy: String(body.requestBy) } : {}),
    ...(body.expectedInvoiceBy ? { expectedInvoiceBy: String(body.expectedInvoiceBy) } : {}),
  };
}

export async function classifyFinance(
  client: DynamoDBDocumentClient,
  input: {
    actorId: string; dealId: string; dealVersion: number; expectedVersion?: number;
    idempotencyKey: string; body: Record<string, unknown>;
  },
) {
  const values = validateClassification(input.body);
  const request = { ...values, dealVersion: input.dealVersion, expectedVersion: input.expectedVersion };
  const replay = await replayMutation(client, {
    actorId: input.actorId,
    operation: 'classify',
    dealId: input.dealId,
    idempotencyKey: input.idempotencyKey,
    request,
  });
  if (replay) return replay;
  const existing = await getFinanceState(client, input.dealId);
  if (existing?.voidedAt) throw safeConflict();
  if (existing && (existing.invoiceLinkId || existing.paymentLinkIds.length || existing.recordedPaymentIds.length) && (
    existing.amountDue !== (values as any).amountDue || existing.currency !== (values as any).currency
    || existing.taxMode !== (values as any).taxMode || existing.taxAmount !== (values as any).taxAmount
  )) throw safeConflict();
  if (existing ? input.expectedVersion !== existing.version : Number(input.expectedVersion || 0) !== 0) throw safeConflict();
  const now = nowIso();
  const nextVersion = (existing?.version || 0) + 1;
  const state: FinanceState = {
    id: input.dealId,
    recordType: 'sponsor-finance',
    dealId: input.dealId,
    version: nextVersion,
    ...values,
    ...(existing?.invoiceRequestedAt ? { invoiceRequestedAt: existing.invoiceRequestedAt } : {}),
    ...(existing?.invoiceNumber ? { invoiceNumber: existing.invoiceNumber } : {}),
    ...(existing?.issuedOn ? { issuedOn: existing.issuedOn } : {}),
    ...(existing?.sentOn ? { sentOn: existing.sentOn } : {}),
    ...(existing?.dueOn ? { dueOn: existing.dueOn } : {}),
    ...(existing?.invoiceLinkId ? { invoiceLinkId: existing.invoiceLinkId } : {}),
    ...(existing?.settlementAdjustment ? { settlementAdjustment: existing.settlementAdjustment } : {}),
    paymentLinkIds: existing?.paymentLinkIds || [],
    recordedPaymentIds: existing?.recordedPaymentIds || [],
    paymentFollowUpTaskIds: existing?.paymentFollowUpTaskIds || [],
    ...(existing?.waitingOn ? { waitingOn: existing.waitingOn } : {}),
    ...(existing?.evidence ? { evidence: existing.evidence } : {}),
    actorId: input.actorId,
    createdAt: existing?.createdAt || now,
    updatedAt: now,
  };
  return executeMutation(client, {
    actorId: input.actorId, operation: 'classify', dealId: input.dealId,
    idempotencyKey: input.idempotencyKey, request,
    financeVersion: nextVersion, recordId: state.id, eventCode: existing ? 'classification-updated' : 'classification-created',
    transactItems: [
      adminCheck(input.actorId),
      dealCheck(input.dealId, input.dealVersion),
      {
        Put: {
          TableName: TABLE_SPONSOR_CRM,
          Item: { ...singleton(financeKey(input.dealId)), ...state },
          ConditionExpression: existing ? '#version = :version AND attribute_not_exists(voidedAt)' : 'attribute_not_exists(PK)',
          ...(existing ? {
            ExpressionAttributeNames: { '#version': 'version' },
            ExpressionAttributeValues: { ':version': existing.version },
          } : {}),
        },
      },
    ],
  });
}

/** Correct a proposal imported as debt. Issued/requested invoices and receipts are never cleared. */
export async function clearProposalClassification(
  client: DynamoDBDocumentClient,
  input: { actorId: string; dealId: string; dealVersion: number; expectedVersion: number; idempotencyKey: string; reason: unknown; evidence: unknown },
) {
  const reason = input.reason;
  const evidence = validateEvidence(input.evidence);
  if (!boundedText(reason, 2000) || !evidence.length) throw Object.assign(new Error('A correction reason and source evidence are required'), { statusCode: 400 });
  const request = { reason, evidence };
  const operation = 'clear-proposal-classification';
  const replay = await replayMutation(client, { ...input, operation, request });
  if (replay) return replay;
  const state = await getFinanceState(client, input.dealId);
  if (!state || state.version !== input.expectedVersion || state.issuedOn || state.sentOn || state.invoiceNumber
    || state.invoiceRequestedAt || state.invoiceLinkId || state.paymentLinkIds.length || state.recordedPaymentIds.length
    || state.settlementAdjustment || state.voidedAt) throw safeConflict();
  return executeMutation(client, {
    ...input, operation, request, financeVersion: state.version + 1, recordId: state.id,
    eventCode: 'proposal-classification-cleared', details: { reason, evidence, previousClassification: state },
    transactItems: [
      adminCheck(input.actorId),
      { Update: {
        TableName: TABLE_SPONSOR_CRM, Key: dealKey(input.dealId),
        UpdateExpression: 'SET #version = #version + :one, updatedAt = :now',
        ConditionExpression: '#version = :version AND #status = :open AND active = :true AND attribute_not_exists(archivedAt)',
        ExpressionAttributeNames: { '#version': 'version', '#status': 'status' },
        ExpressionAttributeValues: { ':version': input.dealVersion, ':one': 1, ':now': nowIso(), ':open': 'open', ':true': true },
      } },
      { Delete: {
        TableName: TABLE_SPONSOR_CRM, Key: singleton(financeKey(input.dealId)),
        ConditionExpression: '#version = :version',
        ExpressionAttributeNames: { '#version': 'version' }, ExpressionAttributeValues: { ':version': state.version },
      } },
    ],
  });
}

export async function recordInvoiceRequest(
  client: DynamoDBDocumentClient,
  input: { actorId: string; dealId: string; dealVersion: number; expectedVersion: number; idempotencyKey: string },
) {
  const request = { dealVersion: input.dealVersion, expectedVersion: input.expectedVersion };
  const replay = await replayMutation(client, {
    actorId: input.actorId,
    operation: 'request-invoice',
    dealId: input.dealId,
    idempotencyKey: input.idempotencyKey,
    request,
  });
  if (replay) return replay;
  const state = await getFinanceState(client, input.dealId);
  if (!state || state.version !== input.expectedVersion || state.invoiceRequirement !== 'required' || state.voidedAt) throw safeConflict();
  const now = nowIso();
  return executeMutation(client, {
    actorId: input.actorId, operation: 'request-invoice', dealId: input.dealId,
    idempotencyKey: input.idempotencyKey, request,
    financeVersion: state.version + 1, recordId: state.id, eventCode: 'invoice-requested',
    transactItems: [
      adminCheck(input.actorId), dealCheck(input.dealId, input.dealVersion),
      {
        Update: {
          TableName: TABLE_SPONSOR_CRM, Key: singleton(financeKey(input.dealId)),
          UpdateExpression: 'SET invoiceRequestedAt = :now, updatedAt = :now, actorId = :actor, #version = #version + :one',
          ConditionExpression: '#version = :version AND invoiceRequirement = :required AND attribute_not_exists(voidedAt) AND attribute_not_exists(invoiceRequestedAt)',
          ExpressionAttributeNames: { '#version': 'version' },
          ExpressionAttributeValues: { ':now': now, ':actor': input.actorId, ':one': 1, ':version': state.version, ':required': 'required' },
        },
      },
    ],
  });
}

async function sourceItem(client: DynamoDBDocumentClient, kind: 'document' | 'transaction', sourceId: string) {
  return (await client.send(new GetCommand({
    TableName: TABLE_BOOKKEEPING,
    Key: singleton(sourceKey(kind, sourceId)),
    ConsistentRead: true,
  }))).Item as Record<string, unknown> | undefined;
}

export async function linkInvoice(
  client: DynamoDBDocumentClient,
  input: {
    actorId: string; dealId: string; dealVersion: number; expectedVersion: number;
    sourceId: string; identityToken: string; issuedOn?: string; dueOn?: string; idempotencyKey: string;
  },
) {
  const dated = input.issuedOn !== undefined || input.dueOn !== undefined;
  if (
    !OPAQUE.test(input.sourceId)
    || (dated && (!realDate(input.issuedOn) || !realDate(input.dueOn) || input.dueOn! < input.issuedOn!))
  ) {
    throw Object.assign(new Error('Invalid invoice link'), { statusCode: 400 });
  }
  const request = {
    dealVersion: input.dealVersion,
    expectedVersion: input.expectedVersion,
    sourceId: input.sourceId,
    identityToken: input.identityToken,
    issuedOn: input.issuedOn,
    dueOn: input.dueOn,
  };
  const replay = await replayMutation(client, {
    actorId: input.actorId,
    operation: 'link-invoice',
    dealId: input.dealId,
    idempotencyKey: input.idempotencyKey,
    request,
  });
  if (replay) return replay;
  const [state, source] = await Promise.all([getFinanceState(client, input.dealId), sourceItem(client, 'document', input.sourceId)]);
  if (
    !state || state.version !== input.expectedVersion || state.invoiceRequirement !== 'required' || state.invoiceLinkId
    || state.voidedAt || !source || invoiceIdentity(source) !== input.identityToken
    || (!dated && !state.issuedOn)
  ) throw safeConflict();
  const id = linkKey(input.dealId, 'document', input.sourceId);
  const nextVersion = state.version + 1;
  const now = nowIso();
  const link: FinanceLink = {
    id, recordType: 'sponsor-finance-link', dealId: input.dealId, kind: 'document',
    sourceId: input.sourceId, identityToken: input.identityToken, actorId: input.actorId,
    financeVersion: nextVersion, createdAt: now,
  };
  const dates = dated ? ', issuedOn = :issued, dueOn = :due' : '';
  return executeMutation(client, {
    actorId: input.actorId, operation: 'link-invoice', dealId: input.dealId, idempotencyKey: input.idempotencyKey,
    request,
    financeVersion: nextVersion, recordId: id, linkId: id, sourceId: input.sourceId, eventCode: 'invoice-linked',
    transactItems: [
      adminCheck(input.actorId), dealCheck(input.dealId, input.dealVersion),
      {
        ConditionCheck: {
          TableName: TABLE_BOOKKEEPING, Key: singleton(sourceKey('document', input.sourceId)),
          ...identityCondition('document', source),
        },
      },
      {
        Put: {
          TableName: TABLE_BOOKKEEPING,
          Item: {
            ...singleton(claimKey('document', input.sourceId)), recordType: 'sponsor-finance-claim',
            kind: 'document', sourceId: input.sourceId, dealId: input.dealId, linkId: id,
            identityToken: input.identityToken, actorId: input.actorId, createdAt: now,
          },
          ConditionExpression: 'attribute_not_exists(PK)',
        },
      },
      { Put: { TableName: TABLE_SPONSOR_CRM, Item: { ...singleton(id), ...link }, ConditionExpression: 'attribute_not_exists(PK)' } },
      {
        Update: {
          TableName: TABLE_SPONSOR_CRM, Key: singleton(financeKey(input.dealId)),
          UpdateExpression: `SET invoiceLinkId = :link${dates}, updatedAt = :now, actorId = :actor, #version = #version + :one`,
          ConditionExpression: '#version = :version AND attribute_not_exists(invoiceLinkId) AND attribute_not_exists(voidedAt)',
          ExpressionAttributeNames: { '#version': 'version' },
          ExpressionAttributeValues: {
            ':link': id, ':now': now, ':actor': input.actorId, ':one': 1, ':version': state.version,
            ...(dated ? { ':issued': input.issuedOn, ':due': input.dueOn } : {}),
          },
        },
      },
    ],
  });
}

function validateIssue(input: { invoiceNumber?: unknown; issuedOn: unknown; dueOn: unknown; sentOn?: unknown }) {
  if (
    (input.invoiceNumber !== undefined && (typeof input.invoiceNumber !== 'string' || !INVOICE_NUMBER.test(input.invoiceNumber)))
    || !realDate(input.issuedOn) || !realDate(input.dueOn) || String(input.dueOn) < String(input.issuedOn)
    || (input.sentOn !== undefined && (!realDate(input.sentOn) || String(input.sentOn) < String(input.issuedOn)))
  ) throw Object.assign(new Error('Invalid invoice issue'), { statusCode: 400 });
}

/**
 * Record that an invoice exists: its number (when known; sponsor AP portals
 * sometimes assign none we see) and issue, sent and due dates.
 * Re-issuing (a corrected invoice) replaces the details. The PDF is linked
 * separately once it reaches bookkeeping.
 */
export async function issueInvoice(
  client: DynamoDBDocumentClient,
  input: {
    actorId: string; dealId: string; dealVersion: number; expectedVersion: number; idempotencyKey: string;
    invoiceNumber?: string; issuedOn: string; dueOn: string; sentOn?: string;
  },
) {
  validateIssue(input);
  const request = {
    dealVersion: input.dealVersion, expectedVersion: input.expectedVersion,
    invoiceNumber: input.invoiceNumber, issuedOn: input.issuedOn, dueOn: input.dueOn, sentOn: input.sentOn,
  };
  const replay = await replayMutation(client, {
    actorId: input.actorId, operation: 'issue-invoice', dealId: input.dealId, idempotencyKey: input.idempotencyKey, request,
  });
  if (replay) return replay;
  const state = await getFinanceState(client, input.dealId);
  if (!state || state.version !== input.expectedVersion || state.invoiceRequirement !== 'required' || state.voidedAt) throw safeConflict();
  const now = nowIso();
  return executeMutation(client, {
    actorId: input.actorId, operation: 'issue-invoice', dealId: input.dealId, idempotencyKey: input.idempotencyKey, request,
    financeVersion: state.version + 1, recordId: state.id, eventCode: state.issuedOn ? 'invoice-reissued' : 'invoice-issued',
    transactItems: [
      adminCheck(input.actorId), dealCheck(input.dealId, input.dealVersion),
      {
        Update: {
          TableName: TABLE_SPONSOR_CRM, Key: singleton(financeKey(input.dealId)),
          UpdateExpression: `SET ${input.invoiceNumber ? 'invoiceNumber = :number, ' : ''}issuedOn = :issued, dueOn = :due, ${input.sentOn ? 'sentOn = :sent, ' : ''}updatedAt = :now, actorId = :actor, #version = #version + :one${[
            ...(input.invoiceNumber ? [] : ['invoiceNumber']), ...(input.sentOn ? [] : ['sentOn']),
          ].map((name, index) => `${index ? ',' : ' REMOVE'} ${name}`).join('')}`,
          ConditionExpression: '#version = :version AND invoiceRequirement = :required AND attribute_not_exists(voidedAt)',
          ExpressionAttributeNames: { '#version': 'version' },
          ExpressionAttributeValues: {
            ...(input.invoiceNumber ? { ':number': input.invoiceNumber } : {}), ':issued': input.issuedOn, ':due': input.dueOn,
            ...(input.sentOn ? { ':sent': input.sentOn } : {}),
            ':now': now, ':actor': input.actorId, ':one': 1, ':version': state.version, ':required': 'required',
          },
        },
      },
    ],
  });
}

function paidTotal(projection: FinanceProjection): bigint {
  return projection.payments.filter((item) => item.source === 'ledger').reduce((sum, item) => sum + scaledMoney(item.amount), 0n);
}

function settledTotal(projection: FinanceProjection): bigint {
  return paidTotal(projection) + (projection.finance?.settlementAdjustment ? scaledMoney(projection.finance.settlementAdjustment.amount) : 0n);
}

/** An explicit owner-approved reduction settles receivable, never cash income. */
export async function recordSettlementAdjustment(
  client: DynamoDBDocumentClient,
  input: { actorId: string; dealId: string; dealVersion: number; expectedVersion: number; idempotencyKey: string; body: Record<string, unknown> },
) {
  const body = input.body;
  const request = { amount: body.amount, currency: body.currency, reason: body.reason, evidence: body.evidence,
    approvedBy: body.approvedBy, approvedOn: body.approvedOn, replacesPaymentId: body.replacesPaymentId,
    restoredInvoiceAmountDue: body.restoredInvoiceAmountDue, originalInvoiceDocumentId: body.originalInvoiceDocumentId };
  const replay = await replayMutation(client, { actorId: input.actorId, operation: 'settlement-adjustment', dealId: input.dealId,
    idempotencyKey: input.idempotencyKey, request });
  if (replay) return replay;
  const projection = await projectFinance(client, input.dealId, 'admin');
  const state = await getFinanceState(client, input.dealId);
  if (!state || state.version !== input.expectedVersion || state.voidedAt || !state.issuedOn || state.settlementAdjustment
    || projection.reconciliationStatus !== 'coherent' || paidTotal(projection) <= 0n || !state.currency || !state.amountDue) throw safeConflict();
  let nominal = scaledMoney(state.amountDue);
  let nominalRestoration: Record<string, unknown> | undefined;
  if (body.restoredInvoiceAmountDue !== undefined) {
    try { nominal = scaledMoney(body.restoredInvoiceAmountDue); }
    catch { throw Object.assign(new Error('Invalid original invoice total'), { statusCode: 400 }); }
    if (typeof body.originalInvoiceDocumentId !== 'string' || projection.invoice?.id !== body.originalInvoiceDocumentId) {
      throw Object.assign(new Error('Attach and review the exact original invoice before restoring its nominal total'), { statusCode: 422 });
    }
    const original = await sourceItem(client, 'document', body.originalInvoiceDocumentId);
    if (!original) throw safeConflict();
    nominalRestoration = { before: state.amountDue, after: displayMoney(nominal), documentId: body.originalInvoiceDocumentId,
      identityToken: invoiceIdentity(original) };
  } else if (body.originalInvoiceDocumentId !== undefined) {
    throw Object.assign(new Error('Original invoice reference requires an explicit restored total'), { statusCode: 400 });
  }
  const adjustmentInput = validateSettlementAdjustment(body, { currency: state.currency,
    outstanding: nominal - paidTotal(projection), today: berlinDate(), validateEvidence });
  const replaced = body.replacesPaymentId === undefined ? undefined
    : projection.payments.find((payment) => payment.source === 'recorded' && payment.id === body.replacesPaymentId);
  if (body.replacesPaymentId !== undefined && (!replaced || scaledMoney(replaced.amount) !== scaledMoney(adjustmentInput.amount)
    || replaced.currency !== adjustmentInput.currency)) {
    throw Object.assign(new Error('Select the exact reviewed reported entry with the approved adjustment amount and currency'), { statusCode: 400 });
  }
  const now = nowIso();
  const adjustment = { ...adjustmentInput, id: digest({ dealId: input.dealId, idempotencyKey: input.idempotencyKey }).slice(0, 32),
    actorId: input.actorId, createdAt: now };
  const replacedKey = replaced ? recordedPaymentKey(input.dealId, replaced.id) : undefined;
  return executeMutation(client, { actorId: input.actorId, operation: 'settlement-adjustment', dealId: input.dealId,
    idempotencyKey: input.idempotencyKey, request, financeVersion: state.version + 1, recordId: adjustment.id,
    eventCode: 'noncash-settlement-approved', details: { adjustment, ...(replaced ? { replacedReportedPayment: replaced } : {}),
      ...(nominalRestoration ? { nominalRestoration } : {}) },
    transactItems: [adminCheck(input.actorId), dealCheck(input.dealId, input.dealVersion),
      ...(nominalRestoration ? await invoiceEvidenceActions(client, state, [], now) : []),
      ...(replacedKey ? [{ Delete: { TableName: TABLE_SPONSOR_CRM, Key: singleton(replacedKey),
        ConditionExpression: 'dealId = :deal AND amount = :amount AND currency = :currency',
        ExpressionAttributeValues: { ':deal': input.dealId, ':amount': replaced!.amount, ':currency': replaced!.currency } } }] : []),
      { Update: { TableName: TABLE_SPONSOR_CRM, Key: singleton(financeKey(input.dealId)),
        UpdateExpression: 'SET settlementAdjustment = :adjustment, amountDue = :nominal, recordedPaymentIds = :records, #version = :next, updatedAt = :now, actorId = :actor',
        ConditionExpression: '#version = :prior AND attribute_not_exists(settlementAdjustment) AND attribute_not_exists(voidedAt) AND recordedPaymentIds = :priorRecords',
        ExpressionAttributeNames: { '#version': 'version' }, ExpressionAttributeValues: {
          ':adjustment': adjustment, ':nominal': displayMoney(nominal), ':records': state.recordedPaymentIds.filter((id) => id !== replacedKey), ':priorRecords': state.recordedPaymentIds,
          ':next': state.version + 1, ':prior': state.version, ':now': now, ':actor': input.actorId,
        } } },
    ],
  });
}

export async function removeSettlementAdjustment(
  client: DynamoDBDocumentClient,
  input: { actorId: string; dealId: string; dealVersion: number; expectedVersion: number; idempotencyKey: string; reason: string },
) {
  if (!boundedText(input.reason, 1000)) throw Object.assign(new Error('An adjustment reversal reason is required'), { statusCode: 400 });
  const request = { reason: input.reason };
  const replay = await replayMutation(client, { actorId: input.actorId, operation: 'remove-settlement-adjustment', dealId: input.dealId,
    idempotencyKey: input.idempotencyKey, request });
  if (replay) return replay;
  const state = await getFinanceState(client, input.dealId);
  if (!state || state.version !== input.expectedVersion || !state.settlementAdjustment || state.voidedAt) throw safeConflict();
  return executeMutation(client, { actorId: input.actorId, operation: 'remove-settlement-adjustment', dealId: input.dealId,
    idempotencyKey: input.idempotencyKey, request, financeVersion: state.version + 1, recordId: state.settlementAdjustment.id,
    eventCode: 'noncash-settlement-reversed', details: { adjustment: state.settlementAdjustment, reason: input.reason },
    transactItems: [adminCheck(input.actorId), dealCheck(input.dealId, input.dealVersion),
      { Update: { TableName: TABLE_SPONSOR_CRM, Key: singleton(financeKey(input.dealId)),
        UpdateExpression: 'SET #version = :next, updatedAt = :now, actorId = :actor REMOVE settlementAdjustment',
        ConditionExpression: '#version = :prior AND settlementAdjustment.id = :id', ExpressionAttributeNames: { '#version': 'version' },
        ExpressionAttributeValues: { ':next': state.version + 1, ':prior': state.version, ':now': nowIso(), ':actor': input.actorId, ':id': state.settlementAdjustment.id } } },
    ],
  });
}

export async function recordPayment(
  client: DynamoDBDocumentClient,
  input: {
    actorId: string; dealId: string; dealVersion: number; expectedVersion: number; idempotencyKey: string;
    receivedOn: string; amount: string; currency: string; method: string; reference?: string;
  },
) {
  try { scaledMoney(input.amount); } catch { throw Object.assign(new Error('Invalid payment'), { statusCode: 400 }); }
  if (
    !realDate(input.receivedOn) || !CURRENCY.test(input.currency)
    || !(RECORDED_PAYMENT_METHODS as readonly string[]).includes(input.method)
    || (input.reference !== undefined && !boundedText(input.reference, 200))
  ) throw Object.assign(new Error('Invalid payment'), { statusCode: 400 });
  const request = {
    dealVersion: input.dealVersion, expectedVersion: input.expectedVersion, receivedOn: input.receivedOn,
    amount: input.amount, currency: input.currency, method: input.method, reference: input.reference,
  };
  const replay = await replayMutation(client, {
    actorId: input.actorId, operation: 'record-payment', dealId: input.dealId, idempotencyKey: input.idempotencyKey, request,
  });
  if (replay) return replay;
  const projection = await projectFinance(client, input.dealId, 'admin');
  const state = await getFinanceState(client, input.dealId);
  if (
    !state || state.version !== input.expectedVersion || state.voidedAt || state.invoiceRequirement !== 'required'
    || !state.issuedOn || state.currency !== input.currency || projection.reconciliationStatus !== 'coherent'
    || state.paymentLinkIds.length + state.recordedPaymentIds.length >= PAYMENT_LINK_LIMIT
    || projection.payments.reduce((sum, item) => sum + scaledMoney(item.amount), 0n) + (state.settlementAdjustment ? scaledMoney(state.settlementAdjustment.amount) : 0n) + scaledMoney(input.amount) > scaledMoney(state.amountDue)
  ) throw safeConflict();
  const paymentId = digest({ dealId: input.dealId, actorId: input.actorId, idempotencyKey: input.idempotencyKey }).slice(0, 32);
  const id = recordedPaymentKey(input.dealId, paymentId);
  const nextVersion = state.version + 1;
  const now = nowIso();
  const record: RecordedPayment = {
    id, recordType: 'sponsor-finance-payment', dealId: input.dealId, paymentId,
    receivedOn: input.receivedOn, amount: input.amount, currency: input.currency,
    method: input.method as RecordedPayment['method'],
    ...(input.reference ? { reference: input.reference } : {}),
    actorId: input.actorId, financeVersion: nextVersion, createdAt: now,
  };
  const nextIds = [...state.recordedPaymentIds, id].sort();
  return executeMutation(client, {
    actorId: input.actorId, operation: 'record-payment', dealId: input.dealId, idempotencyKey: input.idempotencyKey, request,
    financeVersion: nextVersion, recordId: id, eventCode: 'payment-recorded',
    transactItems: [
      adminCheck(input.actorId), dealCheck(input.dealId, input.dealVersion),
      { Put: { TableName: TABLE_SPONSOR_CRM, Item: { ...singleton(id), ...record }, ConditionExpression: 'attribute_not_exists(PK)' } },
      {
        Update: {
          TableName: TABLE_SPONSOR_CRM, Key: singleton(financeKey(input.dealId)),
          UpdateExpression: 'SET recordedPaymentIds = :next, updatedAt = :now, actorId = :actor, #version = #version + :one',
          ConditionExpression: '#version = :version AND recordedPaymentIds = :prior AND attribute_not_exists(voidedAt)',
          ExpressionAttributeNames: { '#version': 'version' },
          ExpressionAttributeValues: {
            ':next': nextIds, ':prior': state.recordedPaymentIds, ':now': now, ':actor': input.actorId,
            ':one': 1, ':version': state.version,
          },
        },
      },
    ],
  });
}

export async function deleteRecordedPayment(
  client: DynamoDBDocumentClient,
  input: { actorId: string; dealId: string; dealVersion: number; expectedVersion: number; idempotencyKey: string; paymentId: string },
) {
  if (!/^[a-f0-9]{32}$/.test(input.paymentId)) throw Object.assign(new Error('Invalid payment'), { statusCode: 400 });
  const id = recordedPaymentKey(input.dealId, input.paymentId);
  const request = { dealVersion: input.dealVersion, expectedVersion: input.expectedVersion, paymentId: input.paymentId };
  const replay = await replayMutation(client, {
    actorId: input.actorId, operation: 'delete-payment', dealId: input.dealId, idempotencyKey: input.idempotencyKey, request,
  });
  if (replay) return replay;
  const state = await getFinanceState(client, input.dealId);
  if (!state || state.version !== input.expectedVersion || !state.recordedPaymentIds.includes(id)) throw safeConflict();
  const now = nowIso();
  return executeMutation(client, {
    actorId: input.actorId, operation: 'delete-payment', dealId: input.dealId, idempotencyKey: input.idempotencyKey, request,
    financeVersion: state.version + 1, recordId: id, eventCode: 'payment-record-deleted',
    transactItems: [
      adminCheck(input.actorId), dealCheck(input.dealId, input.dealVersion),
      {
        Delete: {
          TableName: TABLE_SPONSOR_CRM, Key: singleton(id),
          ConditionExpression: 'dealId = :deal', ExpressionAttributeValues: { ':deal': input.dealId },
        },
      },
      {
        Update: {
          TableName: TABLE_SPONSOR_CRM, Key: singleton(financeKey(input.dealId)),
          UpdateExpression: 'SET recordedPaymentIds = :next, updatedAt = :now, actorId = :actor, #version = #version + :one',
          ConditionExpression: '#version = :version AND recordedPaymentIds = :prior',
          ExpressionAttributeNames: { '#version': 'version' },
          ExpressionAttributeValues: {
            ':next': state.recordedPaymentIds.filter((item) => item !== id), ':prior': state.recordedPaymentIds,
            ':now': now, ':actor': input.actorId, ':one': 1, ':version': state.version,
          },
        },
      },
    ],
  });
}

export function validateWaitingOn(value: unknown): WaitingOn | null {
  if (value === null) return null;
  const record = value as Record<string, unknown>;
  if (
    !record || typeof record !== 'object' || Array.isArray(record)
    || !(WAITING_PARTIES as readonly string[]).includes(String(record.party))
    || !(WAITING_REASONS as readonly string[]).includes(String(record.reason))
    || !realDate(record.since)
    || (record.note !== undefined && !boundedText(record.note, 300))
  ) throw Object.assign(new Error('Invalid waitingOn'), { statusCode: 400 });
  return {
    party: record.party as WaitingOn['party'],
    reason: record.reason as WaitingOn['reason'],
    since: String(record.since),
    ...(record.note !== undefined ? { note: String(record.note) } : {}),
  };
}

export function validateEvidence(value: unknown): FinanceEvidence[] {
  if (!Array.isArray(value) || value.length > MAX_EVIDENCE) throw Object.assign(new Error('Invalid evidence'), { statusCode: 400 });
  return value.map((item) => {
    const record = item as Record<string, unknown>;
    if (
      !record || typeof record !== 'object' || Array.isArray(record)
      || !(EVIDENCE_KINDS as readonly string[]).includes(String(record.kind))
      || !boundedText(record.ref, 300)
      || (record.kind === 'url' && !/^https:\/\/[^\s]+$/.test(String(record.ref)))
      || (record.label !== undefined && !boundedText(record.label, 160))
      || (record.on !== undefined && !realDate(record.on))
    ) throw Object.assign(new Error('Invalid evidence'), { statusCode: 400 });
    return {
      kind: record.kind as FinanceEvidence['kind'],
      ref: String(record.ref),
      ...(record.label !== undefined ? { label: String(record.label) } : {}),
      ...(record.on !== undefined ? { on: String(record.on) } : {}),
    };
  });
}

/** Who the money is waiting on, and where the evidence lives. Omitted fields stay unchanged. */
export async function updateFollowThrough(
  client: DynamoDBDocumentClient,
  input: {
    actorId: string; dealId: string; dealVersion: number; expectedVersion: number; idempotencyKey: string;
    body: Record<string, unknown>;
  },
) {
  const hasWaiting = input.body.waitingOn !== undefined;
  const hasEvidence = input.body.evidence !== undefined;
  if (!hasWaiting && !hasEvidence) throw Object.assign(new Error('Nothing to update'), { statusCode: 400 });
  const waitingOn = hasWaiting ? validateWaitingOn(input.body.waitingOn) : undefined;
  const evidence = hasEvidence ? validateEvidence(input.body.evidence) : undefined;
  const request = { dealVersion: input.dealVersion, expectedVersion: input.expectedVersion, waitingOn, evidence };
  const replay = await replayMutation(client, {
    actorId: input.actorId, operation: 'follow-through', dealId: input.dealId, idempotencyKey: input.idempotencyKey, request,
  });
  if (replay) return replay;
  const state = await getFinanceState(client, input.dealId);
  if (!state || state.version !== input.expectedVersion || state.voidedAt) throw safeConflict();
  const now = nowIso();
  const sets = ['updatedAt = :now', 'actorId = :actor', '#version = #version + :one'];
  const removes: string[] = [];
  const values: Record<string, unknown> = { ':now': now, ':actor': input.actorId, ':one': 1, ':version': state.version };
  if (hasWaiting) {
    if (waitingOn) { sets.push('waitingOn = :waiting'); values[':waiting'] = waitingOn; } else removes.push('waitingOn');
  }
  if (hasEvidence) {
    if (evidence!.length) { sets.push('evidence = :evidence'); values[':evidence'] = evidence; } else removes.push('evidence');
  }
  return executeMutation(client, {
    actorId: input.actorId, operation: 'follow-through', dealId: input.dealId, idempotencyKey: input.idempotencyKey, request,
    financeVersion: state.version + 1, recordId: state.id, eventCode: 'follow-through-updated',
    transactItems: [
      adminCheck(input.actorId), dealCheck(input.dealId, input.dealVersion),
      {
        Update: {
          TableName: TABLE_SPONSOR_CRM, Key: singleton(financeKey(input.dealId)),
          UpdateExpression: `SET ${sets.join(', ')}${removes.length ? ` REMOVE ${removes.join(', ')}` : ''}`,
          ConditionExpression: '#version = :version AND attribute_not_exists(voidedAt)',
          ExpressionAttributeNames: { '#version': 'version' },
          ExpressionAttributeValues: values,
        },
      },
    ],
  });
}

/** Verified cash creates its canonical ledger row and finance claim in one transaction.
 * The statement reference is a global receipt identity: retries or a second deal
 * cannot book the same receipt twice. Existing ledger receipts must be linked.
 */
export async function receivePayment(
  client: DynamoDBDocumentClient,
  input: {
    actorId: string; dealId: string; dealVersion: number; expectedVersion: number; idempotencyKey: string;
    receivedOn: string; amount: string; currency: string; reference: string; counterparty: string; amountEur?: string; category?: string;
    replacesPaymentId?: string;
  },
) {
  try { scaledMoney(input.amount); if (input.amountEur !== undefined) scaledMoney(input.amountEur, true); } catch { throw Object.assign(new Error('Invalid received amount'), { statusCode: 400 }); }
  if (!realDate(input.receivedOn) || !CURRENCY.test(input.currency)
    || !boundedText(input.reference, 200) || !boundedText(input.counterparty, 300)
    || (input.category !== undefined && input.category !== '' && !boundedText(input.category, 300))) {
    throw Object.assign(new Error('Receipt date, amount, currency, counterparty and statement reference are required'), { statusCode: 400 });
  }
  // Version tokens guard a new write; they do not change the meaning of a
  // receipt retry after the CLI has re-read the newly committed version.
  const { idempotencyKey: _key, dealVersion: _dealVersion, expectedVersion: _expectedVersion, ...request } = input;
  const replay = await replayMutation(client, {
    actorId: input.actorId, operation: 'receive-payment', dealId: input.dealId, idempotencyKey: input.idempotencyKey, request,
  });
  if (replay) return replay;
  // Do not derive this identity from the deal or idempotency key: two independent
  // requests for the same bank/processor receipt must collide globally.
  const duplicates = await boundedBookkeepingScan(client, 'begins_with(PK, :prefix) AND (statementRef = :reference OR sourceKey = :reference)',
    { ':prefix': 'BOOKKEEPING#', ':reference': input.reference.trim() });
  if (!duplicates.complete) throw Object.assign(new Error('Receipt duplicate review is incomplete; retry'), { statusCode: 503 });
  if (duplicates.items.length) throw Object.assign(new Error(`Receipt already exists in bookkeeping; link transaction ${duplicates.items[0].id}`), { statusCode: 422 });
  const id = `receipt-${digest({ reference: input.reference.trim() }).slice(0, 40)}`;
  const now = nowIso();
  const source = {
    id, transactionDate: input.receivedOn, paidDate: input.receivedOn,
    amount: input.amount, currency: input.currency, counterparty: input.counterparty.trim(),
    description: `Sponsor payment for deal ${input.dealId}`, statementRef: input.reference.trim(),
    entryType: 'income', category: input.category || '', sourceType: 'sponsor-receipt', sourceKey: input.reference.trim(),
    ...(input.amountEur !== undefined ? { amountEur: input.amountEur } : {}),
    createdAt: now, updatedAt: now,
  };
  return linkPayment(client, {
    actorId: input.actorId, dealId: input.dealId, dealVersion: input.dealVersion,
    expectedVersion: input.expectedVersion, idempotencyKey: input.idempotencyKey,
    sourceId: id, identityToken: paymentIdentity(source), replacesPaymentId: input.replacesPaymentId,
  }, { source, request });
}

/** Correct the cash ledger without changing the invoice's nominal total. */
export async function correctReceipt(
  client: DynamoDBDocumentClient,
  input: {
    actorId: string; dealId: string; dealVersion: number; expectedVersion: number; idempotencyKey: string;
    sourceId: string; receivedOn: string; amount: string; currency: string; reference: string; amountEur?: string; category?: string;
  },
) {
  try { scaledMoney(input.amount); if (input.amountEur !== undefined) scaledMoney(input.amountEur, true); }
  catch { throw Object.assign(new Error('Invalid received amount'), { statusCode: 400 }); }
  if (!OPAQUE.test(input.sourceId) || !realDate(input.receivedOn) || !CURRENCY.test(input.currency)
    || !boundedText(input.reference, 200) || (input.category !== undefined && input.category !== '' && !boundedText(input.category, 300))) throw Object.assign(new Error('Receipt date, amount, currency and evidence reference are required'), { statusCode: 400 });
  const { idempotencyKey: _key, dealVersion: _dealVersion, expectedVersion: _expectedVersion, ...request } = input;
  const replay = await replayMutation(client, {
    actorId: input.actorId, operation: 'correct-receipt', dealId: input.dealId, idempotencyKey: input.idempotencyKey, request,
  });
  if (replay) return replay;
  const projection = await projectFinance(client, input.dealId, 'admin');
  const state = await getFinanceState(client, input.dealId);
  const source = await sourceItem(client, 'transaction', input.sourceId);
  const id = linkKey(input.dealId, 'transaction', input.sourceId);
  if (!state || state.version !== input.expectedVersion || state.voidedAt || !source
    || !state.paymentLinkIds.includes(id) || input.currency !== state.currency
    || projection.reconciliationStatus !== 'coherent'
    || settledTotal(projection) - scaledMoney(source.amount) + scaledMoney(input.amount) > scaledMoney(state.amountDue)) throw safeConflict();
  if (source.sourceType === 'sponsor-receipt' && input.reference.trim() !== source.statementRef) {
    throw Object.assign(new Error('The bank/account transaction identity is immutable; correct the amount or date using its original reference'), { statusCode: 400 });
  }
  const priorIdentity = paymentIdentity(source), now = nowIso();
  const updated = { ...source, amount: input.amount, currency: input.currency, paidDate: input.receivedOn, transactionDate: input.receivedOn,
    ...(input.category !== undefined ? { category: input.category } : {}),
    statementRef: input.reference.trim(), ...(input.amountEur !== undefined ? { amountEur: input.amountEur } : {}), updatedAt: now };
  if (input.amountEur === undefined && (source.amount !== input.amount || source.currency !== input.currency)) {
    if (input.currency === 'EUR') updated.amountEur = input.amount;
    else delete updated.amountEur;
  }
  const identity = paymentIdentity(updated);
  return executeMutation(client, {
    actorId: input.actorId, operation: 'correct-receipt', dealId: input.dealId, idempotencyKey: input.idempotencyKey,
    request, financeVersion: state.version + 1, recordId: id, sourceId: input.sourceId, linkId: id, eventCode: 'receipt-corrected',
    details: { before: { amount: source.amount, currency: source.currency, receivedOn: source.paidDate || source.transactionDate, amountEur: source.amountEur || null }, after: { amount: input.amount, currency: input.currency, receivedOn: input.receivedOn, amountEur: updated.amountEur || null }, reference: input.reference },
    transactItems: [adminCheck(input.actorId), dealCheck(input.dealId, input.dealVersion),
      { Put: { TableName: TABLE_BOOKKEEPING, Item: { ...singleton(sourceKey('transaction', input.sourceId)), ...updated },
        ...identityCondition('transaction', source) } },
      { Update: { TableName: TABLE_BOOKKEEPING, Key: singleton(claimKey('transaction', input.sourceId)),
        UpdateExpression: 'SET identityToken = :next',
        ConditionExpression: 'dealId = :deal AND linkId = :link AND identityToken = :prior',
        ExpressionAttributeValues: { ':next': identity, ':deal': input.dealId, ':link': id, ':prior': priorIdentity } } },
      { Update: { TableName: TABLE_SPONSOR_CRM, Key: singleton(id),
        UpdateExpression: 'SET identityToken = :next, financeVersion = :version',
        ConditionExpression: 'identityToken = :prior AND sourceId = :source',
        ExpressionAttributeValues: { ':next': identity, ':version': state.version + 1, ':prior': priorIdentity, ':source': input.sourceId } } },
      { Update: { TableName: TABLE_SPONSOR_CRM, Key: singleton(financeKey(input.dealId)),
        UpdateExpression: 'SET #version = :next, updatedAt = :now, actorId = :actor',
        ConditionExpression: '#version = :prior AND attribute_not_exists(voidedAt)',
        ExpressionAttributeNames: { '#version': 'version' },
        ExpressionAttributeValues: { ':next': state.version + 1, ':prior': state.version, ':now': now, ':actor': input.actorId } } },
    ],
  });
}

/** Standard bookkeeping evidence, committed by the same trusted finance mutation.
 * Generic document-link writes remain locked for claimed invoices. This path
 * pins the existing finance claim, original bytes and finance link together.
 */
async function invoiceEvidenceActions(
  client: DynamoDBDocumentClient,
  state: FinanceState,
  transactionIds: string[],
  now: string,
): Promise<any[]> {
  if (!state.invoiceLinkId) return [];
  const documentId = state.invoiceLinkId.split('#').at(-1)!;
  const document = await sourceItem(client, 'document', documentId);
  if (!document) throw safeConflict();
  const identity = invoiceIdentity(document);
  let added = 0;
  const links: any[] = [];
  for (const transactionId of transactionIds) {
    const item = documentLinkItem({ documentId, transactionId, coverageType: 'evidence' }, now);
    const existing = (await client.send(new GetCommand({ TableName: TABLE_BOOKKEEPING,
      Key: singleton(item.PK), ConsistentRead: true }))).Item;
    if (existing) {
      if (existing.documentId !== documentId || existing.transactionId !== transactionId || existing.coverageType !== 'evidence') throw safeConflict();
      links.push({ ConditionCheck: { TableName: TABLE_BOOKKEEPING, Key: singleton(item.PK),
        ConditionExpression: 'documentId = :doc AND transactionId = :tx AND coverageType = :coverage',
        ExpressionAttributeValues: { ':doc': documentId, ':tx': transactionId, ':coverage': 'evidence' } } });
    } else {
      added++;
      links.push({ Put: { TableName: TABLE_BOOKKEEPING, Item: item, ConditionExpression: 'attribute_not_exists(PK)' } });
    }
  }
  const sourceGuard = identityCondition('document', document);
  return [
    { ConditionCheck: { TableName: TABLE_BOOKKEEPING, Key: singleton(claimKey('document', documentId)),
      ConditionExpression: 'dealId = :deal AND linkId = :link AND sourceId = :source AND identityToken = :identity AND kind = :kind',
      ExpressionAttributeValues: { ':deal': state.dealId, ':link': state.invoiceLinkId, ':source': documentId, ':identity': identity, ':kind': 'document' } } },
    { ConditionCheck: { TableName: TABLE_SPONSOR_CRM, Key: singleton(state.invoiceLinkId),
      ConditionExpression: 'dealId = :deal AND sourceId = :source AND identityToken = :identity AND kind = :kind',
      ExpressionAttributeValues: { ':deal': state.dealId, ':source': documentId, ':identity': identity, ':kind': 'document' } } },
    added ? { Update: { TableName: TABLE_BOOKKEEPING, Key: singleton(sourceKey('document', documentId)),
      ...sourceGuard, UpdateExpression: 'SET updatedAt = :now ADD linkRefCount :count',
      ExpressionAttributeValues: { ...sourceGuard.ExpressionAttributeValues, ':now': now, ':count': added } } }
      : { ConditionCheck: { TableName: TABLE_BOOKKEEPING, Key: singleton(sourceKey('document', documentId)), ...sourceGuard } },
    ...links,
  ];
}

/** Attach the currently reviewed invoice to explicitly selected allocated receipts.
 * This also handles originals recovered after a payment was already linked.
 */
export async function attachPaymentEvidence(
  client: DynamoDBDocumentClient,
  input: { actorId: string; dealId: string; dealVersion: number; expectedVersion: number; idempotencyKey: string;
    documentId: string; transactionIds: string[] },
) {
  if (!OPAQUE.test(input.documentId) || !Array.isArray(input.transactionIds) || !input.transactionIds.length
    || input.transactionIds.length > PAYMENT_LINK_LIMIT || input.transactionIds.some((id) => typeof id !== 'string' || !OPAQUE.test(id))
    || new Set(input.transactionIds).size !== input.transactionIds.length) {
    throw Object.assign(new Error('Select the reviewed invoice and distinct allocated receipt IDs'), { statusCode: 400 });
  }
  const request = { documentId: input.documentId, transactionIds: [...input.transactionIds].sort() };
  const replay = await replayMutation(client, { actorId: input.actorId, operation: 'attach-payment-evidence', dealId: input.dealId,
    idempotencyKey: input.idempotencyKey, request });
  if (replay) return replay;
  const projection = await projectFinance(client, input.dealId, 'admin');
  const state = await getFinanceState(client, input.dealId);
  if (!state || state.version !== input.expectedVersion || state.voidedAt || projection.reconciliationStatus !== 'coherent'
    || projection.invoice?.id !== input.documentId || request.transactionIds.some((id) => !projection.payments.some((payment) => payment.source === 'ledger' && payment.id === id))) throw safeConflict();
  const now = nowIso();
  const sourceChecks: any[] = [];
  for (const transactionId of request.transactionIds) {
    const source = await sourceItem(client, 'transaction', transactionId);
    if (!source) throw safeConflict();
    const identity = paymentIdentity(source), id = linkKey(input.dealId, 'transaction', transactionId);
    sourceChecks.push(
      { ConditionCheck: { TableName: TABLE_BOOKKEEPING, Key: singleton(sourceKey('transaction', transactionId)), ...identityCondition('transaction', source) } },
      { ConditionCheck: { TableName: TABLE_BOOKKEEPING, Key: singleton(claimKey('transaction', transactionId)),
        ConditionExpression: 'dealId = :deal AND linkId = :link AND identityToken = :identity',
        ExpressionAttributeValues: { ':deal': input.dealId, ':link': id, ':identity': identity } } },
      { ConditionCheck: { TableName: TABLE_SPONSOR_CRM, Key: singleton(id),
        ConditionExpression: 'dealId = :deal AND sourceId = :source AND identityToken = :identity',
        ExpressionAttributeValues: { ':deal': input.dealId, ':source': transactionId, ':identity': identity } } },
    );
  }
  // At most 20 * (source + claim + finance link + evidence link) + 8 = 88
  // actions, including permissions, original guards, version, receipt and audit.
  return executeMutation(client, { actorId: input.actorId, operation: 'attach-payment-evidence', dealId: input.dealId,
    idempotencyKey: input.idempotencyKey, request, financeVersion: state.version + 1,
    recordId: state.invoiceLinkId!, sourceId: input.documentId, eventCode: 'payment-invoice-evidence-linked', details: request,
    transactItems: [adminCheck(input.actorId), dealCheck(input.dealId, input.dealVersion), ...sourceChecks,
      ...await invoiceEvidenceActions(client, state, request.transactionIds, now),
      { Update: { TableName: TABLE_SPONSOR_CRM, Key: singleton(financeKey(input.dealId)),
        UpdateExpression: 'SET #version = :next, updatedAt = :now, actorId = :actor',
        ConditionExpression: '#version = :prior AND invoiceLinkId = :invoice', ExpressionAttributeNames: { '#version': 'version' },
        ExpressionAttributeValues: { ':next': state.version + 1, ':prior': state.version, ':invoice': state.invoiceLinkId, ':now': now, ':actor': input.actorId } } },
    ],
  });
}

export async function linkPayment(
  client: DynamoDBDocumentClient,
  input: {
    actorId: string; dealId: string; dealVersion: number; expectedVersion: number;
    sourceId: string; identityToken: string; idempotencyKey: string;
    /** A recorded (pre-ledger) payment this ledger row confirms; removed in the same transaction. */
    replacesPaymentId?: string;
  },
  prepared?: { source: Record<string, unknown>; request: Record<string, unknown> },
) {
  if (!OPAQUE.test(input.sourceId) || (input.replacesPaymentId !== undefined && !/^[a-f0-9]{32}$/.test(input.replacesPaymentId))) {
    throw Object.assign(new Error('Invalid payment link'), { statusCode: 400 });
  }
  const request = prepared?.request || {
    dealVersion: input.dealVersion,
    expectedVersion: input.expectedVersion,
    sourceId: input.sourceId,
    identityToken: input.identityToken,
    replacesPaymentId: input.replacesPaymentId,
  };
  const replay = await replayMutation(client, {
    actorId: input.actorId,
    operation: prepared ? 'receive-payment' : 'link-payment',
    dealId: input.dealId,
    idempotencyKey: input.idempotencyKey,
    request,
  });
  if (replay) return replay;
  const projection = await projectFinance(client, input.dealId, 'admin');
  const state = await getFinanceState(client, input.dealId);
  const source = prepared?.source || await sourceItem(client, 'transaction', input.sourceId);
  if (
    !state || state.version !== input.expectedVersion || state.voidedAt || !state.issuedOn
    || state.paymentLinkIds.length + state.recordedPaymentIds.length >= PAYMENT_LINK_LIMIT || !source || paymentIdentity(source) !== input.identityToken
    || source.currency !== state.currency || projection.reconciliationStatus !== 'coherent'
  ) throw safeConflict();
  const replaced = input.replacesPaymentId
    ? projection.payments.find((item) => item.source === 'recorded' && item.id === input.replacesPaymentId)
    : undefined;
  if (input.replacesPaymentId && !replaced) throw safeConflict();
  const sourceDate = String(source.paidDate || source.transactionDate || '');
  const lookalike = projection.payments.find((item) => item.source === 'recorded' && item !== replaced
    && item.amount === String(source.amount) && realDate(sourceDate)
    && Math.abs(daysBetween(item.effectiveDate, sourceDate)) <= 14);
  if (lookalike) {
    throw Object.assign(new Error('A recorded payment looks like this bookkeeping row; link it as its replacement'), { statusCode: 409 });
  }
  if (settledTotal(projection) + scaledMoney(source.amount) > scaledMoney(state.amountDue)) throw safeConflict();
  const replacedKey = replaced ? recordedPaymentKey(input.dealId, replaced.id) : undefined;
  const nextRecorded = state.recordedPaymentIds.filter((item) => item !== replacedKey);
  const id = linkKey(input.dealId, 'transaction', input.sourceId);
  const nextIds = [...state.paymentLinkIds, id].sort();
  const nextVersion = state.version + 1;
  const now = nowIso();
  const link: FinanceLink = {
    id, recordType: 'sponsor-finance-link', dealId: input.dealId, kind: 'transaction',
    sourceId: input.sourceId, identityToken: input.identityToken, actorId: input.actorId,
    financeVersion: nextVersion, createdAt: now,
  };
  const existingTupleChecks: any[] = [];
  for (const payment of projection.payments.filter((item) => item.source === 'ledger')) {
    const linkedSource = await sourceItem(client, 'transaction', payment.id);
    if (!linkedSource) throw safeConflict();
    const existingLinkId = linkKey(input.dealId, 'transaction', payment.id);
    const identityToken = paymentIdentity(linkedSource);
    existingTupleChecks.push(
      {
        ConditionCheck: {
          TableName: TABLE_BOOKKEEPING,
          Key: singleton(sourceKey('transaction', payment.id)),
          ...identityCondition('transaction', linkedSource),
        },
      },
      {
        ConditionCheck: {
          TableName: TABLE_BOOKKEEPING,
          Key: singleton(claimKey('transaction', payment.id)),
          ConditionExpression: 'dealId = :booking AND linkId = :link AND kind = :kind AND sourceId = :source AND identityToken = :identity',
          ExpressionAttributeValues: {
            ':booking': input.dealId,
            ':link': existingLinkId,
            ':kind': 'transaction',
            ':source': payment.id,
            ':identity': identityToken,
          },
        },
      },
    );
  }
  if (existingTupleChecks.length + 12 > MAX_PAYMENT_LINK_TRANSACTION_ACTIONS) throw safeConflict();
  return executeMutation(client, {
    actorId: input.actorId, operation: prepared ? 'receive-payment' : 'link-payment', dealId: input.dealId, idempotencyKey: input.idempotencyKey,
    request,
    financeVersion: nextVersion, recordId: id, linkId: id, sourceId: input.sourceId, eventCode: 'payment-linked',
    transactItems: [
      adminCheck(input.actorId), dealCheck(input.dealId, input.dealVersion),
      ...existingTupleChecks,
      ...await invoiceEvidenceActions(client, state, [input.sourceId], now),
      prepared ? { Put: {
        TableName: TABLE_BOOKKEEPING, Item: { ...singleton(sourceKey('transaction', input.sourceId)), ...source },
        ConditionExpression: 'attribute_not_exists(PK)',
      } } : { ConditionCheck: {
        TableName: TABLE_BOOKKEEPING, Key: singleton(sourceKey('transaction', input.sourceId)),
        ...identityCondition('transaction', source),
      } },
      {
        Put: {
          TableName: TABLE_BOOKKEEPING,
          Item: {
            ...singleton(claimKey('transaction', input.sourceId)), recordType: 'sponsor-finance-claim',
            kind: 'transaction', sourceId: input.sourceId, dealId: input.dealId, linkId: id,
            identityToken: input.identityToken, actorId: input.actorId, createdAt: now,
          },
          ConditionExpression: 'attribute_not_exists(PK)',
        },
      },
      { Put: { TableName: TABLE_SPONSOR_CRM, Item: { ...singleton(id), ...link }, ConditionExpression: 'attribute_not_exists(PK)' } },
      ...(replacedKey ? [{
        Delete: {
          TableName: TABLE_SPONSOR_CRM, Key: singleton(replacedKey),
          ConditionExpression: 'dealId = :deal', ExpressionAttributeValues: { ':deal': input.dealId },
        },
      }] : []),
      {
        Update: {
          TableName: TABLE_SPONSOR_CRM, Key: singleton(financeKey(input.dealId)),
          UpdateExpression: 'SET paymentLinkIds = :next, recordedPaymentIds = :nextRecorded, updatedAt = :now, actorId = :actor, #version = #version + :one',
          ConditionExpression: '#version = :version AND paymentLinkIds = :prior AND recordedPaymentIds = :priorRecorded AND size(paymentLinkIds) < :limit AND attribute_not_exists(voidedAt)',
          ExpressionAttributeNames: { '#version': 'version' },
          ExpressionAttributeValues: {
            ':next': nextIds, ':prior': state.paymentLinkIds, ':nextRecorded': nextRecorded,
            ':priorRecorded': state.recordedPaymentIds, ':now': now, ':actor': input.actorId, ':one': 1,
            ':version': state.version, ':limit': PAYMENT_LINK_LIMIT,
          },
        },
      },
    ],
  });
}

export async function unlinkFinanceSource(
  client: DynamoDBDocumentClient,
  input: {
    actorId: string; dealId: string; dealVersion: number; expectedVersion: number;
    kind: 'document' | 'transaction'; sourceId: string; idempotencyKey: string;
  },
) {
  const id = linkKey(input.dealId, input.kind, input.sourceId);
  const request = { dealVersion: input.dealVersion, expectedVersion: input.expectedVersion, sourceId: input.sourceId };
  const replay = await replayMutation(client, {
    actorId: input.actorId,
    operation: `unlink-${input.kind}`,
    dealId: input.dealId,
    idempotencyKey: input.idempotencyKey,
    request,
  });
  if (replay) return replay;
  const state = await getFinanceState(client, input.dealId);
  if (
    !state || state.version !== input.expectedVersion
    || (input.kind === 'document' ? state.invoiceLinkId !== id : !state.paymentLinkIds.includes(id))
  ) throw safeConflict();
  const nextVersion = state.version + 1;
  const now = nowIso();
  const update = input.kind === 'document'
    ? {
      UpdateExpression: 'SET updatedAt = :now, actorId = :actor, #version = #version + :one REMOVE invoiceLinkId',
      ConditionExpression: '#version = :version AND invoiceLinkId = :link',
      ExpressionAttributeNames: { '#version': 'version' },
      ExpressionAttributeValues: { ':now': now, ':actor': input.actorId, ':one': 1, ':version': state.version, ':link': id },
    }
    : {
      UpdateExpression: 'SET paymentLinkIds = :next, updatedAt = :now, actorId = :actor, #version = #version + :one',
      ConditionExpression: '#version = :version AND paymentLinkIds = :prior',
      ExpressionAttributeNames: { '#version': 'version' },
      ExpressionAttributeValues: {
        ':next': state.paymentLinkIds.filter((link) => link !== id), ':prior': state.paymentLinkIds,
        ':now': now, ':actor': input.actorId, ':one': 1, ':version': state.version,
      },
    };
  return executeMutation(client, {
    actorId: input.actorId, operation: `unlink-${input.kind}`, dealId: input.dealId, idempotencyKey: input.idempotencyKey,
    request,
    financeVersion: nextVersion, recordId: id, linkId: id, sourceId: input.sourceId,
    eventCode: input.kind === 'document' ? 'invoice-unlinked' : 'payment-unlinked',
    transactItems: [
      adminCheck(input.actorId), dealCheck(input.dealId, input.dealVersion),
      {
        Delete: {
          TableName: TABLE_BOOKKEEPING, Key: singleton(claimKey(input.kind, input.sourceId)),
          ConditionExpression: 'dealId = :booking AND linkId = :link',
          ExpressionAttributeValues: { ':booking': input.dealId, ':link': id },
        },
      },
      {
        Delete: {
          TableName: TABLE_SPONSOR_CRM, Key: singleton(id),
          ConditionExpression: 'dealId = :booking AND sourceId = :source',
          ExpressionAttributeValues: { ':booking': input.dealId, ':source': input.sourceId },
        },
      },
      { Update: { TableName: TABLE_SPONSOR_CRM, Key: singleton(financeKey(input.dealId)), ...update } },
    ],
  });
}

export async function voidFinance(
  client: DynamoDBDocumentClient,
  input: { actorId: string; dealId: string; dealVersion: number; expectedVersion: number; idempotencyKey: string; reason: string },
) {
  if (!boundedText(input.reason, 500)) throw Object.assign(new Error('A cancellation reason is required'), { statusCode: 400 });
  const request = { reason: input.reason.trim(), dealVersion: input.dealVersion, expectedVersion: input.expectedVersion };
  const replay = await replayMutation(client, {
    actorId: input.actorId,
    operation: 'void',
    dealId: input.dealId,
    idempotencyKey: input.idempotencyKey,
    request,
  });
  if (replay) return replay;
  const state = await getFinanceState(client, input.dealId);
  if (
    !state || state.version !== input.expectedVersion || state.paymentLinkIds.length
    || state.recordedPaymentIds.length || state.voidedAt
  ) throw safeConflict();
  const now = nowIso();
  return executeMutation(client, {
    actorId: input.actorId, operation: 'void', dealId: input.dealId, idempotencyKey: input.idempotencyKey,
    request,
    financeVersion: state.version + 1, recordId: state.id, eventCode: 'finance-voided', details: { reason: input.reason.trim() },
    transactItems: [
      adminCheck(input.actorId), dealCheck(input.dealId, input.dealVersion),
      {
        Update: {
          TableName: TABLE_SPONSOR_CRM, Key: singleton(financeKey(input.dealId)),
          UpdateExpression: 'SET voidedAt = :now, voidReason = :reason, updatedAt = :now, actorId = :actor, #version = #version + :one',
          ConditionExpression: '#version = :version AND size(paymentLinkIds) = :zero AND size(recordedPaymentIds) = :zero AND attribute_not_exists(voidedAt)',
          ExpressionAttributeNames: { '#version': 'version' },
          ExpressionAttributeValues: { ':reason': input.reason.trim(), ':now': now, ':actor': input.actorId, ':one': 1, ':zero': 0, ':version': state.version },
        },
      },
    ],
  });
}

export type ProjectionContext = { today?: string; deliveredOn?: string; dealStatus?: string };

export async function projectFinance(
  client: DynamoDBDocumentClient,
  dealId: string,
  role: 'admin' | 'operator',
  context: ProjectionContext = {},
): Promise<FinanceProjection> {
  const today = context.today || berlinDate();
  for (let retry = 0; retry < 3; retry++) {
    const orphanDiscovery = await discoverFinanceClaims(client, dealId);
    const discovered = await getFinanceState(client, dealId);
    if (!discovered) {
      const coherentEmpty = orphanDiscovery.complete && orphanDiscovery.keys.length === 0;
      return {
        enabled: true, classified: false, dealId, role, invoiceState: 'unclassified',
        paymentState: coherentEmpty ? 'not-applicable' : 'reconciliation-required',
        timingState: 'not-applicable', payments: [],
        followUp: coherentEmpty
          ? deriveFollowUp({ dealStatus: context.dealStatus, deliveredOn: context.deliveredOn, invoiceState: 'unclassified', paymentState: 'not-applicable' }, today)
          : { code: 'reconcile', party: 'us' },
        reconciliationStatus: coherentEmpty ? 'coherent' : 'reconciliation-required',
        paymentLinkCount: 0, paymentLinkLimit: PAYMENT_LINK_LIMIT,
      };
    }
    const recordedIds = discovered.recordedPaymentIds || [];
    const ids = [...(discovered.invoiceLinkId ? [discovered.invoiceLinkId] : []), ...discovered.paymentLinkIds];
    const linkKinds = ids.map((id) => id.includes('#document#') ? 'document' as const : 'transaction' as const);
    const sourceIds = ids.map((id) => id.split('#').at(-1)!);
    const getItems: any[] = [
      { Get: { TableName: TABLE_SPONSOR_CRM, Key: singleton(financeKey(dealId)) } },
      { Get: { TableName: TABLE_SPONSOR_CRM, Key: dealKey(dealId) } },
    ];
    ids.forEach((id, index) => {
      getItems.push(
        { Get: { TableName: TABLE_SPONSOR_CRM, Key: singleton(id) } },
        { Get: { TableName: TABLE_BOOKKEEPING, Key: singleton(claimKey(linkKinds[index], sourceIds[index])) } },
        { Get: { TableName: TABLE_BOOKKEEPING, Key: singleton(sourceKey(linkKinds[index], sourceIds[index])) } },
      );
    });
    recordedIds.forEach((id) => getItems.push({ Get: { TableName: TABLE_SPONSOR_CRM, Key: singleton(id) } }));
    const result = await client.send(new TransactGetCommand({ TransactItems: getItems }));
    const responses = result.Responses || [];
    const state = clean<FinanceState>(responses[0]?.Item as Record<string, unknown>);
    const booking = responses[1]?.Item;
    if (
      !state || state.version !== discovered.version
      || JSON.stringify(state.paymentLinkIds) !== JSON.stringify(discovered.paymentLinkIds)
      || JSON.stringify(state.recordedPaymentIds || []) !== JSON.stringify(recordedIds)
      || state.invoiceLinkId !== discovered.invoiceLinkId
    ) continue;
    const confirmedClaims = await discoverFinanceClaims(client, dealId);
    if (
      !confirmedClaims.complete
      || JSON.stringify(confirmedClaims.keys) !== JSON.stringify(orphanDiscovery.keys)
    ) continue;
    let coherent = !!booking && !booking.archivedAt && booking.active === true && !['cancelled', 'complete'].includes(String(booking.status));
    const payments: FinancePayment[] = [];
    let invoice: FinanceProjection['invoice'];
    let total = 0n;
    for (let index = 0; index < ids.length; index++) {
      const offset = 2 + index * 3;
      const link = clean<FinanceLink>(responses[offset]?.Item as Record<string, unknown>);
      const claim = responses[offset + 1]?.Item;
      const source = responses[offset + 2]?.Item as Record<string, unknown> | undefined;
      const kind = linkKinds[index];
      let identity = '';
      try { identity = source ? (kind === 'document' ? invoiceIdentity(source) : paymentIdentity(source)) : ''; } catch { coherent = false; }
      if (
        !link || !claim || !source || link.id !== ids[index] || link.sourceId !== sourceIds[index]
        || link.dealId !== dealId || link.kind !== kind
        || link.identityToken !== identity || claim.identityToken !== identity || claim.linkId !== link.id
        || claim.dealId !== dealId || claim.kind !== kind || claim.sourceId !== sourceIds[index]
        || String(source.id) !== sourceIds[index]
      ) coherent = false;
      if (kind === 'document' && source) {
        invoice = { id: String(source.id), label: `Invoice ${String(source.id).slice(0, 8)}`, uploadedAt: String(source.createdAt) };
      } else if (kind === 'transaction' && source) {
        if (source.currency !== state.currency) coherent = false;
        const amount = String(source.amount);
        try { total += scaledMoney(amount); } catch { coherent = false; }
        payments.push({
          id: String(source.id),
          effectiveDate: String(source.paidDate || source.transactionDate),
          amount,
          currency: String(source.currency),
          source: 'ledger',
          ...(source.statementRef ? { reference: String(source.statementRef) } : {}),
          ...(source.amountEur !== undefined ? { amountEur: String(source.amountEur) } : {}),
          ...(source.category !== undefined ? { category: String(source.category) } : {}),
        });
      }
    }
    const recordedOffset = 2 + ids.length * 3;
    recordedIds.forEach((id, index) => {
      const record = clean<RecordedPayment>(responses[recordedOffset + index]?.Item as Record<string, unknown>);
      if (!record || record.id !== id || record.dealId !== dealId || record.currency !== state.currency) {
        coherent = false;
        return;
      }
      try { scaledMoney(record.amount); } catch { coherent = false; }
      payments.push({
        id: record.paymentId,
        effectiveDate: record.receivedOn,
        amount: record.amount,
        currency: record.currency,
        source: 'recorded',
        method: record.method,
        ...(record.reference ? { reference: record.reference } : {}),
      });
    });
    const expectedClaims = new Set(ids.map((id, index) => claimKey(linkKinds[index], sourceIds[index])));
    if (
      !orphanDiscovery.complete
      || orphanDiscovery.keys.length !== expectedClaims.size
      || orphanDiscovery.keys.some((key) => !expectedClaims.has(key))
    ) coherent = false;
    const settlement = state.amountDue && state.currency
      ? settlementBalance(scaledMoney(state.amountDue), total, state.currency, state.settlementAdjustment)
      : { adjusted: 0n, outstanding: 0n, coherent: !state.settlementAdjustment };
    if (!settlement.coherent) coherent = false;
    const outstandingValue = settlement.outstanding;
    const { invoiceState, paymentState, timingState } = deriveStates(
      state, total + settlement.adjusted, state.amountDue ? scaledMoney(state.amountDue) : undefined, coherent, today,
    );
    const visiblePayments = coherent
      ? payments.sort((a, b) => a.effectiveDate.localeCompare(b.effectiveDate) || a.id.localeCompare(b.id))
      : [];
    const lastPaymentOn = visiblePayments.filter((item) => item.source === 'ledger').at(-1)?.effectiveDate;
    const followUp = deriveFollowUp({
      dealStatus: context.dealStatus ?? (booking ? String(booking.status) : undefined),
      invoiceState, paymentState, reportedPayments: recordedIds.length > 0,
      requestBy: state.invoiceRequestedAt ? undefined : state.requestBy,
      expectedInvoiceBy: state.expectedInvoiceBy,
      dueOn: state.dueOn, sentOn: state.sentOn, waitingOn: state.waitingOn, deliveredOn: context.deliveredOn,
    }, today);
    return {
      enabled: true, classified: true, dealId, role,
      finance: {
        version: state.version, invoiceRequirement: state.invoiceRequirement,
        ...(state.amountDue ? { amountDue: state.amountDue } : {}),
        ...(state.currency ? { currency: state.currency } : {}),
        ...(state.taxMode ? { taxMode: state.taxMode } : {}),
        ...(state.taxAmount !== undefined ? { taxAmount: state.taxAmount } : {}),
        ...(state.requestBy ? { requestBy: state.requestBy } : {}),
        ...(state.invoiceRequestedAt ? { invoiceRequestedAt: state.invoiceRequestedAt } : {}),
        ...(state.expectedInvoiceBy ? { expectedInvoiceBy: state.expectedInvoiceBy } : {}),
        ...(state.invoiceNumber ? { invoiceNumber: state.invoiceNumber } : {}),
        ...(state.issuedOn ? { issuedOn: state.issuedOn } : {}),
        ...(state.sentOn ? { sentOn: state.sentOn } : {}),
        ...(state.dueOn ? { dueOn: state.dueOn } : {}),
        ...(state.waitingOn ? { waitingOn: state.waitingOn } : {}),
        ...(state.evidence?.length ? { evidence: state.evidence } : {}),
        ...(state.voidedAt ? { voidedAt: state.voidedAt } : {}),
        ...(state.voidReason ? { voidReason: state.voidReason } : {}),
        ...(state.settlementAdjustment ? { settlementAdjustment: state.settlementAdjustment } : {}),
      },
      invoiceState, paymentState, timingState,
      ...(state.amountDue && coherent ? { outstanding: displayMoney(outstandingValue), paid: displayMoney(total), adjusted: displayMoney(settlement.adjusted) } : {}),
      ...(timingState === 'overdue' && state.dueOn ? { daysOverdue: daysBetween(state.dueOn, today) } : {}),
      ...(lastPaymentOn ? { lastPaymentOn } : {}),
      ...(invoice ? { invoice } : {}),
      payments: visiblePayments,
      followUp,
      reconciliationStatus: coherent ? 'coherent' : 'reconciliation-required',
      paymentLinkCount: state.paymentLinkIds.length + recordedIds.length,
      paymentLinkLimit: PAYMENT_LINK_LIMIT,
    };
  }
  throw safeConflict();
}

async function boundedBookkeepingScan(
  client: DynamoDBDocumentClient,
  filterExpression: string,
  expressionAttributeValues: Record<string, unknown>,
): Promise<{ items: Record<string, unknown>[]; complete: boolean }> {
  const startedAt = Date.now();
  const items: Record<string, unknown>[] = [];
  const seenCursors = new Set<string>();
  let evaluated = 0;
  let cursor: Record<string, unknown> | undefined;
  let pages = 0;
  do {
    if (pages >= DISCOVERY_MAX_PAGES || evaluated >= DISCOVERY_MAX_ITEMS || Date.now() - startedAt >= DISCOVERY_DEADLINE_MS) {
      return { items, complete: false };
    }
    const remaining = DISCOVERY_MAX_ITEMS - evaluated;
    const requestLimit = remaining + 1;
    const cursorToken = cursor ? canonicalCursor(cursor) : 'START';
    if (seenCursors.has(cursorToken)) return { items, complete: false };
    seenCursors.add(cursorToken);
    const page = await client.send(new ScanCommand({
      TableName: TABLE_BOOKKEEPING,
      ConsistentRead: true,
      FilterExpression: filterExpression,
      ExpressionAttributeValues: expressionAttributeValues,
      ExclusiveStartKey: cursor,
      Limit: requestLimit,
    }));
    pages++;
    const scanned = page.ScannedCount;
    const pageItems = (page.Items || []) as Record<string, unknown>[];
    if (
      !Number.isSafeInteger(scanned)
      || scanned! < 0
      || scanned! > requestLimit
      || pageItems.length > scanned!
      || scanned! > remaining
      || Date.now() - startedAt >= DISCOVERY_DEADLINE_MS
    ) return { items, complete: false };
    evaluated += scanned!;
    items.push(...pageItems);
    cursor = page.LastEvaluatedKey;
    if (
      cursor && (
        typeof cursor !== 'object'
        || Array.isArray(cursor)
        || Object.keys(cursor).length === 0
        || canonicalCursor(cursor).length > 1_024
      )
    ) return { items, complete: false };
    if (cursor && evaluated >= DISCOVERY_MAX_ITEMS) return { items, complete: false };
  } while (cursor);
  return { items, complete: true };
}

const canonicalCursor = (cursor: Record<string, unknown>) =>
  Object.entries(cursor).sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}:${String(value)}`).join('|');

async function discoverFinanceClaims(client: DynamoDBDocumentClient, dealId: string) {
  const result = await boundedBookkeepingScan(
    client,
    'begins_with(PK, :prefix) AND dealId = :booking',
    { ':prefix': 'SPONSOR_FINANCE_CLAIM#', ':booking': dealId },
  );
  return {
    complete: result.complete,
    keys: result.items.map((item) => String(item.PK)).sort(),
  };
}

export async function listFinanceCandidates(
  client: DynamoDBDocumentClient,
  input: { kind: 'document' | 'transaction'; currency?: string; limit: number; cursor?: string },
) {
  const limit = Math.min(Math.max(input.limit, 1), 50);
  let afterId = '';
  if (input.cursor) {
    try {
      const decoded = JSON.parse(Buffer.from(input.cursor, 'base64url').toString('utf8'));
      if (!decoded || typeof decoded.afterId !== 'string' || !OPAQUE.test(decoded.afterId)) throw new Error();
      afterId = decoded.afterId;
    } catch { throw Object.assign(new Error('Invalid cursor'), { statusCode: 400 }); }
  }
  const prefix = input.kind === 'document' ? 'DOCUMENT#' : 'BOOKKEEPING#';
  const result = await boundedBookkeepingScan(client, 'begins_with(PK, :prefix)', { ':prefix': prefix });
  if (!result.complete) {
    throw Object.assign(new Error('Candidate discovery incomplete; retry'), { statusCode: 503 });
  }
  const eligible = [];
  const candidateDeadline = Date.now() + DISCOVERY_DEADLINE_MS;
  for (const raw of result.items) {
    if (Date.now() >= candidateDeadline) {
      throw Object.assign(new Error('Candidate discovery incomplete; retry'), { statusCode: 503 });
    }
    const source = clean<Record<string, unknown>>(raw as Record<string, unknown>)!;
    if (String(source.id).localeCompare(afterId) <= 0) continue;
    try {
      const identityToken = input.kind === 'document' ? invoiceIdentity(source) : paymentIdentity(source);
      if (input.kind === 'transaction' && source.currency !== input.currency) continue;
      eligible.push(input.kind === 'document'
        ? { id: source.id, label: `Invoice ${String(source.id).slice(0, 8)}`, uploadedAt: source.createdAt, identityToken }
        : {
          id: source.id, effectiveDate: source.paidDate || source.transactionDate,
          amount: source.amount, currency: source.currency, identityToken,
        });
    } catch { /* ineligible source */ }
  }
  eligible.sort((left, right) => String(left.id).localeCompare(String(right.id)));
  const items: typeof eligible = [];
  // Check claims in sorted batches and stop after finding a page plus a
  // continuation item. Reading every eligible claim separately exhausted the
  // bounded discovery deadline on normal-sized ledgers.
  for (let offset = 0; offset < eligible.length && items.length <= limit; offset += 100) {
    const batch = eligible.slice(offset, offset + 100);
    let keys = batch.map((item) => singleton(claimKey(input.kind, String(item.id))));
    const claimed = new Set<string>();
    for (let attempt = 0; keys.length && attempt < 3; attempt++) {
      if (Date.now() >= candidateDeadline) {
        throw Object.assign(new Error('Candidate discovery incomplete; retry'), { statusCode: 503 });
      }
      const result = await client.send(new BatchGetCommand({
        RequestItems: {
          [TABLE_BOOKKEEPING]: { Keys: keys, ConsistentRead: true, ProjectionExpression: 'PK' },
        },
      }));
      for (const claim of result.Responses?.[TABLE_BOOKKEEPING] || []) claimed.add(String(claim.PK));
      keys = (result.UnprocessedKeys?.[TABLE_BOOKKEEPING]?.Keys || []) as typeof keys;
    }
    if (keys.length || Date.now() >= candidateDeadline) {
      throw Object.assign(new Error('Candidate discovery incomplete; retry'), { statusCode: 503 });
    }
    for (const item of batch) {
      if (!claimed.has(claimKey(input.kind, String(item.id)))) items.push(item);
    }
  }
  const page = items.slice(0, limit);
  return {
    items: page,
    nextCursor: items.length > limit
      ? Buffer.from(JSON.stringify({ afterId: String(page.at(-1)!.id) })).toString('base64url')
      : null,
  };
}

export async function listFinanceHistory(client: DynamoDBDocumentClient, dealId: string, limit = 50) {
  const result = await client.send(new QueryCommand({
    TableName: TABLE_SPONSOR_CRM,
    KeyConditionExpression: 'PK = :pk',
    ExpressionAttributeValues: { ':pk': `SPONSOR_FINANCE_HISTORY#${dealId}` },
    ScanIndexForward: false,
    Limit: Math.min(Math.max(limit, 1), 100),
  }));
  return (result.Items || []).map((item) => ({
    actorId: String(item.actorId),
    createdAt: String(item.createdAt),
    eventCode: String(item.eventCode),
    financeVersion: Number(item.financeVersion),
    ...(typeof item.linkId === 'string' ? { linkId: item.linkId } : {}),
    ...(typeof item.sourceId === 'string' ? { sourceId: item.sourceId } : {}),
    ...(item.details && typeof item.details === 'object' ? { details: item.details } : {}),
  }));
}
