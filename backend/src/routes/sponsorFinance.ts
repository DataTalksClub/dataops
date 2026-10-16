import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import type { LambdaEvent, LambdaResponse } from '../types';
import { createPaymentFollowUpTask, withPaymentFollowUpTasks } from '../sponsorFinance/paymentFollowUp';
import {
  classifyFinance,
  financeActor,
  financeEnabled,
  deleteRecordedPayment,
  getFinanceState,
  issueInvoice,
  linkInvoice,
  linkPayment,
  listFinanceCandidates,
  listFinanceHistory,
  projectFinance,
  recordInvoiceRequest,
  recordPayment,
  receivePayment,
  correctReceipt,
  attachPaymentEvidence,
  recordSettlementAdjustment,
  removeSettlementAdjustment,
  unlinkFinanceSource,
  updateFollowThrough,
  voidFinance,
} from '../sponsorFinance/repository';
import { financeLedger } from '../sponsorFinance/ledger';
import { dealProjectionContext } from '../sponsorFinance/context';
import { OPAQUE } from '../sponsorFinance/core';
import { recordRequestError } from '../requestErrorLog';

const headers = {
  'Content-Type': 'application/json',
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
};
const json = (statusCode: number, body: unknown): LambdaResponse => ({ statusCode, headers, body: JSON.stringify(body) });
const parse = (event: LambdaEvent): Record<string, unknown> | null => {
  try {
    const body = event.body ? JSON.parse(String(event.body)) : {};
    return body && typeof body === 'object' && !Array.isArray(body) ? body : null;
  } catch { return null; }
};
const header = (event: LambdaEvent, name: string) => Object.entries(event.headers || {})
  .find(([key]) => key.toLowerCase() === name.toLowerCase())?.[1] || '';

export async function handleSponsorFinanceRoutes(
  path: string,
  method: string,
  event: LambdaEvent,
  client: DynamoDBDocumentClient,
): Promise<LambdaResponse | null> {
  if (!path.includes('/finance')) return null;
  if (!financeEnabled()) return json(404, { error: 'Finance follow-through is disabled' });
  if (path === '/api/sponsor-crm/finance/ledger') {
    if (method !== 'GET') return json(405, { error: 'Method not allowed' });
    try {
      await financeActor(client, header(event, 'x-user-id'));
      const today = event.queryStringParameters?.today;
      return json(200, await financeLedger(client, today && /^\d{4}-\d{2}-\d{2}$/.test(today) ? today : undefined));
    } catch (error) {
      const statusCode = Number((error as { statusCode?: number }).statusCode || 503);
      recordRequestError(error);
      return json(statusCode, {
        error: statusCode === 401 ? 'Unauthorized' : statusCode === 403 ? 'Forbidden' : 'Finance data is temporarily unavailable; retry',
      });
    }
  }
  const match = path.match(/^\/api\/sponsor-crm\/deals\/([^/]+)\/finance(?:\/(.*))?$/);
  if (!match || !OPAQUE.test(match[1])) return json(404, { error: 'Not found' });
  const dealId = match[1], action = match[2] || '';
  const body = parse(event);
  if (!body) return json(400, { error: 'Invalid request' });
  const actorId = header(event, 'x-user-id');
  try {
    const write = method !== 'GET';
    const actor = await financeActor(client, actorId, write || action.startsWith('candidates/'));
    const project = async () => withPaymentFollowUpTasks(
      client,
      await projectFinance(client, dealId, actor.role, await dealProjectionContext(client, dealId)),
      await getFinanceState(client, dealId),
    );
    if (method === 'GET' && !action) return json(200, await project());
    if (method === 'GET' && action === 'history') return json(200, { items: await listFinanceHistory(client, dealId) });
    if (method === 'GET' && (action === 'candidates/invoices' || action === 'candidates/payments')) {
      const state = await getFinanceState(client, dealId);
      if (!state) return json(409, { error: 'Finance state changed; reload and retry' });
      const limit = Number(event.queryStringParameters?.limit || 25);
      if (!Number.isInteger(limit) || limit < 1 || limit > 50) return json(400, { error: 'Invalid pagination' });
      return json(200, await listFinanceCandidates(client, {
        kind: action.endsWith('invoices') ? 'document' : 'transaction',
        currency: state.currency,
        limit,
        cursor: event.queryStringParameters?.cursor,
      }));
    }
    const idempotencyKey = header(event, 'idempotency-key');
    const common = {
      actorId: actor.id,
      dealId,
      dealVersion: Number(body.dealVersion),
      expectedVersion: body.expectedVersion === undefined ? undefined : Number(body.expectedVersion),
      idempotencyKey,
    };
    if (method === 'PUT' && !action) {
      const result = await classifyFinance(client, { ...common, body });
      return json(200, { result, projection: await project() });
    }
    if (method === 'POST' && action === 'request') {
      const result = await recordInvoiceRequest(client, { ...common, expectedVersion: Number(body.expectedVersion) });
      return json(200, { result, projection: await project() });
    }
    if (method === 'POST' && action === 'invoice') {
      const result = await linkInvoice(client, {
        ...common,
        expectedVersion: Number(body.expectedVersion),
        sourceId: String(body.sourceId || ''),
        identityToken: String(body.identityToken || ''),
        ...(body.issuedOn !== undefined ? { issuedOn: String(body.issuedOn) } : {}),
        ...(body.dueOn !== undefined ? { dueOn: String(body.dueOn) } : {}),
      });
      return json(200, { result, projection: await project() });
    }
    if (method === 'POST' && action === 'payments') {
      const result = await linkPayment(client, {
        ...common,
        expectedVersion: Number(body.expectedVersion),
        sourceId: String(body.sourceId || ''),
        identityToken: String(body.identityToken || ''),
        ...(body.replacesPaymentId !== undefined ? { replacesPaymentId: String(body.replacesPaymentId) } : {}),
      });
      return json(200, { result, projection: await project() });
    }
    const unlink = action.match(/^(invoice|payments)\/([^/]+)$/);
    if (method === 'DELETE' && unlink) {
      const result = await unlinkFinanceSource(client, {
        ...common,
        expectedVersion: Number(body.expectedVersion),
        kind: unlink[1] === 'invoice' ? 'document' : 'transaction',
        sourceId: unlink[2],
      });
      return json(200, { result, projection: await project() });
    }
    if (method === 'POST' && action === 'issue') {
      const result = await issueInvoice(client, {
        ...common,
        expectedVersion: Number(body.expectedVersion),
        ...(body.invoiceNumber !== undefined && body.invoiceNumber !== '' ? { invoiceNumber: String(body.invoiceNumber) } : {}),
        issuedOn: String(body.issuedOn || ''),
        dueOn: String(body.dueOn || ''),
        ...(body.sentOn !== undefined ? { sentOn: String(body.sentOn) } : {}),
      });
      return json(200, { result, projection: await project() });
    }
    if (method === 'POST' && action === 'settlement-adjustment') {
      const result = await recordSettlementAdjustment(client, { ...common, expectedVersion: Number(body.expectedVersion), body });
      return json(200, { result, projection: await project() });
    }
    if (method === 'DELETE' && action === 'settlement-adjustment') {
      const result = await removeSettlementAdjustment(client, { ...common, expectedVersion: Number(body.expectedVersion), reason: String(body.reason || '') });
      return json(200, { result, projection: await project() });
    }
    if (method === 'POST' && action === 'payment-evidence') {
      const result = await attachPaymentEvidence(client, {
        ...common, expectedVersion: Number(body.expectedVersion), documentId: String(body.documentId || ''),
        transactionIds: body.transactionIds as string[],
      });
      return json(200, { result, projection: await project() });
    }
    const receipt = action.match(/^receipts\/([^/]+)$/);
    if (method === 'PUT' && receipt) {
      const result = await correctReceipt(client, {
        ...common, expectedVersion: Number(body.expectedVersion), sourceId: receipt[1],
        receivedOn: String(body.receivedOn || ''), amount: String(body.amount || ''),
        currency: String(body.currency || ''), reference: String(body.reference || ''),
        ...(body.amountEur !== undefined ? { amountEur: String(body.amountEur) } : {}),
        ...(body.category !== undefined ? { category: String(body.category) } : {}),
      });
      return json(200, { result, projection: await project() });
    }
    if (method === 'POST' && action === 'receipts') {
      const result = await receivePayment(client, {
        ...common, expectedVersion: Number(body.expectedVersion),
        receivedOn: String(body.receivedOn || ''), amount: String(body.amount || ''),
        currency: String(body.currency || ''), reference: String(body.reference || ''),
        counterparty: String(body.counterparty || ''),
        ...(body.amountEur !== undefined ? { amountEur: String(body.amountEur) } : {}),
        ...(body.category !== undefined ? { category: String(body.category) } : {}),
        ...(body.replacesPaymentId ? { replacesPaymentId: String(body.replacesPaymentId) } : {}),
      });
      return json(200, { result, projection: await project() });
    }
    if (method === 'POST' && action === 'recorded-payments') {
      const result = await recordPayment(client, {
        ...common,
        expectedVersion: Number(body.expectedVersion),
        receivedOn: String(body.receivedOn || ''),
        amount: String(body.amount || ''),
        currency: String(body.currency || ''),
        method: String(body.method || ''),
        ...(body.reference !== undefined ? { reference: String(body.reference) } : {}),
      });
      return json(200, { result, projection: await project() });
    }
    const recorded = action.match(/^recorded-payments\/([^/]+)$/);
    if (method === 'DELETE' && recorded) {
      const result = await deleteRecordedPayment(client, {
        ...common, expectedVersion: Number(body.expectedVersion), paymentId: recorded[1],
      });
      return json(200, { result, projection: await project() });
    }
    if (method === 'PUT' && action === 'follow-through') {
      const result = await updateFollowThrough(client, { ...common, expectedVersion: Number(body.expectedVersion), body });
      return json(200, { result, projection: await project() });
    }
    if (method === 'POST' && action === 'follow-up') {
      // The Task is the result; the finance projection is unchanged (the
      // linked payment follow-up work is re-read with the projection on every GET).
      const result = await createPaymentFollowUpTask(client, {
        ...common,
        expectedVersion: Number(body.expectedVersion),
        ...(body.date !== undefined ? { date: body.date } : {}),
        ...(body.existingTaskId !== undefined ? { existingTaskId: body.existingTaskId } : {}),
        ...(body.reviewedOpenTasks !== undefined ? { reviewedOpenTasks: body.reviewedOpenTasks } : {}),
      });
      return json(201, {
        task: result.task,
        ...(result.replayed ? { replayed: true } : {}),
      });
    }
    if (method === 'POST' && action === 'void') {
      const result = await voidFinance(client, { ...common, expectedVersion: Number(body.expectedVersion), reason: String(body.reason || '') });
      return json(200, { result, projection: await project() });
    }
    if (method === 'POST' && action === 'reconcile') {
      return json(200, { projection: await project() });
    }
    return json(405, { error: 'Method not allowed' });
  } catch (error) {
    const statusCode = Number((error as { statusCode?: number }).statusCode || 409);
    recordRequestError(error);
    const outcome = (error as { outcome?: string }).outcome;
    const taskId = (error as { taskId?: string }).taskId;
    return json(statusCode, {
      error: statusCode === 503 && outcome === 'outcome_unknown'
        ? 'Finance outcome unknown; reload or retry with the same Idempotency-Key'
        : statusCode === 503 ? 'Finance data is temporarily unavailable; retry'
        : statusCode === 401 ? 'Unauthorized'
          : statusCode === 403 ? 'Forbidden'
            : statusCode === 400 || statusCode === 422 ? (error as Error).message
              : 'Finance state changed; reload and retry',
      ...(outcome ? { outcome } : {}),
      ...(taskId ? { taskId } : {}),
    });
  }
}
