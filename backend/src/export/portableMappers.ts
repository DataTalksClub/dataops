/**
 * Canonical JSONL mappers for the portable export: one `map*` function per
 * exported entity, turning DynamoDB items into canonical export records,
 * plus the shared JSON value types and null/empty-stripping coercion helpers.
 *
 * Extracted verbatim from `export/portable.ts`.
 */

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export type JsonRecord = Record<string, JsonValue>;
function optionalString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function optionalBoolean(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
}

function optionalNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function jsonArray(value: unknown): JsonValue[] {
  return Array.isArray(value) ? JSON.parse(JSON.stringify(value)) as JsonValue[] : [];
}

function optionalJsonStringOrObject(value: unknown): JsonValue | null {
  if (typeof value === 'string') return value;
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    return JSON.parse(JSON.stringify(value)) as JsonValue;
  }
  return null;
}

function stripEmpty(record: JsonRecord): JsonRecord {
  const result: JsonRecord = {};
  for (const [key, value] of Object.entries(record)) {
    if (value === null) continue;
    if (Array.isArray(value) && value.length === 0) continue;
    result[key] = value;
  }
  return result;
}

export function mapUser(item: Record<string, unknown>): JsonRecord {
  return stripEmpty({
    user_id: optionalString(item.id),
    name: optionalString(item.name),
    email: optionalString(item.email),
    created_at: optionalString(item.createdAt),
  });
}

export function mapTask(item: Record<string, unknown>): JsonRecord {
  const mapped = stripEmpty({
    task_id: optionalString(item.id),
    version: optionalNumber(item.version),
    description: optionalString(item.description),
    date: optionalString(item.date),
    status: optionalString(item.status),
    source: optionalString(item.source),
    comment: optionalString(item.comment),
    waiting_for: optionalString(item.waitingFor),
    follow_up_at: optionalString(item.followUpAt),
    follow_up_channel: optionalString(item.followUpChannel),
    proof_requirement: optionalJsonStringOrObject(item.proofRequirement),
    external_status: optionalString(item.externalStatus),
    instructions_url: optionalString(item.instructionsUrl),
    instruction_doc_id: optionalString(item.instructionDocId),
    instruction_step_id: optionalString(item.instructionStepId),
    phase: optionalString(item.phase),
    requires: stringArray(item.requires),
    browser_requirement: optionalString(item.browserRequirement),
    depends_on: stringArray(item.dependsOn),
    validation: optionalJsonStringOrObject(item.validation),
    link: optionalString(item.link),
    materials: jsonArray(item.materials),
    required_link_name: optionalString(item.requiredLinkName),
    requires_file: optionalBoolean(item.requiresFile),
    requires_calendar_invite: optionalBoolean(item.requiresCalendarInvite),
    assignee_id: optionalString(item.assigneeId),
    created_by: optionalString(item.createdBy),
    card_id: optionalString(item.cardId),
    subject: optionalJsonStringOrObject(item.subject),
    template_id: optionalString(item.templateId),
    template_task_ref: optionalString(item.templateTaskRef),
    template_offset_days: optionalNumber(item.templateOffsetDays),
    is_milestone: optionalBoolean(item.isMilestone),
    source_doc_ids: stringArray(item.sourceDocIds),
    recurring_config_id: optionalString(item.recurringConfigId),
    stage_on_complete: optionalString(item.stageOnComplete),
    artifact_refs: jsonArray(item.artifactRefs),
    intake_refs: jsonArray(item.intakeRefs),
    audit_event_refs: jsonArray(item.auditEventRefs),
    tags: stringArray(item.tags),
    completed_by: optionalString(item.completedBy),
    completed_at: optionalString(item.completedAt),
    skip_reason: optionalString(item.skipReason),
    skipped_at: optionalString(item.skippedAt),
    skipped_by: optionalString(item.skippedBy),
    created_at: optionalString(item.createdAt),
    updated_at: optionalString(item.updatedAt),
  });
  // Canonical Tasks always expose history, including the meaningful empty state.
  mapped.task_history = jsonArray(item.taskHistory);
  return mapped;
}

export function mapCard(item: Record<string, unknown>): JsonRecord {
  return stripEmpty({
    card_id: optionalString(item.id),
    version: optionalNumber(item.version),
    title: optionalString(item.title),
    description: optionalString(item.description),
    anchor_date: optionalString(item.anchorDate),
    template_id: optionalString(item.templateId),
    source_doc_ids: stringArray(item.sourceDocIds),
    status: optionalString(item.status),
    stage: optionalString(item.stage),
    task_count: optionalNumber(item.taskCount),
    open_task_count: optionalNumber(item.openTaskCount),
    completed_at: optionalString(item.completedAt),
    completed_by: optionalString(item.completedBy),
    active_stage_before_completion: optionalString(item.activeStageBeforeCompletion),
    references: jsonArray(item.references),
    card_links: jsonArray(item.cardLinks),
    calendar_invites: jsonArray(item.calendarInvites),
    guest_emails: stringArray(item.guestEmails),
    event_time: optionalJsonStringOrObject(item.eventTime),
    tags: stringArray(item.tags),
    artifact_refs: jsonArray(item.artifactRefs),
    intake_refs: jsonArray(item.intakeRefs),
    audit_event_refs: jsonArray(item.auditEventRefs),
    created_at: optionalString(item.createdAt),
    updated_at: optionalString(item.updatedAt),
  });
}

export function mapTemplate(item: Record<string, unknown>): JsonRecord {
  return stripEmpty({
    template_id: optionalString(item.id),
    name: optionalString(item.name),
    type: optionalString(item.type),
    icon: optionalString(item.icon),
    tags: stringArray(item.tags),
    phases: jsonArray(item.phases),
    source_doc_ids: stringArray(item.sourceDocIds),
    references: jsonArray(item.references),
    card_link_definitions: jsonArray(item.cardLinkDefinitions),
    task_definitions: jsonArray(item.taskDefinitions),
    trigger_type: optionalString(item.triggerType),
    trigger_schedule: optionalString(item.triggerSchedule),
    trigger_lead_days: optionalNumber(item.triggerLeadDays),
    trigger_enabled: optionalBoolean(item.triggerEnabled),
    source_path: optionalString(item.sourcePath),
    source_revision: optionalString(item.sourceRevision),
    version: optionalNumber(item.version),
    created_at: optionalString(item.createdAt),
    updated_at: optionalString(item.updatedAt),
  });
}

export function mapRecurringConfig(item: Record<string, unknown>): JsonRecord {
  return stripEmpty({
    recurring_config_id: optionalString(item.id),
    description: optionalString(item.description),
    cron_expression: optionalString(item.cronExpression),
    assignee_id: optionalString(item.assigneeId),
    instructions_url: optionalString(item.instructionsUrl),
    instruction_doc_id: optionalString(item.instructionDocId),
    instruction_step_id: optionalString(item.instructionStepId),
    requires: stringArray(item.requires),
    browser_requirement: optionalString(item.browserRequirement),
    proof_requirement: optionalJsonStringOrObject(item.proofRequirement),
    required_link_name: optionalString(item.requiredLinkName),
    requires_file: optionalBoolean(item.requiresFile),
    requires_calendar_invite: optionalBoolean(item.requiresCalendarInvite),
    tags: stringArray(item.tags),
    enabled: optionalBoolean(item.enabled),
    deleted_at: optionalString(item.deletedAt),
    created_at: optionalString(item.createdAt),
    updated_at: optionalString(item.updatedAt),
  });
}

export function mapFile(item: Record<string, unknown>): JsonRecord {
  return stripEmpty({
    file_id: optionalString(item.id),
    task_id: optionalString(item.taskId),
    card_id: optionalString(item.cardId),
    filename: optionalString(item.filename),
    category: optionalString(item.category),
    tags: stringArray(item.tags),
    storage_uri: optionalString(item.storageUri) || optionalString(item.storagePath),
    storage_provider: optionalString(item.storageProvider),
    content_type: optionalString(item.contentType),
    checksum: optionalString(item.checksum),
    size_bytes: optionalNumber(item.sizeBytes),
    created_at: optionalString(item.createdAt),
  });
}

export function mapArtifact(item: Record<string, unknown>): JsonRecord {
  return stripEmpty({
    artifact_id: optionalString(item.id),
    type: optionalString(item.type),
    title: optionalString(item.title),
    description: optionalString(item.description),
    status: optionalString(item.status),
    storage_provider: optionalString(item.storageProvider),
    storage_uri: optionalString(item.storageUri),
    filename: optionalString(item.filename),
    content_type: optionalString(item.contentType),
    checksum: optionalString(item.checksum),
    size_bytes: optionalNumber(item.sizeBytes),
    visibility: optionalString(item.visibility),
    data_class: optionalString(item.dataClass),
    task_id: optionalString(item.taskId),
    card_id: optionalString(item.cardId),
    file_id: optionalString(item.fileId),
    source_type: optionalString(item.sourceType),
    created_by: optionalString(item.createdBy),
    reviewed_by: optionalString(item.reviewedBy),
    created_at: optionalString(item.createdAt),
    updated_at: optionalString(item.updatedAt),
    reviewed_at: optionalString(item.reviewedAt),
    tags: stringArray(item.tags),
    metadata: optionalJsonStringOrObject(item.metadata),
  });
}

export function mapAuditEvent(item: Record<string, unknown>): JsonRecord {
  return stripEmpty({
    audit_event_id: optionalString(item.id),
    record_type: optionalString(item.recordType),
    actor_id: optionalString(item.actorId),
    action: optionalString(item.action),
    summary: optionalString(item.summary),
    card_id: optionalString(item.cardId),
    trigger_task_id: optionalString(item.triggerTaskId),
    trigger_kind: optionalString(item.triggerKind),
    before: optionalJsonStringOrObject(item.before),
    after: optionalJsonStringOrObject(item.after),
    metadata: optionalJsonStringOrObject(item.metadata),
    created_at: optionalString(item.createdAt),
  });
}

export function mapIntakeItem(item: Record<string, unknown>): JsonRecord {
  return stripEmpty({
    intake_item_id: optionalString(item.id),
    source: optionalString(item.source),
    source_message_id: optionalString(item.sourceMessageId),
    source_thread_id: optionalString(item.sourceThreadId),
    source_received_at: optionalString(item.sourceReceivedAt),
    created_at: optionalString(item.createdAt),
    updated_at: optionalString(item.updatedAt),
    triaged_at: optionalString(item.triagedAt),
    archived_at: optionalString(item.archivedAt),
    created_by: optionalString(item.createdBy),
    triaged_by: optionalString(item.triagedBy),
    owner_id: optionalString(item.ownerId),
    assignee_id: optionalString(item.assigneeId),
    status: optionalString(item.status),
    title: optionalString(item.title),
    summary: optionalString(item.summary),
    body_ref: optionalString(item.bodyRef),
    source_actor: optionalJsonStringOrObject(item.sourceActor),
    received_channels: stringArray(item.receivedChannels),
    link_refs: jsonArray(item.linkRefs),
    file_refs: jsonArray(item.fileRefs),
    artifact_refs: jsonArray(item.artifactRefs),
    task_ids: stringArray(item.taskIds),
    card_ids: stringArray(item.cardIds),
    duplicate_of_intake_item_id: optionalString(item.duplicateOfIntakeItemId),
    related_intake_item_ids: stringArray(item.relatedIntakeItemIds),
    tags: stringArray(item.tags),
    priority: optionalString(item.priority),
    data_class: optionalString(item.dataClass),
    metadata: optionalJsonStringOrObject(item.metadata),
    resolution_reason: optionalString(item.resolutionReason),
    blocked_reason: optionalString(item.blockedReason),
    waiting_for: optionalString(item.waitingFor),
    follow_up_at: optionalString(item.followUpAt),
    last_follow_up_at: optionalString(item.lastFollowUpAt),
    history: jsonArray(item.history),
  });
}

export function mapNotification(item: Record<string, unknown>): JsonRecord {
  return stripEmpty({
    notification_id: optionalString(item.id),
    notification_type: optionalString(item.type),
    message: optionalString(item.message),
    user_id: optionalString(item.userId),
    task_id: optionalString(item.taskId),
    intake_item_id: optionalString(item.intakeItemId),
    card_id: optionalString(item.cardId),
    template_id: optionalString(item.templateId),
    recurring_config_id: optionalString(item.recurringConfigId),
    metadata: optionalJsonStringOrObject(item.metadata),
    due_at: optionalString(item.dueAt),
    dismissed: optionalBoolean(item.dismissed),
    created_at: optionalString(item.createdAt),
  });
}
