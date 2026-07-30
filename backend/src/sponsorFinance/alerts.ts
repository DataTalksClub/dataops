import {
  PutCommand,
  ScanCommand,
  UpdateCommand,
  type DynamoDBDocumentClient,
  type ScanCommandOutput,
} from '@aws-sdk/lib-dynamodb';
import { TABLE_NOTIFICATIONS, TABLE_SPONSOR_CRM } from '../db/setup';
import { berlinDate, digest } from './core';
import { financeEnabled, projectFinance } from './repository';

type Condition = { bookingId: string; rule: string; basisDate: string; version: number };

export async function evaluateSponsorFinanceAlerts(
  client: DynamoDBDocumentClient,
  today = berlinDate(),
): Promise<{ created: number; resolved: number }> {
  if (!financeEnabled()) return { created: 0, resolved: 0 };
  const bookings: Record<string, unknown>[] = [];
  let cursor: Record<string, unknown> | undefined;
  do {
    const page: ScanCommandOutput = await client.send(new ScanCommand({
      TableName: TABLE_SPONSOR_CRM,
      FilterExpression: 'begins_with(PK, :prefix)',
      ExpressionAttributeValues: { ':prefix': 'BOOKING#' },
      ExclusiveStartKey: cursor,
    }));
    bookings.push(...(page.Items || []));
    cursor = page.LastEvaluatedKey;
  } while (cursor);
  const conditions: Condition[] = [];
  for (const booking of bookings) {
    if (booking.archivedAt || booking.active !== true || ['cancelled', 'complete'].includes(String(booking.status))) continue;
    const projection = await projectFinance(client, String(booking.id), 'operator');
    if (!projection.classified && booking.status === 'confirmed') {
      conditions.push({ bookingId: String(booking.id), rule: 'finance-unclassified', basisDate: today, version: Number(booking.version) });
      continue;
    }
    const finance = projection.finance;
    if (!finance || finance.invoiceRequirement !== 'required' || finance.voidedAt) continue;
    if (!finance.invoiceRequestedAt && finance.requestBy && finance.requestBy < today) {
      conditions.push({ bookingId: String(booking.id), rule: 'invoice-request-overdue', basisDate: finance.requestBy, version: finance.version });
    }
    if (finance.invoiceRequestedAt && projection.invoiceState !== 'issued' && finance.expectedInvoiceBy && finance.expectedInvoiceBy < today) {
      conditions.push({ bookingId: String(booking.id), rule: 'invoice-missing', basisDate: finance.expectedInvoiceBy, version: finance.version });
    }
    if (
      finance.dueOn
      && finance.dueOn < today
      && ['unpaid', 'partially-paid'].includes(projection.paymentState)
    ) {
      conditions.push({ bookingId: String(booking.id), rule: 'payment-overdue', basisDate: finance.dueOn, version: finance.version });
    }
    if (projection.reconciliationStatus === 'reconciliation-required') {
      conditions.push({ bookingId: String(booking.id), rule: 'finance-reconciliation-required', basisDate: today, version: finance.version });
    }
  }
  const wanted = new Map(conditions.map((condition) => {
    const fingerprint = digest(condition);
    return [fingerprint, { ...condition, fingerprint }];
  }));
  const existing: Record<string, unknown>[] = [];
  cursor = undefined;
  do {
    const page: ScanCommandOutput = await client.send(new ScanCommand({
      TableName: TABLE_NOTIFICATIONS,
      FilterExpression: 'begins_with(PK, :prefix)',
      ExpressionAttributeValues: { ':prefix': 'NOTIFICATION#' },
      ExclusiveStartKey: cursor,
    }));
    existing.push(...(page.Items || []).filter(
      (item: Record<string, unknown>) => (item.metadata as Record<string, unknown> | undefined)?.financeFingerprint,
    ));
    cursor = page.LastEvaluatedKey;
  } while (cursor);
  let created = 0, resolved = 0;
  for (const condition of wanted.values()) {
    const continuing = existing.some((item) => {
      const metadata = item.metadata as Record<string, unknown>;
      return metadata.financeBookingId === condition.bookingId
        && metadata.financeRule === condition.rule && !item.resolvedAt;
    });
    if (continuing) continue;
    const id = `sponsor-finance-${condition.fingerprint}`;
    try {
      await client.send(new PutCommand({
        TableName: TABLE_NOTIFICATIONS,
        Item: {
          PK: `NOTIFICATION#${id}`, SK: `NOTIFICATION#${id}`, id,
          type: 'sponsor-finance', message: 'Sponsor finance follow-through needs attention.',
          dueAt: condition.basisDate, dismissed: false, createdAt: new Date().toISOString(),
          metadata: {
            financeBookingId: condition.bookingId,
            financeRule: condition.rule,
            financeBasisDate: condition.basisDate,
            financeFingerprint: condition.fingerprint,
            route: `/sponsors?booking=${condition.bookingId}`,
          },
        },
        ConditionExpression: 'attribute_not_exists(PK)',
      }));
      created++;
    } catch (error) {
      if ((error as Error).name !== 'ConditionalCheckFailedException') throw error;
    }
  }
  for (const item of existing) {
    if (item.resolvedAt) continue;
    const metadata = item.metadata as Record<string, unknown>;
    const stillWanted = [...wanted.values()].some((condition) =>
      condition.bookingId === metadata.financeBookingId && condition.rule === metadata.financeRule);
    if (stillWanted) continue;
    try {
      await client.send(new UpdateCommand({
        TableName: TABLE_NOTIFICATIONS,
        Key: { PK: item.PK, SK: item.SK },
        UpdateExpression: 'SET resolvedAt = :now, dismissed = :true',
        ConditionExpression: 'attribute_not_exists(resolvedAt)',
        ExpressionAttributeValues: { ':now': new Date().toISOString(), ':true': true },
      }));
      resolved++;
    } catch (error) {
      if ((error as Error).name !== 'ConditionalCheckFailedException') throw error;
    }
  }
  return { created, resolved };
}
