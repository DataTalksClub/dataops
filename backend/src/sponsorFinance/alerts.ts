import {
  PutCommand,
  ScanCommand,
  UpdateCommand,
  type DynamoDBDocumentClient,
  type ScanCommandOutput,
} from '@aws-sdk/lib-dynamodb';
import { TABLE_NOTIFICATIONS, TABLE_SPONSOR_CRM } from '../db/tableNames';
import { berlinDate, digest } from './core';
import { financeEnabled, getFinanceState, projectFinance } from './repository';
import { deliveredOn } from './context';

type Condition = { dealId: string; rule: string; basisDate: string; version: number };

export async function evaluateSponsorFinanceAlerts(
  client: DynamoDBDocumentClient,
  today = berlinDate(),
): Promise<{ created: number; resolved: number }> {
  if (!financeEnabled()) return { created: 0, resolved: 0 };
  const deals: Record<string, unknown>[] = [];
  let cursor: Record<string, unknown> | undefined;
  do {
    const page: ScanCommandOutput = await client.send(new ScanCommand({
      TableName: TABLE_SPONSOR_CRM,
      FilterExpression: 'begins_with(PK, :prefix)',
      ExpressionAttributeValues: { ':prefix': 'DEAL#' },
      ExclusiveStartKey: cursor,
    }));
    deals.push(...(page.Items || []));
    cursor = page.LastEvaluatedKey;
  } while (cursor);
  const deliverables: Record<string, unknown>[] = [];
  cursor = undefined;
  do {
    const page: ScanCommandOutput = await client.send(new ScanCommand({
      TableName: TABLE_SPONSOR_CRM,
      FilterExpression: 'begins_with(PK, :prefix)',
      ExpressionAttributeValues: { ':prefix': 'DELIVERABLE#' },
      ExclusiveStartKey: cursor,
    }));
    deliverables.push(...(page.Items || []));
    cursor = page.LastEvaluatedKey;
  } while (cursor);
  const organizations: Record<string, unknown>[] = [];
  cursor = undefined;
  do {
    const page: ScanCommandOutput = await client.send(new ScanCommand({
      TableName: TABLE_SPONSOR_CRM,
      FilterExpression: 'begins_with(PK, :prefix)',
      ExpressionAttributeValues: { ':prefix': 'ORGANIZATION#' },
      ExclusiveStartKey: cursor,
    }));
    organizations.push(...(page.Items || []));
    cursor = page.LastEvaluatedKey;
  } while (cursor);
  const orgNames = new Map<string, string>(
    organizations.map((org) => [String(org.id), String(org.displayName || org.name || 'Sponsor')]),
  );
  const dealMap = new Map<string, Record<string, unknown>>(
    deals.map((deal) => [String(deal.id), deal]),
  );
  const cutoff60d = new Date(Date.parse(today) - 60 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const conditions: Condition[] = [];
  for (const deal of deals) {
    if (deal.archivedAt || deal.active !== true || deal.status === 'lost') {
      const state = await getFinanceState(client, String(deal.id));
      if (!state?.issuedOn || state.voidedAt) continue;
    }
    const delivered = deliveredOn(deliverables.filter((item) => item.dealId === deal.id));
    const projection = await projectFinance(client, String(deal.id), 'operator', {
      today, dealStatus: String(deal.status), ...(delivered ? { deliveredOn: delivered } : {}),
    });
    const pushCondition = (rule: string, basisDate: string, version: number) => {
      if (basisDate >= cutoff60d) {
        conditions.push({ dealId: String(deal.id), rule, basisDate, version });
      }
    };
    if (!projection.classified && (deal.status === 'agreed' || delivered)) {
      pushCondition('finance-unclassified', today, Number(deal.version));
      continue;
    }
    const finance = projection.finance;
    if (!finance || finance.invoiceRequirement !== 'required' || finance.voidedAt) continue;
    if (!finance.invoiceRequestedAt && finance.requestBy && finance.requestBy < today) {
      pushCondition('invoice-request-overdue', finance.requestBy, finance.version);
    }
    if (finance.invoiceRequestedAt && projection.invoiceState !== 'issued' && finance.expectedInvoiceBy && finance.expectedInvoiceBy < today) {
      pushCondition('invoice-missing', finance.expectedInvoiceBy, finance.version);
    }
    const invoiceFlagged = conditions.some((item) => item.dealId === String(deal.id));
    if (!invoiceFlagged && projection.followUp.code === 'send-invoice') {
      pushCondition(delivered ? 'invoice-after-delivery' : 'invoice-missing', delivered || String(deal.updatedAt || deal.createdAt || today).slice(0, 10), finance.version);
    }
    if (projection.followUp.code === 'unblock' && finance.waitingOn) {
      pushCondition('finance-waiting-on-us', finance.waitingOn.since, finance.version);
    }
    if (
      finance.dueOn
      && finance.dueOn < today
      && ['unpaid', 'partially-paid'].includes(projection.paymentState)
    ) {
      pushCondition('payment-overdue', finance.dueOn, finance.version);
    }
    if (projection.followUp.code === 'reconcile') {
      pushCondition('finance-reconciliation-required', today, finance.version);
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
    const continuing = existing.find((item) => {
      const metadata = item.metadata as Record<string, unknown>;
      return metadata.financeDealId === condition.dealId
        && metadata.financeRule === condition.rule && !item.resolvedAt;
    });
    if (continuing) {
      // Dismissal acknowledges a notification; it does not settle an invoice.
      // The existing sweep restores unresolved finance work without duplicating it.
      if (continuing.dismissed === true) {
        try {
          await client.send(new UpdateCommand({ TableName: TABLE_NOTIFICATIONS,
            Key: { PK: continuing.PK, SK: continuing.SK }, UpdateExpression: 'SET dismissed = :false',
            ConditionExpression: 'dismissed = :true AND attribute_not_exists(resolvedAt)',
            ExpressionAttributeValues: { ':false': false, ':true': true } }));
          created++;
        } catch (error) {
          if ((error as Error).name !== 'ConditionalCheckFailedException') throw error;
        }
      }
      continue;
    }
    const deal = dealMap.get(condition.dealId);
    const orgName = (deal && orgNames.get(String(deal.organizationId))) || deal?.title || 'Sponsor';
    const ruleLabels: Record<string, string> = {
      'finance-unclassified': 'finance details unclassified',
      'invoice-request-overdue': 'invoice request overdue',
      'invoice-missing': 'invoice missing',
      'invoice-after-delivery': 'invoice needed after delivery',
      'finance-waiting-on-us': 'blocked waiting on us',
      'payment-overdue': 'payment overdue',
      'finance-reconciliation-required': 'reconciliation required',
    };
    const actionLabel = ruleLabels[condition.rule] || 'finance follow-through needed';
    const message = `${orgName}: ${actionLabel}`;
    const id = `sponsor-finance-${condition.fingerprint}`;
    try {
      await client.send(new PutCommand({
        TableName: TABLE_NOTIFICATIONS,
        Item: {
          PK: `NOTIFICATION#${id}`, SK: `NOTIFICATION#${id}`, id,
          type: 'sponsor-finance', message,
          dueAt: condition.basisDate, dismissed: false, createdAt: new Date().toISOString(),
          metadata: {
            financeDealId: condition.dealId,
            financeRule: condition.rule,
            financeBasisDate: condition.basisDate,
            financeFingerprint: condition.fingerprint,
            route: `/sponsors/deals/${encodeURIComponent(condition.dealId)}`,
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
      condition.dealId === metadata.financeDealId && condition.rule === metadata.financeRule);
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
