import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import {
  CardNotFoundError,
  CardVersionConflictError,
  createCard,
  getCard,
  getCardConsistent,
  updateCard,
  listCardsPage,
} from '../db/cards';
import { CollectionCursorError, encodeCollectionCursor } from '../db/collectionPagination';
import {
  createCardFromTemplate,
  getTemplate,
  TemplateVersionConflictError,
} from '../db/templates';
import { listAllTasks, listTasksByCard } from '../db/tasks';
import {
  applyCardTemplateUpdate,
  CardTemplateUpdateConflictError,
} from '../db/cardTemplateUpdates';
import { templateCardProjection } from '../templates/cardTemplateProjection';
import {
  resolveInteractiveActor,
  workAdminForbidden,
  type VerifiedActor,
} from '../identity/actor';
import { TeamDirectory } from '../identity/directory';
import { projectCard, projectCards, projectTasks } from '../identity/projections';
import {
  matchesOwnerFilter,
  ownerFilterUserId,
  parseOwnerFilter,
} from '../identity/ownerFilter';
import {
  buildCardTemplateUpdatePlan,
  CardTemplateUpdateInvalidStateError,
} from '../templates/cardTemplateUpdates';
import type { Card, LambdaEvent, LambdaResponse, Task } from '../types';

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

/**
 * Validate an administrative owner reference: an active team member, or an
 * explicit `null` meaning unassigned. A stale or disabled reference is never
 * a valid new owner, and ownership is never inferred.
 */
async function ownerAssignmentError(
  client: DynamoDBDocumentClient,
  ownerId: string | null,
): Promise<string | null> {
  if (ownerId === null) return null;
  const target = await new TeamDirectory(client).project(ownerId);
  return target.active ? null : 'ownerId must reference an active team member';
}

type RequestedOwner =
  | { supplied: false }
  | { supplied: true; ownerId: string | null }
  | { supplied: true; invalid: true };

function requestedOwner(body: Record<string, unknown>): RequestedOwner {
  if (!Object.hasOwn(body, 'ownerId')) return { supplied: false };
  const value = body.ownerId;
  if (value === null) return { supplied: true, ownerId: null };
  if (typeof value !== 'string') return { supplied: true, invalid: true };
  const trimmed = value.trim();
  return { supplied: true, ownerId: trimmed.length > 0 ? trimmed : null };
}

async function loadTemplateUpdate(cardId: string, client: DynamoDBDocumentClient) {
  const card = await getCard(client, cardId);
  if (!card) throw new CardTemplateUpdateRequestError(404, 'card-not-found', 'Card not found');
  if (!card.templateId) {
    throw new CardTemplateUpdateRequestError(422, 'card-has-no-template', 'Card was not created from a Template');
  }
  const template = await getTemplate(client, card.templateId);
  if (!template) throw new CardTemplateUpdateRequestError(409, 'template-not-found', 'Card Template projection no longer exists');
  const tasks = await listTasksByCard(client, card.id);
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
    );
    return json(200, result);
  } catch (error) {
    return updateError(error);
  }
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

function isRecordArrayWithStringId(value: unknown, idField: string): boolean {
  return Array.isArray(value) && value.every((item) => (
    item !== null
    && typeof item === 'object'
    && !Array.isArray(item)
    && typeof (item as Record<string, unknown>)[idField] === 'string'
    && ((item as Record<string, unknown>)[idField] as string).trim().length > 0
  ));
}

function validateCardRefs(body: Record<string, unknown>): string | null {
  if (body.sourceDocIds !== undefined && (
    !Array.isArray(body.sourceDocIds)
    || !body.sourceDocIds.every((item) => typeof item === 'string')
  )) {
    return 'sourceDocIds must be an array of strings';
  }
  if (body.artifactRefs !== undefined && !isRecordArrayWithStringId(body.artifactRefs, 'artifactId')) {
    return 'artifactRefs must be an array of objects with artifactId';
  }
  if (body.assistantJobRefs !== undefined && !isRecordArrayWithStringId(body.assistantJobRefs, 'assistantJobId')) {
    return 'assistantJobRefs must be an array of objects with assistantJobId';
  }
  if (body.auditEventRefs !== undefined && !isRecordArrayWithStringId(body.auditEventRefs, 'auditEventId')) {
    return 'auditEventRefs must be an array of objects with auditEventId';
  }
  return null;
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
    console.error('Card route error:', err);
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

    const ownerParse = parseOwnerFilter((event.queryStringParameters || {}).owner, listActor.actor);
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

    // The bounded-complete Task read is intentionally sequential with Cards:
    // if it reaches its ceiling, the API fails instead of projecting an
    // apparently complete board with orphan-looking relationships.
    const allTasks = await listAllTasks(client);

    const tasksByCardId = new Map<string, Task[]>();
    for (const task of allTasks) {
      if (typeof task.cardId !== 'string' || task.cardId.length === 0) continue;
      const tasks = tasksByCardId.get(task.cardId) || [];
      tasks.push(task);
      tasksByCardId.set(task.cardId, tasks);
    }

    const responseBody: {
      cards: Record<string, unknown>;
      owner?: Awaited<ReturnType<TeamDirectory['project']>>;
    } = {
      cards: {
        items: await projectCards(directory, cardPage.items, tasksByCardId),
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
    const actor = createActor.actor;
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

    // Validate required fields
    if (!body.title || typeof body.title !== 'string' || (body.title as string).trim() === '') {
      return {
        statusCode: 400,
        headers: JSON_HEADERS,
        body: JSON.stringify({ error: 'Missing required field: title' }),
      };
    }

    if (!body.anchorDate) {
      return {
        statusCode: 400,
        headers: JSON_HEADERS,
        body: JSON.stringify({ error: 'Missing required field: anchorDate' }),
      };
    }

    // Validate anchorDate format (YYYY-MM-DD)
    if (!/^\d{4}-\d{2}-\d{2}$/.test(body.anchorDate as string)) {
      return {
        statusCode: 400,
        headers: JSON_HEADERS,
        body: JSON.stringify({ error: 'Invalid anchorDate format, expected YYYY-MM-DD' }),
      };
    }

    const systemOwnedFields = [
      'version', 'expectedVersion', 'status', 'taskCount', 'openTaskCount',
      'completedAt', 'completedBy', 'activeStageBeforeCompletion', 'auditEventRefs',
    ];
    const suppliedSystemField = systemOwnedFields.find((field) => Object.hasOwn(body, field));
    if (suppliedSystemField) {
      return json(400, { error: `${suppliedSystemField} is system-owned and cannot be supplied` });
    }

    // If templateId is provided, verify template exists before creating card
    let template = null;
    if (body.templateId) {
      template = await getTemplate(client, body.templateId as string);
      if (!template) {
        return {
          statusCode: 404,
          headers: JSON_HEADERS,
          body: JSON.stringify({ error: 'Template not found' }),
        };
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
    const refsError = validateCardRefs(body);
    if (refsError) {
      return {
        statusCode: 400,
        headers: JSON_HEADERS,
        body: JSON.stringify({ error: refsError }),
      };
    }

    // Ownership is administrative metadata. An operator-created Card is owned
    // by that operator; only an admin may create a Card owned by somebody else
    // or deliberately unassigned.
    const owner = requestedOwner(body);
    let ownerId: string | null = null;
    if (owner.supplied && 'invalid' in owner) {
      return json(400, { error: 'ownerId must be a user id or null' });
    }
    if (!actor.testBypass) {
      const suppliedOwnerId = owner.supplied ? owner.ownerId : undefined;
      if (suppliedOwnerId !== undefined && suppliedOwnerId !== actor.id && !actor.isAdmin) {
        return workAdminForbidden('Setting a Card owner requires an admin');
      }
      ownerId = suppliedOwnerId === undefined ? actor.id : suppliedOwnerId;
      const ownerError = await ownerAssignmentError(client, ownerId);
      if (ownerError) return json(400, { error: ownerError });
    } else if (owner.supplied && !('invalid' in owner)) {
      ownerId = owner.ownerId;
    }

    // Build card data
    const cardData: Record<string, unknown> = {
      title: body.title,
      anchorDate: body.anchorDate,
      stage: body.stage || 'preparation',
    };
    if (ownerId) cardData.ownerId = ownerId;
    if (body.description !== undefined) {
      cardData.description = body.description;
    }
    if (body.templateId !== undefined) {
      cardData.templateId = body.templateId;
    }

    // When templateId is provided, copy template fields to card (caller values take precedence)
    if (template) {
      Object.assign(cardData, templateCardProjection(template));
      if (body.sourceDocIds !== undefined) {
        cardData.sourceDocIds = body.sourceDocIds;
      } else if (template.sourceDocIds && template.sourceDocIds.length > 0) {
        cardData.sourceDocIds = template.sourceDocIds;
      }
      // Copy references from template if caller didn't provide them
      if (body.references !== undefined) {
        cardData.references = body.references;
      } else if (template.references && template.references.length > 0) {
        cardData.references = template.references;
      }

      // Create cardLinks from template cardLinkDefinitions if caller didn't provide them
      if (body.cardLinks !== undefined) {
        cardData.cardLinks = body.cardLinks;
      } else if (template.cardLinkDefinitions && template.cardLinkDefinitions.length > 0) {
        cardData.cardLinks = template.cardLinkDefinitions.map((def: { name: string }) => ({
          name: def.name,
          url: '',
        }));
      }

      // Copy emoji from template if caller didn't provide it
      if (body.emoji !== undefined) {
        cardData.emoji = body.emoji;
      } else if (template.emoji) {
        cardData.emoji = template.emoji;
      }

      // Copy tags from template if caller didn't provide them
      if (body.tags !== undefined) {
        cardData.tags = body.tags;
      } else if (template.tags && template.tags.length > 0) {
        cardData.tags = template.tags;
      }
    } else {
      // No template - use caller-provided values directly
      if (body.references !== undefined) {
        cardData.references = body.references;
      }
      if (body.cardLinks !== undefined) {
        cardData.cardLinks = body.cardLinks;
      }
      if (body.emoji !== undefined) {
        cardData.emoji = body.emoji;
      }
      if (body.tags !== undefined) {
        cardData.tags = body.tags;
      }
      if (body.sourceDocIds !== undefined) {
        cardData.sourceDocIds = body.sourceDocIds;
      }
    }
    for (const field of ['artifactRefs', 'assistantJobRefs', 'intakeRefs']) {
      if (body[field] !== undefined) {
        cardData[field] = body[field];
      }
    }

    if (template) {
      try {
        const { card, tasks } = await createCardFromTemplate(
          client,
          cardData,
          template,
          body.anchorDate as string,
        );
        return json(201, { card: await projectCard(new TeamDirectory(client), card, tasks), tasks });
      } catch (error) {
        if (error instanceof TemplateVersionConflictError) {
          return json(409, {
            code: 'template_version_conflict',
            error: 'Template changed while the Card was being created. Review the latest Template and retry.',
          });
        }
        throw error;
      }
    }

    const card = await createCard(client, cardData);

    return json(201, { card: await projectCard(new TeamDirectory(client), card) });
  }

  // Method not allowed
  return {
    statusCode: 405,
    headers: JSON_HEADERS,
    body: JSON.stringify({ error: 'Method not allowed' }),
  };
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
    const tasks = await listTasksByCard(client, card.id);
    return json(200, { card: await projectCard(new TeamDirectory(client), card, tasks) });
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
      'activeStageBeforeCompletion', 'auditEventRefs',
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
    if (body.stage !== undefined && existing.status !== 'active') {
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

    // Only allow updating known fields
    const allowedFields = [
      'title', 'description', 'anchorDate', 'references', 'cardLinks', 'emoji', 'tags', 'stage',
      'sourceDocIds', 'artifactRefs', 'assistantJobRefs', 'intakeRefs',
    ];
    const updates: Record<string, unknown> = {};
    for (const field of allowedFields) {
      if (body[field] !== undefined) {
        updates[field] = body[field];
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
    return json(200, { card: await projectCard(new TeamDirectory(client), card) });
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
    tasks: await projectTasks(directory, tasks),
    owner: projected.owner,
    taskAssignees: projected.taskAssignees,
  });
}

export { handleCardRoutes };
