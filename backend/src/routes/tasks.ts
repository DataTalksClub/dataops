import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

import { resolveInteractiveActor, workAdminForbidden } from '../identity/actor';
import { TeamDirectory } from '../identity/directory';
import { projectTask, projectTasks } from '../identity/projections';
import {
  matchesOwnerFilter,
  ownerFilterUserId,
  parseOwnerFilter,
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
  listTasksByStatus,
  listTasksByOwner,
  TaskVersionConflictError,
} from '../db/tasks';
import type { TaskPatch } from '../db/tasks';
import { getCard } from '../db/cards';
import { listFilesByTask } from '../db/files';
import { getTemplate } from '../db/templates';
import type { LambdaEvent, LambdaResponse, Task, TaskHistoryEvent } from '../types';
import {
  ALLOWED_UPDATE_FIELDS,
  WAITING_COMPLETION_ERROR,
  WAITING_FIELDS_ERROR,
  WAITING_TODO_ERROR,
  expectedVersionError,
  isNonEmptyString,
  isTaskStatus,
  makeTaskHistoryEvent,
  skipClosureSuppresses,
  trimmedString,
  validateActionChannel,
  validateActionNote,
  validateDateOrTimestampValue,
  validateDoneProof,
  validateDoneProofOnCreate,
  validateProofRequirement,
  validateRequiredCardLinks,
  validateTaskDocContext,
  validateTaskRefs,
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
    if (body.date) taskData.date = body.date;
    if (body.comment !== undefined) taskData.comment = body.comment;
    if (body.cardId !== undefined) taskData.cardId = body.cardId;
    if (body.waitingFor !== undefined) taskData.waitingFor = body.waitingFor;
    if (body.followUpAt !== undefined) taskData.followUpAt = body.followUpAt;
    if (body.followUpChannel !== undefined) taskData.followUpChannel = body.followUpChannel;
    if (body.proofRequirement !== undefined) taskData.proofRequirement = body.proofRequirement;
    if (body.externalStatus !== undefined) taskData.externalStatus = body.externalStatus;
    if (body.instructionsUrl !== undefined) taskData.instructionsUrl = body.instructionsUrl;
    if (body.instructionDocId !== undefined) taskData.instructionDocId = body.instructionDocId;
    if (body.instructionStepId !== undefined) taskData.instructionStepId = body.instructionStepId;
    if (body.phase !== undefined) taskData.phase = body.phase;
    if (body.systems !== undefined) taskData.systems = body.systems;
    if (body.validation !== undefined) taskData.validation = body.validation;
    if (body.link !== undefined) taskData.link = body.link;
    if (body.requiredLinkName !== undefined) taskData.requiredLinkName = body.requiredLinkName;
    if (body.requiresFile !== undefined) taskData.requiresFile = body.requiresFile;
    if (body.assigneeId !== undefined) taskData.assigneeId = body.assigneeId;
    if (body.tags !== undefined) taskData.tags = body.tags;
    if (body.templateId !== undefined) taskData.templateId = body.templateId;
    if (body.sourceDocIds !== undefined) taskData.sourceDocIds = body.sourceDocIds;
    if (body.artifactRefs !== undefined) taskData.artifactRefs = body.artifactRefs;
    if (body.assistantJobRefs !== undefined) taskData.assistantJobRefs = body.assistantJobRefs;
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
        return jsonResponse(400, { error: "Invalid status. Must be 'todo', 'waiting', 'done', or 'archived'" });
      }
      if (body.status === 'archived') {
        return jsonResponse(400, { error: 'archived is system-owned and cannot be set directly' });
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
    if (taskData.templateId !== undefined) {
      if (!isNonEmptyString(taskData.templateId) || !await getTemplate(client, taskData.templateId)) {
        return jsonResponse(404, { error: 'Template not found' });
      }
    }
    if (taskData.status === 'done') {
      const cardLinkError = await validateRequiredCardLinks(client, taskData);
      if (cardLinkError) {
        return jsonResponse(400, { error: cardLinkError });
      }
      const proofError = await validateDoneProofOnCreate(client, taskData);
      if (proofError) {
        return jsonResponse(400, { error: proofError });
      }
    }

    const task = await createTask(client, taskData);
    return jsonResponse(201, await projectTask(new TeamDirectory(client), task));
  }

  // GET /api/tasks — List tasks with filters
  if (method === 'GET' && reqPath === '/api/tasks') {
    const listActor = await resolveInteractiveActor(client, event, 'work-read');
    if (!listActor.ok) return listActor.response;

    const params = event.queryStringParameters || {};
    const { date, startDate, endDate, cardId, status } = params;

    // `owner` composes with one existing filter instead of competing with
    // it, so the existing priority can never silently discard it.
    const ownerParse = parseOwnerFilter(params.owner, listActor.actor);
    if (!ownerParse.ok) return jsonResponse(400, { error: ownerParse.error });
    const ownerFilter = ownerParse.filter;

    if (!date && !startDate && !endDate && !cardId && !status && !ownerFilter) {
      return jsonResponse(400, {
        error: 'At least one filter is required: owner, date, startDate+endDate, cardId, or status',
      });
    }

    const directory = new TeamDirectory(client);
    await directory.loadAll();
    const activeMemberIds = await directory.activeMemberIds();

    async function ownerListResponse(tasks: Task[]): Promise<LambdaResponse> {
      const visible = ownerFilter
        ? tasks.filter((task) => matchesOwnerFilter(task.assigneeId, ownerFilter, activeMemberIds))
        : tasks;
      const responseBody: Record<string, unknown> = { tasks: await projectTasks(directory, visible) };
      const ownerReference = ownerFilterUserId(ownerFilter);
      // A concrete reference always answers with its honest availability,
      // including for a disabled or missing teammate, so a deep link never
      // degrades into a different scope.
      if (ownerReference) responseBody.owner = await directory.project(ownerReference);
      return jsonResponse(200, responseBody);
    }

    // Priority: date > startDate+endDate > cardId > status > owner
    if (date) {
      return await ownerListResponse(await listTasksByDate(client, date));
    }

    if (startDate || endDate) {
      if (!startDate || !endDate) {
        return jsonResponse(400, {
          error: 'Both startDate and endDate are required for range queries',
        });
      }
      return await ownerListResponse(await listTasksByDateRange(client, startDate, endDate));
    }

    if (cardId) {
      return await ownerListResponse(await listTasksByCard(client, cardId));
    }

    if (status) {
      if (!isTaskStatus(status)) {
        return jsonResponse(400, {
          error: "Invalid status. Must be 'todo', 'waiting', 'done', or 'archived'",
        });
      }
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
    if (existing.status === 'archived') {
      return jsonResponse(400, {
        error: 'archived Tasks are system-owned and cannot be changed through manual actions',
      });
    }

    const actorId = actionActor.actor.id || undefined;
    const now = new Date().toISOString();

    if (taskAction.action === 'mark-waiting') {
      if (existing.status === 'done') {
        return jsonResponse(400, { error: 'Completed tasks must be reopened before marking waiting' });
      }
      const waitingFor = trimmedString(body.waitingFor);
      const followUpAt = trimmedString(body.followUpAt);
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
      return jsonResponse(200, await projectTask(new TeamDirectory(client), updated));
    }

    if (taskAction.action === 'follow-up-sent') {
      if (existing.status !== 'waiting') {
        return jsonResponse(400, { error: 'Task must be waiting before recording a follow-up' });
      }
      const channel = trimmedString(body.channel);
      const note = trimmedString(body.note);
      const nextFollowUpAt = trimmedString(body.nextFollowUpAt || body.followUpAt);
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
      return jsonResponse(200, await projectTask(new TeamDirectory(client), updated));
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
      return jsonResponse(200, await projectTask(new TeamDirectory(client), updated));
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
      for (const field of ['comment', 'link', 'externalStatus', 'artifactRefs', 'assistantJobRefs', 'auditEventRefs']) {
        if (body[field] !== undefined) updates[field] = body[field];
      }

      const taskData = { ...existing, ...updates };
      const effectiveRequiredLinkName = (updates.requiredLinkName !== undefined ? updates.requiredLinkName : existing.requiredLinkName) as string | undefined;
      const effectiveLink = (updates.link !== undefined ? updates.link : existing.link) as string | undefined;
      if (
        effectiveRequiredLinkName
        && !effectiveLink
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
      return jsonResponse(200, await projectTask(new TeamDirectory(client), updated));
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
    return jsonResponse(200, await projectTask(new TeamDirectory(client), task));
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
    if (updates.status !== undefined && !isTaskStatus(updates.status)) {
      return jsonResponse(400, { error: "Invalid status. Must be 'todo', 'waiting', 'done', or 'archived'" });
    }
    if (updates.status === 'archived') {
      return jsonResponse(400, { error: 'archived is system-owned and cannot be set directly' });
    }
    if (updates.cardId !== undefined && updates.cardId !== null && !isNonEmptyString(updates.cardId)) {
      return jsonResponse(400, { error: 'cardId must be a non-empty string or null' });
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
    if (existing.status === 'archived') {
      return jsonResponse(400, {
        error: 'archived Tasks are system-owned and cannot be changed through manual updates',
      });
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

    return jsonResponse(200, await projectTask(new TeamDirectory(client), updated));
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
