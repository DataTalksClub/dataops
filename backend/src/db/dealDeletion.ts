import { ScanCommand, TransactWriteCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

import { usesLocalTransactionEmulation } from './client';
import { emulateTransaction } from './cardDeletion';
import { getCrmRecord } from './sponsorCrm';
import type { PlannedWrite } from './plannedWrite';
import { TABLE_SPONSOR_CRM, TABLE_TASKS } from './tableNames';

/**
 * Admin hard delete of a sponsor deal. A deal that already has a concrete
 * result attached (a booked newsletter slot/issue, a deliverable, or finance:
 * invoice, payment, settlement) is refused with a 409 naming it. Otherwise the
 * deal goes together with its history, notes, message-target index rows,
 * finance bookkeeping rows and subject Tasks in one transaction.
 */

type Dict = Record<string, unknown>;

const MAX_PAGES = 200;
const MAX_ITEMS = 100;

const statusError = (message: string, statusCode: number) => Object.assign(new Error(message), { statusCode });

async function scanMatching(client: DynamoDBDocumentClient, table: string, filter: string, values: Dict, names?: Record<string, string>) {
  const items: Dict[] = [];
  let start: Dict | undefined;
  let pages = 0;
  do {
    const page = await client.send(new ScanCommand({
      TableName: table,
      ConsistentRead: true,
      FilterExpression: filter,
      ExpressionAttributeValues: values,
      ...(names ? { ExpressionAttributeNames: names } : {}),
      ...(start ? { ExclusiveStartKey: start } : {}),
    }));
    items.push(...((page.Items || []) as Dict[]));
    start = page.LastEvaluatedKey as Dict | undefined;
    if (++pages >= MAX_PAGES && start) throw statusError('Deal storage scan exceeded its bounded page limit', 500);
  } while (start);
  return items;
}

const list = (ids: unknown[]) => ids.map(String).join(', ');

/** Why the deal cannot be deleted, one entry per blocking kind of result. */
function blockers(id: string, owned: Dict[]): string[] {
  const reasons: string[] = [];
  const deliverables = owned.filter(row => String(row.PK).startsWith('DELIVERABLE#'));
  const booked = deliverables.filter(row => row.newsletterIssueId);
  if (booked.length) reasons.push(`a booked newsletter slot/issue (issue ${list([...new Set(booked.map(row => row.newsletterIssueId))])})`);
  const plain = deliverables.filter(row => !row.newsletterIssueId);
  if (plain.length) reasons.push(`a deliverable (${list(plain.map(row => row.id))})`);
  const finance: string[] = [];
  const state = owned.find(row => row.PK === `SPONSOR_FINANCE#${id}`);
  const rows = (prefix: string) => owned.some(row => String(row.PK).startsWith(prefix));
  if (state?.invoiceNumber || state?.invoiceLinkId || state?.issuedOn || rows(`SPONSOR_FINANCE_LINK#${id}#document#`)) finance.push('invoice');
  if ((Array.isArray(state?.paymentLinkIds) && state.paymentLinkIds.length) ||
    (Array.isArray(state?.recordedPaymentIds) && state.recordedPaymentIds.length) ||
    rows(`SPONSOR_FINANCE_LINK#${id}#transaction#`) || rows(`SPONSOR_FINANCE_PAYMENT#${id}#`)) finance.push('payment');
  if (state?.settlementAdjustment) finance.push('settlement');
  if (finance.length) reasons.push(`finance (${finance.join(', ')})`);
  return reasons;
}

export async function hardDeleteDeal(client: DynamoDBDocumentClient, id: string, expectedVersion?: number) {
  const existing = await getCrmRecord(client, 'deal', id);
  if (!existing) throw statusError('Not found', 404);
  if (expectedVersion !== undefined && expectedVersion !== existing.version) {
    throw statusError('Record was changed; reload and retry', 409);
  }
  const historyPk = `HISTORY#${id}`;
  const notePk = `NOTE#deal:${id}`;
  const targetPk = `MESSAGE_TARGET#deal:${id}`;
  // Every row keyed to this deal. Shared MESSAGE# records stay: only this
  // deal's target index row goes.
  const owned = (await scanMatching(client, TABLE_SPONSOR_CRM,
    'dealId = :id OR PK = :history OR PK = :note OR PK = :target',
    { ':id': id, ':history': historyPk, ':note': notePk, ':target': targetPk }))
    .filter(row => row.PK !== `DEAL#${id}` && !String(row.PK).startsWith('MESSAGE#'));
  const reasons = blockers(id, owned);
  if (reasons.length) throw statusError(`Deal has ${reasons.join('; ')}; hard delete is refused`, 409);

  const tasks = await scanMatching(client, TABLE_TASKS, 'begins_with(PK, :prefix) AND #subject.#id = :id AND #subject.#type = :type',
    { ':prefix': 'TASK#', ':id': id, ':type': 'sponsor-deal' }, { '#subject': 'subject', '#id': 'id', '#type': 'type' });

  const dealKey = { PK: `DEAL#${id}`, SK: `DEAL#${id}` };
  const writes: PlannedWrite[] = [{
    tableName: TABLE_SPONSOR_CRM,
    key: dealKey,
    item: { Delete: {
      TableName: TABLE_SPONSOR_CRM, Key: dealKey,
      ConditionExpression: '#version = :version',
      ExpressionAttributeNames: { '#version': 'version' },
      ExpressionAttributeValues: { ':version': existing.version },
    } },
    holds: current => Boolean(current) && current!.version === existing.version,
    after: () => null,
  }];
  for (const row of owned) {
    const key = { PK: row.PK, SK: row.SK };
    writes.push({
      tableName: TABLE_SPONSOR_CRM, key,
      item: { Delete: { TableName: TABLE_SPONSOR_CRM, Key: key } },
      holds: () => true, after: () => null,
    });
  }
  for (const task of tasks) {
    const key = { PK: task.PK, SK: task.SK };
    writes.push({
      tableName: TABLE_TASKS, key,
      item: { Delete: {
        TableName: TABLE_TASKS, Key: key,
        ConditionExpression: '#version = :version',
        ExpressionAttributeNames: { '#version': 'version' },
        ExpressionAttributeValues: { ':version': task.version },
      } },
      holds: current => Boolean(current) && current!.version === task.version,
      after: () => null,
    });
  }
  // Never leave a half-deleted deal when its rows exceed the transaction limit.
  if (writes.length > MAX_ITEMS) throw statusError('Deal history exceeds the atomic hard-delete limit', 409);

  try {
    if (usesLocalTransactionEmulation()) await emulateTransaction(client, writes);
    else await client.send(new TransactWriteCommand({ TransactItems: writes.map(({ item }) => item) }));
  } catch (error) {
    if ((error as Error).name === 'TransactionCanceledException') throw statusError('Conflicting delete; reload and retry', 409);
    throw error;
  }
  return { id, deleted: true, deletedTaskIds: tasks.map(task => String(task.id)) };
}
