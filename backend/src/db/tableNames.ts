/**
 * Resolve a table name. Infrastructure passes each table's name explicitly;
 * DATAOPS_TABLE_PREFIX is the shared prefix those names are built from, so a
 * second environment can run the same code against its own tables.
 *
 * This module is intentionally limited to names. Table definitions and all
 * create/delete operations belong to explicit local tooling under scripts/.
 */
function tableName(envName: string, fallback: string, suffix: string): string {
  const explicitName = process.env[envName];
  if (explicitName) return explicitName;

  const prefix = process.env.DATAOPS_TABLE_PREFIX;
  return prefix ? `${prefix}-${suffix}` : fallback;
}

const TABLE_TASKS = tableName('DATAOPS_TASKS_TABLE', 'Tasks', 'tasks');
const TABLE_CARDS = tableName('DATAOPS_CARDS_TABLE', 'Projects', 'cards');
const TABLE_TEMPLATES = tableName('DATAOPS_TEMPLATES_TABLE', 'Templates', 'templates');
const TABLE_USERS = tableName('DATAOPS_USERS_TABLE', 'Users', 'users');
const TABLE_FILES = tableName('DATAOPS_FILES_TABLE', 'Files', 'files');
const TABLE_ARTIFACTS = tableName('DATAOPS_ARTIFACTS_TABLE', 'Artifacts', 'artifacts');
const TABLE_ASSISTANT_JOBS = tableName('DATAOPS_ASSISTANT_JOBS_TABLE', 'AssistantJobs', 'assistant-jobs');
const TABLE_AUDIT_EVENTS = tableName('DATAOPS_AUDIT_EVENTS_TABLE', 'AuditEvents', 'audit-events');
const TABLE_INTAKE = tableName('DATAOPS_INTAKE_TABLE', 'IntakeItems', 'intake');
const TABLE_NOTIFICATIONS = tableName('DATAOPS_NOTIFICATIONS_TABLE', 'Notifications', 'notifications');
const TABLE_SESSIONS = tableName('DATAOPS_SESSIONS_TABLE', 'Sessions', 'sessions');
const TABLE_BOOKKEEPING = tableName('DATAOPS_BOOKKEEPING_TABLE', 'Bookkeeping', 'bookkeeping');
const TABLE_SPONSOR_CRM = tableName('DATAOPS_SPONSOR_CRM_TABLE', 'SponsorCrm', 'sponsor-crm');
const TABLE_NEWSLETTER_SLOTS = tableName('DATAOPS_NEWSLETTER_SLOTS_TABLE', 'NewsletterSlots', 'newsletter-slots');
const TABLE_CALENDAR = tableName('DATAOPS_CALENDAR_TABLE', 'Calendar', 'calendar');
const TABLE_CONVERSATIONAL_STATE = tableName(
  'DATAOPS_CONVERSATIONAL_STATE_TABLE',
  'ConversationalState',
  'conversational-state',
);

export {
  TABLE_TASKS,
  TABLE_CARDS,
  TABLE_TEMPLATES,
  TABLE_USERS,
  TABLE_FILES,
  TABLE_ARTIFACTS,
  TABLE_ASSISTANT_JOBS,
  TABLE_AUDIT_EVENTS,
  TABLE_INTAKE,
  TABLE_NOTIFICATIONS,
  TABLE_SESSIONS,
  TABLE_BOOKKEEPING,
  TABLE_SPONSOR_CRM,
  TABLE_NEWSLETTER_SLOTS,
  TABLE_CALENDAR,
  TABLE_CONVERSATIONAL_STATE,
};
