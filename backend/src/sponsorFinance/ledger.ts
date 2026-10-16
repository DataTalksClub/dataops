import { BatchGetCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { listCrmRecords, scanCrmPrefix } from '../db/sponsorCrm';
import { TABLE_BOOKKEEPING } from '../db/tableNames';
import { berlinDate, displayMoney, scaledMoney, sourceKey } from './core';
import { financeEnabled } from './repository';
import { deliveredOn } from './context';
import { daysBetween, deriveFollowUp, deriveStates, followUpUrgency } from './followUp';
import type { FinanceState, FollowUp, InvoiceState, PaymentState, RecordedPayment, TimingState, WaitingOn } from './types';

export type LedgerRow = {
  dealId: string;
  organizationId: string;
  organizationName: string;
  dealTitle?: string;
  dealStatus: string;
  productKind?: string;
  amountDue?: string;
  currency?: string;
  invoiceState: InvoiceState;
  paymentState: PaymentState;
  timingState: TimingState;
  invoiceNumber?: string;
  issuedOn?: string;
  sentOn?: string;
  dueOn?: string;
  daysOverdue?: number;
  paid?: string;
  outstanding?: string;
  lastPaymentOn?: string;
  /** Payments recorded before their bookkeeping row existed; a row that arrives confirms one. */
  recordedPayments?: Array<{ id: string; amount: string; receivedOn: string }>;
  deliveredOn?: string;
  nextDeliverableOn?: string;
  waitingOn?: WaitingOn;
  followUp: FollowUp;
};

export type ForecastBucket = { bucket: string; currency: string; amount: string; dealIds: string[] };

export type FinanceLedger = {
  asOf: string;
  rows: LedgerRow[];
  followUps: LedgerRow[];
  totals: Array<{ currency: string; outstanding: string; overdue: string; notInvoiced: string; paidThisYear: string }>;
  forecast: ForecastBucket[];
};

const FOLLOW_UP_CODES = new Set<FollowUp['code']>(['reconcile', 'unblock', 'payment-follow-up', 'send-invoice', 'classify']);

async function ledgerSources(client: DynamoDBDocumentClient, ids: string[]) {
  const found = new Map<string, Record<string, unknown>>();
  for (let index = 0; index < ids.length; index += 100) {
    let keys = ids.slice(index, index + 100).map((id) => ({ PK: sourceKey('transaction', id), SK: sourceKey('transaction', id) }));
    for (let attempt = 0; keys.length && attempt < 5; attempt++) {
      const result = await client.send(new BatchGetCommand({ RequestItems: { [TABLE_BOOKKEEPING]: { Keys: keys } } }));
      for (const item of (result.Responses?.[TABLE_BOOKKEEPING] || []) as Record<string, unknown>[]) found.set(String(item.id), item);
      keys = (result.UnprocessedKeys?.[TABLE_BOOKKEEPING]?.Keys || []) as typeof keys;
    }
    if (keys.length) throw Object.assign(new Error('Finance data is temporarily unavailable; retry'), { statusCode: 503 });
  }
  return found;
}

/**
 * Portfolio view of every deal's money: what to follow up on today, what is
 * outstanding, and when cash is expected. Built from stored finance state
 * plus linked ledger amounts; per-deal reconciliation proof stays in the
 * deal projection.
 */
export type CrmPreload = {
  organizations: Array<Record<string, unknown> & { id: string }>;
  deals: Array<Record<string, unknown> & { id: string }>;
  deliverables: Array<Record<string, unknown> & { id: string }>;
};

export async function financeLedger(
  client: DynamoDBDocumentClient,
  today = berlinDate(),
  preload?: CrmPreload,
): Promise<FinanceLedger> {
  const [organizations, deals, deliverables, financeItems] = await Promise.all([
    preload?.organizations ?? listCrmRecords(client, 'organization'),
    preload?.deals ?? listCrmRecords(client, 'deal'),
    preload?.deliverables ?? listCrmRecords(client, 'deliverable'),
    scanCrmPrefix(client, 'SPONSOR_FINANCE'),
  ]);
  const states = new Map<string, FinanceState>();
  const recorded = new Map<string, RecordedPayment>();
  for (const item of financeItems) {
    if (item.recordType === 'sponsor-finance') states.set(String(item.dealId), item as unknown as FinanceState);
    else if (item.recordType === 'sponsor-finance-payment') recorded.set(String(item.id), item as unknown as RecordedPayment);
  }
  const linkedIds = [...states.values()].flatMap((state) => state.paymentLinkIds.map((id) => id.split('#').at(-1)!));
  const sources = await ledgerSources(client, [...new Set(linkedIds)]);
  const orgName = new Map<string, string>(organizations.map((item) => [item.id, String(item.displayName || 'Unknown sponsor')]));
  const rows: LedgerRow[] = [];
  const totals = new Map<string, { outstanding: bigint; overdue: bigint; notInvoiced: bigint; paidThisYear: bigint }>();
  const forecast = new Map<string, { bucket: string; currency: string; amount: bigint; dealIds: string[] }>();
  const total = (currency: string) => {
    if (!totals.has(currency)) totals.set(currency, { outstanding: 0n, overdue: 0n, notInvoiced: 0n, paidThisYear: 0n });
    return totals.get(currency)!;
  };
  const addForecast = (bucket: string, currency: string, amount: bigint, dealId: string) => {
    const key = `${bucket}#${currency}`;
    const entry = forecast.get(key) || { bucket, currency, amount: 0n, dealIds: [] };
    entry.amount += amount;
    entry.dealIds.push(dealId);
    forecast.set(key, entry);
  };

  for (const deal of deals) {
    if (deal.archivedAt || deal.active === false || deal.status === 'lost') continue;
    const state = states.get(deal.id);
    const dealDeliverables = deliverables.filter((item) => item.dealId === deal.id && !item.archivedAt);
    const delivered = deliveredOn(dealDeliverables);
    const upcoming = dealDeliverables
      .filter((item) => !item.publishedAt && item.plannedPublicationDate && String(item.plannedPublicationDate) >= today)
      .map((item) => String(item.plannedPublicationDate)).sort()[0];
    const base = {
      dealId: deal.id,
      organizationId: String(deal.organizationId || ''),
      organizationName: orgName.get(String(deal.organizationId)) || 'Unknown sponsor',
      ...(typeof deal.title === 'string' && deal.title ? { dealTitle: deal.title } : {}),
      dealStatus: String(deal.status),
      ...(deal.productKind ? { productKind: String(deal.productKind) } : {}),
      ...(delivered ? { deliveredOn: delivered } : {}),
      ...(upcoming ? { nextDeliverableOn: upcoming } : {}),
    };
    if (!state) {
      rows.push({
        ...base, invoiceState: 'unclassified', paymentState: 'not-applicable', timingState: 'not-applicable',
        followUp: deriveFollowUp({ dealStatus: String(deal.status), invoiceState: 'unclassified', paymentState: 'not-applicable' }, today),
      });
      continue;
    }
    let coherent = true;
    let paid = 0n;
    const paymentDates: string[] = [];
    const yearPaid: bigint[] = [];
    for (const linkId of state.paymentLinkIds) {
      const source = sources.get(linkId.split('#').at(-1)!);
      if (!source || source.currency !== state.currency) { coherent = false; continue; }
      try {
        const amount = scaledMoney(source.amount);
        paid += amount;
        const date = String(source.paidDate || source.transactionDate || '');
        paymentDates.push(date);
        if (date.slice(0, 4) === today.slice(0, 4)) yearPaid.push(amount);
      } catch { coherent = false; }
    }
    const unconfirmed: NonNullable<LedgerRow['recordedPayments']> = [];
    for (const id of state.recordedPaymentIds || []) {
      const record = recorded.get(id);
      if (!record || record.currency !== state.currency) { coherent = false; continue; }
      unconfirmed.push({ id: record.paymentId, amount: record.amount, receivedOn: record.receivedOn });
      const amount = scaledMoney(record.amount);
      paid += amount;
      paymentDates.push(record.receivedOn);
      if (record.receivedOn.slice(0, 4) === today.slice(0, 4)) yearPaid.push(amount);
    }
    const due = state.amountDue ? scaledMoney(state.amountDue) : undefined;
    if (due !== undefined && paid > due) coherent = false;
    const states_ = deriveStates(state, paid, due, coherent, today);
    const followUp = deriveFollowUp({
      dealStatus: String(deal.status), ...states_,
      requestBy: state.invoiceRequestedAt ? undefined : state.requestBy,
      expectedInvoiceBy: state.expectedInvoiceBy, dueOn: state.dueOn, waitingOn: state.waitingOn, deliveredOn: delivered,
    }, today);
    const outstanding = due !== undefined && coherent ? due - paid : undefined;
    const row: LedgerRow = {
      ...base,
      ...(state.amountDue ? { amountDue: state.amountDue } : {}),
      ...(state.currency ? { currency: state.currency } : {}),
      ...states_,
      ...(state.invoiceNumber ? { invoiceNumber: state.invoiceNumber } : {}),
      ...(state.issuedOn ? { issuedOn: state.issuedOn } : {}),
      ...(state.sentOn ? { sentOn: state.sentOn } : {}),
      ...(state.dueOn ? { dueOn: state.dueOn } : {}),
      ...(states_.timingState === 'overdue' && state.dueOn ? { daysOverdue: daysBetween(state.dueOn, today) } : {}),
      ...(outstanding !== undefined ? { paid: displayMoney(paid), outstanding: displayMoney(outstanding) } : {}),
      ...(paymentDates.length ? { lastPaymentOn: paymentDates.sort().at(-1) } : {}),
      ...(unconfirmed.length ? { recordedPayments: unconfirmed } : {}),
      ...(state.waitingOn ? { waitingOn: state.waitingOn } : {}),
      followUp,
    };
    rows.push(row);
    if (!state.currency || state.voidedAt || state.invoiceRequirement !== 'required') continue;
    const bucket = total(state.currency);
    bucket.paidThisYear += yearPaid.reduce((sum, value) => sum + value, 0n);
    if (outstanding === undefined || outstanding <= 0n) continue;
    if (states_.invoiceState !== 'issued') {
      bucket.notInvoiced += outstanding;
      addForecast('not-invoiced', state.currency, outstanding, deal.id);
    } else {
      bucket.outstanding += outstanding;
      if (states_.timingState === 'overdue') {
        bucket.overdue += outstanding;
        addForecast('overdue', state.currency, outstanding, deal.id);
      } else {
        addForecast(state.dueOn ? state.dueOn.slice(0, 7) : 'no-due-date', state.currency, outstanding, deal.id);
      }
    }
  }

  rows.sort((left, right) =>
    followUpUrgency(left.followUp) - followUpUrgency(right.followUp)
    || String(left.followUp.since || '9999').localeCompare(String(right.followUp.since || '9999'))
    || left.organizationName.localeCompare(right.organizationName)
    || left.dealId.localeCompare(right.dealId));
  const order = (bucket: string) => bucket === 'overdue' ? '0' : bucket === 'not-invoiced' ? '9' : `1${bucket}`;
  return {
    asOf: today,
    rows,
    followUps: rows.filter((row) => row.followUp.party === 'us' && FOLLOW_UP_CODES.has(row.followUp.code)),
    totals: [...totals.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([currency, value]) => ({
      currency,
      outstanding: displayMoney(value.outstanding),
      overdue: displayMoney(value.overdue),
      notInvoiced: displayMoney(value.notInvoiced),
      paidThisYear: displayMoney(value.paidThisYear),
    })),
    forecast: [...forecast.values()]
      .sort((left, right) => order(left.bucket).localeCompare(order(right.bucket)) || left.currency.localeCompare(right.currency))
      .map((entry) => ({ ...entry, amount: displayMoney(entry.amount) })),
  };
}

/** Each deal's money facts from the ledger, keyed by deal id; empty while sponsor finance is off. */
export async function dealMoneyFacts(client: DynamoDBDocumentClient, today: string, preload: CrmPreload): Promise<Map<string, LedgerRow>> {
  const facts = new Map<string, LedgerRow>();
  if (!financeEnabled()) return facts;
  for (const row of (await financeLedger(client, today, preload)).rows) facts.set(row.dealId, row);
  return facts;
}
