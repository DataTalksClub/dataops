/**
 * Card creation from a request-shaped input.
 *
 * `POST /api/cards` and every route that creates a Card on behalf of another
 * record (a newsletter slot, a podcast episode) share this one path, so a Card
 * created anywhere is instantiated from a Template and gets the same
 * validation, ownership rule, Template projection, and title parsing.
 */
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

import { normalizeCardLinks } from '../artifactLinks';
import {
  createCardFromTemplate,
  getTemplate,
  listTemplates,
  TemplateVersionConflictError,
} from '../db/templates';
import { parseCardTitle } from './cardTitleStructure';
import { cardFieldTitleValues, renderCardTitle } from './cardTitlePattern';
import { templateCardProjection } from '../templates/cardTemplateProjection';
import { countValuesError } from '../templates/repeatedTasks';
import { workAdminForbidden, type VerifiedActor } from '../identity/actor';
import { TeamDirectory } from '../identity/directory';
import type { PlannedWrite } from '../db/plannedWrite';
import type { Card, LambdaResponse, Task, Template } from '../types';

const JSON_HEADERS: Record<string, string> = { 'Content-Type': 'application/json' };

function json(statusCode: number, body: unknown): LambdaResponse {
  return { statusCode, headers: JSON_HEADERS, body: JSON.stringify(body) };
}

export type CardCreation =
  | { ok: true; card: Card; tasks: Task[]; template: Template }
  | { ok: false; response: LambdaResponse };

function isRecordArrayWithStringId(value: unknown, idField: string): boolean {
  return Array.isArray(value) && value.every((item) => (
    item !== null
    && typeof item === 'object'
    && !Array.isArray(item)
    && typeof (item as Record<string, unknown>)[idField] === 'string'
    && ((item as Record<string, unknown>)[idField] as string).trim().length > 0
  ));
}

export function validateCardRefs(body: Record<string, unknown>): string | null {
  if (body.sourceDocIds !== undefined && (
    !Array.isArray(body.sourceDocIds)
    || !body.sourceDocIds.every((item) => typeof item === 'string')
  )) {
    return 'sourceDocIds must be an array of strings';
  }
  if (body.artifactRefs !== undefined && !isRecordArrayWithStringId(body.artifactRefs, 'artifactId')) {
    return 'artifactRefs must be an array of objects with artifactId';
  }
  if (body.auditEventRefs !== undefined && !isRecordArrayWithStringId(body.auditEventRefs, 'auditEventId')) {
    return 'auditEventRefs must be an array of objects with auditEventId';
  }
  return null;
}

let cachedTemplateTypeMap: { timestamp: number; map: Map<string, string> } | null = null;

/**
 * Drop the process-local type map. Template create/delete/adopt call this
 * synchronously so the same Lambda never resolves a new type to a stale id
 * (or a deleted id to a card) within the 60s cross-instance TTL window.
 */
export function invalidateTemplateTypeMap(): void {
  cachedTemplateTypeMap = null;
}

export async function getTemplateIdByType(client: DynamoDBDocumentClient): Promise<Map<string, string>> {
  const now = Date.now();
  if (cachedTemplateTypeMap && now - cachedTemplateTypeMap.timestamp < 60_000) {
    return cachedTemplateTypeMap.map;
  }
  try {
    const templates = await listTemplates(client);
    const map = new Map<string, string>();
    for (const t of templates) {
      if (t.type && t.id) {
        map.set(t.type, t.id);
      }
    }
    cachedTemplateTypeMap = { timestamp: now, map };
    return map;
  } catch (err) {
    console.error('Failed to load templates for card structure mapping:', err);
    return cachedTemplateTypeMap ? cachedTemplateTypeMap.map : new Map();
  }
}

function isNameList(value: unknown): boolean {
  return Array.isArray(value)
    && value.length <= 20
    && value.every((item) => typeof item === 'string' && item.trim().length > 0 && item.length <= 200);
}

export function validateCardPeople(body: Record<string, unknown>): string | null {
  if (body.people !== undefined && !isNameList(body.people)) {
    return 'people must be an array of up to 20 non-empty names';
  }
  if (body.secondarySponsors !== undefined && !isNameList(body.secondarySponsors)) {
    return 'secondarySponsors must be an array of up to 20 non-empty names';
  }
  if (body.sponsor !== undefined && body.sponsor !== null && (
    typeof body.sponsor !== 'string' || body.sponsor.trim().length === 0 || body.sponsor.length > 200
  )) {
    return 'sponsor must be a non-empty string or null';
  }
  if (body.issueNumber !== undefined && body.issueNumber !== null) {
    if (typeof body.issueNumber !== 'string' && typeof body.issueNumber !== 'number') {
      return 'issueNumber must be a string or number';
    }
    const str = String(body.issueNumber).trim();
    if (str.length === 0 || str.length > 50) {
      return 'issueNumber must not be empty or longer than 50 characters';
    }
  }
  return null;
}

/**
 * Validate an administrative owner reference: an active team member, or an
 * explicit `null` meaning unassigned. A stale or disabled reference is never
 * a valid new owner, and ownership is never inferred.
 */
export async function ownerAssignmentError(
  client: DynamoDBDocumentClient,
  ownerId: string | null,
): Promise<string | null> {
  if (ownerId === null) return null;
  const target = await new TeamDirectory(client).project(ownerId);
  return target.active ? null : 'ownerId must reference an active team member';
}

export type RequestedOwner =
  | { supplied: false }
  | { supplied: true; ownerId: string | null }
  | { supplied: true; invalid: true };

export function requestedOwner(body: Record<string, unknown>): RequestedOwner {
  if (!Object.hasOwn(body, 'ownerId')) return { supplied: false };
  const value = body.ownerId;
  if (value === null) return { supplied: true, ownerId: null };
  if (typeof value !== 'string') return { supplied: true, invalid: true };
  const trimmed = value.trim();
  return { supplied: true, ownerId: trimmed.length > 0 ? trimmed : null };
}

/**
 * Validate a create request and write the Card (and, for a Template-backed
 * Card, its Tasks as one aggregate). The actor must already be resolved for
 * `work-write`.
 */
export async function createCardFromInput(
  client: DynamoDBDocumentClient,
  actor: VerifiedActor,
  body: Record<string, unknown>,
  options: { companions?: (card: Card) => PlannedWrite[] } = {},
): Promise<CardCreation> {
  const fail = (statusCode: number, payload: unknown): CardCreation => ({ ok: false, response: json(statusCode, payload) });

  if (body.title !== undefined && typeof body.title !== 'string') {
    return fail(400, { error: 'title must be a string' });
  }
  if (!body.anchorDate) {
    return fail(400, { error: 'Missing required field: anchorDate' });
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(body.anchorDate as string)) {
    return fail(400, { error: 'Invalid anchorDate format, expected YYYY-MM-DD' });
  }
  if (body.endDate !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(body.endDate as string)) {
    return fail(400, { error: 'Invalid endDate format, expected YYYY-MM-DD' });
  }

  const systemOwnedFields = [
    'version', 'expectedVersion', 'status', 'taskCount', 'openTaskCount',
    'completedAt', 'completedBy', 'activeStageBeforeCompletion', 'auditEventRefs', 'selectedOptionalGroups',
    'linkedFrom',
  ];
  const suppliedSystemField = systemOwnedFields.find((field) => Object.hasOwn(body, field));
  if (suppliedSystemField) {
    return fail(400, { error: `${suppliedSystemField} is system-owned and cannot be supplied` });
  }

  // Every Card is instantiated from a Template.
  if (typeof body.templateId !== 'string' || body.templateId.trim() === '') {
    return fail(400, { error: 'Missing required field: templateId', code: 'template-required' });
  }
  const template = await getTemplate(client, body.templateId);
  if (!template) return fail(404, { error: 'Template not found' });

  // A Template with a card_title pattern names its Cards; otherwise the
  // caller must.
  let title = typeof body.title === 'string' ? body.title.trim() : '';
  if (!title && template.cardTitle) {
    title = renderCardTitle(template.cardTitle, cardFieldTitleValues(template.type || '', body)) || template.name;
  }
  if (!title) return fail(400, { error: 'Missing required field: title' });

  const VALID_STAGES = ['preparation', 'announced', 'after-event'];
  if (body.stage !== undefined && !VALID_STAGES.includes(body.stage as string)) {
    return fail(400, { error: `Invalid stage value. Must be one of: ${VALID_STAGES.join(', ')}` });
  }
  const refsError = validateCardRefs(body);
  if (refsError) return fail(400, { error: refsError });
  const peopleError = validateCardPeople(body);
  if (peopleError) return fail(400, { error: peopleError });

  // Ownership is administrative metadata. An operator-created Card is owned
  // by that operator; only an admin may create a Card owned by somebody else
  // or deliberately unassigned.
  const owner = requestedOwner(body);
  let ownerId: string | null = null;
  if (owner.supplied && 'invalid' in owner) {
    return fail(400, { error: 'ownerId must be a user id or null' });
  }
  if (!actor.testBypass) {
    const suppliedOwnerId = owner.supplied ? owner.ownerId : undefined;
    if (suppliedOwnerId !== undefined && suppliedOwnerId !== actor.id && !actor.isAdmin) {
      return { ok: false, response: workAdminForbidden('Setting a Card owner requires an admin') };
    }
    ownerId = suppliedOwnerId === undefined ? actor.id : suppliedOwnerId;
    const ownerError = await ownerAssignmentError(client, ownerId);
    if (ownerError) return fail(400, { error: ownerError });
  } else if (owner.supplied && !('invalid' in owner)) {
    ownerId = owner.ownerId;
  }

  const cardData: Record<string, unknown> = {
    title,
    anchorDate: body.anchorDate,
    stage: body.stage || 'preparation',
  };
  if (body.endDate !== undefined) cardData.endDate = body.endDate;
  if (ownerId) cardData.ownerId = ownerId;
  if (body.description !== undefined) {
    cardData.description = body.description;
  }

  // Copy Template fields to the Card; caller values take precedence.
  Object.assign(cardData, templateCardProjection(template));
  if (body.sourceDocIds !== undefined) {
    cardData.sourceDocIds = body.sourceDocIds;
  } else if (template.sourceDocIds && template.sourceDocIds.length > 0) {
    cardData.sourceDocIds = template.sourceDocIds;
  }
  if (body.references !== undefined) {
    cardData.references = body.references;
  } else if (template.references && template.references.length > 0) {
    cardData.references = template.references;
  }
  if (body.cardLinks !== undefined) {
    cardData.cardLinks = normalizeCardLinks(body.cardLinks);
  } else if (template.cardLinkDefinitions && template.cardLinkDefinitions.length > 0) {
    cardData.cardLinks = template.cardLinkDefinitions.map((def: { name: string }) => ({
      name: def.name,
      url: '',
    }));
  }
  if (body.tags !== undefined) {
    cardData.tags = body.tags;
  } else if (template.tags && template.tags.length > 0) {
    cardData.tags = template.tags;
  }
  for (const field of ['artifactRefs', 'intakeRefs', 'people', 'sponsor', 'secondarySponsors', 'issueNumber']) {
    if (body[field] !== undefined) {
      cardData[field] = body[field] !== null && field === 'issueNumber' ? String(body[field]).trim() : body[field];
    }
  }

  const parsed = parseCardTitle(String(cardData.title || ''));
  if (parsed.tag && parsed.templateType) {
    if (cardData.issueNumber === undefined && parsed.issueNumber) {
      cardData.issueNumber = parsed.issueNumber;
    }
    if (cardData.sponsor === undefined && parsed.sponsor) {
      cardData.sponsor = parsed.sponsor;
    }
    if (cardData.secondarySponsors === undefined && parsed.secondarySponsors?.length) {
      cardData.secondarySponsors = parsed.secondarySponsors;
    }
    if ((!cardData.people || (cardData.people as string[]).length === 0) && parsed.people.length > 0) {
      cardData.people = parsed.people;
    }
    if (parsed.cleanTitle && parsed.cleanTitle !== cardData.title) {
      cardData.title = parsed.cleanTitle;
    }
  }
  for (const field of ['people', 'sponsor', 'secondarySponsors']) {
    if (body[field] !== undefined) {
      cardData[field] = body[field];
    }
  }

  let selectedGroups: string[] | undefined;
  if (body.optionalGroups !== undefined) {
    if (!Array.isArray(body.optionalGroups) || body.optionalGroups.some((group) => typeof group !== 'string')) {
      return fail(400, { error: 'optionalGroups must be an array of strings', code: 'invalid-optional-groups' });
    }
    const knownGroups = new Set(
      (template.taskDefinitions || [])
        .map((definition) => definition.optionalGroup)
        .filter((group): group is string => typeof group === 'string'),
    );
    const unknown = (body.optionalGroups as string[]).find((group) => !knownGroups.has(group));
    if (unknown !== undefined) {
      return fail(400, { error: `Unknown optional task group: ${unknown}`, code: 'unknown-optional-group' });
    }
    selectedGroups = [...(body.optionalGroups as string[])];
  }
  if (body.counts !== undefined) {
    const countsError = countValuesError(template, body.counts);
    if (countsError) return fail(400, { error: countsError, code: 'invalid-counts' });
  }
  const needsEndDate = (template.taskDefinitions || []).some((definition) => definition.anchor === 'end');
  if (needsEndDate && cardData.endDate === undefined) {
    return fail(400, {
      error: 'Template anchors Tasks to the cohort END date: endDate is required',
      code: 'missing-end-date',
    });
  }
  try {
    const { card, tasks } = await createCardFromTemplate(
      client,
      cardData,
      template,
      body.anchorDate as string,
      selectedGroups,
      options.companions,
      body.counts as Record<string, number> | undefined,
    );
    return { ok: true, card, tasks, template };
  } catch (error) {
    if (error instanceof TemplateVersionConflictError) {
      return fail(409, {
        code: 'template_version_conflict',
        error: 'Template changed while the Card was being created. Review the latest Template and retry.',
      });
    }
    throw error;
  }
}
