// --- Task ---

export type TaskStatus = 'todo' | 'waiting' | 'done' | 'archived';
export type ProofRequirementType = 'url' | 'file' | 'artifact' | 'comment' | 'external-status';
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
  bundleId?: string;
  assistantJobId?: string;
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

export interface AssistantJobRef {
  assistantJobId: string;
  assistantType?: string;
  status?: string;
}

export type AssistantJobStatus =
  | 'draft'
  | 'queued'
  | 'running'
  | 'waiting_approval'
  | 'approved'
  | 'rejected'
  | 'retrying'
  | 'succeeded'
  | 'failed'
  | 'canceled';

export type AssistantJobEventAction =
  | 'created'
  | 'queued'
  | 'started'
  | 'log-appended'
  | 'artifact-attached'
  | 'approval-requested'
  | 'approved'
  | 'rejected'
  | 'retry-requested'
  | 'failed'
  | 'canceled'
  | 'succeeded';

export interface AssistantJobInputRef {
  type: 'source-message' | 'file' | 'url' | 'doc' | 'task' | 'bundle' | 'artifact' | 'other' | string;
  id?: string;
  uri?: string;
  title?: string;
  metadata?: Record<string, unknown>;
}

export interface AssistantJobLogRef {
  artifactId?: string;
  storageUri?: string;
  title?: string;
  type?: string;
}

export interface AssistantJobApproval {
  status: 'pending' | 'approved' | 'rejected';
  decidedBy?: string;
  decidedAt?: string;
  reason?: string;
}

export interface AssistantJobError {
  code: string;
  summary: string;
}

export interface AssistantJobRecord {
  id: string;
  assistantType: string;
  title: string;
  status: AssistantJobStatus;
  taskId?: string;
  bundleId?: string;
  requestedBy?: string;
  inputRefs: AssistantJobInputRef[];
  outputArtifactIds: string[];
  logRefs: AssistantJobLogRef[];
  approvalRequired: boolean;
  approval?: AssistantJobApproval;
  attemptCount: number;
  maxAttempts: number;
  retryOfJobId?: string;
  lastError?: AssistantJobError;
  createdAt: string;
  queuedAt?: string;
  startedAt?: string;
  completedAt?: string;
  updatedAt: string;
}

export interface AssistantJobEvent {
  id: string;
  assistantJobId: string;
  actorId?: string;
  action: AssistantJobEventAction;
  summary: string;
  metadata?: Record<string, unknown>;
  createdAt: string;
}

export interface AuditEventRef {
  auditEventId: string;
  action?: string;
  createdAt?: string;
}

export interface Task {
  id: string;
  description: string;
  date: string;
  status: TaskStatus;
  source?: string;
  comment?: string | null;
  waitingFor?: string;
  followUpAt?: string;
  completedBy?: string;
  completedAt?: string;
  proofRequirement?: ProofRequirement;
  externalStatus?: string;
  instructionsUrl?: string;
  instructionDocId?: string;
  instructionStepId?: string;
  phase?: string;
  systems?: string[];
  validation?: string | Record<string, unknown>;
  link?: string;
  requiredLinkName?: string;
  requiresFile?: boolean;
  assigneeId?: string;
  tags?: string[];
  bundleId?: string;
  templateId?: string;
  templateTaskRef?: string;
  stageOnComplete?: string;
  recurringConfigId?: string;
  artifactRefs?: ArtifactRef[];
  assistantJobRefs?: AssistantJobRef[];
  auditEventRefs?: AuditEventRef[];
  createdAt: string;
  updatedAt: string;
}

// --- File ---

export interface FileRecord {
  id: string;
  taskId: string;
  bundleId?: string;
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

// --- Bundle ---

export interface BundleLink {
  name: string;
  url: string;
}

export interface Bundle {
  id: string;
  title?: string;
  description?: string | null;
  anchorDate?: string;
  templateId?: string;
  references?: BundleLink[];
  bundleLinks?: BundleLink[];
  emoji?: string;
  tags?: string[];
  stage?: string;
  status?: string;
  artifactRefs?: ArtifactRef[];
  assistantJobRefs?: AssistantJobRef[];
  auditEventRefs?: AuditEventRef[];
  createdAt: string;
  updatedAt: string;
}

// --- Template ---

export interface Reference {
  name: string;
  url: string;
}

export interface BundleLinkDefinition {
  name: string;
}

export interface TaskDefinition {
  refId: string;
  description: string;
  offsetDays: number;
  isMilestone?: boolean;
  stageOnComplete?: string;
  assigneeId?: string;
  instructionsUrl?: string;
  instructionDocId?: string;
  instructionStepId?: string;
  phase?: string;
  systems?: string[];
  validation?: string | Record<string, unknown>;
  requiredLinkName?: string;
  requiresFile?: boolean;
  proofRequirement?: ProofRequirement;
  artifactRefs?: ArtifactRef[];
  assistantJobRefs?: AssistantJobRef[];
  auditEventRefs?: AuditEventRef[];
}

export interface Template {
  id: string;
  name: string;
  type?: string;
  emoji?: string;
  tags?: string[];
  defaultAssigneeId?: string;
  phases?: WorkflowPhase[];
  sourceDocIds?: string[];
  references?: Reference[];
  bundleLinkDefinitions?: BundleLinkDefinition[];
  triggerType?: string;
  triggerSchedule?: string;
  triggerLeadDays?: number;
  triggerEnabled?: boolean;
  taskDefinitions?: TaskDefinition[];
  createdAt: string;
  updatedAt: string;
}

// --- Recurring ---

export interface RecurringConfig {
  id: string;
  description: string;
  cronExpression: string;
  assigneeId?: string;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

// --- User ---

export interface User {
  id: string;
  name: string;
  email: string;
  createdAt: string;
  passwordHash?: string;
}

// --- Session ---

export interface Session {
  token: string;
  userId: string;
  createdAt: string;
}

// --- Notification ---

export interface Notification {
  id: string;
  message: string;
  type?: NotificationType | string;
  taskId?: string;
  bundleId?: string;
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
}
