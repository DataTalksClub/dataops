/**
 * The Card of a newsletter issue.
 *
 * An issue has at most one Card, created from the Template of its kind
 * (weekly -> `newsletter`, stand-alone -> `newsletter-standalone`) when it is
 * due (`cardSchedule.ts`) or on request, in the same transaction as the issue
 * row's next version. The new Card is filled from the issue: sponsors booked
 * in the Sponsors tab fill open slots, a weekly Card starts with the task
 * groups (`primary-slot`, `secondary-slot`) of its booked slots and no
 * others, and the issue's links fill the Card's link slots. Booking a slot
 * later adds its group's Tasks; releasing it skips the group's open ones. A
 * group enabled on the Card itself stays until its slot is released. The
 * issue owns the shared facts (date, issue number, sponsors, title) and
 * pushes them onto the Card.
 */
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

import { getCardConsistent } from '../db/cards';
import { applyCardTemplateUpdate } from '../db/cardTemplateUpdates';
import {
  nextNewsletterIssue,
  replaceIssueWrite,
  type NewsletterIssue,
  type NewsletterSlotPosition,
} from '../db/newsletterIssues';
import { getCrmRecord } from '../db/sponsorCrm';
import { listTasksByCardConsistent, updateTask } from '../db/tasks';
import { getTemplate, listTemplates } from '../db/templates';
import type { VerifiedActor } from '../identity/actor';
import { buildCardTemplateUpdatePlan } from '../templates/cardTemplateUpdates';
import { dateFromTemplateOffset } from '../templates/cardTemplateProjection';
import type { Card, CardLink, LambdaResponse, Task, Template } from '../types';
import { createCardFromInput } from '../cards/createCard';
import { newsletterIssueTitleValues, renderCardTitle } from '../cards/cardTitlePattern';
import { pushFieldsToCard } from '../cards/recordCardLink';
import { channelSlot, issueDeliverables } from './slotBooking';

export const ISSUE_TEMPLATE_TYPE = { weekly: 'newsletter', standalone: 'newsletter-standalone' } as const;
export const SLOT_POSITIONS = { weekly: ['primary', 'secondary'], standalone: ['primary'] } as const;
export const SLOT_GROUP: Record<NewsletterSlotPosition, string> = {
  primary: 'primary-slot',
  secondary: 'secondary-slot',
};
/** The Card link a slot's sponsorship document fills. */
export const SLOT_DOCUMENT_LINK: Record<NewsletterSlotPosition, string> = {
  primary: 'Sponsorship document',
  secondary: 'Secondary sponsorship document',
};

/** The slot task groups of a weekly issue's booked slots. */
export function issueTaskGroups(issue: Pick<NewsletterIssue, 'kind' | 'slots'>): string[] {
  if (issue.kind !== 'weekly') return [];
  return SLOT_POSITIONS.weekly.filter((position) => issue.slots[position]?.sponsor).map((position) => SLOT_GROUP[position]);
}

/**
 * The Card's slot groups after the issue changed from `previous` to `next`:
 * a newly booked slot adds its group, a released slot removes it, and every
 * other group the Card holds stays as it is.
 */
export function cardGroupsAfterIssueChange(
  cardGroups: readonly string[],
  previous: Pick<NewsletterIssue, 'kind' | 'slots'>,
  next: Pick<NewsletterIssue, 'kind' | 'slots'>,
): string[] {
  const before = new Set(issueTaskGroups(previous));
  const after = new Set(issueTaskGroups(next));
  const groups = new Set(cardGroups);
  for (const group of before) if (!after.has(group)) groups.delete(group);
  for (const group of after) if (!before.has(group)) groups.add(group);
  return [...groups].sort();
}

export function issueSponsor(issue: Pick<NewsletterIssue, 'slots'>, position: NewsletterSlotPosition): string | null {
  return issue.slots[position]?.sponsor || null;
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

/** The issue with each open slot filled from its booking in the Sponsors tab. */
export async function issueWithBookings(client: DynamoDBDocumentClient, issue: NewsletterIssue): Promise<NewsletterIssue> {
  const slots = structuredClone(issue.slots);
  for (const deliverable of await issueDeliverables(client, issue.id)) {
    const position = channelSlot(issue.kind, deliverable.channel);
    if (!position || slots[position]?.sponsor) continue;
    const org = await getCrmRecord(client, 'organization', String(deliverable.organizationId));
    if (org?.displayName) slots[position] = { ...(slots[position] || {}), sponsor: String(org.displayName) };
  }
  return { ...issue, slots };
}

/**
 * The Card's links: the Template's link slots, filled from the slots'
 * sponsorship documents and the issue's links of the same name, then the
 * issue's other links.
 */
export function issueCardLinks(template: Pick<Template, 'cardLinkDefinitions'>, issue: NewsletterIssue): CardLink[] {
  const byName = new Map<string, string>();
  for (const link of issue.links || []) if (!byName.has(link.name)) byName.set(link.name, link.url);
  for (const position of SLOT_POSITIONS[issue.kind] as readonly NewsletterSlotPosition[]) {
    const url = issue.slots[position]?.documentUrl;
    if (url) byName.set(SLOT_DOCUMENT_LINK[position], url);
  }
  const names = new Set((template.cardLinkDefinitions || []).map((definition) => definition.name));
  return [
    ...(template.cardLinkDefinitions || []).map((definition) => ({ name: definition.name, url: byName.get(definition.name) || '' })),
    ...(issue.links || []).filter((link) => !names.has(link.name)).map((link) => ({ name: link.name, url: link.url })),
  ];
}

export type IssueCardCreation =
  | { ok: true; card: Card; issue: NewsletterIssue }
  | { ok: false; response: LambdaResponse };

/**
 * Create the issue's Card, filled from the issue, and write the issue's next
 * version (its bookings filled in, `cardId` set) in the same transaction,
 * conditional on the version read, so an issue never gets two Cards.
 * `ownerId` sets the Card owner (the daily run passes the default assignee).
 */
export async function createIssueCard(
  client: DynamoDBDocumentClient,
  actor: VerifiedActor,
  issue: NewsletterIssue,
  options: { ownerId?: string | null } = {},
): Promise<IssueCardCreation> {
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
  const filled = await issueWithBookings(client, issue);
  const fields = issueCardFields(filled);
  const title = (template.cardTitle && renderCardTitle(template.cardTitle, newsletterIssueTitleValues(filled)))
    || issueLabel(filled);
  let next: NewsletterIssue | null = null;
  const created = await createCardFromInput(
    client,
    actor,
    {
      title,
      anchorDate: fields.anchorDate,
      templateId: template.id,
      cardLinks: issueCardLinks(template, filled),
      ...(filled.kind === 'weekly' ? { optionalGroups: issueTaskGroups(filled) } : {}),
      ...(fields.issueNumber ? { issueNumber: fields.issueNumber } : {}),
      ...(fields.sponsor ? { sponsor: fields.sponsor } : {}),
      ...(fields.secondarySponsors.length ? { secondarySponsors: fields.secondarySponsors } : {}),
      ...(options.ownerId !== undefined ? { ownerId: options.ownerId } : {}),
    },
    {
      companions: (card) => {
        next = nextNewsletterIssue(issue, { slots: filled.slots, cardId: card.id });
        return [replaceIssueWrite(issue, next)];
      },
    },
  );
  if (!created.ok) return created;
  return { ok: true, card: created.card, issue: next! };
}

/** Push date, issue number, sponsors and title onto the issue's Card. */
export async function pushIssueToCard(client: DynamoDBDocumentClient, issue: NewsletterIssue): Promise<Card | null> {
  if (!issue.cardId) return null;
  return pushFieldsToCard(client, issue.cardId, issueCardFields(issue), newsletterIssueTitleValues(issue));
}

/** Done Tasks of the slot groups whose slots `next` releases. */
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
 * Bring the Card's slot Tasks in line with the bookings that changed from
 * `previous` to `issue`: a newly booked slot's Tasks are added; a released
 * slot's open Tasks are skipped with history (done ones stay). Uses the
 * Card's Template update, so it applies the Template's current definition at
 * the same time.
 */
export async function syncIssueSlotTasks(
  client: DynamoDBDocumentClient,
  previous: NewsletterIssue,
  issue: NewsletterIssue,
  actorId: string,
): Promise<'unchanged' | 'synced'> {
  if (!issue.cardId || issue.kind !== 'weekly') return 'unchanged';
  const card = await getCardConsistent(client, issue.cardId);
  if (!card?.templateId) throw new Error(`Newsletter issue ${issue.id} Card is missing or has no Template`);
  const current = [...(card.selectedOptionalGroups || [])].sort();
  const groups = cardGroupsAfterIssueChange(current, previous, issue);
  if (JSON.stringify(current) === JSON.stringify(groups)) return 'unchanged';
  const template = await getTemplate(client, card.templateId);
  if (!template) throw new Error(`Template ${card.templateId} is not available`);
  const tasks = await listTasksByCardConsistent(client, card.id);
  const plan = buildCardTemplateUpdatePlan(card, tasks, template, groups);
  await applyCardTemplateUpdate(client, card, tasks, template, plan.preview.previewToken, actorId, groups);
  return 'synced';
}

/**
 * Re-derive the due dates of the Card's open Tasks from its anchor date and
 * each Task's Template offset, after the issue moved to another day. Done and
 * skipped Tasks keep their dates. Returns how many Tasks moved.
 */
export async function rescheduleOpenIssueTasks(client: DynamoDBDocumentClient, issue: NewsletterIssue): Promise<number> {
  if (!issue.cardId) return 0;
  let moved = 0;
  for (const task of await listTasksByCardConsistent(client, issue.cardId)) {
    if ((task.status !== 'todo' && task.status !== 'waiting') || typeof task.templateOffsetDays !== 'number') continue;
    const date = dateFromTemplateOffset(issue.publicationDate, task.templateOffsetDays);
    if (task.date === date) continue;
    await updateTask(client, task.id, {
      expectedVersion: task.version,
      patch: {
        date,
        ...(task.templateDefinitionSnapshot ? { templateDefinitionSnapshot: { ...task.templateDefinitionSnapshot, date } } : {}),
      },
    });
    moved += 1;
  }
  return moved;
}
