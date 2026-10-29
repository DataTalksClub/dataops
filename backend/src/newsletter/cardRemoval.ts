/**
 * Removing a newsletter issue's Card while keeping the issue.
 *
 * A Card created too early holds nothing but its Template's Tasks; removing
 * it puts the issue back to "Card due in N days". What the Card collected
 * that the issue can hold moves to the issue first: card links and Task
 * links become the issue's links (a sponsorship document fills its slot's
 * document), and linked artifacts with a web address become issue links.
 * Real work keeps the Card: a Task done, or skipped by a person, Task
 * activity, comments or notes, uploaded files, and records
 * that point at the Card.
 */
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

import { getCardConsistent } from '../db/cards';
import {
  CardDeletionBlockedError,
  cardBlockingReferences,
  deleteCardCascade,
  listCardArtifacts,
} from '../db/cardDeletion';
import { TEMPLATE_REMOVED_SKIP_REASON } from '../db/cardTemplateUpdates';
import {
  nextNewsletterIssue,
  replaceIssueWrite,
  type NewsletterIssue,
  type NewsletterIssueLink,
  type NewsletterSlotPosition,
} from '../db/newsletterIssues';
import { listTasksByCardConsistent } from '../db/tasks';
import type { Card, Task } from '../types';
import { SLOT_DOCUMENT_LINK, SLOT_POSITIONS } from './issueCard';

const SYSTEM_HISTORY = new Set(['template-retired', 'template-restored']);

export type CardMove = { from: string; to: string; url: string };

export type CardRemovalPlan = {
  cardId: string;
  cardTitle: string;
  /** Why the Card should stay; empty when it holds no work. */
  keep: string[];
  moves: CardMove[];
  next: NewsletterIssue;
};

const plural = (count: number, one: string) => `${count} ${one}${count === 1 ? '' : 's'}`;
const isWebUrl = (value: unknown) => {
  try {
    return typeof value === 'string' && new URL(value).protocol === 'https:';
  } catch {
    return false;
  }
};

/** What keeps the Card, and where its links go when it is removed. */
export async function planIssueCardRemoval(
  client: DynamoDBDocumentClient,
  issue: NewsletterIssue,
  card: Card,
  tasks: Task[],
): Promise<CardRemovalPlan> {
  const keep: string[] = [];
  const done = tasks.filter((task) => task.status === 'done');
  if (done.length) keep.push(`${plural(done.length, 'Task')} done`);
  const skipped = tasks.filter((task) => task.status === 'skipped' && task.skipReason !== TEMPLATE_REMOVED_SKIP_REASON);
  if (skipped.length) keep.push(`${plural(skipped.length, 'Task')} skipped by a person`);
  const waiting = tasks.filter((task) => task.status === 'waiting'
    || (task.status === 'todo' && (task.taskHistory || []).some((event) => !SYSTEM_HISTORY.has(event.action))));
  if (waiting.length) keep.push(`${plural(waiting.length, 'Task')} with waiting or follow-up history`);
  const commented = tasks.filter((task) => typeof task.comment === 'string' && task.comment.trim());
  if (commented.length) keep.push(`${plural(commented.length, 'Task')} with comments`);
  if (typeof card.description === 'string' && card.description.trim()) keep.push('Card notes');
  const blocking = await cardBlockingReferences(client, card, tasks, { newsletterIssueId: issue.id });
  if (blocking.files.length) keep.push(plural(blocking.files.length, 'uploaded file'));
  if (blocking.sponsorDeliverables.length) keep.push(plural(blocking.sponsorDeliverables.length, 'sponsor deliverable') + ' pointing at the Card');
  if (blocking.newsletterIssues.length) keep.push('another newsletter issue pointing at the Card');
  if (blocking.linkingTasks.length) keep.push(plural(blocking.linkingTasks.length, 'Task') + ' on another Card linking it');

  const moves: CardMove[] = [];
  const slots = structuredClone(issue.slots);
  const links: NewsletterIssueLink[] = [...(issue.links || [])];
  const known = new Set([
    ...links.map((link) => link.url),
    ...Object.values(slots).map((slot) => slot?.documentUrl).filter(Boolean) as string[],
  ]);
  const addLink = (from: string, name: string, url: string) => {
    if (known.has(url)) return;
    known.add(url);
    const position = (SLOT_POSITIONS[issue.kind] as readonly NewsletterSlotPosition[])
      .find((candidate) => SLOT_DOCUMENT_LINK[candidate] === name && !slots[candidate]?.documentUrl);
    if (position) {
      slots[position] = { ...(slots[position] || {}), documentUrl: url };
      moves.push({ from, to: `${position} slot sponsorship document`, url });
      return;
    }
    links.push({ name: name.slice(0, 200), url });
    moves.push({ from, to: `issue link "${name}"`, url });
  };
  for (const link of card.cardLinks || []) {
    if (isWebUrl(link.url)) addLink(`card link "${link.name}"`, link.name, link.url);
  }
  for (const task of tasks) {
    if (isWebUrl(task.link)) addLink(`Task "${task.description}" link`, task.description, String(task.link));
  }
  const artifacts = await listCardArtifacts(client, card, tasks);
  const artifactRefs = card.artifactRefs || [];
  for (const artifact of artifacts) {
    if (isWebUrl(artifact.storageUri)) addLink(`artifact "${artifact.title}"`, String(artifact.title || 'Artifact'), String(artifact.storageUri));
    else keep.push(`artifact "${artifact.title}" that is not a web link`);
  }
  for (const ref of artifactRefs) {
    if (artifacts.some((artifact) => artifact.id === ref.artifactId)) continue;
    if (isWebUrl(ref.storageUri)) addLink(`artifact "${ref.title || ref.artifactId}"`, ref.title || 'Artifact', String(ref.storageUri));
    else keep.push(`artifact "${ref.title || ref.artifactId}" that is not a web link`);
  }
  const next = nextNewsletterIssue(issue, {
    cardId: undefined,
    slots,
    ...(links.length ? { links } : {}),
  });
  return { cardId: card.id, cardTitle: String(card.title || ''), keep, moves, next };
}

export type CardRemovalResult =
  | { ok: true; plan: CardRemovalPlan; removed: boolean }
  | { ok: false; status: number; error: string; code?: string; plan?: CardRemovalPlan };

/**
 * Remove the issue's Card. Refused while the Card holds work, unless the
 * caller confirms; `dryRun` returns the plan without writing.
 */
export async function removeIssueCard(
  client: DynamoDBDocumentClient,
  issue: NewsletterIssue,
  actorId: string,
  options: { confirm?: boolean; dryRun?: boolean } = {},
): Promise<CardRemovalResult> {
  if (!issue.cardId) return { ok: false, status: 409, error: 'The issue has no Card' };
  const card = await getCardConsistent(client, issue.cardId);
  if (!card) return { ok: false, status: 409, error: 'The issue Card is unavailable; reload and retry' };
  const tasks = await listTasksByCardConsistent(client, card.id);
  const plan = await planIssueCardRemoval(client, issue, card, tasks);
  if (options.dryRun) return { ok: true, plan, removed: false };
  if (plan.keep.length && !options.confirm) {
    return {
      ok: false,
      status: 409,
      code: 'card-has-progress',
      error: `The issue Card holds work (${plan.keep.join('; ')}); confirm to remove it`,
      plan,
    };
  }
  try {
    await deleteCardCascade(client, card.id, card.version, actorId, {
      newsletterIssueId: issue.id,
      write: replaceIssueWrite(issue, plan.next),
    });
  } catch (error) {
    if (error instanceof CardDeletionBlockedError) {
      return { ok: false, status: 409, error: error.message, plan };
    }
    const name = (error as Error).name;
    if (['CardDeletionConflictError', 'CardVersionConflictError', 'TransactionCanceledException'].includes(name)) {
      return { ok: false, status: 409, error: 'Issue or Card changed; reload and retry' };
    }
    throw error;
  }
  return { ok: true, plan, removed: true };
}
