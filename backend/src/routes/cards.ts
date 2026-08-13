import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { getClient } from '../db/client';
import {
  createCard,
  getCard,
  updateCard,
  deleteCard,
  listCards,
} from '../db/cards';
import { getTemplate, instantiateTemplate } from '../db/templates';
import { listTasksByCard } from '../db/tasks';
import {
  applyCardTemplateUpdate,
  CardTemplateUpdateConflictError,
} from '../db/cardTemplateUpdates';
import { templateCardProjection } from '../templates/cardTemplateProjection';
import {
  buildCardTemplateUpdatePlan,
  CardTemplateUpdateInvalidStateError,
} from '../templates/cardTemplateUpdates';
import type { LambdaEvent, LambdaResponse } from '../types';

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

function headerValue(headers: Record<string, string> | null | undefined, name: string): string {
  if (!headers) return '';
  const match = Object.entries(headers).find(([key]) => key.toLowerCase() === name.toLowerCase());
  return match && typeof match[1] === 'string' ? match[1].trim() : '';
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
  try {
    const loaded = await loadTemplateUpdate(cardId, client);
    if (method === 'GET') return json(200, { preview: loaded.plan.preview });
    if (method !== 'POST') return json(405, { error: 'Method not allowed' });
    const body = parseObject(rawBody);
    const previewToken = typeof body.previewToken === 'string' ? body.previewToken : '';
    if (!/^[a-f0-9]{64}$/.test(previewToken)) {
      return json(400, { error: 'previewToken must be a SHA-256 digest', code: 'invalid-preview-token' });
    }
    const actorId = headerValue(event.headers, 'x-user-id') || 'system';
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

    const actorId = headerValue(event.headers, 'x-user-id') || 'system';
    const results = [];
    for (const update of updates) {
      const cardId = String(update.cardId);
      try {
        const loaded = await loadTemplateUpdate(cardId, client);
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
): Promise<LambdaResponse | null> {
  // Match /api/cards paths
  if (!path.startsWith('/api/cards')) {
    return null;
  }

  const client = await getClient();

  try {
    // Parse the path segments after /api/cards
    const suffix = path.slice('/api/cards'.length);

    // Route: /api/cards (collection)
    if (suffix === '' || suffix === '/') {
      return await handleCollection(method, rawBody, client);
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

    // Route: /api/cards/:id/archive
    const archiveMatch = suffix.match(/^\/([^/]+)\/archive\/?$/);
    if (archiveMatch) {
      const id = archiveMatch[1];
      return await handleArchive(method, id, client);
    }

    // Route: /api/cards/:id/tasks
    const tasksMatch = suffix.match(/^\/([^/]+)\/tasks\/?$/);
    if (tasksMatch) {
      const id = tasksMatch[1];
      return await handleCardTasks(method, id, client);
    }

    // Route: /api/cards/:id
    const idMatch = suffix.match(/^\/([^/]+)\/?$/);
    if (idMatch) {
      const id = idMatch[1];
      return await handleSingle(method, id, rawBody, client);
    }

    // No match within /api/cards
    return {
      statusCode: 404,
      headers: JSON_HEADERS,
      body: JSON.stringify({ error: 'Not found' }),
    };
  } catch (err: unknown) {
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
async function handleCollection(method: string, rawBody: string | null, client: DynamoDBDocumentClient): Promise<LambdaResponse> {
  if (method === 'GET') {
    const cards = await listCards(client);
    return {
      statusCode: 200,
      headers: JSON_HEADERS,
      body: JSON.stringify({ cards }),
    };
  }

  if (method === 'POST') {
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
    const VALID_STAGES = ['preparation', 'announced', 'after-event', 'done'];
    if (body.stage !== undefined && !VALID_STAGES.includes(body.stage as string)) {
      return {
        statusCode: 400,
        headers: JSON_HEADERS,
        body: JSON.stringify({ error: `Invalid stage value. Must be one of: ${VALID_STAGES.join(', ')}` }),
      };
    }

    // Validate status if provided
    const VALID_STATUSES = ['active', 'archived'];
    if (body.status !== undefined && !VALID_STATUSES.includes(body.status as string)) {
      return {
        statusCode: 400,
        headers: JSON_HEADERS,
        body: JSON.stringify({ error: `Invalid status value. Must be one of: ${VALID_STATUSES.join(', ')}` }),
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

    // Build card data
    const cardData: Record<string, unknown> = {
      title: body.title,
      anchorDate: body.anchorDate,
      stage: body.stage || 'preparation',
      status: body.status || 'active',
    };
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
    for (const field of ['artifactRefs', 'assistantJobRefs', 'auditEventRefs']) {
      if (body[field] !== undefined) {
        cardData[field] = body[field];
      }
    }

    const card = await createCard(client, cardData);

    // If templateId provided, instantiate the template
    if (body.templateId) {
      const tasks = await instantiateTemplate(
        client,
        body.templateId as string,
        card.id,
        body.anchorDate as string
      );
      return {
        statusCode: 201,
        headers: JSON_HEADERS,
        body: JSON.stringify({ card, tasks }),
      };
    }

    return {
      statusCode: 201,
      headers: JSON_HEADERS,
      body: JSON.stringify({ card }),
    };
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
async function handleSingle(method: string, id: string, rawBody: string | null, client: DynamoDBDocumentClient): Promise<LambdaResponse> {
  if (method === 'GET') {
    const card = await getCard(client, id);
    if (!card) {
      return {
        statusCode: 404,
        headers: JSON_HEADERS,
        body: JSON.stringify({ error: 'Card not found' }),
      };
    }
    return {
      statusCode: 200,
      headers: JSON_HEADERS,
      body: JSON.stringify({ card }),
    };
  }

  if (method === 'PUT') {
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

    // Check card exists
    const existing = await getCard(client, id);
    if (!existing) {
      return {
        statusCode: 404,
        headers: JSON_HEADERS,
        body: JSON.stringify({ error: 'Card not found' }),
      };
    }

    // Validate stage if provided
    const VALID_STAGES = ['preparation', 'announced', 'after-event', 'done'];
    if (body.stage !== undefined && !VALID_STAGES.includes(body.stage as string)) {
      return {
        statusCode: 400,
        headers: JSON_HEADERS,
        body: JSON.stringify({ error: `Invalid stage value. Must be one of: ${VALID_STAGES.join(', ')}` }),
      };
    }

    // Validate status if provided
    const VALID_STATUSES = ['active', 'archived'];
    if (body.status !== undefined && !VALID_STATUSES.includes(body.status as string)) {
      return {
        statusCode: 400,
        headers: JSON_HEADERS,
        body: JSON.stringify({ error: `Invalid status value. Must be one of: ${VALID_STATUSES.join(', ')}` }),
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

    // Only allow updating known fields
    const allowedFields = [
      'title', 'description', 'anchorDate', 'references', 'cardLinks', 'emoji', 'tags', 'stage', 'status',
      'sourceDocIds', 'artifactRefs', 'assistantJobRefs', 'auditEventRefs',
    ];
    const updates: Record<string, unknown> = {};
    for (const field of allowedFields) {
      if (body[field] !== undefined) {
        updates[field] = body[field];
      }
    }

    if (Object.keys(updates).length === 0) {
      return {
        statusCode: 400,
        headers: JSON_HEADERS,
        body: JSON.stringify({ error: 'No valid fields to update' }),
      };
    }

    const card = await updateCard(client, id, updates);
    return {
      statusCode: 200,
      headers: JSON_HEADERS,
      body: JSON.stringify({ card }),
    };
  }

  if (method === 'DELETE') {
    const existing = await getCard(client, id);
    if (!existing) {
      return {
        statusCode: 404,
        headers: JSON_HEADERS,
        body: JSON.stringify({ error: 'Card not found' }),
      };
    }

    // Only archived cards can be permanently deleted
    if (existing.status !== 'archived') {
      return {
        statusCode: 400,
        headers: JSON_HEADERS,
        body: JSON.stringify({ error: 'Only archived cards can be deleted' }),
      };
    }

    await deleteCard(client, id);
    return {
      statusCode: 204,
      headers: JSON_HEADERS,
      body: '',
    };
  }

  // Method not allowed
  return {
    statusCode: 405,
    headers: JSON_HEADERS,
    body: JSON.stringify({ error: 'Method not allowed' }),
  };
}

/**
 * Handle /api/cards/:id/archive sub-route (PUT only).
 */
async function handleArchive(method: string, id: string, client: DynamoDBDocumentClient): Promise<LambdaResponse> {
  if (method !== 'PUT') {
    return {
      statusCode: 405,
      headers: JSON_HEADERS,
      body: JSON.stringify({ error: 'Method not allowed' }),
    };
  }

  const existing = await getCard(client, id);
  if (!existing) {
    return {
      statusCode: 404,
      headers: JSON_HEADERS,
      body: JSON.stringify({ error: 'Card not found' }),
    };
  }

  const card = await updateCard(client, id, { status: 'archived' });
  return {
    statusCode: 200,
    headers: JSON_HEADERS,
    body: JSON.stringify({ card }),
  };
}

/**
 * Handle /api/cards/:id/tasks sub-route (GET only).
 */
async function handleCardTasks(method: string, id: string, client: DynamoDBDocumentClient): Promise<LambdaResponse> {
  if (method !== 'GET') {
    return {
      statusCode: 405,
      headers: JSON_HEADERS,
      body: JSON.stringify({ error: 'Method not allowed' }),
    };
  }

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
  return {
    statusCode: 200,
    headers: JSON_HEADERS,
    body: JSON.stringify({ tasks }),
  };
}

export { handleCardRoutes };
