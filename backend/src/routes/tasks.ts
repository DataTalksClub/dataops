import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

import { resolveInteractiveActor, workAdminForbidden } from '../identity/actor';
import { TeamDirectory } from '../identity/directory';
import { projectTask, projectTasks } from '../identity/projections';
import { attachPrerequisites, normalizeDependsOn } from '../db/taskDependencies';
import { attachSubjects, parseTaskSubject } from '../db/taskSubjects';
import {
  matchesOwnerFilter,
  ownerFilterUserId,
  resolveOwnerFilter,
} from '../identity/ownerFilter';
import {
  createTask,
  getTask,
  getTaskConsistent,
  updateTask,
  deleteTask,
  listTasksByDate,
  listTasksByDateRange,
  listTasksByCard,
  listTasksByCardConsistent,
  listTasksByStatus,
  listTasksByOwner,
  TaskVersionConflictError,
} from '../db/tasks';
import type { TaskPatch } from '../db/tasks';
import {
  CollectionCursorError,
  decodeCollectionCursor,
  encodeCollectionCursor,
  parseCollectionLimit,
  type CursorBinding,
} from '../db/collectionPagination';
import { getCard } from '../db/cards';
import { listFilesByTask } from '../db/files';
import { getTemplate } from '../db/templates';
import { liveBackReferences, setTaskLinkedCard, TaskCardLinkConflictError } from '../db/taskCardLinks';
import { parseRepeatInstanceRef } from '../templates/repeatedTasks';
import { attachLinkedCards } from '../cards/taskCardLinkView';
import { matchesRequiresFilter, parseResourceList } from '../resources/vocabulary';
import type { RequiresFilter } from '../resources/vocabulary';
import { matchesBrowserRequirementFilter, parseBrowserRequirementFilter } from '../browserRequirement';
import type { BrowserRequirementFilter } from '../browserRequirement';
import type { LambdaEvent, LambdaResponse, Task, TaskHistoryEvent } from '../types';
import { mergeMaterials } from '../taskMaterials';
import { resolveTaskDate, resolveTaskDateTime, addDays, isValidTimezone } from '../relativeDates';
import {
  ALLOWED_UPDATE_FIELDS,
  INVALID_STATUS_ERROR,
  SKIPPED_STATUS_ERROR,
  SKIPPED_TASK_ERROR,
  SKIPPED_TASK_LIFECYCLE_ERROR,
  SKIPPED_TASK_LOCKED_FIELDS,
  WAITING_COMPLETION_ERROR,
  WAITING_FIELDS_ERROR,
  WAITING_TODO_ERROR,
  applyLeadingTagToTaskData,
  applyTitleLinksToTaskData,
  expectedVersionError,
  isNonEmptyString,
  isTaskStatus,
  makeTaskHistoryEvent,
  resolveCardLinkForTask,
  skipClosureSuppresses,
  trimmedString,
  validateActionChannel,
  validateActionNote,
  validateCalendarInviteRequirement,
  validateDateOrTimestampValue,
  validateDoneProof,
  validateDoneProofOnCreate,
  validateProofRequirement,
  validateRequiredCardLinks,
  validateSkipReason,
  validateTaskDocContext,
  validateTaskRefs,
  validateTaskTags,
} from './taskValidation';

/**
 * Task routes: create, list, read, update, delete, and the atomic follow-up
 * actions under `/api/tasks`.
 *
 * Extracted verbatim from `src/router.ts`, which remains the request
 * composition entry and keeps mapping the task concurrency errors these
 * handlers throw.
 */

const JSON_HEADERS: Record<string, string> = { 'Content-Type': 'application/json' };
const SUBJECT_WITH_CARD_ERROR = 'A Task belongs to a Card or has a subject, not both';
const RELATIVE_DATE_ERROR =
  'must be a date like 2026-01-31, +7d, tomorrow, or a weekday like mon (Europe/Berlin)';

/**
 * Accept an absolute date or a relative word (`+7d`, `tomorrow`, `mon`)
 * resolved against the Europe/Berlin today. Timestamps stay untouched for
 * the follow-up fields that accept them; anything else is rejected.
 */
function resolveDateInput(value: unknown, fieldName: string): { date: string } | { error: string } {
  if (typeof value !== 'string') return { error: `${fieldName} ${RELATIVE_DATE_ERROR}` };
  const resolved = resolveTaskDate(value);
  if (resolved) return { date: resolved };
  if (!Number.isNaN(Date.parse(value.trim()))) return { date: value.trim() };
  return { error: `${fieldName} ${RELATIVE_DATE_ERROR}` };
}

/** Resolve a write-time timezone name, defaulting to Europe/Berlin. */
function resolveTimezoneInput(value: unknown): { timezone: string } | { error: string } {
  if (value === undefined) return { timezone: 'Europe/Berlin' };
  if (typeof value !== 'string' || !isValidTimezone(value.trim())) {
    return { error: 'timezone must be an IANA timezone like Europe/Berlin' };
  }
  return { timezone: value.trim() };
}

/**
 * Accept a "not before" moment: an ISO instant with an offset, a civil
 * `YYYY-MM-DD HH:mm` in `tz`, a plain date, or a relative word.
 */
function resolveDateTimeInput(value: unknown, fieldName: string, tz: string): { date: string } | { error: string } {
  if (typeof value !== 'string') {
    return { error: `${fieldName} must be an ISO instant, "YYYY-MM-DD HH:mm", a date, or a relative word like +7d` };
  }
  const resolved = resolveTaskDateTime(value, tz);
  if (resolved) return { date: resolved };
  return { error: `${fieldName} must be an ISO instant, "YYYY-MM-DD HH:mm" with --tz ${tz}, a date, or a relative word like +7d` };
}

interface RescheduleDeltas {
  dateDeltaDays: number;
  momentDeltaMs: number | null;
}

/**
 * Shift every open Task that depends on `root` (transitively, same Card) by
 * the same offset the root just moved: dates by whole days, set moments by
 * milliseconds. Done and skipped Tasks keep their history. Returns the ids
 * that moved; a dependent that changed concurrently is left for a retry.
 */
async function rescheduleDependents(
  client: DynamoDBDocumentClient,
  root: Task,
  deltas: RescheduleDeltas,
  actorId: string | undefined,
): Promise<string[]> {
  if (!root.cardId || (deltas.dateDeltaDays === 0 && deltas.momentDeltaMs === null)) return [];
  const moved: string[] = [];
  const seen = new Set([root.id]);
  const queue = [root.id];
  const now = new Date().toISOString();
  let guard = 0;
  while (queue.length > 0 && guard++ < 100) {
    const parentId = queue.shift() as string;
    const siblings = await listTasksByCardConsistent(client, root.cardId);
    for (const dependent of siblings) {
      if (seen.has(dependent.id)) continue;
      if (!(dependent.dependsOn || []).includes(parentId)) continue;
      // Traverse through resolved Tasks without rewriting their history;
      // only open work shifts.
      seen.add(dependent.id);
      queue.push(dependent.id);
      if (dependent.status !== 'todo' && dependent.status !== 'waiting') continue;
      const patch: Record<string, unknown> = {};
      if (deltas.dateDeltaDays !== 0) patch.date = addDays(dependent.date, deltas.dateDeltaDays);
      if (deltas.momentDeltaMs !== null && typeof dependent.notBeforeAt === 'string') {
        patch.notBeforeAt = new Date(Date.parse(dependent.notBeforeAt) + deltas.momentDeltaMs).toISOString();
      }
      if (Object.keys(patch).length === 0) continue;
      const historyEvent = makeTaskHistoryEvent('scheduled', dependent, {
        actorId,
        note: `Parent ${parentId} moved; shifted by the same offset`,
        createdAt: now,
      });
      try {
        await updateTask(client, dependent.id, {
          currentTask: dependent,
          expectedVersion: dependent.version,
          patch,
          historyEvents: [historyEvent],
          actorId,
          triggerKind: 'task-rescheduled',
        });
      } catch (error) {
        if (!(error instanceof TaskVersionConflictError)) throw error;
        continue;
      }
      moved.push(dependent.id);
    }
  }
  return moved;
}

function jsonResponse(statusCode: number, body: unknown): LambdaResponse {
  return {
    statusCode,
    headers: JSON_HEADERS,
    body: typeof body === 'string' ? body : JSON.stringify(body),
  };
}

function parseBody(event: LambdaEvent): Record<string, unknown> | null {
  if (!event.body) return null;
  if (typeof event.body === 'object') return event.body as Record<string, unknown>;
  try {
    return JSON.parse(event.body);
  } catch {
    return null;
  }
}
/** Project a Task with its resolved prerequisites and blocked state. */
async function projectWithPrerequisites(client: DynamoDBDocumentClient, task: Task) {
  const [withPrerequisites] = await attachLinkedCards(
    client, await attachSubjects(client, await attachPrerequisites(client, [task])),
  );
  return projectTask(new TeamDirectory(client), withPrerequisites);
}

function extractTaskId(reqPath: string): string | null {
  const prefix = '/api/tasks/';
  if (reqPath.startsWith(prefix) && reqPath.length > prefix.length) {
    return reqPath.slice(prefix.length);
  }
  return null;
}

function extractTaskAction(reqPath: string): { taskId: string; action: string } | null {
  const match = reqPath.match(/^\/api\/tasks\/([^/]+)\/actions\/([^/]+)$/);
  if (!match) return null;
  return { taskId: decodeURIComponent(match[1]), action: match[2] };
}

export async function handleTaskRoutes(
  reqPath: string,
  method: string,
  event: LambdaEvent,
  client: DynamoDBDocumentClient,
): Promise<LambdaResponse | null> {
  // POST /api/tasks — Create a task
  if (method === 'POST' && reqPath === '/api/tasks') {
    const createActor = await resolveInteractiveActor(client, event, 'work-write');
    if (!createActor.ok) return createActor.response;
    const actor = createActor.actor;
    const body = parseBody(event);
    if (!body) {
      return jsonResponse(400, { error: 'Request body is required' });
    }
    if (!body.description) {
      return jsonResponse(400, { error: 'Missing required field: description' });
    }
    if (!body.date) {
      return jsonResponse(400, { error: 'Missing required field: date' });
    }

    const taskData: Record<string, unknown> = {};
    if (body.description) taskData.description = body.description;
    if (body.date) {
      const resolved = resolveDateInput(body.date, 'date');
      if ('error' in resolved) return jsonResponse(400, { error: resolved.error });
      taskData.date = resolved.date;
    }
    if (body.comment !== undefined) taskData.comment = body.comment;
    if (body.cardId !== undefined) taskData.cardId = body.cardId;
    if (body.subject !== undefined) taskData.subject = body.subject;
    if (body.waitingFor !== undefined) taskData.waitingFor = body.waitingFor;
    if (body.followUpAt !== undefined) {
      const resolved = resolveDateInput(body.followUpAt, 'followUpAt');
      if ('error' in resolved) return jsonResponse(400, { error: resolved.error });
      taskData.followUpAt = resolved.date;
    }
    if (body.notBeforeAt !== undefined) {
      const timezone = resolveTimezoneInput(body.timezone);
      if ('error' in timezone) return jsonResponse(400, { error: timezone.error });
      const resolved = resolveDateTimeInput(body.notBeforeAt, 'notBeforeAt', timezone.timezone);
      if ('error' in resolved) return jsonResponse(400, { error: resolved.error });
      taskData.notBeforeAt = resolved.date;
    }
    if (body.followUpChannel !== undefined) taskData.followUpChannel = body.followUpChannel;
    if (body.proofRequirement !== undefined) taskData.proofRequirement = body.proofRequirement;
    if (body.externalStatus !== undefined) taskData.externalStatus = body.externalStatus;
    if (body.instructionsUrl !== undefined) taskData.instructionsUrl = body.instructionsUrl;
    if (body.instructionDocId !== undefined) taskData.instructionDocId = body.instructionDocId;
    if (body.instructionStepId !== undefined) taskData.instructionStepId = body.instructionStepId;
    if (body.phase !== undefined) taskData.phase = body.phase;
    if (body.requires !== undefined) taskData.requires = body.requires;
    if (body.browserRequirement !== undefined) taskData.browserRequirement = body.browserRequirement;
    if (body.dependsOn !== undefined) taskData.dependsOn = body.dependsOn;
    if (body.validation !== undefined) taskData.validation = body.validation;
    if (body.link !== undefined) taskData.link = body.link;
    if (body.materials !== undefined) taskData.materials = body.materials;
    if (body.requiredLinkName !== undefined) taskData.requiredLinkName = body.requiredLinkName;
    if (body.requiresFile !== undefined) taskData.requiresFile = body.requiresFile;
    if (body.requiresCalendarInvite !== undefined) taskData.requiresCalendarInvite = body.requiresCalendarInvite;
    if (body.assigneeId !== undefined) taskData.assigneeId = body.assigneeId;
    if (body.tags !== undefined) taskData.tags = body.tags;
    if (body.templateId !== undefined) taskData.templateId = body.templateId;
    if (body.sourceDocIds !== undefined) taskData.sourceDocIds = body.sourceDocIds;
    if (body.artifactRefs !== undefined) taskData.artifactRefs = body.artifactRefs;
    if (body.auditEventRefs !== undefined) taskData.auditEventRefs = body.auditEventRefs;
    taskData.source = (body.source as string) || 'manual';
    if (actor.id) taskData.createdBy = actor.id;

    // Assignment is administration, not execution. An operator creates work
    // for themselves; only an admin may create work assigned to a peer, and
    // only to an active member.
    if (!actor.testBypass) {
      if (taskData.assigneeId !== undefined && taskData.assigneeId !== null && !isNonEmptyString(taskData.assigneeId)) {
        return jsonResponse(400, { error: 'assigneeId must be a non-empty string' });
      }
      const requestedAssigneeId = isNonEmptyString(taskData.assigneeId) ? taskData.assigneeId.trim() : null;
      if (requestedAssigneeId && requestedAssigneeId !== actor.id) {
        if (!actor.isAdmin) {
          return workAdminForbidden('Assigning a Task to another teammate requires an admin');
        }
        const target = await new TeamDirectory(client).project(requestedAssigneeId);
        if (!target.active) {
          return jsonResponse(400, { error: 'assigneeId must reference an active team member' });
        }
      }
      taskData.assigneeId = requestedAssigneeId || actor.id;
    }
    if (body.status !== undefined) {
      if (!isTaskStatus(body.status)) {
        return jsonResponse(400, { error: INVALID_STATUS_ERROR });
      }
      if (body.status === 'skipped') {
        return jsonResponse(400, { error: SKIPPED_STATUS_ERROR });
      }
      taskData.status = body.status;
    }
    if (taskData.status === 'waiting' && (
      !isNonEmptyString(taskData.waitingFor)
      || !isNonEmptyString(taskData.followUpAt)
      || !isNonEmptyString(taskData.comment)
    )) {
      return jsonResponse(400, { error: WAITING_FIELDS_ERROR });
    }
    if (taskData.cardId !== undefined && !isNonEmptyString(taskData.cardId)) {
      return jsonResponse(400, { error: 'cardId must be a non-empty string' });
    }
    if (taskData.subject !== undefined) {
      if (taskData.cardId !== undefined) return jsonResponse(400, { error: SUBJECT_WITH_CARD_ERROR });
      const parsed = await parseTaskSubject(client, taskData.subject);
      if ('error' in parsed) return jsonResponse(parsed.statusCode, { error: parsed.error });
      taskData.subject = parsed.subject;
    }
    const createTitleLinks = applyTitleLinksToTaskData(taskData);
    if ('error' in createTitleLinks) {
      return jsonResponse(400, { error: createTitleLinks.error });
    }
    applyLeadingTagToTaskData(taskData);
    const tagsError = validateTaskTags(taskData.tags);
    if (tagsError) {
      return jsonResponse(400, { error: tagsError });
    }
    const docContextError = validateTaskDocContext(taskData);
    if (docContextError) {
      return jsonResponse(400, { error: docContextError });
    }
    const proofRequirementError = validateProofRequirement(taskData.proofRequirement);
    if (proofRequirementError) {
      return jsonResponse(400, { error: proofRequirementError });
    }
    const refsError = validateTaskRefs(taskData);
    if (refsError) {
      return jsonResponse(400, { error: refsError });
    }
    if (taskData.dependsOn !== undefined) {
      const dependsOn = normalizeDependsOn(taskData.dependsOn);
      if (dependsOn === null) delete taskData.dependsOn;
      else taskData.dependsOn = dependsOn;
    }
    if (taskData.templateId !== undefined) {
      if (!isNonEmptyString(taskData.templateId) || !await getTemplate(client, taskData.templateId)) {
        return jsonResponse(404, { error: 'Template not found' });
      }
    }
    if (taskData.status === 'done') {
      if (
        isNonEmptyString(taskData.requiredLinkName)
        && !isNonEmptyString(taskData.link)
        && isNonEmptyString(taskData.cardId)
      ) {
        const cardLinkUrl = await resolveCardLinkForTask(client, taskData.cardId, taskData.requiredLinkName);
        if (cardLinkUrl) taskData.link = cardLinkUrl;
      }
      const cardLinkError = await validateRequiredCardLinks(client, taskData);
      if (cardLinkError) {
        return jsonResponse(400, { error: cardLinkError });
      }
      const proofError = await validateDoneProofOnCreate(client, taskData);
      if (proofError) {
        return jsonResponse(400, { error: proofError });
      }
    }
    // The notes log starts with the creation comment, so it is never lost
    // to a later overwrite.
    if (isNonEmptyString(taskData.comment)) {
      taskData.notesLog = [{
        id: crypto.randomUUID(),
        text: String(taskData.comment).trim(),
        ...(actor.id ? { authorId: actor.id } : {}),
        createdAt: new Date().toISOString(),
      }];
    }

    const task = await createTask(client, taskData);
    return jsonResponse(201, await projectWithPrerequisites(client, task));
  }

  // GET /api/tasks — List tasks with filters
  if (method === 'GET' && reqPath === '/api/tasks') {
    const listActor = await resolveInteractiveActor(client, event, 'work-read');
    if (!listActor.ok) return listActor.response;

    const params = event.queryStringParameters || {};
    const { cardId, status } = params;
    // Batched card checklist reads: one request carries every active Card id
    // instead of one request per Card, so a mobile snapshot costs one round
    // trip rather than 8 + N. Comma-separated, capped like a collection page.
    const cardIds = (() => {
      const raw = params.cardIds;
      if (raw === undefined) return null;
      const ids = [...new Set(String(raw).split(',').map((id) => id.trim()).filter(Boolean))];
      return ids;
    })();
    if (cardIds !== null && cardIds.length === 0) {
      return jsonResponse(400, { error: 'cardIds must list at least one card id' });
    }
    if (cardIds !== null && cardIds.length > 200) {
      return jsonResponse(400, { error: 'cardIds must list at most 200 card ids' });
    }
    if (cardIds !== null && cardId) {
      return jsonResponse(400, { error: 'Use either cardId or cardIds, not both' });
    }
    let { date, startDate, endDate } = params;
    for (const [field, value] of [['date', date], ['startDate', startDate], ['endDate', endDate]] as const) {
      if (value === undefined) continue;
      const resolved = resolveDateInput(value, field);
      if ('error' in resolved) return jsonResponse(400, { error: resolved.error });
      if (field === 'date') date = resolved.date;
      if (field === 'startDate') startDate = resolved.date;
      if (field === 'endDate') endDate = resolved.date;
    }

    if (status && !isTaskStatus(status)) {
      return jsonResponse(400, { error: INVALID_STATUS_ERROR });
    }
    if (Boolean(startDate) !== Boolean(endDate)) {
      return jsonResponse(400, { error: 'Both startDate and endDate are required for range queries' });
    }

    // `owner` composes with one existing filter instead of competing with
    // it, so the existing priority can never silently discard it.
    const ownerParse = await resolveOwnerFilter(client, params.owner, listActor.actor);
    if (!ownerParse.ok) return jsonResponse(400, { error: ownerParse.error });
    const ownerFilter = ownerParse.filter;

    // Required-resource filters narrow whichever list the primary filter
    // selects: `requires` keeps Tasks needing any of the ids, `excludeRequires`
    // drops them, and `canDo` keeps only Tasks whose every requirement is in
    // the caller's declared set.
    const requiresFilter: RequiresFilter = {};
    for (const [param, key] of [['requires', 'anyOf'], ['excludeRequires', 'noneOf'], ['canDo', 'within']] as const) {
      const raw = params[param];
      if (raw === undefined) continue;
      const parsed = parseResourceList(raw, param);
      if (!parsed.ok) return jsonResponse(400, { error: parsed.error });
      requiresFilter[key] = parsed.ids;
    }

    // `blocked=false` leaves out Tasks still waiting on an unresolved
    // prerequisite (the work queue: nobody can do them yet); `blocked=true`
    // keeps only those. It narrows a list, so it is not a primary filter.
    const blockedParam = params.blocked;
    if (blockedParam !== undefined && blockedParam !== 'true' && blockedParam !== 'false') {
      return jsonResponse(400, { error: 'blocked must be true or false' });
    }
    const blockedFilter = blockedParam === undefined ? null : blockedParam === 'true';
    // The browser filter narrows the same selection by execution requirement:
    // `headless` keeps only Tasks explicitly classified as browser-free, so an
    // unclassified Task is never offered as safe headless work. It only reads
    // and filters; it never mutates status, dates, or ownership.
    let browserFilter: BrowserRequirementFilter | undefined;
    if (params.browser !== undefined) {
      const parsed = parseBrowserRequirementFilter(params.browser);
      if (!parsed.ok) return jsonResponse(400, { error: parsed.error });
      browserFilter = parsed.filter;
    }

    let limit: number;
    try {
      limit = parseCollectionLimit(params.limit);
    } catch (err) {
      if (err instanceof CollectionCursorError) {
        return jsonResponse(400, { error: 'Invalid pagination input', code: 'invalid_pagination_input' });
      }
      throw err;
    }

    if (!date && !startDate && !endDate && !cardId && !cardIds && !status && !ownerFilter) {
      return jsonResponse(400, {
        error: 'At least one filter is required: owner, date, startDate+endDate, cardId, cardIds, or status',
      });
    }

    const binding: CursorBinding = {
      collection: 'tasks',
      filters: {
        cardId,
        cardIds,
        date,
        startDate,
        endDate,
        status,
        owner: ownerFilter,
        requires: requiresFilter,
        blocked: blockedFilter,
        browser: browserFilter,
      },
      principal: listActor.actor.id || 'test-bypass',
    };

    let offset = 0;
    if (params.cursor !== undefined) {
      try {
        const decoded = await decodeCollectionCursor(binding, params.cursor);
        offset = Number(decoded.offset ?? 0);
        if (!Number.isSafeInteger(offset) || offset < 0) {
          return jsonResponse(400, { error: 'Invalid pagination input', code: 'invalid_pagination_input' });
        }
      } catch (err) {
        if (err instanceof CollectionCursorError) {
          return jsonResponse(400, { error: 'Invalid pagination input', code: 'invalid_pagination_input' });
        }
        throw err;
      }
    }

    const directory = new TeamDirectory(client);
    await directory.loadAll();
    const activeMemberIds = await directory.activeMemberIds();

    async function ownerListResponse(tasks: Task[]): Promise<LambdaResponse> {
      const cardIdSet = cardIds ? new Set(cardIds) : null;
      const visible = tasks.filter((task) => (
        (!date || task.date === date)
        && (!startDate || task.date >= startDate)
        && (!endDate || task.date <= endDate)
        && (!cardId || task.cardId === cardId)
        && (!cardIdSet || (task.cardId !== undefined && cardIdSet.has(task.cardId)))
        && (!status || task.status === status)
        && (!ownerFilter || matchesOwnerFilter(task.assigneeId, ownerFilter, activeMemberIds))
        && matchesRequiresFilter(task.requires, requiresFilter)
        && matchesBrowserRequirementFilter(task.browserRequirement, browserFilter)
      ));

      let matchingTasks: Task[];
      let prereqsAttached = false;
      let withPrereqs: Awaited<ReturnType<typeof attachPrerequisites<Task>>> = [];

      if (blockedFilter !== null) {
        withPrereqs = (await attachPrerequisites(client, visible))
          .filter((task) => Boolean(task.blocked) === blockedFilter);
        matchingTasks = withPrereqs;
        prereqsAttached = true;
      } else {
        matchingTasks = visible;
      }

      matchingTasks.sort((left, right) => {
        if (status === 'done') {
          const leftComp = String(left.completedAt || left.updatedAt || left.date || '');
          const rightComp = String(right.completedAt || right.updatedAt || right.date || '');
          const comp = rightComp.localeCompare(leftComp);
          if (comp !== 0) return comp;
          return String(left.id || '').localeCompare(String(right.id || ''));
        }
        const dateComp = String(left.date || '').localeCompare(String(right.date || ''));
        if (dateComp !== 0) return dateComp;
        return String(left.id || '').localeCompare(String(right.id || ''));
      });

      const totalMatching = matchingTasks.length;
      const pageSlice = matchingTasks.slice(offset, offset + limit);

      const pageWithPrereqs = prereqsAttached
        ? (pageSlice as typeof withPrereqs)
        : await attachPrerequisites(client, pageSlice);

      const projected = await projectTasks(
        directory, await attachLinkedCards(client, await attachSubjects(client, pageWithPrereqs)),
      );

      // Frozen Template definitions and heavy audit collections are detail-only
      // provenance. Repeating them on every row in list responses can exceed Lambda's
      // 6 MB response limit. GET /api/tasks/:id returns the complete stored snapshot.
      const listTasks = projected.map(({
        templateDefinitionSnapshot: _snapshot,
        historyActors: _ha,
        ...task
      }) => task);

      const responseBody: Record<string, unknown> = { tasks: listTasks };

      if (offset + limit < totalMatching) {
        responseBody.nextCursor = await encodeCollectionCursor(binding, { offset: offset + limit });
      }

      const ownerReference = ownerFilterUserId(ownerFilter);
      // A concrete reference always answers with its honest availability,
      // including for a disabled or missing teammate, so a deep link never
      // degrades into a different scope.
      if (ownerReference) responseBody.owner = await directory.project(ownerReference);
      return jsonResponse(200, responseBody);
    }

    // Pick a query source, then intersect every supplied filter above.
    if (status && (startDate || endDate)) {
      return await ownerListResponse(await listTasksByStatus(client, status, { startDate, endDate }));
    }

    if (date) {
      return await ownerListResponse(await listTasksByDate(client, date));
    }

    if (startDate || endDate) {
      return await ownerListResponse(await listTasksByDateRange(client, startDate!, endDate!));
    }

    if (cardId) {
      return await ownerListResponse(await listTasksByCard(client, cardId));
    }

    if (cardIds) {
      const perCard = await Promise.all(cardIds.map((id) => listTasksByCard(client, id)));
      return await ownerListResponse(perCard.flat());
    }

    if (status) {
      return await ownerListResponse(await listTasksByStatus(client, status));
    }

    if (ownerFilter) {
      const owned = await listTasksByOwner(
        client,
        ownerFilter.kind === 'unassigned'
          ? { kind: 'unassigned' }
          : ownerFilter.kind === 'team'
            ? { kind: 'any' }
            : { kind: 'user', userId: ownerFilter.userId },
      );
      return await ownerListResponse(owned);
    }
  }

  // POST /api/tasks/:id/actions/:action — Atomic task follow-up actions
  if (method === 'POST' && reqPath.startsWith('/api/tasks/')) {
    const taskAction = extractTaskAction(reqPath);
    if (!taskAction) {
      return jsonResponse(404, { error: 'Not found' });
    }

    // Ordinary Task execution: allowed on an own, teammate, or unassigned
    // Task. The assignee is not changed and history records the verified
    // actor who did the work, never the assignee or a client-supplied id.
    const actionActor = await resolveInteractiveActor(client, event, 'work-write');
    if (!actionActor.ok) return actionActor.response;

    const body = parseBody(event);
    if (!body) {
      return jsonResponse(400, { error: 'Request body is required' });
    }
    const preconditionError = expectedVersionError(body);
    if (preconditionError) return jsonResponse(400, { error: preconditionError });
    const expectedVersion = body.expectedVersion as number;

    const existing = await getTaskConsistent(client, taskAction.taskId);
    if (!existing) {
      return jsonResponse(404, { error: 'Task not found', code: 'task_not_found' });
    }
    if (existing.version !== expectedVersion) {
      throw new TaskVersionConflictError(existing.id, expectedVersion);
    }
    const actorId = actionActor.actor.id || undefined;
    const now = new Date().toISOString();

    // Skip resolves an open Task as not applicable. It deliberately bypasses
    // the link, file, and proof gates that completion enforces: the reason is
    // the evidence. Card completion counts a skipped Task as resolved.
    if (taskAction.action === 'skip') {
      if (existing.status === 'skipped') {
        return jsonResponse(400, { error: 'Task is already skipped' });
      }
      if (existing.status === 'done') {
        return jsonResponse(400, { error: 'Completed tasks must be reopened before skipping' });
      }
      const reason = trimmedString(body.reason);
      const reasonError = validateSkipReason(reason);
      if (reasonError) return jsonResponse(400, { error: reasonError });

      const historyEvent = makeTaskHistoryEvent('skipped', existing, {
        actorId,
        note: reason,
        createdAt: now,
      });
      const updated = await updateTask(client, existing.id, {
        currentTask: existing,
        expectedVersion,
        patch: {
          status: 'skipped',
          skipReason: reason,
          skippedAt: now,
          skippedBy: actorId || 'system',
          waitingFor: null,
          followUpAt: null,
          followUpChannel: null,
        },
        historyEvents: [historyEvent],
        actorId,
        triggerKind: 'task-skipped',
      });
      return jsonResponse(200, await projectWithPrerequisites(client, updated));
    }

    if (taskAction.action === 'unskip') {
      if (existing.status !== 'skipped') {
        return jsonResponse(400, { error: 'Task is not skipped' });
      }
      const historyEvent = makeTaskHistoryEvent('unskipped', existing, {
        actorId,
        note: existing.skipReason,
        createdAt: now,
      });
      const updated = await updateTask(client, existing.id, {
        currentTask: existing,
        expectedVersion,
        patch: {
          status: 'todo',
          skipReason: null,
          skippedAt: null,
          skippedBy: null,
        },
        historyEvents: [historyEvent],
        actorId,
        triggerKind: 'task-unskipped',
      });
      return jsonResponse(200, await projectWithPrerequisites(client, updated));
    }

    // Linking the Card that carries a Task out is context, not a lifecycle
    // change, so it is allowed from any status.
    if (taskAction.action === 'link-card') {
      if (!Object.hasOwn(body, 'cardId') || (body.cardId !== null && !isNonEmptyString(body.cardId))) {
        return jsonResponse(400, { error: 'cardId must be a Card id, or null to unlink' });
      }
      const targetCardId = body.cardId === null ? null : (body.cardId as string).trim();
      if (!existing.cardId) {
        return jsonResponse(400, { error: 'Only a Task on a Card can link another Card', code: 'task-without-card' });
      }
      if ((existing.linkedCardId || null) === targetCardId) {
        return jsonResponse(200, await projectWithPrerequisites(client, existing));
      }
      if (targetCardId) {
        if (targetCardId === existing.cardId) {
          return jsonResponse(400, { error: 'A Task cannot link its own Card', code: 'link-own-card' });
        }
        const target = await getCard(client, targetCardId);
        if (!target) return jsonResponse(404, { error: 'Linked Card not found', code: 'card_not_found' });
        const sourceTemplate = existing.templateId ? await getTemplate(client, existing.templateId) : null;
        const ref = parseRepeatInstanceRef(existing.templateTaskRef)?.refId ?? existing.templateTaskRef;
        const wanted = sourceTemplate?.taskDefinitions?.find(({ refId }) => refId === ref)?.linkCard?.templateType;
        if (wanted) {
          const targetType = (await getTemplate(client, target.templateId))?.type;
          if (targetType !== wanted) {
            return jsonResponse(422, {
              error: `This Task links a ${wanted} Card; ${target.title || target.id} is a ${targetType || 'different'} Card`,
              code: 'linked-card-type',
            });
          }
        }
        const holders = (await liveBackReferences(client, target.id, target.linkedFrom))
          .filter(({ taskId }) => taskId !== existing.id);
        if (holders.length > 0) {
          return jsonResponse(409, {
            error: `Card is already linked by Task "${holders[0].task.description}"; unlink it there first`,
            code: 'card-already-linked',
            taskId: holders[0].taskId,
          });
        }
      }
      try {
        const updated = await setTaskLinkedCard(client, existing, targetCardId);
        return jsonResponse(200, await projectWithPrerequisites(client, updated));
      } catch (error) {
        if (error instanceof TaskCardLinkConflictError) {
          return jsonResponse(409, { error: error.message, code: 'task-card-link-conflict' });
        }
        throw error;
      }
    }

    // Notes append from any status, including skipped and done: context is
    // never a lifecycle change.
    if (taskAction.action === 'add-note') {
      const note = trimmedString(body.note);
      const noteError = validateActionNote(note);
      if (noteError) return jsonResponse(400, { error: noteError });

      const entry = {
        id: crypto.randomUUID(),
        text: note,
        ...(actorId ? { authorId: actorId } : {}),
        createdAt: now,
      };
      const historyEvent = makeTaskHistoryEvent('noted', existing, {
        actorId,
        note,
        createdAt: now,
      });
      const updated = await updateTask(client, existing.id, {
        currentTask: existing,
        expectedVersion,
        patch: { notesLog: [...(existing.notesLog || []), entry] },
        historyEvents: [historyEvent],
        actorId,
        triggerKind: 'task-noted',
      });
      return jsonResponse(200, await projectWithPrerequisites(client, updated));
    }

    if (existing.status === 'skipped') {
      return jsonResponse(400, { error: SKIPPED_TASK_ERROR });
    }

    if (taskAction.action === 'mark-waiting') {
      if (existing.status === 'done') {
        return jsonResponse(400, { error: 'Completed tasks must be reopened before marking waiting' });
      }
      const waitingFor = trimmedString(body.waitingFor);
      const rawFollowUpAt = trimmedString(body.followUpAt);
      const resolvedFollowUpAt = rawFollowUpAt ? resolveDateInput(rawFollowUpAt, 'followUpAt') : null;
      if (resolvedFollowUpAt && 'error' in resolvedFollowUpAt) {
        return jsonResponse(400, { error: resolvedFollowUpAt.error });
      }
      const followUpAt = resolvedFollowUpAt && 'date' in resolvedFollowUpAt ? resolvedFollowUpAt.date : rawFollowUpAt;
      const channel = trimmedString(body.channel);
      const note = trimmedString(body.note);
      const noteError = validateActionNote(note);
      const channelError = validateActionChannel(channel);
      const dateError = validateDateOrTimestampValue(followUpAt, 'followUpAt');
      if (!waitingFor) return jsonResponse(400, { error: 'waitingFor is required' });
      if (waitingFor.length > 160) return jsonResponse(400, { error: 'waitingFor must be 160 characters or fewer' });
      if (dateError) return jsonResponse(400, { error: dateError });
      if (channelError) return jsonResponse(400, { error: channelError });
      if (noteError) return jsonResponse(400, { error: noteError });

      const historyEvent = makeTaskHistoryEvent('waiting-started', existing, {
        actorId,
        channel,
        waitingFor,
        followUpAt,
        note,
        createdAt: now,
      });
      const updated = await updateTask(client, existing.id, {
        currentTask: existing,
        expectedVersion,
        patch: {
          status: 'waiting',
          waitingFor,
          followUpAt,
          followUpChannel: channel,
        },
        historyEvents: [historyEvent],
        actorId,
        triggerKind: 'task-marked-waiting',
      });
      return jsonResponse(200, await projectWithPrerequisites(client, updated));
    }

    if (taskAction.action === 'follow-up-sent') {
      if (existing.status !== 'waiting') {
        return jsonResponse(400, { error: 'Task must be waiting before recording a follow-up' });
      }
      const channel = trimmedString(body.channel);
      const note = trimmedString(body.note);
      const rawNextFollowUpAt = trimmedString(body.nextFollowUpAt || body.followUpAt);
      const resolvedNext = rawNextFollowUpAt ? resolveDateInput(rawNextFollowUpAt, 'nextFollowUpAt') : null;
      if (resolvedNext && 'error' in resolvedNext) {
        return jsonResponse(400, { error: resolvedNext.error });
      }
      const nextFollowUpAt = resolvedNext && 'date' in resolvedNext ? resolvedNext.date : rawNextFollowUpAt;
      const noteError = validateActionNote(note);
      const channelError = validateActionChannel(channel);
      const dateError = validateDateOrTimestampValue(nextFollowUpAt, 'nextFollowUpAt');
      if (channelError) return jsonResponse(400, { error: channelError });
      if (noteError) return jsonResponse(400, { error: noteError });
      if (dateError) return jsonResponse(400, { error: dateError });

      const historyEvent = makeTaskHistoryEvent('follow-up-sent', existing, {
        actorId,
        channel,
        waitingFor: existing.waitingFor,
        previousFollowUpAt: existing.followUpAt,
        followUpAt: nextFollowUpAt,
        note,
        createdAt: now,
      });
      const updated = await updateTask(client, existing.id, {
        currentTask: existing,
        expectedVersion,
        patch: {
          status: 'waiting',
          followUpAt: nextFollowUpAt,
          followUpChannel: channel,
        },
        historyEvents: [historyEvent],
        actorId,
        triggerKind: 'task-follow-up-sent',
      });
      return jsonResponse(200, await projectWithPrerequisites(client, updated));
    }

    // Snooze hides an open Task from the today/overdue queue until the given
    // date, then it returns. The due date, status, and ownership are
    // untouched; only the queue hides it.
    if (taskAction.action === 'snooze') {
      if (existing.status === 'done') {
        return jsonResponse(400, { error: 'Completed tasks cannot be snoozed' });
      }
      const rawUntil = trimmedString(body.snoozedUntil);
      const resolvedUntil = rawUntil ? resolveDateInput(rawUntil, 'snoozedUntil') : null;
      if (!resolvedUntil || 'error' in resolvedUntil) {
        return jsonResponse(400, { error: resolvedUntil && 'error' in resolvedUntil ? resolvedUntil.error : 'snoozedUntil is required' });
      }
      const reason = trimmedString(body.reason);
      const reasonError = validateSkipReason(reason);
      if (reasonError) return jsonResponse(400, { error: reasonError });

      const historyEvent = makeTaskHistoryEvent('snoozed', existing, {
        actorId,
        followUpAt: resolvedUntil.date,
        note: reason,
        createdAt: now,
      });
      const updated = await updateTask(client, existing.id, {
        currentTask: existing,
        expectedVersion,
        patch: {
          snoozedUntil: resolvedUntil.date,
          snoozeReason: reason,
        },
        historyEvents: [historyEvent],
        actorId,
        triggerKind: 'task-snoozed',
      });
      return jsonResponse(200, await projectWithPrerequisites(client, updated));
    }

    if (taskAction.action === 'unsnooze') {
      if (!existing.snoozedUntil) {
        return jsonResponse(400, { error: 'Task is not snoozed' });
      }
      const historyEvent = makeTaskHistoryEvent('unsnoozed', existing, {
        actorId,
        previousFollowUpAt: existing.snoozedUntil,
        note: existing.snoozeReason,
        createdAt: now,
      });
      const updated = await updateTask(client, existing.id, {
        currentTask: existing,
        expectedVersion,
        patch: {
          snoozedUntil: null,
          snoozeReason: null,
        },
        historyEvents: [historyEvent],
        actorId,
        triggerKind: 'task-unsnoozed',
      });
      return jsonResponse(200, await projectWithPrerequisites(client, updated));
    }

    if (taskAction.action === 'response-received' || taskAction.action === 'unblocked') {
      if (existing.status !== 'waiting') {
        return jsonResponse(400, { error: 'Task must be waiting before it can be unblocked' });
      }
      const note = trimmedString(body.note);
      const noteError = validateActionNote(note);
      if (noteError) return jsonResponse(400, { error: noteError });

      const action = taskAction.action === 'unblocked' ? 'unblocked' : 'response-received';
      const historyEvent = makeTaskHistoryEvent(action, existing, {
        actorId,
        channel: trimmedString(body.channel) || existing.followUpChannel,
        waitingFor: existing.waitingFor,
        previousFollowUpAt: existing.followUpAt,
        note,
        createdAt: now,
      });
      const updated = await updateTask(client, existing.id, {
        currentTask: existing,
        expectedVersion,
        patch: {
          status: 'todo',
          waitingFor: null,
          followUpAt: null,
          followUpChannel: null,
        },
        historyEvents: [historyEvent],
        actorId,
        triggerKind: `task-${action}`,
      });
      return jsonResponse(200, await projectWithPrerequisites(client, updated));
    }

    if (taskAction.action === 'resolve-done') {
      if (existing.status !== 'waiting') {
        return jsonResponse(400, { error: 'Task must be waiting before resolving the wait' });
      }
      const note = trimmedString(body.note);
      const noteError = validateActionNote(note);
      if (noteError) return jsonResponse(400, { error: noteError });

      const updates: TaskPatch & Record<string, unknown> = {
        status: 'done',
        waitingFor: null,
        followUpAt: null,
        followUpChannel: null,
      };
      for (const field of ['comment', 'link', 'externalStatus', 'artifactRefs', 'auditEventRefs']) {
        if (body[field] !== undefined) updates[field] = body[field];
      }

      const taskData = { ...existing, ...updates };
      const effectiveRequiredLinkName = (updates.requiredLinkName !== undefined ? updates.requiredLinkName : existing.requiredLinkName) as string | undefined;
      const effectiveLink = (updates.link !== undefined ? updates.link : existing.link) as string | undefined;
      if (
        effectiveRequiredLinkName
        && !effectiveLink
        && isNonEmptyString(taskData.cardId)
      ) {
        const cardLinkUrl = await resolveCardLinkForTask(client, taskData.cardId, effectiveRequiredLinkName);
        if (cardLinkUrl) {
          updates.link = cardLinkUrl;
          taskData.link = cardLinkUrl;
        }
      }
      const resolvedLink = (updates.link !== undefined ? updates.link : existing.link) as string | undefined;
      if (
        effectiveRequiredLinkName
        && !resolvedLink
        && !skipClosureSuppresses(taskData, 'requiredLink', effectiveRequiredLinkName)
      ) {
        return jsonResponse(400, { error: `Cannot mark task as done: required link '${effectiveRequiredLinkName}' is not filled` });
      }

      const effectiveRequiresFile = existing.requiresFile as boolean | undefined;
      if (effectiveRequiresFile && !skipClosureSuppresses(taskData, 'file')) {
        const files = await listFilesByTask(client, existing.id);
        if (files.length === 0) {
          return jsonResponse(400, { error: 'Cannot mark task as done: required file has not been uploaded' });
        }
      }

      const calendarInviteError = await validateCalendarInviteRequirement(client, taskData);
      if (calendarInviteError) return jsonResponse(400, { error: calendarInviteError });

      const cardLinkError = await validateRequiredCardLinks(client, taskData);
      if (cardLinkError) return jsonResponse(400, { error: cardLinkError });

      const proofError = await validateDoneProof(client, existing.id, existing, updates);
      if (proofError) return jsonResponse(400, { error: proofError });

      updates.completedAt = now;
      if (actorId) updates.completedBy = actorId;
      const resolvedEvent = makeTaskHistoryEvent('wait-resolved', existing, {
        actorId,
        channel: trimmedString(body.channel) || existing.followUpChannel,
        waitingFor: existing.waitingFor,
        previousFollowUpAt: existing.followUpAt,
        note,
        createdAt: now,
      });
      const completedEvent = makeTaskHistoryEvent('completed', existing, {
        actorId,
        note,
        createdAt: now,
      });
      const updated = await updateTask(client, existing.id, {
        currentTask: existing,
        expectedVersion,
        patch: updates,
        historyEvents: [resolvedEvent, completedEvent],
        actorId,
        triggerKind: 'task-wait-resolved-done',
      });
      return jsonResponse(200, await projectWithPrerequisites(client, updated));
    }

    return jsonResponse(404, { error: 'Not found' });
  }

  // GET /api/tasks/:id — Get a single task
  if (method === 'GET' && reqPath.startsWith('/api/tasks/')) {
    const id = extractTaskId(reqPath);
    if (!id) {
      return jsonResponse(404, { error: 'Not found' });
    }
    const readActor = await resolveInteractiveActor(client, event, 'work-read');
    if (!readActor.ok) return readActor.response;
    const task = await getTask(client, id);
    if (!task) {
      return jsonResponse(404, { error: 'Task not found' });
    }
    return jsonResponse(200, await projectWithPrerequisites(client, task));
  }

  // PUT /api/tasks/:id — Update a task
  if (method === 'PUT' && reqPath.startsWith('/api/tasks/')) {
    const id = extractTaskId(reqPath);
    if (!id) {
      return jsonResponse(404, { error: 'Not found' });
    }

    const updateActor = await resolveInteractiveActor(client, event, 'work-write');
    if (!updateActor.ok) return updateActor.response;
    const actor = updateActor.actor;

    const body = parseBody(event);
    if (!body) {
      return jsonResponse(400, { error: 'Request body is required' });
    }
    const preconditionError = expectedVersionError(body);
    if (preconditionError) return jsonResponse(400, { error: preconditionError });
    const expectedVersion = body.expectedVersion as number;

    // Filter to allowed fields only
    const updates: TaskPatch & Record<string, unknown> = {};
    for (const field of ALLOWED_UPDATE_FIELDS) {
      if (body[field] !== undefined) {
        updates[field] = body[field];
      }
    }

    if (Object.keys(updates).length === 0) {
      return jsonResponse(400, { error: 'No valid fields to update' });
    }
    for (const field of ['date', 'followUpAt', 'snoozedUntil'] as const) {
      if (updates[field] !== undefined && updates[field] !== null) {
        const resolved = resolveDateInput(updates[field], field);
        if ('error' in resolved) return jsonResponse(400, { error: resolved.error });
        updates[field] = resolved.date;
      }
    }
    if (updates.notBeforeAt !== undefined && updates.notBeforeAt !== null) {
      const timezone = resolveTimezoneInput(body.timezone);
      if ('error' in timezone) return jsonResponse(400, { error: timezone.error });
      const resolved = resolveDateTimeInput(updates.notBeforeAt, 'notBeforeAt', timezone.timezone);
      if ('error' in resolved) return jsonResponse(400, { error: resolved.error });
      updates.notBeforeAt = resolved.date;
    }
    if (updates.status !== undefined && !isTaskStatus(updates.status)) {
      return jsonResponse(400, { error: INVALID_STATUS_ERROR });
    }
    if (updates.status === 'skipped') {
      return jsonResponse(400, { error: SKIPPED_STATUS_ERROR });
    }
    if (updates.cardId !== undefined && updates.cardId !== null && !isNonEmptyString(updates.cardId)) {
      return jsonResponse(400, { error: 'cardId must be a non-empty string or null' });
    }
    if (updates.subject !== undefined && updates.subject !== null) {
      const parsed = await parseTaskSubject(client, updates.subject);
      if ('error' in parsed) return jsonResponse(parsed.statusCode, { error: parsed.error });
      updates.subject = parsed.subject;
    }
    const titleLinks = applyTitleLinksToTaskData(updates);
    if ('error' in titleLinks) {
      return jsonResponse(400, { error: titleLinks.error });
    }
    applyLeadingTagToTaskData(updates);
    const tagsError = validateTaskTags(updates.tags);
    if (tagsError) {
      return jsonResponse(400, { error: tagsError });
    }
    const docContextError = validateTaskDocContext(updates);
    if (docContextError) {
      return jsonResponse(400, { error: docContextError });
    }
    const proofRequirementError = validateProofRequirement(updates.proofRequirement);
    if (proofRequirementError) {
      return jsonResponse(400, { error: proofRequirementError });
    }
    const refsError = validateTaskRefs(updates);
    if (refsError) {
      return jsonResponse(400, { error: refsError });
    }
    if (updates.dependsOn !== undefined) updates.dependsOn = normalizeDependsOn(updates.dependsOn);
    if (updates.templateId !== undefined) {
      if (!isNonEmptyString(updates.templateId) || !await getTemplate(client, updates.templateId)) {
        return jsonResponse(404, { error: 'Template not found' });
      }
    }

    // Verify task exists
    const existing = await getTaskConsistent(client, id);
    if (!existing) {
      return jsonResponse(404, { error: 'Task not found', code: 'task_not_found' });
    }
    if (existing.version !== expectedVersion) {
      throw new TaskVersionConflictError(existing.id, expectedVersion);
    }
    // A skipped Task is edited like a done one (title, assignee, date, ...);
    // only its lifecycle waits for the unskip action.
    const nextCard = updates.cardId !== undefined ? updates.cardId : existing.cardId;
    const nextSubject = updates.subject !== undefined ? updates.subject : existing.subject;
    if (nextCard && nextSubject) return jsonResponse(400, { error: SUBJECT_WITH_CARD_ERROR });
    if (existing.status === 'skipped' && SKIPPED_TASK_LOCKED_FIELDS.some((field) => updates[field] !== undefined)) {
      return jsonResponse(400, { error: SKIPPED_TASK_LIFECYCLE_ERROR });
    }
    if (titleLinks.moved.length > 0 && !titleLinks.supplied) {
      updates.materials = mergeMaterials(existing.materials || [], titleLinks.moved);
    }

    // Delegated execution must not become assignment or membership
    // administration. Everything else on this route is ordinary Task work an
    // active member may perform on a visible Task.
    if (!actor.testBypass) {
      const nextAssigneeId = isNonEmptyString(updates.assigneeId) ? String(updates.assigneeId).trim() : null;
      const currentAssigneeId = isNonEmptyString(existing.assigneeId) ? existing.assigneeId.trim() : null;
      if (updates.assigneeId !== undefined && nextAssigneeId !== currentAssigneeId) {
        if (!actor.isAdmin) {
          return workAdminForbidden('Changing a Task assignee requires an admin');
        }
        if (nextAssigneeId) {
          const target = await new TeamDirectory(client).project(nextAssigneeId);
          if (!target.active) {
            return jsonResponse(400, { error: 'assigneeId must reference an active team member' });
          }
        }
      }

      if (Object.hasOwn(updates, 'cardId')) {
        const nextCardId = isNonEmptyString(updates.cardId) ? String(updates.cardId).trim() : null;
        const currentCardId = isNonEmptyString(existing.cardId) ? existing.cardId.trim() : null;
        if (nextCardId !== currentCardId && !actor.isAdmin) {
          // Moving a Task in or out of a Card administers that Card.
          for (const affectedCardId of [currentCardId, nextCardId]) {
            if (!affectedCardId) continue;
            const affectedCard = await getCard(client, affectedCardId);
            if (!affectedCard || affectedCard.ownerId !== actor.id) {
              return workAdminForbidden('Changing Task membership requires the Card owner or an admin');
            }
          }
        }
      }
    }

    const historyEvents: TaskHistoryEvent[] = [];

    const effectiveStatus = updates.status !== undefined ? updates.status : existing.status;
    if (existing.status === 'waiting' && updates.status === 'done') {
      return jsonResponse(400, { error: WAITING_COMPLETION_ERROR });
    }
    if (existing.status === 'waiting' && updates.status === 'todo') {
      return jsonResponse(400, { error: WAITING_TODO_ERROR });
    }
    if (effectiveStatus === 'waiting') {
      const effectiveWaitingFor = updates.waitingFor !== undefined ? updates.waitingFor : existing.waitingFor;
      const effectiveFollowUpAt = updates.followUpAt !== undefined ? updates.followUpAt : existing.followUpAt;
      const effectiveComment = updates.comment !== undefined ? updates.comment : existing.comment;
      if (
        !isNonEmptyString(effectiveWaitingFor)
        || !isNonEmptyString(effectiveFollowUpAt)
        || !isNonEmptyString(effectiveComment)
      ) {
        return jsonResponse(400, { error: WAITING_FIELDS_ERROR });
      }
    }

    // requiredLinkName validation: cannot mark done if requiredLinkName is set but link is empty
    if (updates.status === 'done') {
      const completedAt = new Date().toISOString();
      const taskData = { ...existing, ...updates };
      const effectiveRequiredLinkName = (updates.requiredLinkName !== undefined ? updates.requiredLinkName : existing.requiredLinkName) as string | undefined;
      const effectiveLink = (updates.link !== undefined ? updates.link : existing.link) as string | undefined;
      if (
        effectiveRequiredLinkName
        && !effectiveLink
        && isNonEmptyString(taskData.cardId)
      ) {
        const cardLinkUrl = await resolveCardLinkForTask(client, taskData.cardId, effectiveRequiredLinkName);
        if (cardLinkUrl) {
          updates.link = cardLinkUrl;
          taskData.link = cardLinkUrl;
        }
      }
      const resolvedLink = (updates.link !== undefined ? updates.link : existing.link) as string | undefined;
      if (
        effectiveRequiredLinkName
        && !resolvedLink
        && !skipClosureSuppresses(taskData, 'requiredLink', effectiveRequiredLinkName)
      ) {
        return jsonResponse(400, { error: `Cannot mark task as done: required link '${effectiveRequiredLinkName}' is not filled` });
      }

      // requiresFile validation: cannot mark done if requiresFile is true and no files uploaded
      const effectiveRequiresFile = (updates.requiresFile !== undefined ? updates.requiresFile : existing.requiresFile) as boolean | undefined;
      if (effectiveRequiresFile && !skipClosureSuppresses(taskData, 'file')) {
        const files = await listFilesByTask(client, id);
        if (files.length === 0) {
          return jsonResponse(400, { error: 'Cannot mark task as done: required file has not been uploaded' });
        }
      }

      const calendarInviteError = existing.status === 'done'
        ? null
        : await validateCalendarInviteRequirement(client, taskData);
      if (calendarInviteError) {
        return jsonResponse(400, { error: calendarInviteError });
      }

      const cardLinkError = await validateRequiredCardLinks(client, taskData);
      if (cardLinkError) {
        return jsonResponse(400, { error: cardLinkError });
      }

      const proofError = await validateDoneProof(client, id, existing, updates);
      if (proofError) {
        return jsonResponse(400, { error: proofError });
      }

      updates.completedAt = completedAt;
      const actorId = actor.id;
      if (actorId) updates.completedBy = actorId;
      if (existing.status !== 'done') {
        historyEvents.push(makeTaskHistoryEvent('completed', existing, {
          actorId: actorId || undefined,
          note: isNonEmptyString(updates.comment) ? String(updates.comment) : undefined,
          createdAt: completedAt,
        }));
      }
    } else if (
      existing.status === 'done'
      && (updates.status === 'todo' || updates.status === 'waiting')
    ) {
      historyEvents.push(makeTaskHistoryEvent('reopened', existing, {
        actorId: actor.id || undefined,
      }));
      updates.completedAt = null;
      updates.completedBy = null;
    }

    // `comment` appends to the notes log instead of overwriting it: the
    // pre-existing comment becomes the first log entry, so no note is lost.
    if (updates.comment !== undefined && isNonEmptyString(updates.comment)) {
      const log = [...(existing.notesLog || [])];
      if (log.length === 0 && isNonEmptyString(existing.comment)) {
        log.push({
          id: crypto.randomUUID(),
          text: String(existing.comment).trim(),
          ...(isNonEmptyString(existing.createdBy) ? { authorId: String(existing.createdBy).trim() } : {}),
          createdAt: existing.updatedAt,
        });
      }
      log.push({
        id: crypto.randomUUID(),
        text: String(updates.comment).trim(),
        ...(actor.id ? { authorId: actor.id } : {}),
        createdAt: new Date().toISOString(),
      });
      updates.notesLog = log;
    }

    const updated = await updateTask(client, id, {
      currentTask: existing,
      expectedVersion,
      patch: updates,
      historyEvents,
      actorId: actor.id || undefined,
      triggerKind: updates.status === 'done'
        ? 'task-completed'
        : updates.status === 'todo' || updates.status === 'waiting'
          ? 'task-reopened'
          : 'task-updated',
    });

    // Dependents follow the same offset when this Task's date or moment
    // moves: dates shift by whole days, set moments by milliseconds.
    let rescheduled: string[] = [];
    const dateMoved = typeof updates.date === 'string' && updates.date !== existing.date;
    const momentMoved = typeof updates.notBeforeAt === 'string' && updates.notBeforeAt !== existing.notBeforeAt;
    if ((dateMoved || momentMoved) && typeof updated.cardId === 'string' && updated.cardId) {
      const dayShift = dateMoved
        ? Math.round((Date.parse(String(updates.date)) - Date.parse(existing.date)) / 86400000)
        : 0;
      const momentShift = momentMoved && typeof existing.notBeforeAt === 'string'
        ? Date.parse(String(updates.notBeforeAt)) - Date.parse(existing.notBeforeAt)
        : null;
      if ((Number.isFinite(dayShift) && dayShift !== 0) || (momentShift !== null && Number.isFinite(momentShift) && momentShift !== 0)) {
        rescheduled = await rescheduleDependents(client, updated, {
          dateDeltaDays: Number.isFinite(dayShift) ? dayShift : 0,
          momentDeltaMs: momentShift,
        }, actor.id || undefined);
      }
    }

    const projected = await projectWithPrerequisites(client, updated);
    return jsonResponse(200, rescheduled.length > 0 ? { ...projected, rescheduled } : projected);
  }

  // DELETE /api/tasks/:id — Delete a task
  if (method === 'DELETE' && reqPath.startsWith('/api/tasks/')) {
    const id = extractTaskId(reqPath);
    if (!id) {
      return jsonResponse(404, { error: 'Not found' });
    }
    // Deletion is administration, not execution: an operator may not delete
    // their own, a teammate's, or an unassigned Task.
    const deleteActor = await resolveInteractiveActor(client, event, 'work-write');
    if (!deleteActor.ok) return deleteActor.response;
    if (!deleteActor.actor.testBypass && !deleteActor.actor.isAdmin) {
      return workAdminForbidden('Deleting a Task requires an admin');
    }
    const body = parseBody(event);
    if (!body) return jsonResponse(400, { error: 'Request body is required' });
    const preconditionError = expectedVersionError(body);
    if (preconditionError) return jsonResponse(400, { error: preconditionError });
    await deleteTask(
      client,
      id,
      body.expectedVersion as number,
      deleteActor.actor.id || undefined,
    );
    return {
      statusCode: 204,
      headers: JSON_HEADERS,
      body: '',
    };
  }
  return null;
}
