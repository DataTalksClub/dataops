import { cardEventInterval } from '../calendar/cardEventTime';
import { adoptEventDate, CardInviteConflictError, CardInviteInputError, cardGuests, parseCardGuests, syncCardInvite, unlinkCardInvite, verifyCardInvites } from '../calendar/cardInvite';
import { calendarInviteDeps } from './calendarHolds';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import {
  CardNotFoundError,
  CardStatusTransitionError,
  CardVersionConflictError,
  getCard,
  getCardConsistent,
  parkCard,
  resumeCard,
  updateCard,
  updateCardAdditive,
  listCardsPage,
} from '../db/cards';
import { attachLinkedCards, cardBackReferences } from '../cards/taskCardLinkView';
import { ensureEventSlotCards } from '../cards/eventSlots';
import {
  CardDeletionBlockedError,
  CardDeletionConflictError,
  CardDeletionTooLargeError,
  deleteCardCascade,
} from '../db/cardDeletion';
import { CollectionCursorError, encodeCollectionCursor } from '../db/collectionPagination';
import { getTemplate } from '../db/templates';
import {
  createCardFromInput,
  getTemplateIdByType,
  ownerAssignmentError,
  requestedOwner,
  validateCardPeople,
  validateCardRefs,
} from '../cards/createCard';
import { resolveTemplateConditionalValidation } from '../cards/conditionalRequired';
import { listAllTasks, listTasksByCard, listTasksByCardConsistent } from '../db/tasks';
import {
  applyCardTemplateUpdate,
  CardTemplateUpdateConflictError,
} from '../db/cardTemplateUpdates';
import {
  resolveInteractiveActor,
  workAdminForbidden,
  type VerifiedActor,
} from '../identity/actor';
import { TeamDirectory } from '../identity/directory';
import { projectCard, projectCards, projectTasks } from '../identity/projections';
import { attachPrerequisites } from '../db/taskDependencies';
import { normalizeCardLinks } from '../artifactLinks';
import {
  matchesOwnerFilter,
  ownerFilterUserId,
  resolveOwnerFilter,
} from '../identity/ownerFilter';
import {
  buildCardTemplateUpdatePlan,
  CardTemplateUpdateInvalidStateError,
} from '../templates/cardTemplateUpdates';
import type { Card, CardCalendarInvite, LambdaEvent, LambdaResponse, Task } from '../types';
import { recordRequestError } from '../requestErrorLog';

const JSON_HEADERS: Record<string, string> = { 'Content-Type': 'application/json' };

class CardTemplateUpdateRequestError extends Error {
  constructor(readonly statusCode: number, readonly code: string, message: string) {
    super(message);
    this.name = 'CardTemplateUpdateRequestError';
  }
}

function json(statusCode: number, body: unknown): LambdaResponse {
  return { statusCode, headers: JSON_HEADERS, body: JSON.stringify(body) };
}

function parseObject(rawBody: string | null): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody || '');
  } catch {
    throw new CardTemplateUpdateRequestError(400, 'invalid-json', 'Invalid JSON');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new CardTemplateUpdateRequestError(400, 'invalid-body', 'Request body must be an object');
  }
  return parsed as Record<string, unknown>;
}

/**
 * The Card administration boundary.
 *
 * An operator administers only a Card they own. Unassigned Cards, and Cards
 * owned by somebody else, are admin-managed. This is deliberately separate
 * from Task execution: completing a teammate's Task may still update this
 * Card's counters, lifecycle, and audit through the accepted Task/Card
 * transaction, and that never becomes permission to edit the Card itself.
 */
function mayAdministerCard(actor: VerifiedActor, card: Card | null): boolean {
  if (actor.testBypass || actor.isAdmin) return true;
  return Boolean(card && actor.id && card.ownerId === actor.id);
}

async function loadTemplateUpdate(cardId: string, client: DynamoDBDocumentClient) {
  // Card first, then its Tasks from the base table: every graph-affecting
  // write bumps the Card, so a Task list read after the Card cannot be older
  // than the version the update will be conditioned on.
  const card = await getCardConsistent(client, cardId);
  if (!card) throw new CardTemplateUpdateRequestError(404, 'card-not-found', 'Card not found');
  const stored = await getTemplate(client, card.templateId);
  if (!stored) throw new CardTemplateUpdateRequestError(409, 'template-not-found', 'Card Template projection no longer exists');
  // Same resolution the apply path performs, so the preview an operator
  // reviews already carries the required/optional outcome being confirmed.
  const template = card.anchorDate
    ? await resolveTemplateConditionalValidation(client, stored, card.anchorDate)
    : stored;
  const tasks = await listTasksByCardConsistent(client, card.id);
  try {
    return { card, template, tasks, plan: buildCardTemplateUpdatePlan(card, tasks, template) };
  } catch (error) {
    if (error instanceof CardTemplateUpdateInvalidStateError) {
      throw new CardTemplateUpdateRequestError(422, 'invalid-template-state', error.message);
    }
    throw error;
  }
}

function updateError(error: unknown): LambdaResponse {
  if (error instanceof CardTemplateUpdateRequestError) {
    return json(error.statusCode, { error: error.message, code: error.code });
  }
  if (error instanceof CardTemplateUpdateInvalidStateError) {
    return json(422, { error: error.message, code: 'invalid-template-state' });
  }
  if (error instanceof CardTemplateUpdateConflictError) {
    return json(409, {
      error: error.message,
      code: 'template-update-conflict',
      reloadLatest: true,
    });
  }
  throw error;
}

async function handleSingleTemplateUpdate(
  method: string,
  cardId: string,
  rawBody: string | null,
  event: LambdaEvent,
  client: DynamoDBDocumentClient,
): Promise<LambdaResponse> {
  const resolution = await resolveInteractiveActor(
    client, event, method === 'GET' ? 'work-read' : 'work-write',
  );
  if (!resolution.ok) return resolution.response;
  const actor = resolution.actor;

  try {
    const loaded = await loadTemplateUpdate(cardId, client);
    if (method === 'GET') return json(200, { preview: loaded.plan.preview });
    if (method !== 'POST') return json(405, { error: 'Method not allowed' });
    if (!mayAdministerCard(actor, loaded.card)) {
      return workAdminForbidden('Applying a Template update requires the Card owner or an admin');
    }
    const body = parseObject(rawBody);
    if (body.previewOnly !== undefined && typeof body.previewOnly !== 'boolean') {
      return json(400, { error: 'previewOnly must be a boolean' });
    }
    if (body.previewOnly === true) {
      try {
        return json(200, {
          preview: buildCardTemplateUpdatePlan(
            loaded.card, loaded.tasks, loaded.template, body.optionalGroups, body.counts,
          ).preview,
        });
      } catch (error) {
        return updateError(error);
      }
    }
    const previewToken = typeof body.previewToken === 'string' ? body.previewToken : '';
    if (!/^[a-f0-9]{64}$/.test(previewToken)) {
      return json(400, { error: 'previewToken must be a SHA-256 digest', code: 'invalid-preview-token' });
    }
    // Only the explicit test bypass can leave the verified actor id empty.
    const actorId = actor.id || 'system';
    const result = await applyCardTemplateUpdate(
      client,
      loaded.card,
      loaded.tasks,
      loaded.template,
      previewToken,
      actorId,
      body.optionalGroups,
      body.counts,
    );
    return json(200, { ...result, ...await eventSlotsAfterWrite(client, actor, loaded.card) });
  } catch (error) {
    return updateError(error);
  }
}

/**
 * Event Cards for the Card's open slot Tasks, created after the Card or its
 * Tasks were written. A failure leaves the Card in place and names the
 * command that finishes the job.
 */
async function eventSlotsAfterWrite(client: DynamoDBDocumentClient, actor: VerifiedActor, card: Card) {
  try {
    return { eventSlots: await ensureEventSlotCards(client, actor, card, { apply: true }) };
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'event Card creation failed';
    return { eventSlots: [], eventSlotsError: `${reason}. Finish with: dataops cards event-slots ${card.id} --apply` };
  }
}

/** /api/cards/:id/event-slots: GET previews, POST creates the missing event Cards. */
async function handleCardEventSlots(method: string, id: string, client: DynamoDBDocumentClient, event: LambdaEvent): Promise<LambdaResponse> {
  if (method !== 'GET' && method !== 'POST') return json(405, { error: 'Method not allowed' });
  const resolved = await resolveInteractiveActor(client, event, method === 'GET' ? 'work-read' : 'work-write');
  if (!resolved.ok) return resolved.response;
  const card = await getCardConsistent(client, id);
  if (!card) return json(404, { error: 'Card not found' });
  if (method === 'POST' && !mayAdministerCard(resolved.actor, card)) {
    return workAdminForbidden('Creating event Cards requires the Card owner or an admin');
  }
  return json(200, { eventSlots: await ensureEventSlotCards(client, resolved.actor, card, { apply: method === 'POST' }) });
}

function selectedCardIds(body: Record<string, unknown>): string[] {
  if (!Array.isArray(body.cardIds) || body.cardIds.length === 0 || body.cardIds.length > 25) {
    throw new CardTemplateUpdateRequestError(400, 'invalid-card-selection', 'cardIds must select between 1 and 25 Cards');
  }
  const cardIds = body.cardIds.map((id) => typeof id === 'string' ? id.trim() : '');
  if (cardIds.some((id) => !id) || new Set(cardIds).size !== cardIds.length) {
    throw new CardTemplateUpdateRequestError(400, 'invalid-card-selection', 'cardIds must contain unique non-empty IDs');
  }
  return cardIds;
}

async function handleBatchTemplateUpdates(
  action: string,
  method: string,
  rawBody: string | null,
  event: LambdaEvent,
  client: DynamoDBDocumentClient,
): Promise<LambdaResponse> {
  if (method !== 'POST') return json(405, { error: 'Method not allowed' });
  const resolution = await resolveInteractiveActor(
    client, event, action === 'preview' ? 'work-read' : 'work-write',
  );
  if (!resolution.ok) return resolution.response;
  const actor = resolution.actor;

  try {
    const body = parseObject(rawBody);
    if (action === 'preview') {
      const cardIds = selectedCardIds(body);
      const results = [];
      for (const cardId of cardIds) {
        try {
          const loaded = await loadTemplateUpdate(cardId, client);
          results.push({ cardId, status: 'ready', preview: loaded.plan.preview });
        } catch (error) {
          const response = updateError(error);
          const detail = JSON.parse(response.body);
          results.push({ cardId, status: 'failed', httpStatus: response.statusCode, ...detail });
        }
      }
      return json(results.some(({ status }) => status === 'failed') ? 207 : 200, { results });
    }

    if (!Array.isArray(body.updates) || body.updates.length === 0 || body.updates.length > 25) {
      throw new CardTemplateUpdateRequestError(400, 'invalid-update-selection', 'updates must contain between 1 and 25 reviewed Cards');
    }
    if (body.updates.some((value) => !value || typeof value !== 'object' || Array.isArray(value))) {
      throw new CardTemplateUpdateRequestError(400, 'invalid-update-selection', 'Each update must be an object');
    }
    const updates = body.updates.map((value) => value as Record<string, unknown>);
    const identities = updates.map(({ cardId }) => typeof cardId === 'string' ? cardId.trim() : '');
    if (
      updates.some(({ cardId, previewToken }) => (
        typeof cardId !== 'string'
        || !cardId.trim()
        || typeof previewToken !== 'string'
        || !/^[a-f0-9]{64}$/.test(previewToken)
      ))
      || new Set(identities).size !== identities.length
    ) {
      throw new CardTemplateUpdateRequestError(400, 'invalid-update-selection', 'Each update needs a unique Card ID and preview token');
    }

    // Only the explicit test bypass can leave the verified actor id empty.
    const actorId = actor.id || 'system';
    const results = [];
    for (const update of updates) {
      const cardId = String(update.cardId);
      try {
        const loaded = await loadTemplateUpdate(cardId, client);
        if (!mayAdministerCard(actor, loaded.card)) {
          throw new CardTemplateUpdateRequestError(
            403,
            'work_admin_forbidden',
            'Applying a Template update requires the Card owner or an admin',
          );
        }
        const applied = await applyCardTemplateUpdate(
          client,
          loaded.card,
          loaded.tasks,
          loaded.template,
          String(update.previewToken),
          actorId,
        );
        results.push({
          cardId,
          status: applied.applied ? 'applied' : 'unchanged',
          idempotent: applied.idempotent,
          cardVersion: applied.card.version,
          auditEventId: applied.auditEvent?.id || null,
        });
      } catch (error) {
        const response = updateError(error);
        const detail = JSON.parse(response.body);
        results.push({ cardId, status: 'failed', httpStatus: response.statusCode, ...detail });
      }
    }
    return json(results.some(({ status }) => status === 'failed') ? 207 : 200, { results });
  } catch (error) {
    return updateError(error);
  }
}

/**
 * Handle all /api/cards routes.
 */
async function handleCardRoutes(
  path: string,
  method: string,
  rawBody: string | null,
  event: LambdaEvent,
  client: DynamoDBDocumentClient,
): Promise<LambdaResponse | null> {
  // Match /api/cards paths
  if (!path.startsWith('/api/cards')) {
    return null;
  }

  try {
    // Parse the path segments after /api/cards
    const suffix = path.slice('/api/cards'.length);

    // Route: /api/cards (collection)
    if (suffix === '' || suffix === '/') {
      return await handleCollection(method, rawBody, client, event);
    }

    // Route: /api/cards/template-updates/:action
    const batchTemplateUpdateMatch = suffix.match(/^\/template-updates\/(preview|apply)\/?$/);
    if (batchTemplateUpdateMatch) {
      return await handleBatchTemplateUpdates(
        batchTemplateUpdateMatch[1], method, rawBody, event, client,
      );
    }

    // Route: /api/cards/:id/template-update
    const templateUpdateMatch = suffix.match(/^\/([^/]+)\/template-update\/?$/);
    if (templateUpdateMatch) {
      return await handleSingleTemplateUpdate(
        method, templateUpdateMatch[1], rawBody, event, client,
      );
    }

    // Route: /api/cards/:id/tasks
    const tasksMatch = suffix.match(/^\/([^/]+)\/tasks\/?$/);
    if (tasksMatch) {
      const id = tasksMatch[1];
      return await handleCardTasks(method, id, client, event);
    }

    // Route: /api/cards/:id/park and /api/cards/:id/resume
    const parkMatch = suffix.match(/^\/([^/]+)\/(park|resume)\/?$/);
    if (parkMatch) {
      return await handleParkResume(method, parkMatch[1], parkMatch[2] as 'park' | 'resume', rawBody, client, event);
    }

    const timeMatch = suffix.match(/^\/([^/]+)\/time\/?$/);
    if (timeMatch) return await handleCardTime(method, timeMatch[1], rawBody, client, event);

    const eventSlotsMatch = suffix.match(/^\/([^/]+)\/event-slots\/?$/);
    if (eventSlotsMatch) return await handleCardEventSlots(method, eventSlotsMatch[1], client, event);

    // Route: /api/cards/:id/calendar-invites
    const invitesMatch = suffix.match(/^\/([^/]+)\/calendar-invites\/?$/);
    if (invitesMatch) {
      return await handleCardCalendarInvites(method, invitesMatch[1], rawBody, client, event);
    }

    // Route: /api/cards/:id
    const idMatch = suffix.match(/^\/([^/]+)\/?$/);
    if (idMatch) {
      const id = idMatch[1];
      return await handleSingle(method, id, rawBody, client, event);
    }

    // No match within /api/cards
    return {
      statusCode: 404,
      headers: JSON_HEADERS,
      body: JSON.stringify({ error: 'Not found' }),
    };
  } catch (err: unknown) {
    if (err instanceof CardInviteConflictError) return json(409, { error: err.message, code: 'card_invite_conflict' });
    if (err instanceof CardNotFoundError) {
      return json(404, { error: 'Card not found', code: 'card_not_found' });
    }
    if (err instanceof CardVersionConflictError) {
      const currentCard = await getCardConsistent(client, err.cardId);
      if (!currentCard) return json(404, { error: 'Card not found', code: 'card_not_found' });
      return json(409, {
        error: 'Card changed; review the current card and retry',
        code: 'card_version_conflict',
        expectedVersion: err.expectedVersion,
        currentVersion: currentCard.version,
        currentCard,
      });
    }
    if (err instanceof CardDeletionBlockedError) {
      return json(409, {
        error: err.message,
        code: 'card_has_references',
        references: err.references,
      });
    }
    if (err instanceof CardDeletionConflictError) {
      return json(409, { error: err.message, code: 'card_delete_conflict' });
    }
    if (err instanceof CardDeletionTooLargeError) {
      return json(422, { error: err.message, code: 'card_delete_too_large' });
    }
    if (err instanceof CardStatusTransitionError) {
      return json(422, {
        error: err.message,
        code: 'card-status-transition',
        status: err.status,
      });
    }
    recordRequestError(err);
    return {
      statusCode: 500,
      headers: JSON_HEADERS,
      body: JSON.stringify({ error: 'Internal server error' }),
    };
  }
}

/**
 * Handle /api/cards collection routes (GET list, POST create).
 */
async function handleCollection(
  method: string,
  rawBody: string | null,
  client: DynamoDBDocumentClient,
  event: LambdaEvent,
): Promise<LambdaResponse> {
  if (method === 'GET') {
    const listActor = await resolveInteractiveActor(client, event, 'work-read');
    if (!listActor.ok) return listActor.response;

    const ownerParse = await resolveOwnerFilter(client, (event.queryStringParameters || {}).owner, listActor.actor);
    if (!ownerParse.ok) return json(400, { error: ownerParse.error });
    const ownerFilter = ownerParse.filter;

    const directory = new TeamDirectory(client);
    await directory.loadAll();
    const activeMemberIds = await directory.activeMemberIds();
    const binding = {
      collection: 'cards',
      filters: { owner: ownerFilter },
      principal: listActor.actor.id || 'test-bypass',
    };
    let cardPage;
    try {
      cardPage = await listCardsPage(client, {
        binding,
        pagination: event.queryStringParameters || {},
        matches: (card) => matchesOwnerFilter(card.ownerId, ownerFilter, activeMemberIds),
      });
    } catch (error) {
      if (error instanceof CollectionCursorError) {
        return json(400, { error: 'Invalid pagination input', code: 'invalid_pagination_input' });
      }
      throw error;
    }

    // Query tasks for the cards on this page using GSI-Card instead of scanning the full table
    const perCardTasks = await Promise.all(
      cardPage.items.map((card) => listTasksByCard(client, card.id)),
    );
    const tasksByCardId = new Map<string, Task[]>();
    for (let index = 0; index < cardPage.items.length; index++) {
      tasksByCardId.set(cardPage.items[index].id, perCardTasks[index]);
    }

    const templateIdByType = await getTemplateIdByType(client);
    const responseBody: {
      cards: Record<string, unknown>;
      owner?: Awaited<ReturnType<TeamDirectory['project']>>;
    } = {
      cards: {
        items: await projectCards(directory, cardPage.items, tasksByCardId, templateIdByType),
      },
    };
    if (cardPage.nextExclusiveStartKey) {
      responseBody.cards.nextCursor = await encodeCollectionCursor(binding, cardPage.nextExclusiveStartKey);
    }
    const ownerReference = ownerFilterUserId(ownerFilter);
    if (ownerReference) responseBody.owner = await directory.project(ownerReference);
    return json(200, responseBody);
  }

  if (method === 'POST') {
    const createActor = await resolveInteractiveActor(client, event, 'work-write');
    if (!createActor.ok) return createActor.response;
    let body: Record<string, unknown>;
    try {
      body = JSON.parse(rawBody!);
    } catch {
      return json(400, { error: 'Invalid JSON' });
    }
    const created = await createCardFromInput(client, createActor.actor, body);
    if (!created.ok) return created.response;
    const slots = await eventSlotsAfterWrite(client, createActor.actor, created.card);
    const templateIdByType = await getTemplateIdByType(client);
    const tasks = slots.eventSlots.length ? await listTasksByCardConsistent(client, created.card.id) : created.tasks;
    const card = await projectCard(new TeamDirectory(client), created.card, tasks, templateIdByType);
    return json(201, { card, tasks, ...slots });
  }

  // Method not allowed
  return {
    statusCode: 405,
    headers: JSON_HEADERS,
    body: JSON.stringify({ error: 'Method not allowed' }),
  };
}

/**
 * Handle explicit park/resume transitions between the board and the parked
 * Archive category. Parking keeps the stage and the Task counters; resuming
 * restores the board. Task-count completion still owns the done Archive.
 */
async function handleParkResume(
  method: string,
  id: string,
  action: 'park' | 'resume',
  rawBody: string | null,
  client: DynamoDBDocumentClient,
  event: LambdaEvent,
): Promise<LambdaResponse> {
  if (method !== 'POST') {
    return { statusCode: 405, headers: JSON_HEADERS, body: JSON.stringify({ error: 'Method not allowed' }) };
  }
  const updateActor = await resolveInteractiveActor(client, event, 'work-write');
  if (!updateActor.ok) return updateActor.response;
  const actor = updateActor.actor;
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(rawBody || '');
  } catch {
    return json(400, { error: 'Invalid JSON' });
  }
  if (!Number.isInteger(body.expectedVersion) || (body.expectedVersion as number) < 1) {
    return json(400, { error: 'expectedVersion must be an integer greater than or equal to 1' });
  }
  const existing = await getCardConsistent(client, id);
  if (!existing) return json(404, { error: 'Card not found' });
  if (!mayAdministerCard(actor, existing)) {
    return workAdminForbidden('Administering this Card requires its owner or an admin');
  }
  const card = action === 'park'
    ? await parkCard(client, id, body.expectedVersion as number)
    : await resumeCard(client, id, body.expectedVersion as number);
  const templateIdByType = await getTemplateIdByType(client);
  return json(200, { card: await projectCard(new TeamDirectory(client), card, undefined, templateIdByType) });
}

/**
 * Handle /api/cards/:id single resource routes (GET, PUT, DELETE).
 */
async function handleSingle(
  method: string,
  id: string,
  rawBody: string | null,
  client: DynamoDBDocumentClient,
  event: LambdaEvent,
): Promise<LambdaResponse> {
  if (method === 'GET') {
    const readActor = await resolveInteractiveActor(client, event, 'work-read');
    if (!readActor.ok) return readActor.response;
    const card = await getCardConsistent(client, id);
    if (!card) {
      return {
        statusCode: 404,
        headers: JSON_HEADERS,
        body: JSON.stringify({ error: 'Card not found' }),
      };
    }
    // Opening a teammate's Card exposes its Task execution actions; it does
    // not grant direct Card administration.
    const templateIdByType = await getTemplateIdByType(client);
    const tasks = await listTasksByCard(client, card.id);
    const projected = await projectCard(new TeamDirectory(client), card, tasks, templateIdByType);
    const linkedFrom = await cardBackReferences(client, card);
    return json(200, { card: { ...projected, linkedFrom } });
  }

  if (method === 'PUT') {
    const updateActor = await resolveInteractiveActor(client, event, 'work-write');
    if (!updateActor.ok) return updateActor.response;
    const actor = updateActor.actor;
    // Parse body
    let body: Record<string, unknown>;
    try {
      body = JSON.parse(rawBody!);
    } catch {
      return {
        statusCode: 400,
        headers: JSON_HEADERS,
        body: JSON.stringify({ error: 'Invalid JSON' }),
      };
    }

    if (!body || typeof body !== 'object' || Object.keys(body).length === 0) {
      return {
        statusCode: 400,
        headers: JSON_HEADERS,
        body: JSON.stringify({ error: 'Request body is empty or invalid' }),
      };
    }

    if (Object.hasOwn(body, 'version')) {
      return json(400, { error: 'version is response-only; use expectedVersion' });
    }
    if (!Number.isInteger(body.expectedVersion) || Number(body.expectedVersion) < 1) {
      return json(400, { error: 'expectedVersion must be an integer greater than or equal to 1' });
    }
    const systemOwnedFields = [
      'status', 'taskCount', 'openTaskCount', 'completedAt', 'completedBy',
      'activeStageBeforeCompletion', 'auditEventRefs', 'selectedOptionalGroups',
      'counts', 'linkedFrom',
    ];
    const suppliedSystemField = systemOwnedFields.find((field) => Object.hasOwn(body, field));
    if (suppliedSystemField) {
      return json(400, { error: `${suppliedSystemField} is system-owned and cannot be updated directly` });
    }

    // Check card exists using the same strong snapshot used for its precondition.
    const existing = await getCardConsistent(client, id);
    if (!existing) {
      return {
        statusCode: 404,
        headers: JSON_HEADERS,
        body: JSON.stringify({ error: 'Card not found' }),
      };
    }
    if (!mayAdministerCard(actor, existing)) {
      return workAdminForbidden('Administering this Card requires its owner or an admin');
    }

    const owner = requestedOwner(body);
    if (owner.supplied && 'invalid' in owner) {
      return json(400, { error: 'ownerId must be a user id or null' });
    }
    if (owner.supplied && !('invalid' in owner) && !actor.testBypass) {
      const currentOwnerId = typeof existing.ownerId === 'string' ? existing.ownerId : null;
      if (owner.ownerId !== currentOwnerId) {
        if (!actor.isAdmin) return workAdminForbidden('Changing a Card owner requires an admin');
        const ownerError = await ownerAssignmentError(client, owner.ownerId);
        if (ownerError) return json(400, { error: ownerError });
      }
    }

    // Validate stage if provided
    const VALID_STAGES = ['preparation', 'announced', 'after-event'];
    if (body.stage !== undefined && !VALID_STAGES.includes(body.stage as string)) {
      return {
        statusCode: 400,
        headers: JSON_HEADERS,
        body: JSON.stringify({ error: `Invalid stage value. Must be one of: ${VALID_STAGES.join(', ')}` }),
      };
    }
    if (body.stage !== undefined && existing.status !== 'active' && existing.status !== 'parked') {
      return json(400, { error: 'stage is system-owned while a Card is completed' });
    }

    const refsError = validateCardRefs(body);
    if (refsError) {
      return {
        statusCode: 400,
        headers: JSON_HEADERS,
        body: JSON.stringify({ error: refsError }),
      };
    }
    const peopleError = validateCardPeople(body);
    if (peopleError) {
      return {
        statusCode: 400,
        headers: JSON_HEADERS,
        body: JSON.stringify({ error: peopleError }),
      };
    }

    // Only allow updating known fields
    const allowedFields = [
      'title', 'description', 'anchorDate', 'endDate', 'references', 'cardLinks', 'tags', 'stage',
      'sourceDocIds', 'artifactRefs', 'intakeRefs',
      'people', 'sponsor', 'secondarySponsors', 'issueNumber',
    ];
    if (body.endDate !== undefined && body.endDate !== null
      && !/^\d{4}-\d{2}-\d{2}$/.test(body.endDate as string)) {
      return json(400, { error: 'Invalid endDate format, expected YYYY-MM-DD' });
    }
    if (
      body.anchorDate !== undefined &&
      body.anchorDate !== existing.anchorDate &&
      existing.eventTime?.eventKey &&
      existing.eventTime.status !== 'released'
    ) {
      return json(409, {
        error: `Card date is owned by event hold ${existing.eventTime.eventKey}. Use 'dataops event reschedule ${existing.id} --date ${body.anchorDate}' so the calendar hold and Card move together.`,
        code: 'event_hold_owns_date',
        holdId: existing.eventTime.eventKey,
      });
    }
    const updates: Record<string, unknown> = {};
    for (const field of allowedFields) {
      if (body[field] !== undefined) {
        if (field === 'issueNumber' && body[field] !== null) {
          updates[field] = String(body[field]).trim();
        } else if (field === 'cardLinks') {
          updates[field] = normalizeCardLinks(body[field]);
        } else {
          updates[field] = body[field];
        }
      }
    }
    if (owner.supplied && !('invalid' in owner)) {
      updates.ownerId = owner.ownerId;
    }

    if (Object.keys(updates).length === 0) {
      return {
        statusCode: 400,
        headers: JSON_HEADERS,
        body: JSON.stringify({ error: 'No valid fields to update' }),
      };
    }

    const card = await updateCard(client, id, {
      expectedVersion: body.expectedVersion as number,
      patch: updates,
    });
    const templateIdByType = await getTemplateIdByType(client);
    return json(200, { card: await projectCard(new TeamDirectory(client), card, undefined, templateIdByType) });
  }

  if (method === 'DELETE') {
    // Deleting a Card removes every Task it contains: administration only an
    // admin performs, never the Card owner alone.
    const deleteActor = await resolveInteractiveActor(client, event, 'work-write');
    if (!deleteActor.ok) return deleteActor.response;
    if (!deleteActor.actor.testBypass && !deleteActor.actor.isAdmin) {
      return workAdminForbidden('Deleting a Card requires an admin');
    }
    let body: Record<string, unknown>;
    try {
      body = JSON.parse(rawBody || '');
    } catch {
      return json(400, { error: 'Request body with expectedVersion is required' });
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return json(400, { error: 'Request body with expectedVersion is required' });
    }
    if (Object.hasOwn(body, 'version')) {
      return json(400, { error: 'version is response-only; use expectedVersion' });
    }
    if (!Number.isInteger(body.expectedVersion) || Number(body.expectedVersion) < 1) {
      return json(400, { error: 'expectedVersion must be an integer greater than or equal to 1' });
    }
    const deleted = await deleteCardCascade(
      client,
      id,
      body.expectedVersion as number,
      deleteActor.actor.id || 'system',
    );
    return json(200, { deleted });
  }

  // Method not allowed
  return {
    statusCode: 405,
    headers: JSON_HEADERS,
    body: JSON.stringify({ error: 'Method not allowed' }),
  };
}

/**
 * Handle /api/cards/:id/tasks sub-route (GET only).
 */
async function handleCardTasks(
  method: string,
  id: string,
  client: DynamoDBDocumentClient,
  event: LambdaEvent,
): Promise<LambdaResponse> {
  if (method !== 'GET') {
    return {
      statusCode: 405,
      headers: JSON_HEADERS,
      body: JSON.stringify({ error: 'Method not allowed' }),
    };
  }

  const readActor = await resolveInteractiveActor(client, event, 'work-read');
  if (!readActor.ok) return readActor.response;

  // Check card exists
  const card = await getCard(client, id);
  if (!card) {
    return {
      statusCode: 404,
      headers: JSON_HEADERS,
      body: JSON.stringify({ error: 'Card not found' }),
    };
  }

  const tasks = await listTasksByCard(client, id);
  const directory = new TeamDirectory(client);
  await directory.loadAll();
  const projected = await projectCard(directory, card, tasks);
  return json(200, {
    tasks: await projectTasks(directory, await attachLinkedCards(client, await attachPrerequisites(client, tasks))),
    owner: projected.owner,
    taskAssignees: projected.taskAssignees,
  });
}

/**
 * Handle /api/cards/:id/calendar-invites. A Card's invitations come only
 * from `cards time`; this route lists them (`?verify=1` asks Google which are
 * gone and marks those stale) and unlinks one (DELETE). Unlinking removes the
 * reference on the Card and never deletes the Google event.
 */
async function handleCardCalendarInvites(
  method: string,
  id: string,
  rawBody: string | null,
  client: DynamoDBDocumentClient,
  event: LambdaEvent,
): Promise<LambdaResponse> {
  if (method === 'GET') {
    const readActor = await resolveInteractiveActor(client, event, 'work-read');
    if (!readActor.ok) return readActor.response;
    const card = await getCardConsistent(client, id);
    if (!card) return json(404, { error: 'Card not found' });
    if (!['1', 'true'].includes(String(event.queryStringParameters?.verify || ''))) {
      return json(200, { invites: card.calendarInvites || [] });
    }
    const verified = await verifyCardInvites(client, card, await calendarInviteDeps({}, client));
    return json(200, { invites: verified.card.calendarInvites || [], check: verified.check });
  }

  if (method === 'DELETE') {
    const writeActor = await resolveInteractiveActor(client, event, 'work-write');
    if (!writeActor.ok) return writeActor.response;
    let body: Record<string, unknown>;
    try {
      body = JSON.parse(rawBody || '{}');
    } catch {
      return json(400, { error: 'Invalid JSON' });
    }
    const eventId = typeof body?.eventId === 'string' ? body.eventId.trim() : '';
    const calendar = typeof body?.calendar === 'string' ? body.calendar.trim() : '';
    const deleteEvent = body?.deleteEvent === true;
    if (!eventId) return json(400, { error: 'eventId is required' });
    const existing = await getCardConsistent(client, id);
    if (!existing) return json(404, { error: 'Card not found' });
    if (!mayAdministerCard(writeActor.actor, existing)) {
      return workAdminForbidden('Administering this Card requires its owner or an admin');
    }
    try {
      const { card, removed } = await unlinkCardInvite(client, existing, eventId, calendar || undefined,
        deleteEvent ? { deleteEvent, deps: await calendarInviteDeps({}, client) } : {});
      return json(200, { removed, invites: card.calendarInvites || [] });
    } catch (error) {
      if (error instanceof CardInviteInputError) return json(404, { error: error.message, code: 'invite_not_linked' });
      if (error instanceof CardInviteConflictError) return json(409, { error: error.message, code: 'invite_conflict' });
      throw error;
    }
  }

  return json(405, { error: 'Method not allowed' });
}

export { handleCardRoutes };

async function handleCardTime(method: string, id: string, rawBody: string | null, client: DynamoDBDocumentClient, event: LambdaEvent): Promise<LambdaResponse> {
  if (method !== 'POST') return json(405, { error: 'Method not allowed' });
  const resolved = await resolveInteractiveActor(client, event, 'work-write');
  if (!resolved.ok) return resolved.response;
  const card = await getCardConsistent(client, id);
  if (!card) return json(404, { error: 'Card not found' });
  if (!mayAdministerCard(resolved.actor, card)) return workAdminForbidden('Administering this Card requires its owner or an admin');
  let interval;
  let guests;
  try {
    const body = JSON.parse(rawBody || '{}');
    interval = cardEventInterval(body.at, body.duration ?? card.eventTime?.durationMinutes ?? 60, body.tz ?? card.eventTime?.timeZone ?? 'Europe/Berlin');
    guests = body.guestEmails !== undefined ? parseCardGuests(body.guestEmails) : await cardGuests(client, card);
  } catch (error) {
    return json(400, { error: error instanceof Error ? error.message : 'Invalid event time' });
  }
  try {
    const deps = await calendarInviteDeps({}, client);
    const verified = await verifyCardInvites(client, card, deps);
    const result = await syncCardInvite(client, verified.card, interval, guests, deps, resolved.actor.id);
    const dated = await adoptEventDate(client, result.card, card.eventTime);
    const projected = await projectCard(new TeamDirectory(client), dated.card, undefined, await getTemplateIdByType(client));
    return json(result.sync.state === 'synced' ? 200 : 502, {
      ...result, card: projected, inviteCheck: verified.check, movedTasks: dated.movedTasks,
      ...(result.sync.state === 'deferred' ? { error: result.sync.reason } : {}),
    });
  } catch (error) {
    if (error instanceof CardVersionConflictError || error instanceof CardInviteConflictError) return json(409, { error: 'Card invitation changed or is syncing; reload and retry' });
    if (error instanceof CardInviteInputError) return json(422, { error: error.message });
    throw error;
  }
}
