import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, ScanCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';

const client = DynamoDBDocumentClient.from(new DynamoDBClient({ region: 'eu-west-1' }));
const TABLE_NAME = 'dataops-v1-notifications';

const isApply = process.argv.includes('--apply');
const nowIso = new Date().toISOString();
const today = nowIso.slice(0, 10);
// 60 days ago
const cutoff60d = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
// 30 days ago
const cutoff30d = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

async function run() {
  console.log(`Running notification cleanup (${isApply ? 'APPLY' : 'DRY RUN'})...`);
  console.log(`Cutoff 60d: ${cutoff60d}, Cutoff 30d: ${cutoff30d}\n`);

  let cursor;
  const allItems = [];
  do {
    const res = await client.send(new ScanCommand({
      TableName: TABLE_NAME,
      ExclusiveStartKey: cursor,
    }));
    allItems.push(...(res.Items || []));
    cursor = res.LastEvaluatedKey;
  } while (cursor);

  const activeItems = allItems.filter(item => !item.dismissed);
  console.log(`Total notifications in table: ${allItems.length}`);
  console.log(`Currently active (undismissed): ${activeItems.length}`);
  console.log(`Currently dismissed: ${allItems.length - activeItems.length}\n`);

  const toDismiss = [];
  const toKeep = [];

  const seenFinanceKeys = new Set();
  const seenBookingAlertKeys = new Set();
  const seenTaskFollowUpKeys = new Set();

  for (const item of activeItems) {
    const createdDate = String(item.createdAt || '').slice(0, 10);
    const dueDate = String(item.dueAt || createdDate).slice(0, 10);

    // 1. Drop routine recurring-due spam
    if (item.type === 'recurring-due') {
      toDismiss.push({ item, reason: 'Drop routine recurring-due notification spam' });
      continue;
    }

    // 2. Drop routine stage-change noise (card auto-created)
    if (item.type === 'stage-change') {
      toDismiss.push({ item, reason: 'Drop routine stage-change card auto-creation noise' });
      continue;
    }

    // 3. Automation failures: archive old ones (>30 days old)
    if (item.type === 'automation-failure') {
      if (createdDate < cutoff30d) {
        toDismiss.push({ item, reason: 'Stale automation failure (>30d old)' });
      } else {
        toKeep.push({ item, reason: 'Recent automation failure' });
      }
      continue;
    }

    // 4. Sponsor finance: dedupe per deal+rule, drop items overdue >60 days
    if (item.type === 'sponsor-finance') {
      const dealId = item.metadata?.financeDealId || item.id;
      const rule = item.metadata?.financeRule || 'general';
      const key = `${dealId}#${rule}`;

      if (dueDate < cutoff60d) {
        toDismiss.push({ item, reason: `Stale sponsor finance follow-up (>60d overdue: ${dueDate})` });
      } else if (seenFinanceKeys.has(key)) {
        toDismiss.push({ item, reason: `Duplicate sponsor finance follow-up for deal ${dealId} rule ${rule}` });
      } else {
        seenFinanceKeys.add(key);
        toKeep.push({ item, reason: 'Actionable sponsor finance alert' });
      }
      continue;
    }

    // 5. Follow-up due: sponsor booking alerts vs task follow-ups
    if (item.type === 'follow-up-due') {
      const alertRule = item.metadata?.sponsorAlertRule;
      if (alertRule) {
        // Sponsor CRM booking alert
        const targetId = item.metadata?.sponsorDeliverableId || item.metadata?.sponsorDealId || item.id;
        const key = `${targetId}#${alertRule}`;
        if (dueDate < cutoff60d) {
          toDismiss.push({ item, reason: `Stale sponsor CRM alert (>60d overdue: ${dueDate})` });
        } else if (seenBookingAlertKeys.has(key)) {
          toDismiss.push({ item, reason: `Duplicate sponsor CRM alert for ${targetId} rule ${alertRule}` });
        } else {
          seenBookingAlertKeys.add(key);
          toKeep.push({ item, reason: 'Actionable sponsor CRM booking alert' });
        }
      } else {
        // Standard waiting task follow-up
        const taskId = item.taskId || item.id;
        const key = `${taskId}`;
        if (dueDate < cutoff60d) {
          toDismiss.push({ item, reason: `Stale task follow-up (>60d overdue: ${dueDate})` });
        } else if (seenTaskFollowUpKeys.has(key)) {
          toDismiss.push({ item, reason: `Duplicate follow-up for task ${taskId}` });
        } else {
          // Check if task is still in waiting status
          let isWaiting = false;
          let taskStatus = 'not-found';
          if (item.taskId) {
            try {
              const taskRes = await client.send(new GetCommand({
                TableName: 'dataops-v1-tasks',
                Key: { PK: `TASK#${item.taskId}`, SK: `TASK#${item.taskId}` },
              }));
              taskStatus = taskRes.Item?.status || 'deleted';
              isWaiting = taskStatus === 'waiting';
            } catch (err) {
              console.error(`Failed to get task ${item.taskId}:`, err);
            }
          }
          if (!isWaiting) {
            toDismiss.push({ item, reason: `Task already handled (status: ${taskStatus})` });
          } else {
            seenTaskFollowUpKeys.add(key);
            toKeep.push({ item, reason: 'Actionable task follow-up' });
          }
        }
      }
      continue;
    }

    // Any other type: keep if not clearly stale
    toKeep.push({ item, reason: 'Unknown / generic notification' });
  }

  console.log('--- CLEANUP BREAKDOWN ---');
  console.log(`Notifications to dismiss: ${toDismiss.length}`);
  const dismissByReason = {};
  for (const d of toDismiss) {
    dismissByReason[d.reason] = (dismissByReason[d.reason] || 0) + 1;
  }
  for (const [r, c] of Object.entries(dismissByReason)) {
    console.log(`  - ${r}: ${c}`);
  }

  console.log(`\nNotifications to KEEP active: ${toKeep.length}`);
  const keepByType = {};
  for (const k of toKeep) {
    keepByType[k.item.type] = (keepByType[k.item.type] || 0) + 1;
    console.log(`  [${k.item.type}] "${k.item.message}" (due: ${k.item.dueAt || 'none'}) -> ${k.reason}`);
  }
  console.log('\nKeep by type:', keepByType);

  if (isApply) {
    console.log(`\nApplying updates to DynamoDB: dismissing ${toDismiss.length} items...`);
    let updated = 0;
    for (const { item } of toDismiss) {
      await client.send(new UpdateCommand({
        TableName: TABLE_NAME,
        Key: { PK: item.PK, SK: item.SK },
        UpdateExpression: 'SET dismissed = :true, dismissedAt = :now, dismissedReason = :reason',
        ExpressionAttributeValues: {
          ':true': true,
          ':now': nowIso,
          ':reason': 'notifications-hygiene-2026-10-17'
        }
      }));
      updated++;
      if (updated % 50 === 0) {
        console.log(`Dismissed ${updated}/${toDismiss.length}...`);
      }
    }
    console.log(`SUCCESS: Dismissed ${updated} notifications.`);
  } else {
    console.log('\nDRY RUN complete. Run with --apply to execute.');
  }
}

run().catch(console.error);
