import {
  CreateTableCommand,
  DeleteTableCommand,
} from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

/**
 * Resolve a table name. Infrastructure passes each table's name explicitly;
 * DATAOPS_TABLE_PREFIX is the shared prefix those names are built from, so a
 * second environment can run the same code against its own tables.
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
  'conversational-state'
);

/**
 * Create all application tables (Tasks, Cards, Templates) with GSIs.
 * Idempotent — silently ignores ResourceInUseException if a table already exists.
 */
async function createTables(client: DynamoDBDocumentClient): Promise<void> {
  const tableDefinitions = [
    {
      TableName: TABLE_CONVERSATIONAL_STATE,
      KeySchema: [
        { AttributeName: 'PK', KeyType: 'HASH' as const },
        { AttributeName: 'SK', KeyType: 'RANGE' as const },
      ],
      AttributeDefinitions: [
        { AttributeName: 'PK', AttributeType: 'S' as const },
        { AttributeName: 'SK', AttributeType: 'S' as const },
        { AttributeName: 'GSI1PK', AttributeType: 'S' as const },
        { AttributeName: 'GSI1SK', AttributeType: 'S' as const },
        { AttributeName: 'GSI2PK', AttributeType: 'S' as const },
        { AttributeName: 'GSI2SK', AttributeType: 'S' as const },
      ],
      GlobalSecondaryIndexes: [
        {
          IndexName: 'GSI1',
          KeySchema: [
            { AttributeName: 'GSI1PK', KeyType: 'HASH' as const },
            { AttributeName: 'GSI1SK', KeyType: 'RANGE' as const },
          ],
          Projection: { ProjectionType: 'ALL' as const },
        },
        {
          IndexName: 'GSI2',
          KeySchema: [
            { AttributeName: 'GSI2PK', KeyType: 'HASH' as const },
            { AttributeName: 'GSI2SK', KeyType: 'RANGE' as const },
          ],
          Projection: { ProjectionType: 'ALL' as const },
        },
      ],
      BillingMode: 'PAY_PER_REQUEST' as const,
    },
    {TableName:TABLE_CALENDAR,KeySchema:[{AttributeName:'PK',KeyType:'HASH' as const},{AttributeName:'SK',KeyType:'RANGE' as const}],AttributeDefinitions:[{AttributeName:'PK',AttributeType:'S' as const},{AttributeName:'SK',AttributeType:'S' as const},{AttributeName:'rangeMonth',AttributeType:'S' as const},{AttributeName:'rangeStart',AttributeType:'S' as const}],GlobalSecondaryIndexes:[{IndexName:'GSI-Range',KeySchema:[{AttributeName:'rangeMonth',KeyType:'HASH' as const},{AttributeName:'rangeStart',KeyType:'RANGE' as const}],Projection:{ProjectionType:'ALL' as const}}],BillingMode:'PAY_PER_REQUEST' as const},
    {TableName:TABLE_NEWSLETTER_SLOTS,KeySchema:[{AttributeName:'PK',KeyType:'HASH' as const},{AttributeName:'SK',KeyType:'RANGE' as const}],AttributeDefinitions:[{AttributeName:'PK',AttributeType:'S' as const},{AttributeName:'SK',AttributeType:'S' as const},{AttributeName:'rangeKey',AttributeType:'S' as const},{AttributeName:'publicationKey',AttributeType:'S' as const}],GlobalSecondaryIndexes:[{IndexName:'GSI-Date',KeySchema:[{AttributeName:'rangeKey',KeyType:'HASH' as const},{AttributeName:'publicationKey',KeyType:'RANGE' as const}],Projection:{ProjectionType:'ALL' as const}}],BillingMode:'PAY_PER_REQUEST' as const},
    {
      TableName: TABLE_SPONSOR_CRM,
      KeySchema: [{ AttributeName: 'PK', KeyType: 'HASH' as const }, { AttributeName: 'SK', KeyType: 'RANGE' as const }],
      AttributeDefinitions: [
        { AttributeName: 'PK', AttributeType: 'S' as const },
        { AttributeName: 'SK', AttributeType: 'S' as const },
        { AttributeName: 'GSI1PK', AttributeType: 'S' as const },
        { AttributeName: 'GSI1SK', AttributeType: 'S' as const },
        { AttributeName: 'GSI2PK', AttributeType: 'S' as const },
        { AttributeName: 'GSI2SK', AttributeType: 'S' as const },
        { AttributeName: 'GSI3PK', AttributeType: 'S' as const },
        { AttributeName: 'GSI3SK', AttributeType: 'S' as const },
        { AttributeName: 'GSI4PK', AttributeType: 'S' as const },
        { AttributeName: 'GSI4SK', AttributeType: 'S' as const },
      ],
      GlobalSecondaryIndexes: [
        { IndexName: 'GSI-Communication', KeySchema: [{ AttributeName: 'GSI1PK', KeyType: 'HASH' as const }, { AttributeName: 'GSI1SK', KeyType: 'RANGE' as const }], Projection: { ProjectionType: 'ALL' as const } },
        { IndexName: 'GSI-SponsorSendDue', KeySchema: [{ AttributeName: 'GSI2PK', KeyType: 'HASH' as const }, { AttributeName: 'GSI2SK', KeyType: 'RANGE' as const }], Projection: { ProjectionType: 'ALL' as const } },
        { IndexName: 'GSI-SponsorSendLookup', KeySchema: [{ AttributeName: 'GSI3PK', KeyType: 'HASH' as const }, { AttributeName: 'GSI3SK', KeyType: 'RANGE' as const }], Projection: { ProjectionType: 'ALL' as const } },
        { IndexName: 'GSI-SponsorBookingCommunication', KeySchema: [{ AttributeName: 'GSI4PK', KeyType: 'HASH' as const }, { AttributeName: 'GSI4SK', KeyType: 'RANGE' as const }], Projection: { ProjectionType: 'ALL' as const } },
      ],
      BillingMode: 'PAY_PER_REQUEST' as const,
    },
    {
      TableName: TABLE_BOOKKEEPING,
      KeySchema: [{ AttributeName: 'PK', KeyType: 'HASH' as const }, { AttributeName: 'SK', KeyType: 'RANGE' as const }],
      AttributeDefinitions: [{ AttributeName: 'PK', AttributeType: 'S' as const }, { AttributeName: 'SK', AttributeType: 'S' as const }],
      BillingMode: 'PAY_PER_REQUEST' as const,
    },
    {
      TableName: TABLE_TASKS,
      KeySchema: [
        { AttributeName: 'PK', KeyType: 'HASH' as const },
        { AttributeName: 'SK', KeyType: 'RANGE' as const },
      ],
      AttributeDefinitions: [
        { AttributeName: 'PK', AttributeType: 'S' as const },
        { AttributeName: 'SK', AttributeType: 'S' as const },
        { AttributeName: 'date', AttributeType: 'S' as const },
        { AttributeName: 'status', AttributeType: 'S' as const },
        { AttributeName: 'cardId', AttributeType: 'S' as const },
      ],
      GlobalSecondaryIndexes: [
        {
          IndexName: 'GSI-Date',
          KeySchema: [
            { AttributeName: 'date', KeyType: 'HASH' as const },
            { AttributeName: 'status', KeyType: 'RANGE' as const },
          ],
          Projection: { ProjectionType: 'ALL' as const },
        },
        {
          IndexName: 'GSI-Card',
          KeySchema: [
            { AttributeName: 'cardId', KeyType: 'HASH' as const },
            { AttributeName: 'date', KeyType: 'RANGE' as const },
          ],
          Projection: { ProjectionType: 'ALL' as const },
        },
        {
          IndexName: 'GSI-Status',
          KeySchema: [
            { AttributeName: 'status', KeyType: 'HASH' as const },
            { AttributeName: 'date', KeyType: 'RANGE' as const },
          ],
          Projection: { ProjectionType: 'ALL' as const },
        },
      ],
      BillingMode: 'PAY_PER_REQUEST' as const,
    },
    {
      TableName: TABLE_CARDS,
      KeySchema: [
        { AttributeName: 'PK', KeyType: 'HASH' as const },
        { AttributeName: 'SK', KeyType: 'RANGE' as const },
      ],
      AttributeDefinitions: [
        { AttributeName: 'PK', AttributeType: 'S' as const },
        { AttributeName: 'SK', AttributeType: 'S' as const },
      ],
      BillingMode: 'PAY_PER_REQUEST' as const,
    },
    {
      TableName: TABLE_TEMPLATES,
      KeySchema: [
        { AttributeName: 'PK', KeyType: 'HASH' as const },
        { AttributeName: 'SK', KeyType: 'RANGE' as const },
      ],
      AttributeDefinitions: [
        { AttributeName: 'PK', AttributeType: 'S' as const },
        { AttributeName: 'SK', AttributeType: 'S' as const },
      ],
      BillingMode: 'PAY_PER_REQUEST' as const,
    },
    {
      TableName: TABLE_USERS,
      KeySchema: [
        { AttributeName: 'PK', KeyType: 'HASH' as const },
        { AttributeName: 'SK', KeyType: 'RANGE' as const },
      ],
      AttributeDefinitions: [
        { AttributeName: 'PK', AttributeType: 'S' as const },
        { AttributeName: 'SK', AttributeType: 'S' as const },
      ],
      BillingMode: 'PAY_PER_REQUEST' as const,
    },
    {
      TableName: TABLE_FILES,
      KeySchema: [
        { AttributeName: 'PK', KeyType: 'HASH' as const },
        { AttributeName: 'SK', KeyType: 'RANGE' as const },
      ],
      AttributeDefinitions: [
        { AttributeName: 'PK', AttributeType: 'S' as const },
        { AttributeName: 'SK', AttributeType: 'S' as const },
        { AttributeName: 'taskId', AttributeType: 'S' as const },
      ],
      GlobalSecondaryIndexes: [
        {
          IndexName: 'GSI-Task',
          KeySchema: [
            { AttributeName: 'taskId', KeyType: 'HASH' as const },
            { AttributeName: 'SK', KeyType: 'RANGE' as const },
          ],
          Projection: { ProjectionType: 'ALL' as const },
        },
      ],
      BillingMode: 'PAY_PER_REQUEST' as const,
    },
    {
      TableName: TABLE_ARTIFACTS,
      KeySchema: [
        { AttributeName: 'PK', KeyType: 'HASH' as const },
        { AttributeName: 'SK', KeyType: 'RANGE' as const },
      ],
      AttributeDefinitions: [
        { AttributeName: 'PK', AttributeType: 'S' as const },
        { AttributeName: 'SK', AttributeType: 'S' as const },
      ],
      BillingMode: 'PAY_PER_REQUEST' as const,
    },
    {
      TableName: TABLE_NOTIFICATIONS,
      KeySchema: [
        { AttributeName: 'PK', KeyType: 'HASH' as const },
        { AttributeName: 'SK', KeyType: 'RANGE' as const },
      ],
      AttributeDefinitions: [
        { AttributeName: 'PK', AttributeType: 'S' as const },
        { AttributeName: 'SK', AttributeType: 'S' as const },
      ],
      BillingMode: 'PAY_PER_REQUEST' as const,
    },
    {
      TableName: TABLE_ASSISTANT_JOBS,
      KeySchema: [
        { AttributeName: 'PK', KeyType: 'HASH' as const },
        { AttributeName: 'SK', KeyType: 'RANGE' as const },
      ],
      AttributeDefinitions: [
        { AttributeName: 'PK', AttributeType: 'S' as const },
        { AttributeName: 'SK', AttributeType: 'S' as const },
      ],
      BillingMode: 'PAY_PER_REQUEST' as const,
    },
    {
      TableName: TABLE_AUDIT_EVENTS,
      KeySchema: [
        { AttributeName: 'PK', KeyType: 'HASH' as const },
        { AttributeName: 'SK', KeyType: 'RANGE' as const },
      ],
      AttributeDefinitions: [
        { AttributeName: 'PK', AttributeType: 'S' as const },
        { AttributeName: 'SK', AttributeType: 'S' as const },
      ],
      BillingMode: 'PAY_PER_REQUEST' as const,
    },
    {
      TableName: TABLE_INTAKE,
      KeySchema: [
        { AttributeName: 'PK', KeyType: 'HASH' as const },
        { AttributeName: 'SK', KeyType: 'RANGE' as const },
      ],
      AttributeDefinitions: [
        { AttributeName: 'PK', AttributeType: 'S' as const },
        { AttributeName: 'SK', AttributeType: 'S' as const },
        { AttributeName: 'status', AttributeType: 'S' as const },
        { AttributeName: 'updatedAt', AttributeType: 'S' as const },
        { AttributeName: 'sourceMessageKey', AttributeType: 'S' as const },
        { AttributeName: 'ownerStatusKey', AttributeType: 'S' as const },
        { AttributeName: 'assigneeStatusKey', AttributeType: 'S' as const },
        { AttributeName: 'assistantStatusKey', AttributeType: 'S' as const },
        { AttributeName: 'followUpAt', AttributeType: 'S' as const },
      ],
      GlobalSecondaryIndexes: [
        {
          IndexName: 'GSI-Status',
          KeySchema: [
            { AttributeName: 'status', KeyType: 'HASH' as const },
            { AttributeName: 'updatedAt', KeyType: 'RANGE' as const },
          ],
          Projection: { ProjectionType: 'ALL' as const },
        },
        {
          IndexName: 'GSI-SourceMessage',
          KeySchema: [
            { AttributeName: 'sourceMessageKey', KeyType: 'HASH' as const },
            { AttributeName: 'SK', KeyType: 'RANGE' as const },
          ],
          Projection: { ProjectionType: 'ALL' as const },
        },
        {
          IndexName: 'GSI-OwnerStatus',
          KeySchema: [
            { AttributeName: 'ownerStatusKey', KeyType: 'HASH' as const },
            { AttributeName: 'updatedAt', KeyType: 'RANGE' as const },
          ],
          Projection: { ProjectionType: 'ALL' as const },
        },
        {
          IndexName: 'GSI-AssigneeStatus',
          KeySchema: [
            { AttributeName: 'assigneeStatusKey', KeyType: 'HASH' as const },
            { AttributeName: 'updatedAt', KeyType: 'RANGE' as const },
          ],
          Projection: { ProjectionType: 'ALL' as const },
        },
        {
          IndexName: 'GSI-AssistantStatus',
          KeySchema: [
            { AttributeName: 'assistantStatusKey', KeyType: 'HASH' as const },
            { AttributeName: 'updatedAt', KeyType: 'RANGE' as const },
          ],
          Projection: { ProjectionType: 'ALL' as const },
        },
        {
          IndexName: 'GSI-FollowUp',
          KeySchema: [
            { AttributeName: 'followUpAt', KeyType: 'HASH' as const },
            { AttributeName: 'updatedAt', KeyType: 'RANGE' as const },
          ],
          Projection: { ProjectionType: 'ALL' as const },
        },
      ],
      BillingMode: 'PAY_PER_REQUEST' as const,
    },
    {
      TableName: TABLE_SESSIONS,
      KeySchema: [
        { AttributeName: 'PK', KeyType: 'HASH' as const },
        { AttributeName: 'SK', KeyType: 'RANGE' as const },
      ],
      AttributeDefinitions: [
        { AttributeName: 'PK', AttributeType: 'S' as const },
        { AttributeName: 'SK', AttributeType: 'S' as const },
      ],
      BillingMode: 'PAY_PER_REQUEST' as const,
    },
  ];

  // Issued together rather than one at a time: this runs once per test process
  // and in local setup, where sixteen sequential round trips is the slowest
  // part of the fixture. Tables are independent, so ordering buys nothing.
  await Promise.all(
    tableDefinitions.map(async (def) => {
      try {
        await client.send(new CreateTableCommand(def));
      } catch (err: unknown) {
        if (err instanceof Error && err.name === 'ResourceInUseException') {
          return;
        }
        throw err;
      }
    }),
  );
}

/**
 * Delete all application tables. Used for test cleanup.
 */
async function deleteTables(client: DynamoDBDocumentClient): Promise<void> {
  const tableNames = [
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
  ];

  for (const tableName of tableNames) {
    try {
      await client.send(new DeleteTableCommand({ TableName: tableName }));
    } catch (err: unknown) {
      if (err instanceof Error && err.name === 'ResourceNotFoundException') {
        continue;
      }
      throw err;
    }
  }
}

export {
  createTables,
  deleteTables,
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
