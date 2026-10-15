/**
 * The Card of a newsletter issue.
 *
 * Every issue that is not cancelled has exactly one Card, created from the
 * Template of its kind (weekly -> `newsletter`, stand-alone ->
 * `newsletter-standalone`) in the same transaction as the issue row. A weekly
 * issue's ticked slots select the Template's optional task groups
 * (`primary-slot`, `secondary-slot`): ticking a slot adds its sponsor Tasks to
 * the Card, unticking skips its open ones. The issue owns the shared facts
 * (date, issue number, sponsors, title) and pushes them onto the Card.
 */
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

import { getCardConsistent } from '../db/cards';
import { applyCardTemplateUpdate } from '../db/cardTemplateUpdates';
import { createIssueWrite, type NewsletterIssue, type NewsletterSlotPosition } from '../db/newsletterIssues';
import type { PlannedWrite } from '../db/plannedWrite';
import { listTasksByCardConsistent } from '../db/tasks';
import { getTemplate, listTemplates } from '../db/templates';
import type { VerifiedActor } from '../identity/actor';
import { buildCardTemplateUpdatePlan } from '../templates/cardTemplateUpdates';
import type { Card, Task, Template } from '../types';
import { createCardFromInput, type CardCreation } from '../cards/createCard';
import { newsletterIssueTitleValues, renderCardTitle } from '../cards/cardTitlePattern';
import { pushFieldsToCard } from '../cards/recordCardLink';

export const ISSUE_TEMPLATE_TYPE = { weekly: 'newsletter', standalone: 'newsletter-standalone' } as const;
export const SLOT_POSITIONS = { weekly: ['primary', 'secondary'], standalone: ['primary'] } as const;
export const SLOT_GROUP: Record<NewsletterSlotPosition, string> = {
  primary: 'primary-slot',
  secondary: 'secondary-slot',
};

/** The Template optional groups a weekly issue's ticked slots select. */
export function issueTaskGroups(issue: Pick<NewsletterIssue, 'kind' | 'slots'>): string[] {
  if (issue.kind !== 'weekly') return [];
  return SLOT_POSITIONS.weekly.filter((position) => issue.slots[position]?.ticked).map((position) => SLOT_GROUP[position]);
}

export function issueSponsor(issue: Pick<NewsletterIssue, 'slots'>, position: NewsletterSlotPosition): string | null {
  const slot = issue.slots[position];
  return slot?.ticked && slot.sponsor ? slot.sponsor : null;
}

/** The facts an issue pushes onto its Card. */
export function issueCardFields(issue: NewsletterIssue) {
  const secondary = issueSponsor(issue, 'secondary');
  return {
    anchorDate: issue.publicationDate,
    issueNumber: issue.issueNumber == null ? null : String(issue.issueNumber),
    sponsor: issueSponsor(issue, 'primary'),
    secondarySponsors: secondary ? [secondary] : [],
  };
}

export function issueLabel(issue: Pick<NewsletterIssue, 'kind' | 'issueNumber'>): string {
  if (issue.kind === 'standalone') return 'Stand-alone newsletter';
  return issue.issueNumber == null ? 'Weekly newsletter' : `Weekly #${issue.issueNumber}`;
}

export async function issueTemplate(client: DynamoDBDocumentClient, issue: Pick<NewsletterIssue, 'kind'>): Promise<Template | null> {
  const type = ISSUE_TEMPLATE_TYPE[issue.kind];
  return (await listTemplates(client)).find((template) => template.type === type) || null;
}

/**
 * Create the issue's Card and write the issue in one transaction.
 * `issueWrite` receives the new Card's id and returns the issue row write
 * (a create, or a version-conditional replace when a cancelled issue is
 * reinstated).
 */
export async function createIssueCard(
  client: DynamoDBDocumentClient,
  actor: VerifiedActor,
  issue: NewsletterIssue,
  issueWrite: (cardId: string) => PlannedWrite = (cardId) => createIssueWrite({ ...issue, cardId }),
): Promise<CardCreation> {
  const template = await issueTemplate(client, issue);
  if (!template) {
    return {
      ok: false,
      response: {
        statusCode: 422,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: `No ${ISSUE_TEMPLATE_TYPE[issue.kind]} Template is available` }),
      },
    };
  }
  const fields = issueCardFields(issue);
  const title = (template.cardTitle && renderCardTitle(template.cardTitle, newsletterIssueTitleValues(issue)))
    || issueLabel(issue);
  return createCardFromInput(
    client,
    actor,
    {
      title,
      anchorDate: fields.anchorDate,
      templateId: template.id,
      ...(issue.kind === 'weekly' ? { optionalGroups: issueTaskGroups(issue) } : {}),
      ...(fields.issueNumber ? { issueNumber: fields.issueNumber } : {}),
      ...(fields.sponsor ? { sponsor: fields.sponsor } : {}),
      ...(fields.secondarySponsors.length ? { secondarySponsors: fields.secondarySponsors } : {}),
    },
    { companions: (card) => [issueWrite(card.id)] },
  );
}

/** Push date, issue number, sponsors and title onto the issue's Card. */
export async function pushIssueToCard(client: DynamoDBDocumentClient, issue: NewsletterIssue): Promise<Card | null> {
  if (!issue.cardId) return null;
  return pushFieldsToCard(client, issue.cardId, issueCardFields(issue), newsletterIssueTitleValues(issue));
}

/** Done Tasks of the slot groups `issue` stops selecting. */
export async function completedTasksLeavingCard(
  client: DynamoDBDocumentClient,
  previous: NewsletterIssue,
  next: NewsletterIssue,
): Promise<Task[]> {
  if (!previous.cardId) return [];
  const removed = issueTaskGroups(previous).filter((group) => !issueTaskGroups(next).includes(group));
  if (!removed.length) return [];
  const card = await getCardConsistent(client, previous.cardId);
  const template = card?.templateId ? await getTemplate(client, card.templateId) : null;
  if (!card || !template) return [];
  const refs = new Set((template.taskDefinitions || [])
    .filter((definition) => definition.optionalGroup && removed.includes(definition.optionalGroup))
    .map((definition) => definition.refId));
  const tasks = await listTasksByCardConsistent(client, card.id);
  return tasks.filter((task) => task.status === 'done' && task.templateTaskRef && refs.has(task.templateTaskRef));
}

/**
 * Bring the Card's Tasks in line with the issue's ticked slots: a newly ticked
 * slot's Tasks are added; an unticked slot's open Tasks are skipped with
 * history (done ones stay). Uses the Card's Template update, so it applies the
 * Template's current definition at the same time.
 */
export async function syncIssueSlotTasks(
  client: DynamoDBDocumentClient,
  issue: NewsletterIssue,
  actorId: string,
): Promise<'unchanged' | 'synced'> {
  if (!issue.cardId || issue.kind !== 'weekly') return 'unchanged';
  const card = await getCardConsistent(client, issue.cardId);
  if (!card?.templateId) throw new Error(`Newsletter issue ${issue.id} Card is missing or has no Template`);
  const groups = issueTaskGroups(issue);
  if (JSON.stringify([...(card.selectedOptionalGroups || [])].sort()) === JSON.stringify([...groups].sort())) {
    return 'unchanged';
  }
  const template = await getTemplate(client, card.templateId);
  if (!template) throw new Error(`Template ${card.templateId} is not available`);
  const tasks = await listTasksByCardConsistent(client, card.id);
  const plan = buildCardTemplateUpdatePlan(card, tasks, template, groups);
  await applyCardTemplateUpdate(client, card, tasks, template, plan.preview.previewToken, actorId, groups);
  return 'synced';
}
