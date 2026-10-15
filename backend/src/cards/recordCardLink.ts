/**
 * Links from a planning record (a newsletter slot, a podcast episode) to the
 * Card that executes it.
 *
 * The record's `cardId` is the single canonical link: nothing on the Card
 * points back. The record owns the shared facts (date, issue number, guests)
 * and pushes them one way onto the Card; the Card never writes back. When the
 * Card's Template authors a `card_title` pattern, the title is one of those
 * facts: it is rendered from the record at creation and on every push.
 */
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

import { getCard, updateCardAdditive, type CardPatch } from '../db/cards';
import { discardCreatedTemplateCard, getTemplate, listTemplates } from '../db/templates';
import type { VerifiedActor } from '../identity/actor';
import type { Card, LambdaResponse, Task } from '../types';
import { renderCardTitle, type CardTitleValues } from './cardTitlePattern';
import { cardTemplateType, hydrateStructuredCardFields } from './cardTitleStructure';
import { createCardFromInput, getTemplateIdByType } from './createCard';

export type CardSummary = {
  id: string;
  title: string;
  stage: Card['stage'];
  status: Card['status'];
  anchorDate: string | null;
  taskCount: number;
  openTaskCount: number;
};

export type LinkCheck =
  | { ok: true; card: Card }
  | { ok: false; statusCode: number; error: string };

/** The Card as the board shows it: title-derived fields hydrated. */
function projected(card: Card, templateIdByType: Map<string, string>): Card {
  const copy = { ...card };
  hydrateStructuredCardFields(copy, templateIdByType);
  return copy;
}

export async function summarizeCard(
  client: DynamoDBDocumentClient,
  card: Card,
): Promise<CardSummary> {
  const view = projected(card, await getTemplateIdByType(client));
  return {
    id: card.id,
    title: String(view.title || ''),
    stage: card.stage,
    status: card.status,
    anchorDate: view.anchorDate || null,
    taskCount: card.taskCount,
    openTaskCount: card.openTaskCount,
  };
}

/**
 * A Card may be linked when it exists, belongs to one of `templateTypes`, and
 * no other record already links it (`linkedRecordIds` excludes `recordId`).
 */
export async function checkCardLink(
  client: DynamoDBDocumentClient,
  cardId: string,
  templateTypes: string[],
  recordId: string | null,
  linkedRecordIds: (cardId: string) => Promise<string[]>,
): Promise<LinkCheck> {
  const card = await getCard(client, cardId);
  if (!card) return { ok: false, statusCode: 422, error: 'Card unavailable' };
  const template = card.templateId ? await getTemplate(client, card.templateId) : null;
  const type = template?.type || cardTemplateType(card);
  if (!type || !templateTypes.includes(type)) {
    return { ok: false, statusCode: 422, error: `Card is not a ${templateTypes.join(' or ')} Card` };
  }
  const others = (await linkedRecordIds(cardId)).filter((id) => id !== recordId);
  if (others.length > 0) {
    return { ok: false, statusCode: 409, error: `Card is already linked to ${others[0]}` };
  }
  return { ok: true, card };
}

export type PushedCardFields = {
  anchorDate?: string;
  issueNumber?: string | null;
  people?: string[];
  sponsor?: string | null;
  secondarySponsors?: string[];
};

/**
 * Push the record's facts onto the linked Card. Fields already equal on the
 * Card's projected view are not written; when the Card's Template authors a
 * `card_title`, the title is re-rendered from `titleValues`.
 */
export async function pushFieldsToCard(
  client: DynamoDBDocumentClient,
  cardId: string,
  fields: PushedCardFields,
  titleValues: CardTitleValues,
): Promise<Card | null> {
  const card = await getCard(client, cardId);
  if (!card) return null;
  const templateIdByType = await getTemplateIdByType(client);
  const pattern = card.templateId ? (await getTemplate(client, card.templateId))?.cardTitle : undefined;
  const title = pattern ? renderCardTitle(pattern, titleValues) : '';
  const buildPatch = (current: Card): CardPatch => {
    const view = projected(current, templateIdByType);
    const patch: CardPatch = {};
    if (fields.anchorDate && current.anchorDate !== fields.anchorDate) patch.anchorDate = fields.anchorDate;
    if (fields.issueNumber && current.issueNumber !== fields.issueNumber) patch.issueNumber = fields.issueNumber;
    if (fields.people && JSON.stringify(view.people || []) !== JSON.stringify(fields.people)) {
      patch.people = fields.people;
    }
    if (fields.sponsor !== undefined && (current.sponsor || null) !== fields.sponsor) patch.sponsor = fields.sponsor;
    if (
      fields.secondarySponsors
      && JSON.stringify(current.secondarySponsors || []) !== JSON.stringify(fields.secondarySponsors)
    ) {
      patch.secondarySponsors = fields.secondarySponsors;
    }
    if (title && title !== current.title) patch.title = title;
    return patch;
  };
  if (Object.keys(buildPatch(card)).length === 0) return card;
  return updateCardAdditive(client, card, buildPatch);
}

export type LinkedCardCreation =
  | { ok: true; card: Card; tasks: Task[] }
  | { ok: false; response: LambdaResponse };

/**
 * Create a Card from the Template of `templateType` and link it through
 * `link`. The Template's `card_title` pattern, when authored, names the Card
 * from `titleValues`; otherwise `input.title` does. When linking fails the new
 * Card and its Tasks are discarded and the link error is rethrown, so no
 * orphan Card is left behind.
 */
export async function createLinkedCard(
  client: DynamoDBDocumentClient,
  actor: VerifiedActor,
  templateType: string,
  input: Record<string, unknown>,
  titleValues: CardTitleValues,
  link: (card: Card) => Promise<void>,
): Promise<LinkedCardCreation> {
  const template = (await listTemplates(client)).find((candidate) => candidate.type === templateType);
  if (!template) {
    return {
      ok: false,
      response: {
        statusCode: 422,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: `No ${templateType} Template is available` }),
      },
    };
  }
  const title = template.cardTitle ? renderCardTitle(template.cardTitle, titleValues) : '';
  const created = await createCardFromInput(client, actor, {
    ...input,
    ...(title ? { title } : {}),
    templateId: template.id,
  });
  if (!created.ok) return created;
  const tasks = created.tasks;
  try {
    await link(created.card);
  } catch (error) {
    await discardCreatedTemplateCard(client, created.card, tasks);
    throw error;
  }
  return { ok: true, card: created.card, tasks };
}
