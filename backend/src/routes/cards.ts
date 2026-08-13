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
import { templateCardProjection } from '../templates/cardTemplateProjection';
import type { LambdaResponse } from '../types';

const JSON_HEADERS: Record<string, string> = { 'Content-Type': 'application/json' };

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
async function handleCardRoutes(path: string, method: string, rawBody: string | null): Promise<LambdaResponse | null> {
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
