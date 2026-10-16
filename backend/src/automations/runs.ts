/**
 * The last run of each automation that records one: when it ran, whether it
 * succeeded, and a one-line summary. One item per automation in the Users
 * table, next to the workspace settings record, overwritten on every run;
 * history lives in notifications and logs, not here.
 */

import { GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

import { TABLE_USERS } from '../db/tableNames';

export interface AutomationRun {
  at: string;
  ok: boolean;
  summary: string;
}

const runKey = (id: string) => ({ PK: `AUTOMATION#${id}`, SK: 'LAST_RUN' });

/**
 * Record a run. A failure to record is logged, never thrown: bookkeeping about
 * a job must not fail the job.
 */
export async function recordAutomationRun(
  client: DynamoDBDocumentClient,
  id: string,
  run: { ok: boolean; summary: string },
  at: Date = new Date(),
): Promise<void> {
  try {
    await client.send(new PutCommand({
      TableName: TABLE_USERS,
      Item: { ...runKey(id), automationId: id, at: at.toISOString(), ok: run.ok, summary: run.summary },
    }));
  } catch (error) {
    console.error(`Could not record the run of automation ${id}: ${(error as Error).message}`);
  }
}

export async function getAutomationRuns(
  client: DynamoDBDocumentClient,
  ids: string[],
): Promise<Map<string, AutomationRun>> {
  const items = await Promise.all(ids.map(async (id) => (await client.send(new GetCommand({
    TableName: TABLE_USERS,
    Key: runKey(id),
  }))).Item));
  const runs = new Map<string, AutomationRun>();
  for (const item of items) {
    if (item) runs.set(String(item.automationId), { at: String(item.at), ok: item.ok === true, summary: String(item.summary || '') });
  }
  return runs;
}
