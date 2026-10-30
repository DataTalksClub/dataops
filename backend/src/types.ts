import type { EventPolicy } from './events/policy';
import type { EpisodeStage, EpisodeStageRefs } from './podcast/cardStatus';

// --- Task ---

/**
 * `skipped` resolves a Task as not applicable without doing it. It always
 * carries `skipReason`, `skippedAt`, and `skippedBy`. An operator skips with a
 * reason; a reviewed Template update skips Tasks its new version removed.
 */
export type TaskStatus = 'todo' | 'waiting' | 'done' | 'skipped';
export type ProofRequirementType = 'url' | 'file' | 'artifact' | 'comment' | 'external-status';
/**
 * Whether doing the work needs an interactive browser: `'required'`, or
 * `'headless'` when the whole Task can finish without one. An absent value is
 * an honest "not classified" and is never treated as headless-safe (see
 * browserRequirement.ts).
 */
export type BrowserRequirement = 'required' | 'headless';
export type NotificationType =
  | 'task-due'
  | 'task-overdue'
  | 'follow-up-due'
  | 'missing-evidence'
  | 'recurring-due'
  | 'stage-change'
  | 'automation-failure';
export type WorkflowStage = 'preparation' | 'announced' | 'after-event' | 'done' | string;

export interface ProofRequirement {
  type: ProofRequirementType;
  label?: string;
  required?: boolean;
}

export interface WorkflowPhase {
  id: string;
  name: string;
  stage?: WorkflowStage;
  entryCriteria?: string[];
  exitCriteria?: string[];
  allowedNextPhaseIds?: string[];
}

export interface ArtifactRef {
  artifactId: string;
  type?: string;
  title?: string;
  storageUri?: string;
  status?: string;
}

export type ArtifactType =
  | 'podcast-doc'
  | 'transcript'
  | 'recording'
  | 'report'
  | 'invoice'
  | 'event-page'
  | 'assistant-output'
  | 'external-link'
  | 'other';

export type ArtifactStatus = 'draft' | 'needs-review' | 'approved' | 'rejected' | 'archived' | 'superseded';
export type ArtifactStorageProvider = 's3' | 'dropbox' | 'google-drive' | 'github' | 'external-url' | 'local-dev' | 'unknown';
export type ArtifactDataClass = 'public' | 'internal' | 'private' | 'sensitive';
export type ArtifactSourceType = 'manual-link' | 'manual-upload' | 'assistant-output' | 'import' | 'migration' | 'system';

export interface ArtifactRecord {
  id: string;
  type: ArtifactType | string;
  title: string;
  description?: string;
  status: ArtifactStatus;
  storageProvider: ArtifactStorageProvider;
  storageUri: string;
  filename?: string;
  contentType?: string;
  checksum?: string;
  sizeBytes?: number;
  visibility?: ArtifactDataClass;
  dataClass: ArtifactDataClass;
  taskId?: string;
  cardId?: string;
  fileId?: string;
  sourceType: ArtifactSourceType;
  createdBy?: string;
  reviewedBy?: string;
  createdAt: string;
  updatedAt: string;
  reviewedAt?: string;
  tags?: string[];
  metadata?: Record<string, unknown>;
}

export interface IntakeRef {
  intakeItemId: string;
  source?: IntakeSource;
  title?: string;
  status?: IntakeStatus;
}

export type IntakeSource = 'telegram' | 'email' | 'manual' | 'file' | 'link' | 'import' | 'assistant' | 'unknown';
export type IntakeStatus = 'new' | 'triaged' | 'attached' | 'converted' | 'ignored' | 'duplicate' | 'blocked' | 'archived';
export type IntakePriority = 'low' | 'normal' | 'high' | 'urgent';
export type IntakeDataClass = 'public' | 'internal' | 'private' | 'sensitive';

export interface IntakeSourceActor {
  name?: string;
  handle?: string;
  email?: string;
  chatId?: string;
  userId?: string;
  metadata?: Record<string, unknown>;
}

export interface IntakeLinkRef {
  url: string;
  title?: string;
  normalizedUrl?: string;
  type?: string;
  safetyStatus?: 'unchecked' | 'safe' | 'blocked' | 'redacted' | string;
}

export interface IntakeFileRef {
  fileId?: string;
  filename?: string;
  storageUri?: string;
  storageProvider?: string;
  contentType?: string;
  checksum?: string;
  sizeBytes?: number;
  title?: string;
  metadata?: Record<string, unknown>;
}

export interface IntakeHistoryEvent {
  id: string;
  action: string;
  actorId?: string;
  reason?: string;
  metadata?: Record<string, unknown>;
  createdAt: string;
}

export interface IntakeItem {
  id: string;
  source: IntakeSource;
  sourceMessageId?: string;
  sourceThreadId?: string;
  sourceReceivedAt: string;
  createdAt: string;
  updatedAt: string;
  triagedAt?: string;
  archivedAt?: string;
  createdBy?: string;
  triagedBy?: string;
  ownerId?: string;
  assigneeId?: string;
  status: IntakeStatus;
  title: string;
  summary: string;
  bodyRef?: string;
  sourceActor?: IntakeSourceActor;
  receivedChannels: string[];
  linkRefs: IntakeLinkRef[];
  fileRefs: IntakeFileRef[];
  artifactRefs: ArtifactRef[];
  taskIds: string[];
  cardIds: string[];
  duplicateOfIntakeItemId?: string;
  relatedIntakeItemIds: string[];
  tags: string[];
  priority: IntakePriority;
  dataClass: IntakeDataClass;
  metadata?: Record<string, unknown>;
  resolutionReason?: string;
  blockedReason?: string;
  waitingFor?: string;
  followUpAt?: string;
  lastFollowUpAt?: string;
  history: IntakeHistoryEvent[];
}

export interface AuditEventRef {
  auditEventId: string;
  action?: string;
  createdAt?: string;
}

export type TaskHistoryAction =
  | 'waiting-started'
  | 'follow-up-sent'
  | 'response-received'
  | 'unblocked'
  | 'wait-resolved'
  | 'snoozed'
  | 'unsnoozed'
  | 'noted'
  | 'scheduled'
  | 'completed'
  | 'reopened'
  | 'skipped'
  | 'unskipped'
  | 'template-retired'
  | 'template-restored';

export interface TaskHistoryEvent {
  id: string;
  taskId: string;
  cardId?: string;
  action: TaskHistoryAction;
  actorId?: string;
  channel?: string;
  waitingFor?: string;
  followUpAt?: string;
  previousFollowUpAt?: string;
  note?: string;
  createdAt: string;
}

/** A supporting link of a Task, stored clean; `label` is absent for a bare URL. */
export interface TaskMaterial {
  url: string;
  label?: string;
}

/** One entry of a Task's append-only notes log: who wrote what, when. */
export interface TaskNote {
  id: string;
  text: string;
  authorId?: string;
  createdAt: string;
}

export type TaskSubjectType = 'sponsor-deal' | 'sponsor-company' | 'sponsor-person' | 'tuition-agreement';

export interface TaskSubject {
  type: TaskSubjectType;
  id: string;
}

export interface Task {
  id: string;
  /** Monotonic optimistic-concurrency token. */
  version: number;
  description: string;
  date: string;
  status: TaskStatus;
  source?: string;
  comment?: string | null;
  /** Append-only notes: every note ever added, oldest first. `comment` stays the latest. */
  notesLog?: TaskNote[];
  waitingFor?: string;
  followUpAt?: string;
  followUpChannel?: string;
  /** Civil date the Task stays out of the today/overdue queue until (then it returns). */
  snoozedUntil?: string;
  /** Why the Task was snoozed; present exactly when snoozedUntil is set. */
  snoozeReason?: string;
  /** UTC instant the Task must not surface before; hidden from queue views until then. */
  notBeforeAt?: string;
  completedBy?: string;
  completedAt?: string;
  /** Why the Task does not apply; present exactly when status is `skipped`. */
  skipReason?: string;
  skippedAt?: string;
  skippedBy?: string;
  proofRequirement?: ProofRequirement;
  externalStatus?: string;
  instructionsUrl?: string;
  instructionDocId?: string;
  instructionStepId?: string;
  phase?: string;
  /** Required resource ids (see resources/vocabulary.ts) needed to do this Task. */
  requires?: string[];
  /** Whether this Task needs an interactive browser; absent is not classified. */
  browserRequirement?: BrowserRequirement;
  /**
   * Ids of prerequisite Tasks on the same Card. This Task cannot be completed
   * until every one of them is resolved: `done` or `skipped`.
   */
  dependsOn?: string[];
  validation?: string | Record<string, unknown>;
  link?: string;
  /** Supporting links (a message template, a how-to video); never pasted into `description`. */
  materials?: TaskMaterial[];
  requiredLinkName?: string;
  requiresFile?: boolean;
  /** When true, the Task cannot be marked done until its Card links at least one calendar invite. */
  requiresCalendarInvite?: boolean;
  assigneeId?: string;
  createdBy?: string;
  tags?: string[];
  cardId?: string;
  /** What a Task outside any Card is about (a sponsor deal or company); never set with `cardId`. */
  subject?: TaskSubject;
  templateId?: string;
  templateTaskRef?: string;
  templateOffsetDays?: number;
  templateTaskOrder?: number;
  /** Template projection used for the last reviewed application to this Task. */
  templateVersion?: number;
  templateSourceRevision?: string;
  templateDefinitionSnapshot?: TemplateTaskDefinitionSnapshot;
  templateRetiredAt?: string;
  templateRetiredReason?: 'removed' | 'completed-modified';
  isMilestone?: boolean;
  /** Source documents inherited from the runtime template at instantiation. */
  sourceDocIds?: string[];
  stageOnComplete?: string;
  recurringConfigId?: string;
  /** Another Card this Task is carried out by (a course's "Workshop 2" Task links that workshop's Card). */
  linkedCardId?: string;
  artifactRefs?: ArtifactRef[];
  intakeRefs?: IntakeRef[];
  auditEventRefs?: AuditEventRef[];
  taskHistory: TaskHistoryEvent[];
  createdAt: string;
  updatedAt: string;
}

// --- File ---

export interface FileRecord {
  id: string;
  taskId: string;
  cardId?: string;
  filename: string;
  category: 'image' | 'invoice' | 'document';
  tags?: string[];
  storagePath: string;
  storageProvider?: 'local-dev' | 's3' | 'dropbox' | 'google-drive' | 'external-url' | 'unknown';
  storageUri?: string;
  contentType?: string;
  checksum?: string;
  sizeBytes?: number;
  createdAt: string;
}

// --- Card ---

export interface CardLink {
  name: string;
  url: string;
}

/**
 * One Google Calendar invite linked to a Card. DataOps creates and moves
 * invites when the Card event time changes. Hand linking is reserved for
 * adopting legacy events. Entries are unique per (calendar, event id).
 */
export interface CardCalendarInvite {
  eventId: string;
  calendar: string;
  url?: string;
  label?: string;
  createdAt?: string;
  createdBy?: string;
}

export interface Card {
  id: string;
  /** Monotonic optimistic-concurrency token. */
  version: number;
  title?: string;
  description?: string | null;
  anchorDate?: string;
  /**
   * Cohort END date (date-only, Europe/Berlin semantics like `anchorDate`).
   * Required on Cards whose Template anchors any Task to END; START-anchored
   * Cards leave it absent.
   */
  endDate?: string;
  /** Every Card is instantiated from a Template; these fields record it. */
  templateId: string;
  /** Template projection used for the last reviewed application to this Card. */
  templateVersion: number;
  templateSourceRevision?: string;
  templateDefinitionSnapshot: TemplateCardDefinitionSnapshot;
  /** Source documents inherited from the runtime template at instantiation. */
  sourceDocIds?: string[];
  /** Optional task groups selected when the Card was created from its Template. */
  selectedOptionalGroups: string[];
  /** Values of the Template's count fields (`countFields`): how many times each repeated Task exists. */
  counts?: Record<string, number>;
  /**
   * Tasks on other Cards that link this Card (`Task.linkedCardId`). Written
   * with the link; a reader confirms each entry against its Task.
   */
  linkedFrom?: TaskCardBackReference[];
  /** People named by the Card: speakers and guests on event Cards. */
  people?: string[];
  /** Main sponsor of a newsletter Card. */
  sponsor?: string;
  /** Additional sponsors beyond the main one. */
  secondarySponsors?: string[];
  /** Issue number for recurring publications, e.g. "298". */
  issueNumber?: string;
  references?: CardLink[];
  cardLinks?: CardLink[];
  /** Google Calendar invites linked to this Card (see CardCalendarInvite). */
  calendarInvites?: CardCalendarInvite[];
  /** Guest email addresses used for this Card's calendar invitation. */
  guestEmails?: string[];
  eventTime?: {
    startIso: string;
    endIso: string;
    timeZone: string;
    durationMinutes: number;
    eventKey: string;
    googleEventIds: Record<string, string>;
    sync: 'syncing' | 'synced' | 'deferred';
    syncStartedAt: string;
    reason?: string;
    generation?: number;
    status?: 'proposed' | 'approved' | 'released';
  };
  tags?: string[];
  /**
   * Administrative owner of the Card. Optional: existing and system-created
   * Cards without an explicit owner are honestly unassigned and are never
   * backfilled from Task assignees or historical text. Outside the Task
   * aggregate: an authorized Task action retains it unchanged.
   */
  ownerId?: string;
  /** System-owned Task aggregate. Archived Tasks remain part of taskCount. */
  taskCount: number;
  /** Number of attached Tasks in todo or waiting state. */
  openTaskCount: number;
  stage: 'preparation' | 'announced' | 'after-event' | 'done';
  /**
   * `active` Cards sit on the board, `parked` Cards are set aside with open
   * work remaining (a second Archive category), and `archived` Cards are done.
   */
  status: 'active' | 'parked' | 'archived';
  completedAt?: string;
  completedBy?: string;
  activeStageBeforeCompletion?: 'preparation' | 'announced' | 'after-event';
  artifactRefs?: ArtifactRef[];
  intakeRefs?: IntakeRef[];
  auditEventRefs?: AuditEventRef[];
  createdAt: string;
  updatedAt: string;
}

// --- Template ---

export interface Reference {
  name: string;
  url: string;
}

export interface CardLinkDefinition {
  name: string;
}

/** A Task on another Card that links this Card. */
export interface TaskCardBackReference {
  taskId: string;
  cardId: string;
}

/**
 * A number entered on the Card (e.g. "Number of workshops") that decides how
 * many times the Template's repeated Tasks (`TaskDefinition.repeat`) exist.
 */
export interface CountField {
  id: string;
  label: string;
  default: number;
  min: number;
  max: number;
}

/** Repeat a Task once per unit of a count field, numbered 1..N. */
export interface TaskRepeat {
  countField: string;
}

/** The kind of Card a Task may link (`Task.linkedCardId`). */
export interface TaskLinkCard {
  templateType: string;
}

export interface ExternalSourceDocument {
  id: string;
  location: string;
  kind: 'external-process' | 'external-template' | 'external-assistant';
  status: 'provenance-only' | 'pending-copy' | 'verified-external';
  note: string;
}

export interface TaskClosure {
  successCriteria: string;
  followUp: 'none' | 'waiting' | 'handoff' | 'review';
  closeCondition: string;
  waitingFor?: string;
  followUpAfterDays?: number;
  recipientRole?: string;
}

export interface TaskDefinition {
  refId: string;
  description: string;
  offsetDays: number;
  /**
   * Which Card date `offsetDays` counts from: the cohort START (`anchorDate`,
   * the default) or the cohort END (`endDate`). Closeout work (certificates,
   * testimonials, payout, retrospective) anchors to END so it stays after
   * delivery no matter how long the cohort runs.
   */
  anchor?: 'start' | 'end';
  /**
   * Optional checklist group (e.g. "secondary"): tasks in a group are only
   * instantiated when the group is selected at Card creation. Ungrouped
   * tasks always instantiate.
   */
  optionalGroup?: string;
  /**
   * Repeat this Task per unit of a count field. Consecutive definitions with
   * the same count field form one group repeated together; `{n}` in the
   * description is the instance number (appended when absent).
   */
  repeat?: TaskRepeat;
  /** The kind of Card a Task from this definition links. */
  linkCard?: TaskLinkCard;
  /**
   * Runtime only, set by `expandTaskDefinitions`: the Task's place in the
   * Card's checklist. Absent on authored definitions.
   */
  order?: number;
  taskKind?: 'procedure' | 'communication' | 'milestone' | 'milestone-plus-publication'
    | 'handoff' | 'waiting-input' | 'validation' | 'approval-gate' | 'checklist' | 'dynamic-slot';
  ownerRole?: string;
  tools?: string[];
  instructionExemptReason?: string;
  runtimeInstructionSource?: string;
  closure?: TaskClosure;
  isMilestone?: boolean;
  stageOnComplete?: string;
  /** The podcast episode stage completing this Task marks (podcast/cardStatus.ts). */
  episodeStage?: EpisodeStage;
  assigneeId?: string;
  instructionsUrl?: string;
  instructionDocId?: string;
  instructionStepId?: string;
  phase?: string;
  requires?: string[];
  /** Whether this Task needs an interactive browser; absent is not classified. */
  browserRequirement?: BrowserRequirement;
  /** `refId`s of the definitions that must be done before this one. */
  dependsOn?: string[];
  validation?: string | Record<string, unknown>;
  requiredLinkName?: string;
  requiresFile?: boolean;
  /**
   * When true, the Task cannot be marked done until its Card links at least
   * one calendar invite. Webinar/podcast invite Tasks carry this; the
   * `create-calendar-invite` template ref implies it for Cards created
   * before their Template declared it.
   */
  requiresCalendarInvite?: boolean;
  proofRequirement?: ProofRequirement;
  /** Checklist tag split out of the description (e.g. "Podcast page"). */
  tags?: string[];
  artifactRefs?: ArtifactRef[];
  intakeRefs?: IntakeRef[];
  auditEventRefs?: AuditEventRef[];
}

/** Definition-owned Card defaults captured when a Template is applied. */
export interface TemplateCardDefinitionSnapshot {
  eventPolicy?: EventPolicy;
  tags: string[];
  sourceDocIds: string[];
  references: Reference[];
  cardLinkDefinitions: CardLinkDefinition[];
  /**
   * Template task refs the Card has accounted for at its `templateVersion`:
   * instantiated as Tasks, or deliberately left out. A Template update adds
   * a Task only for a ref outside this set.
   */
  taskRefs: string[];
  /** The Template's episode stage Tasks by stage; absent when the Template marks none. */
  episodeStages?: EpisodeStageRefs;
}

/**
 * Definition-owned Task values captured when a Template is applied. Runtime
 * status, evidence, notes, links and history deliberately never live here.
 */
export interface TemplateTaskDefinitionSnapshot {
  description: string;
  date: string;
  templateOffsetDays: number;
  /**
   * Canonical schedule anchor captured when a Template is applied. Only END
   * is stored: an absent anchor and an explicit START anchor both mean the
   * cohort START date, so START-anchored Tasks keep the snapshot shape they
   * have always had.
   */
  templateAnchor?: 'end';
  templateTaskOrder: number;
  isMilestone?: boolean;
  stageOnComplete?: string;
  assigneeId?: string;
  instructionsUrl?: string;
  instructionDocId?: string;
  instructionStepId?: string;
  phase?: string;
  requires?: string[];
  /** Whether this Task needs an interactive browser; absent is not classified. */
  browserRequirement?: BrowserRequirement;
  /** Template refIds this Task depended on; the Task itself stores resolved ids in `dependsOn`. */
  dependsOnRefs?: string[];
  validation?: string | Record<string, unknown>;
  requiredLinkName?: string;
  requiresFile?: boolean;
  /**
   * When true, the Task cannot be marked done until its Card links at least
   * one calendar invite. Webinar/podcast invite Tasks carry this; the
   * `create-calendar-invite` template ref implies it for Cards created
   * before their Template declared it.
   */
  requiresCalendarInvite?: boolean;
  proofRequirement?: ProofRequirement;
  tags?: string[];
  sourceDocIds?: string[];
}

export interface Template {
  eventPolicy?: EventPolicy;
  id: string;
  /** Authored identity and schema revision, separate from runtime id/version. */
  authoredId?: string;
  schemaVersion?: number;
  department?: string;
  businessSystem?: string;
  ownerRole?: string;
  status?: 'draft' | 'proposed' | 'active' | 'review-due' | 'blocked' | 'deprecated' | 'archived';
  criticality?: 'core' | 'supporting' | 'historical';
  outcome?: string;
  tools?: string[];
  reviewCycleDays?: number;
  lastReviewedAt?: string | null;
  nextReviewAt?: string | null;
  externalSourceDocuments?: ExternalSourceDocument[];
  name: string;
  type?: string;
  /** Curated icon name (`templates/templateIcons.ts`) shown wherever the template's cards appear. */
  icon?: string;
  /** Pattern for the title of a Card a planning record links (`cards/cardTitlePattern.ts`). */
  cardTitle?: string;
  tags?: string[];
  phases?: WorkflowPhase[];
  sourceDocIds?: string[];
  references?: Reference[];
  cardLinkDefinitions?: CardLinkDefinition[];
  /** Numbers entered on the Card that drive repeated Tasks. */
  countFields?: CountField[];
  triggerType?: string;
  triggerSchedule?: string;
  triggerLeadDays?: number;
  triggerEnabled?: boolean;
  taskDefinitions?: TaskDefinition[];
  /**
   * Private-repository path, SHA256 content hash, and Git blob SHA1 for this
   * runtime projection. `sourceRevision` is the content hash the knowledge
   * store records (`sha256sum <file>`); it is never the Git blob. `sourceBlobSha`
   * is the Git blob (`git hash-object <file>`, `git rev-parse HEAD:<path>`) so
   * Orin can verify sync against Git without a Developer.
   */
  sourcePath?: string;
  sourceRevision?: string;
  sourceBlobSha?: string;
  /**
   * How the effective definition arrived: Git-seeded (`git`) or created
   * through the Templates API (`custom`). Pre-feature rows lack it until
   * the seed or a template write backfills it.
   */
  origin?: 'git' | 'custom';
  /**
   * True when an operator pinned a whole effective definition over the Git
   * base. The top-level fields always hold the effective definition, so
   * every reader sees a validated whole; `base` preserves the Git
   * projection underneath for reset and drift comparison.
   */
  pinned?: boolean;
  /** Per-lifetime identity token: a stale pair can never authorize a new row. */
  revision?: string;
  /** The Git projection underneath an operator pin (`origin === 'git'`). */
  base?: Record<string, unknown>;
  /** `base.sourceRevision` convenience for pin-drift comparison. */
  baseSourceRevision?: string | null;
  /** `base.sourceBlobSha` convenience for pin-drift comparison. */
  baseSourceBlobSha?: string | null;
  /** Required monotonic optimistic-concurrency token. */
  version: number;
  createdAt: string;
  updatedAt: string;
}

// --- Recurring ---

/** What one firing of a recurring schedule did: work or no work, success or not. */
export type RecurringRunOutcome = 'succeeded' | 'failed';

export interface RecurringConfig {
  id: string;
  description: string;
  cronExpression: string;
  assigneeId?: string;
  instructionsUrl?: string;
  instructionDocId?: string;
  instructionStepId?: string;
  requires?: string[];
  /** Whether this Task needs an interactive browser; absent is not classified. */
  browserRequirement?: BrowserRequirement;
  proofRequirement?: ProofRequirement;
  requiredLinkName?: string;
  requiresFile?: boolean;
  tags?: string[];
  enabled: boolean;
  /** First civil date the schedule matches, recomputed whenever it is written. */
  nextRunDate?: string;
  lastRunAt?: string;
  lastRunOutcome?: RecurringRunOutcome;
  /** Set when a schedule with generated history is deleted; the row stays as its tombstone. */
  deletedAt?: string;
  createdAt: string;
  updatedAt: string;
}

/** One config's one firing, kept so a schedule with history cannot be deleted. */
export interface RecurringRun {
  configId: string;
  date: string;
  outcome: RecurringRunOutcome;
  generatedTaskIds: string[];
  createdAt: string;
}

// --- User ---

export interface User {
  id: string;
  name: string;
  email: string;
  createdAt: string;
  /** Authorization role. `admin` may manage users; `operator` is read-only for user data. */
  role?: UserRole;
  /** When true the account is disabled and cannot log in. */
  disabled?: boolean;
  /**
   * Google profile photo URL from the last SSO sign-in (absent until the person
   * signs in). The URL is unguessable but public; the bytes are never stored.
   */
  picture?: string;
}

export type UserRole = 'admin' | 'operator';

/** What a deleted account leaves behind: a name for the history that cites it. */
export interface FormerUser {
  id: string;
  name: string;
  deletedAt: string;
}

// --- Session ---

export interface Session {
  token: string;
  userId: string;
  createdAt: string;
  /** Present only for bounded browser sessions; legacy bearer sessions remain unbounded. */
  expiresAt?: string;
  /** DynamoDB TTL epoch seconds. */
  ttl?: number;
  sessionType?: 'browser';
}

// --- CLI device authorization and API tokens ---

/**
 * A pending CLI login. The device code is the CLI's secret; the user code is
 * the short string a human confirms in the portal. Both are stored hashed and
 * expire quickly.
 */
export interface DeviceGrant {
  id: string;
  userCodeHash: string;
  status: 'pending' | 'approved' | 'denied';
  /** Set once a signed-in operator approves the grant. */
  userId?: string;
  /** Human-facing description of the machine that started the login. */
  label: string;
  requestIp: string;
  createdAt: string;
  expiresAt: string;
  approvedAt?: string;
  /** Confirmation attempts against this user code, for throttling. */
  attempts: number;
  ttl: number;
}

/** A long-lived bearer credential for non-browser clients. */
export interface ApiToken {
  id: string;
  userId: string;
  label: string;
  createdAt: string;
  expiresAt: string;
  lastUsedAt?: string;
  /** Set when the token was minted by a device-code login. */
  source: 'device' | 'manual';
  ttl: number;
}

// --- Notification ---

export interface Notification {
  id: string;
  message: string;
  type?: NotificationType | string;
  taskId?: string;
  cardId?: string;
  templateId?: string;
  recurringConfigId?: string;
  metadata?: Record<string, unknown>;
  userId?: string;
  dueAt?: string;
  dismissed: boolean;
  createdAt: string;
}

// --- Lambda ---

export interface LambdaEvent {
  httpMethod: string;
  path: string;
  headers?: Record<string, string> | null;
  body?: string | null;
  isBase64Encoded?: boolean;
  queryStringParameters?: Record<string, string> | null;
}

export interface LambdaResponse {
  statusCode: number;
  headers?: Record<string, string>;
  body: string;
  /** Set when `body` is base64-encoded binary (images, gzip, downloads). */
  isBase64Encoded?: boolean;
}
