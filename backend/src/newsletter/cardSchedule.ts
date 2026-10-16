/**
 * When a newsletter issue gets its Card, and what removing one keeps.
 *
 * An issue is planned (date, slots, sponsors, links) without a Card. The
 * daily run creates the Card `newsletterCardLeadDays` days before the issue
 * goes out (a workspace setting), or earlier when the Template has a Task due
 * further ahead, so no Task is born overdue. "Create card now" on the issue
 * creates it at any time. Every issue has at most one Card: creating it
 * replaces the issue row at the version it read, in the same transaction.
 */
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

import { listNewsletterIssues, type NewsletterIssue } from '../db/newsletterIssues';
import { listTemplates } from '../db/templates';
import { getWorkspaceSettings, resolveDefaultAssigneeId } from '../db/workspaceSettings';
import type { VerifiedActor } from '../identity/actor';
import type { Template } from '../types';
import { dateFromTemplateOffset } from '../templates/cardTemplateProjection';
import { createIssueCard, ISSUE_TEMPLATE_TYPE, issueLabel } from './issueCard';

/** Days before the issue date its Card is due: the setting, or the Template's earliest Task offset if earlier. */
export function issueCardLeadDays(template: Pick<Template, 'taskDefinitions'>, settingDays: number): number {
  const earliest = Math.min(0, ...(template.taskDefinitions || []).map((definition) => definition.offsetDays || 0));
  return Math.max(settingDays, -earliest);
}

export type CardSchedule = {
  /** Lead days per issue kind; absent when the kind's Template is missing. */
  leadDays: Partial<Record<NewsletterIssue['kind'], number>>;
  templates: Partial<Record<NewsletterIssue['kind'], Template>>;
};

export async function loadCardSchedule(client: DynamoDBDocumentClient): Promise<CardSchedule> {
  const [templates, settings] = await Promise.all([listTemplates(client), getWorkspaceSettings(client)]);
  const schedule: CardSchedule = { leadDays: {}, templates: {} };
  for (const kind of Object.keys(ISSUE_TEMPLATE_TYPE) as NewsletterIssue['kind'][]) {
    const template = templates.find((candidate) => candidate.type === ISSUE_TEMPLATE_TYPE[kind]);
    if (!template) continue;
    schedule.templates[kind] = template;
    schedule.leadDays[kind] = issueCardLeadDays(template, settings.newsletterCardLeadDays);
  }
  return schedule;
}

/** The day the daily run creates the issue's Card, or null without a Template. */
export function cardDueDate(issue: Pick<NewsletterIssue, 'kind' | 'publicationDate'>, schedule: CardSchedule): string | null {
  const lead = schedule.leadDays[issue.kind];
  return lead === undefined ? null : dateFromTemplateOffset(issue.publicationDate, -lead);
}

/** An issue that should get a Card: active, in the future, without one. */
export const needsCard = (issue: NewsletterIssue, today: string) =>
  !issue.cardId && !['cancelled', 'sent'].includes(issue.status) && issue.publicationDate >= today;

/** The actor the daily run creates Cards as: owned by the default assignee, if any. */
export async function systemCardActor(client: DynamoDBDocumentClient): Promise<{ actor: VerifiedActor; ownerId: string | null }> {
  const ownerId = await resolveDefaultAssigneeId(client);
  return { actor: { id: 'system', user: null, role: null, isAdmin: true, testBypass: false }, ownerId };
}

export type DueCardRun = {
  today: string;
  dryRun: boolean;
  created: { issueId: string; label: string; publicationDate: string; cardId: string }[];
  due: { issueId: string; label: string; publicationDate: string; cardDueDate: string }[];
  failures: { issueId: string; label: string; error: string }[];
};

/**
 * Create the Card of every issue whose Card is due by `today`. Idempotent:
 * an issue that has a Card is skipped, and two runs racing for the same issue
 * cannot both win, because the Card is written with the issue row at the
 * version both read.
 */
export async function createDueIssueCards(
  client: DynamoDBDocumentClient,
  today: string,
  options: { dryRun?: boolean } = {},
): Promise<DueCardRun> {
  const run: DueCardRun = { today, dryRun: Boolean(options.dryRun), created: [], due: [], failures: [] };
  const candidates = (await listNewsletterIssues(client, today, '9999-12-31')).filter((issue) => needsCard(issue, today));
  if (!candidates.length) return run;
  const schedule = await loadCardSchedule(client);
  const due = candidates.filter((issue) => {
    const date = cardDueDate(issue, schedule);
    return date !== null && date <= today;
  });
  for (const kind of new Set(candidates.map((issue) => issue.kind))) {
    if (schedule.leadDays[kind] === undefined) {
      for (const issue of candidates.filter((candidate) => candidate.kind === kind)) {
        run.failures.push({ issueId: issue.id, label: issueLabel(issue), error: `No ${ISSUE_TEMPLATE_TYPE[kind]} Template is available` });
      }
    }
  }
  for (const issue of due) {
    run.due.push({ issueId: issue.id, label: issueLabel(issue), publicationDate: issue.publicationDate, cardDueDate: cardDueDate(issue, schedule)! });
  }
  if (run.dryRun || !due.length) return run;
  const { actor, ownerId } = await systemCardActor(client);
  for (const issue of due) {
    try {
      const created = await createIssueCard(client, actor, issue, { ownerId });
      if (!created.ok) {
        run.failures.push({ issueId: issue.id, label: issueLabel(issue), error: JSON.parse(created.response.body).error });
        continue;
      }
      run.created.push({ issueId: issue.id, label: issueLabel(issue), publicationDate: issue.publicationDate, cardId: created.card.id });
    } catch (error) {
      const name = (error as Error).name;
      // Another run or a person created it first: the issue changed under us.
      const message = name === 'TransactionCanceledException' ? 'The issue changed while its Card was being created' : (error as Error).message;
      run.failures.push({ issueId: issue.id, label: issueLabel(issue), error: message });
    }
  }
  return run;
}
