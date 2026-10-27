/**
 * Resolve a table name. Infrastructure passes each table's name explicitly;
 * DATAOPS_TABLE_PREFIX is the shared prefix those names are built from, so a
 * second environment can run the same code against its own tables.
 *
 * With neither set, names default to the live `dataops-v1-` tables. There are
 * no bare-name fallbacks: the old unprefixed tables no longer exist.
 *
 * This module is intentionally limited to names. Table definitions and all
 * create/delete operations belong to explicit local tooling under scripts/.
 */
function tableName(envName: string, suffix: string): string {
  const explicitName = process.env[envName];
  if (explicitName) return explicitName;

  const prefix = process.env.DATAOPS_TABLE_PREFIX || 'dataops-v1';
  return `${prefix}-${suffix}`;
}

const TABLE_TASKS = tableName('DATAOPS_TASKS_TABLE', 'tasks');
const TABLE_CARDS = tableName('DATAOPS_CARDS_TABLE', 'cards');
const TABLE_TEMPLATES = tableName('DATAOPS_TEMPLATES_TABLE', 'templates');
const TABLE_USERS = tableName('DATAOPS_USERS_TABLE', 'users');
const TABLE_FILES = tableName('DATAOPS_FILES_TABLE', 'files');
const TABLE_ARTIFACTS = tableName('DATAOPS_ARTIFACTS_TABLE', 'artifacts');
const TABLE_AUDIT_EVENTS = tableName('DATAOPS_AUDIT_EVENTS_TABLE', 'audit-events');
const TABLE_INTAKE = tableName('DATAOPS_INTAKE_TABLE', 'intake');
const TABLE_NOTIFICATIONS = tableName('DATAOPS_NOTIFICATIONS_TABLE', 'notifications');
const TABLE_SESSIONS = tableName('DATAOPS_SESSIONS_TABLE', 'sessions');
const TABLE_BOOKKEEPING = tableName('DATAOPS_BOOKKEEPING_TABLE', 'bookkeeping');
const TABLE_SPONSOR_CRM = tableName('DATAOPS_SPONSOR_CRM_TABLE', 'sponsor-crm');
const TABLE_NEWSLETTER_SLOTS = tableName('DATAOPS_NEWSLETTER_SLOTS_TABLE', 'newsletter-slots');
const TABLE_CALENDAR = tableName('DATAOPS_CALENDAR_TABLE', 'calendar');
const TABLE_PODCAST_EPISODES = tableName('DATAOPS_PODCAST_EPISODES_TABLE', 'podcast-episodes');
const TABLE_SECRETS = tableName('DATAOPS_SECRETS_TABLE', 'secrets');
const TABLE_PEOPLE = tableName('DATAOPS_PEOPLE_TABLE', 'people');
const TABLE_BOOKS = tableName('DATAOPS_BOOKS_TABLE', 'books');

const DATAOPS_TABLES = Object.freeze([
  TABLE_TASKS,
  TABLE_CARDS,
  TABLE_TEMPLATES,
  TABLE_USERS,
  TABLE_FILES,
  TABLE_ARTIFACTS,
  TABLE_AUDIT_EVENTS,
  TABLE_INTAKE,
  TABLE_NOTIFICATIONS,
  TABLE_SESSIONS,
  TABLE_BOOKKEEPING,
  TABLE_SPONSOR_CRM,
  TABLE_NEWSLETTER_SLOTS,
  TABLE_CALENDAR,
  TABLE_PODCAST_EPISODES,
  TABLE_SECRETS,
  TABLE_PEOPLE,
  TABLE_BOOKS,
]);

export {
  TABLE_TASKS,
  TABLE_CARDS,
  TABLE_TEMPLATES,
  TABLE_USERS,
  TABLE_FILES,
  TABLE_ARTIFACTS,
  TABLE_AUDIT_EVENTS,
  TABLE_INTAKE,
  TABLE_NOTIFICATIONS,
  TABLE_SESSIONS,
  TABLE_BOOKKEEPING,
  TABLE_SPONSOR_CRM,
  TABLE_NEWSLETTER_SLOTS,
  TABLE_CALENDAR,
  TABLE_PODCAST_EPISODES,
  TABLE_SECRETS,
  TABLE_PEOPLE,
  TABLE_BOOKS,
  DATAOPS_TABLES,
};
