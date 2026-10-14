import { randomUUID } from 'crypto';
import {
  GetCommand,
  QueryCommand,
  ScanCommand,
  TransactGetCommand,
  TransactWriteCommand,
  type DynamoDBDocumentClient,
} from '@aws-sdk/lib-dynamodb';
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
const safeConflict = () => Object.assign(new Error('Finance state changed; reload and retry'), { statusCode: 409 });
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

function adminCheck(actorId: string) {
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

function dealCheck(dealId: string, version: number) {
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

async function replayMutation(
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

async function executeMutation(
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
  },
): Promise<MutationResult> {
  if (!IDEMPOTENCY.test(input.idempotencyKey)) throw Object.assign(new Error('Invalid Idempotency-Key'), { statusCode: 400 });
  const requestDigest = digest(input.request);
  const key = receiptKey(input.actorId, input.operation, input.dealId, input.idempotencyKey);
  const prior = await existingReceipt(client, key, requestDigest);
  if (prior) return prior;
  const at = nowIso();
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
  try {
    await client.send(new TransactWriteCommand({
      TransactItems: [
        ...input.transactItems,
        { Put: { TableName: TABLE_SPONSOR_CRM, Item: receipt, ConditionExpression: 'attribute_not_exists(PK)' } },
        {
          Put: {
            TableName: TABLE_SPONSOR_CRM,
            Item: {
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
              createdAt: at,
            },
            ConditionExpression: 'attribute_not_exists(PK) AND attribute_not_exists(SK)',
          },
        },
      ],
      ClientRequestToken: digest({ key, requestDigest }).slice(0, 36),
    }));
    return { financeVersion: input.financeVersion, recordId: input.recordId };
  } catch (error) {
    const receipt = await existingReceipt(client, key, requestDigest).catch(() => null);
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
  if (existing && input.expectedVersion !== existing.version) throw safeConflict();
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
    paymentLinkIds: existing?.paymentLinkIds || [],
    recordedPaymentIds: existing?.recordedPaymentIds || [],
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

function validateIssue(input: { invoiceNumber: unknown; issuedOn: unknown; dueOn: unknown; sentOn?: unknown }) {
  if (
    typeof input.invoiceNumber !== 'string' || !INVOICE_NUMBER.test(input.invoiceNumber)
    || !realDate(input.issuedOn) || !realDate(input.dueOn) || String(input.dueOn) < String(input.issuedOn)
    || (input.sentOn !== undefined && (!realDate(input.sentOn) || String(input.sentOn) < String(input.issuedOn)))
  ) throw Object.assign(new Error('Invalid invoice issue'), { statusCode: 400 });
}

/**
 * Record that an invoice exists: its number and issue, sent and due dates.
 * Re-issuing (a corrected invoice) replaces the details. The PDF is linked
 * separately once it reaches bookkeeping.
 */
export async function issueInvoice(
  client: DynamoDBDocumentClient,
  input: {
    actorId: string; dealId: string; dealVersion: number; expectedVersion: number; idempotencyKey: string;
    invoiceNumber: string; issuedOn: string; dueOn: string; sentOn?: string;
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
          UpdateExpression: `SET invoiceNumber = :number, issuedOn = :issued, dueOn = :due, ${input.sentOn ? 'sentOn = :sent, ' : ''}updatedAt = :now, actorId = :actor, #version = #version + :one${input.sentOn ? '' : ' REMOVE sentOn'}`,
          ConditionExpression: '#version = :version AND invoiceRequirement = :required AND attribute_not_exists(voidedAt)',
          ExpressionAttributeNames: { '#version': 'version' },
          ExpressionAttributeValues: {
            ':number': input.invoiceNumber, ':issued': input.issuedOn, ':due': input.dueOn,
            ...(input.sentOn ? { ':sent': input.sentOn } : {}),
            ':now': now, ':actor': input.actorId, ':one': 1, ':version': state.version, ':required': 'required',
          },
        },
      },
    ],
  });
}

function paidTotal(projection: FinanceProjection): bigint {
  return projection.payments.reduce((sum, item) => sum + scaledMoney(item.amount), 0n);
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
    || paidTotal(projection) + scaledMoney(input.amount) > scaledMoney(state.amountDue)
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

export async function linkPayment(
  client: DynamoDBDocumentClient,
  input: {
    actorId: string; dealId: string; dealVersion: number; expectedVersion: number;
    sourceId: string; identityToken: string; idempotencyKey: string;
    /** A recorded (pre-ledger) payment this ledger row confirms; removed in the same transaction. */
    replacesPaymentId?: string;
  },
) {
  if (!OPAQUE.test(input.sourceId) || (input.replacesPaymentId !== undefined && !/^[a-f0-9]{32}$/.test(input.replacesPaymentId))) {
    throw Object.assign(new Error('Invalid payment link'), { statusCode: 400 });
  }
  const request = {
    dealVersion: input.dealVersion,
    expectedVersion: input.expectedVersion,
    sourceId: input.sourceId,
    identityToken: input.identityToken,
    replacesPaymentId: input.replacesPaymentId,
  };
  const replay = await replayMutation(client, {
    actorId: input.actorId,
    operation: 'link-payment',
    dealId: input.dealId,
    idempotencyKey: input.idempotencyKey,
    request,
  });
  if (replay) return replay;
  const projection = await projectFinance(client, input.dealId, 'admin');
  const state = await getFinanceState(client, input.dealId);
  const source = await sourceItem(client, 'transaction', input.sourceId);
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
    throw Object.assign(new Error('A recorded payment looks like this ledger row; link it as its replacement'), { statusCode: 409 });
  }
  const replacedAmount = replaced ? scaledMoney(replaced.amount) : 0n;
  if (paidTotal(projection) - replacedAmount + scaledMoney(source.amount) > scaledMoney(state.amountDue)) throw safeConflict();
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
  if (existingTupleChecks.length + 8 > MAX_PAYMENT_LINK_TRANSACTION_ACTIONS) throw safeConflict();
  return executeMutation(client, {
    actorId: input.actorId, operation: 'link-payment', dealId: input.dealId, idempotencyKey: input.idempotencyKey,
    request,
    financeVersion: nextVersion, recordId: id, linkId: id, sourceId: input.sourceId, eventCode: 'payment-linked',
    transactItems: [
      adminCheck(input.actorId), dealCheck(input.dealId, input.dealVersion),
      ...existingTupleChecks,
      {
        ConditionCheck: {
          TableName: TABLE_BOOKKEEPING, Key: singleton(sourceKey('transaction', input.sourceId)),
          ...identityCondition('transaction', source),
        },
      },
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
  input: { actorId: string; dealId: string; dealVersion: number; expectedVersion: number; idempotencyKey: string },
) {
  const request = { dealVersion: input.dealVersion, expectedVersion: input.expectedVersion };
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
    !state || state.version !== input.expectedVersion || state.invoiceLinkId || state.paymentLinkIds.length
    || state.recordedPaymentIds.length || state.voidedAt
  ) throw safeConflict();
  const now = nowIso();
  return executeMutation(client, {
    actorId: input.actorId, operation: 'void', dealId: input.dealId, idempotencyKey: input.idempotencyKey,
    request,
    financeVersion: state.version + 1, recordId: state.id, eventCode: 'finance-voided',
    transactItems: [
      adminCheck(input.actorId), dealCheck(input.dealId, input.dealVersion),
      {
        Update: {
          TableName: TABLE_SPONSOR_CRM, Key: singleton(financeKey(input.dealId)),
          UpdateExpression: 'SET voidedAt = :now, updatedAt = :now, actorId = :actor, #version = #version + :one',
          ConditionExpression: '#version = :version AND size(paymentLinkIds) = :zero AND size(recordedPaymentIds) = :zero AND attribute_not_exists(invoiceLinkId) AND attribute_not_exists(voidedAt)',
          ExpressionAttributeNames: { '#version': 'version' },
          ExpressionAttributeValues: { ':now': now, ':actor': input.actorId, ':one': 1, ':zero': 0, ':version': state.version },
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
          ? deriveFollowUp({ dealStatus: context.dealStatus, invoiceState: 'unclassified', paymentState: 'not-applicable' }, today)
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
      try { total += scaledMoney(record.amount); } catch { coherent = false; }
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
    if (state.amountDue && total > scaledMoney(state.amountDue)) coherent = false;
    const outstandingValue = state.amountDue ? scaledMoney(state.amountDue) - total : 0n;
    const { invoiceState, paymentState, timingState } = deriveStates(
      state, total, state.amountDue ? scaledMoney(state.amountDue) : undefined, coherent, today,
    );
    const visiblePayments = coherent
      ? payments.sort((a, b) => a.effectiveDate.localeCompare(b.effectiveDate) || a.id.localeCompare(b.id))
      : [];
    const lastPaymentOn = visiblePayments.at(-1)?.effectiveDate;
    const followUp = deriveFollowUp({
      dealStatus: context.dealStatus ?? (booking ? String(booking.status) : undefined),
      invoiceState, paymentState,
      requestBy: state.invoiceRequestedAt ? undefined : state.requestBy,
      expectedInvoiceBy: state.expectedInvoiceBy,
      dueOn: state.dueOn, waitingOn: state.waitingOn, deliveredOn: context.deliveredOn,
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
      },
      invoiceState, paymentState, timingState,
      ...(state.amountDue && coherent ? { outstanding: displayMoney(outstandingValue), paid: displayMoney(total) } : {}),
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
  const items = [];
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
      const claimed = (await client.send(new GetCommand({
        TableName: TABLE_BOOKKEEPING,
        Key: singleton(claimKey(input.kind, String(source.id))),
        ConsistentRead: true,
      }))).Item;
      if (claimed) continue;
      items.push(input.kind === 'document'
        ? { id: source.id, label: `Invoice ${String(source.id).slice(0, 8)}`, uploadedAt: source.createdAt, identityToken }
        : {
          id: source.id, effectiveDate: source.paidDate || source.transactionDate,
          amount: source.amount, currency: source.currency, identityToken,
        });
    } catch { /* ineligible source */ }
  }
  items.sort((left, right) => String(left.id).localeCompare(String(right.id)));
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
  }));
}
