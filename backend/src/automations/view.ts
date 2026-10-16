/**
 * The automations overview as the browser and the CLI read it: each registry
 * entry with its schedule in words, its next run, its last run where one is
 * cheaply known, and the current value of each setting it reads.
 */

import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

import { getWorkspaceSettings } from '../db/workspaceSettings';
import { createKnowledgeStore, knowledgeStoreConfigFromEnv } from '../docs/knowledgeStore';
import { AUTOMATIONS, type AutomationDefinition, type AutomationSchedule, type AutomationSettingSpec } from './registry';
import { getAutomationRuns, type AutomationRun } from './runs';

export interface AutomationView {
  id: string;
  name: string;
  description: string;
  runsIn: string;
  scheduleLabel: string;
  /** ISO instant of the next scheduled run; null for event-driven or sub-hourly automations. */
  nextRunAt: string | null;
  /** `null` when the automation records nothing the portal can read. */
  lastRun: (AutomationRun & { source: 'recorded' | 'knowledge-checkpoint' }) | null;
  link: string | null;
  settings: Array<AutomationSettingSpec & { value: unknown }>;
}

export interface AutomationsOverview {
  automations: AutomationView[];
  /** Workspace settings version, for a settings change to send back. */
  settingsVersion: number;
}

/** A daily cron as `{hour, minute}` in UTC, or null for anything else. */
export function dailyCronTime(expression: string): { hour: number; minute: number } | null {
  const bare = expression.trim().replace(/^cron\((.*)\)$/, '$1').trim();
  const fields = bare.split(/\s+/);
  if (fields.length !== 5 && fields.length !== 6) return null;
  const [minute, hour, dayOfMonth, month, dayOfWeek, year = '*'] = fields;
  if (!/^\d{1,2}$/.test(minute) || !/^\d{1,2}$/.test(hour)) return null;
  if (month !== '*' || year !== '*') return null;
  const anyDay = (value: string) => value === '*' || value === '?';
  if (!anyDay(dayOfMonth) || !anyDay(dayOfWeek)) return null;
  return { hour: Number(hour), minute: Number(minute) };
}

const pad = (value: number) => String(value).padStart(2, '0');

export function scheduleLabel(schedule: AutomationSchedule): string {
  if (schedule.kind === 'event') return schedule.trigger;
  if (schedule.kind === 'interval') return schedule.minutes === 1 ? 'Every minute' : `Every ${schedule.minutes} minutes`;
  const daily = dailyCronTime(schedule.expression);
  return daily ? `Daily at ${pad(daily.hour)}:${pad(daily.minute)} UTC` : schedule.expression;
}

export function nextRunAt(schedule: AutomationSchedule, now: Date): string | null {
  if (schedule.kind !== 'cron') return null;
  const daily = dailyCronTime(schedule.expression);
  if (!daily) return null;
  const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), daily.hour, daily.minute));
  if (next.getTime() <= now.getTime()) next.setUTCDate(next.getUTCDate() + 1);
  return next.toISOString();
}

/** Reads `jobs/<job>/success.json`, the knowledge worker's last success; null when unknown. */
export type KnowledgeCheckpointReader = (job: string) => Promise<{ at: string } | null>;

const readKnowledgeCheckpoint: KnowledgeCheckpointReader = async (job) => {
  const store = createKnowledgeStore(knowledgeStoreConfigFromEnv());
  if (!store.bucket) return null;
  try {
    const { value } = await store.json<{ at?: unknown }>(`jobs/${job}/success.json`);
    return typeof value.at === 'string' ? { at: value.at } : null;
  } catch (error) {
    if (['NoSuchKey', 'NotFound'].includes((error as Error).name)) return null;
    throw error;
  }
};

async function lastRunOf(
  automation: AutomationDefinition,
  recorded: Map<string, AutomationRun>,
  readCheckpoint: KnowledgeCheckpointReader,
): Promise<AutomationView['lastRun']> {
  if (automation.runSource === 'recorded') {
    const run = recorded.get(automation.id);
    return run ? { ...run, source: 'recorded' } : null;
  }
  if (automation.runSource === 'knowledge-checkpoint') {
    const checkpoint = await readCheckpoint(automation.id);
    return checkpoint ? { at: checkpoint.at, ok: true, summary: 'Last success', source: 'knowledge-checkpoint' } : null;
  }
  return null;
}

export async function automationsOverview(
  client: DynamoDBDocumentClient,
  options: { now?: Date; readCheckpoint?: KnowledgeCheckpointReader } = {},
): Promise<AutomationsOverview> {
  const now = options.now || new Date();
  const readCheckpoint = options.readCheckpoint || readKnowledgeCheckpoint;
  const [settings, recorded] = await Promise.all([
    getWorkspaceSettings(client),
    getAutomationRuns(client, AUTOMATIONS.filter((automation) => automation.runSource === 'recorded').map((automation) => automation.id)),
  ]);
  const automations = await Promise.all(AUTOMATIONS.map(async (automation): Promise<AutomationView> => ({
    id: automation.id,
    name: automation.name,
    description: automation.description,
    runsIn: automation.runsIn,
    scheduleLabel: scheduleLabel(automation.schedule),
    nextRunAt: nextRunAt(automation.schedule, now),
    lastRun: await lastRunOf(automation, recorded, readCheckpoint),
    link: automation.link || null,
    settings: automation.settings.map((setting) => ({
      ...setting,
      value: (settings as unknown as Record<string, unknown>)[setting.key],
    })),
  })));
  return { automations, settingsVersion: settings.version };
}
