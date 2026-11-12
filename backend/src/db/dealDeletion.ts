import { ScanCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { randomUUID } from 'node:crypto';

import { transactWrite } from './transactWrite';
import { getCrmRecord } from './sponsorCrm';
import type { PlannedWrite } from './plannedWrite';
import { TABLE_BOOKKEEPING, TABLE_SPONSOR_CRM, TABLE_TASKS } from './tableNames';

/**
 * Admin hard delete of a sponsor deal. The explicit withDeliverables flag
 * authorizes deleting every deliverable, including one for a booked newsletter
 * slot. Finance source records stay in bookkeeping; their deal links are
 * released and deal-owned finance state is archived without active links.
 * The deal and its remaining owned rows go in one transaction.
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

/** Why the deal cannot be deleted without explicit deliverable confirmation. */
function blockers(owned: Dict[], allowDeliverables = false): string[] {
  if (allowDeliverables) return [];
  const reasons: string[] = [];
  const deliverables = owned.filter(row => String(row.PK).startsWith('DELIVERABLE#'));
  const booked = deliverables.filter(row => row.newsletterIssueId || row.scheduleEntryId);
  if (booked.length) {
    const bookings = booked.map(row => row.newsletterIssueId ? `issue ${row.newsletterIssueId}` : `slot ${row.scheduleEntryId}`);
    reasons.push(`a booked newsletter slot/issue (${list([...new Set(bookings)])})`);
  }
  const plain = deliverables.filter(row => !row.newsletterIssueId && !row.scheduleEntryId);
  if (plain.length) reasons.push(`a deliverable (${list(plain.map(row => row.id))})`);
  return reasons;
}

function isFinanceAuditRow(row: Dict): boolean {
  return String(row.PK).startsWith('SPONSOR_FINANCE_HISTORY#') ||
    String(row.PK).startsWith('SPONSOR_FINANCE_RECEIPT#');
}

function financeArchiveRecord(row: Dict, dealId: string, detachedAt: string) {
  const isState = row.PK === `SPONSOR_FINANCE#${dealId}`;
  const sourceRecordId = String(row.paymentId || row.id || String(row.SK).split('#').at(-1) || row.PK);
  const archiveKey = {
    PK: `SPONSOR_FINANCE_ARCHIVE#${dealId}`,
    SK: isState ? 'STATE' : `PAYMENT#${sourceRecordId}`,
  };
  const fields = { ...row };
  for (const field of ['PK', 'SK', 'id', 'dealId', 'invoiceLinkId', 'paymentLinkIds', 'recordedPaymentIds', 'paymentFollowUpTaskIds']) {
    delete fields[field];
  }
  return {
    ...archiveKey,
    ...fields,
    recordType: isState ? 'detached-sponsor-finance' : 'detached-sponsor-finance-payment',
    sourceRecordId,
    formerDealId: dealId,
    detachedAt,
  };
}

function conditionalDelete(
  tableName: string,
  row: Dict,
  dealId: string,
): PlannedWrite {
  const key = { PK: row.PK, SK: row.SK };
  const names: Record<string, string> = {};
  const values: Dict = {};
  const conditions = ['attribute_exists(PK)'];
  if (row.dealId !== undefined) {
    names['#dealId'] = 'dealId'; values[':dealId'] = dealId; conditions.push('#dealId = :dealId');
  }
  if (row.version !== undefined) {
    names['#version'] = 'version'; values[':version'] = row.version; conditions.push('#version = :version');
  }
  if (row.recordType !== undefined) {
    names['#recordType'] = 'recordType'; values[':recordType'] = row.recordType; conditions.push('#recordType = :recordType');
  }
  return {
    tableName, key,
    item: { Delete: {
      TableName: tableName, Key: key,
      ConditionExpression: conditions.join(' AND '),
      ...(Object.keys(names).length ? { ExpressionAttributeNames: names } : {}),
      ...(Object.keys(values).length ? { ExpressionAttributeValues: values } : {}),
    } },
    holds: current => Boolean(current) &&
      (row.dealId === undefined || current!.dealId === dealId) &&
      (row.version === undefined || current!.version === row.version) &&
      (row.recordType === undefined || current!.recordType === row.recordType),
    after: () => null,
  };
}

function archiveWrite(row: Dict, dealId: string, detachedAt: string): PlannedWrite {
  const archived = financeArchiveRecord(row, dealId, detachedAt);
  const key = { PK: archived.PK, SK: archived.SK };
  return {
    tableName: TABLE_SPONSOR_CRM, key,
    item: { Put: {
      TableName: TABLE_SPONSOR_CRM, Item: archived,
      ConditionExpression: 'attribute_not_exists(PK) AND attribute_not_exists(SK)',
    } },
    holds: current => !current,
    after: () => archived,
  };
}

function financeClaimDelete(row: Dict, dealId: string): PlannedWrite {
  const key = { PK: row.PK, SK: row.SK };
  return {
    tableName: TABLE_BOOKKEEPING, key,
    item: { Delete: {
      TableName: TABLE_BOOKKEEPING, Key: key,
      ConditionExpression: 'recordType = :type AND dealId = :dealId',
      ExpressionAttributeValues: {
        ':type': 'sponsor-finance-claim', ':dealId': dealId,
      },
    } },
    holds: current => Boolean(current) && current!.recordType === 'sponsor-finance-claim' &&
      current!.dealId === dealId,
    after: () => null,
  };
}

export async function hardDeleteDeal(
  client: DynamoDBDocumentClient,
  id: string,
  expectedVersion?: number,
  options: { withDeliverables?: boolean; apply?: boolean; actorId?: string } = {},
) {
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
    'dealId = :id OR PK = :history OR PK = :note OR PK = :target OR PK = :financeState OR begins_with(PK, :financePayment) OR begins_with(PK, :financeLink)',
    {
      ':id': id, ':history': historyPk, ':note': notePk, ':target': targetPk,
      ':financeState': `SPONSOR_FINANCE#${id}`,
      ':financePayment': `SPONSOR_FINANCE_PAYMENT#${id}#`,
      ':financeLink': `SPONSOR_FINANCE_LINK#${id}#`,
    }))
    .filter(row => row.PK !== `DEAL#${id}` && !String(row.PK).startsWith('MESSAGE#'));
  const reasons = blockers(owned, options.withDeliverables === true);
  if (reasons.length) throw statusError(`Deal has ${reasons.join('; ')}; pass withDeliverables: true to remove them`, 409);

  const financeClaims = await scanMatching(client, TABLE_BOOKKEEPING,
    'recordType = :type AND dealId = :id',
    { ':type': 'sponsor-finance-claim', ':id': id });

  const tasks = await scanMatching(client, TABLE_TASKS, 'begins_with(PK, :prefix) AND #subject.#id = :id AND #subject.#type = :type',
    { ':prefix': 'TASK#', ':id': id, ':type': 'sponsor-deal' }, { '#subject': 'subject', '#id': 'id', '#type': 'type' });

  const deliverables = owned.filter(row => String(row.PK).startsWith('DELIVERABLE#'));
  const financeLinks = owned.filter(row => String(row.PK).startsWith(`SPONSOR_FINANCE_LINK#${id}#`));
  const financeRecords = owned.filter(row => row.PK === `SPONSOR_FINANCE#${id}` ||
    String(row.PK).startsWith(`SPONSOR_FINANCE_PAYMENT#${id}#`));
  const retainedFinanceAuditRows = owned.filter(isFinanceAuditRow);
  const rowsToDelete = owned.filter(row => !financeRecords.includes(row) && !retainedFinanceAuditRows.includes(row));
  const detachedAt = new Date().toISOString();
  const archivedFinanceRecords = financeRecords.map(row => financeArchiveRecord(row, id, detachedAt));
  const detachedFinanceSourceIds = [...new Set([...financeLinks, ...financeClaims].map(row => String(row.sourceId || row.id || row.PK)))];
  const retainedNewsletterSlotIds = [...new Set(deliverables.flatMap(row => [row.newsletterIssueId, row.scheduleEntryId]
    .filter((value): value is string => typeof value === 'string' && value.length > 0)))];
  const snapshot = {
    deal: existing,
    deliverables,
    deletedRelatedRowKeys: rowsToDelete.filter(row => !deliverables.includes(row)).map(row => ({ PK: row.PK, SK: row.SK })),
    detachedFinanceSourceIds,
    retainedNewsletterSlotIds,
    archivedFinanceRecordKeys: archivedFinanceRecords.map(row => ({ PK: row.PK, SK: row.SK })),
    retainedFinanceAuditKeys: retainedFinanceAuditRows.map(row => ({ PK: row.PK, SK: row.SK })),
    deletedTaskIds: tasks.map(task => String(task.id)),
  };
  const apply = options.apply !== false;
  const result = {
    id,
    mode: apply ? 'applied' : 'dry-run',
    deleted: apply,
    deletedDeliverableIds: deliverables.map(row => String(row.id)),
    detachedFinanceSourceIds,
    retainedNewsletterSlotIds,
    archivedFinanceRecordIds: archivedFinanceRecords.map(row => String(row.sourceRecordId)),
    deletedTaskIds: tasks.map(task => String(task.id)),
    auditSnapshotRetained: apply,
  };
  if (!apply) return result;

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
  for (const row of financeRecords) {
    writes.push(archiveWrite(row, id, detachedAt));
    writes.push(conditionalDelete(TABLE_SPONSOR_CRM, row, id));
  }
  for (const row of financeClaims) writes.push(financeClaimDelete(row, id));
  for (const row of rowsToDelete) {
    writes.push(conditionalDelete(TABLE_SPONSOR_CRM, row, id));
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
  const auditId = `${new Date().toISOString()}#${randomUUID()}`;
  const auditKey = { PK: `DEAL_DELETE_AUDIT#${id}`, SK: auditId };
  writes.push({
    tableName: TABLE_SPONSOR_CRM,
    key: auditKey,
    item: { Put: {
      TableName: TABLE_SPONSOR_CRM,
      Item: {
        ...auditKey,
        entityKind: 'deal-delete-audit',
        entityId: id,
        actorId: options.actorId || 'unknown',
        deletedAt: new Date().toISOString(),
        snapshot,
      },
      ConditionExpression: 'attribute_not_exists(PK) AND attribute_not_exists(SK)',
    } },
    holds: current => !current,
    after: () => ({ ...auditKey, entityKind: 'deal-delete-audit', entityId: id, actorId: options.actorId || 'unknown', deletedAt: new Date().toISOString(), snapshot }),
  });
  // Never leave a half-deleted deal when its rows exceed the transaction limit.
  if (writes.length > MAX_ITEMS) throw statusError('Deal history exceeds the atomic hard-delete limit', 409);

  try {
    await transactWrite(client, writes.map(({ item }) => item));
  } catch (error) {
    if ((error as Error).name === 'TransactionCanceledException') throw statusError('Conflicting delete; reload and retry', 409);
    throw error;
  }
  return { ...result, auditSnapshotRetained: true };
}
