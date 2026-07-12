import {
  CreateTableCommand,
  DeleteTableCommand,
} from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

function tableName(envName: string, fallback: string): string {
  return process.env[envName] || fallback;
}

function shouldAutoCreateTables(): boolean {
  return (
    process.env.DATAOPS_AUTO_CREATE_TABLES === 'true' ||
    process.env.IS_LOCAL === 'true' ||
    process.env.IS_LOCAL === '1' ||
    process.env.NODE_ENV === 'test' ||
    process.env.NODE_ENV === 'local'
  );
}

const TABLE_TASKS = tableName('DATAOPS_TASKS_TABLE', 'Tasks');
const TABLE_BUNDLES = tableName('DATAOPS_BUNDLES_TABLE', 'Projects');
const TABLE_TEMPLATES = tableName('DATAOPS_TEMPLATES_TABLE', 'Templates');
const TABLE_USERS = tableName('DATAOPS_USERS_TABLE', 'Users');
const TABLE_FILES = tableName('DATAOPS_FILES_TABLE', 'Files');
const TABLE_ARTIFACTS = tableName('DATAOPS_ARTIFACTS_TABLE', 'Artifacts');
const TABLE_ASSISTANT_JOBS = tableName('DATAOPS_ASSISTANT_JOBS_TABLE', 'AssistantJobs');
const TABLE_AUDIT_EVENTS = tableName('DATAOPS_AUDIT_EVENTS_TABLE', 'AuditEvents');
const TABLE_INTAKE = tableName('DATAOPS_INTAKE_TABLE', 'IntakeItems');
const TABLE_NOTIFICATIONS = tableName('DATAOPS_NOTIFICATIONS_TABLE', 'Notifications');
const TABLE_SESSIONS = tableName('DATAOPS_SESSIONS_TABLE', 'Sessions');
const TABLE_BOOKKEEPING = tableName('DATAOPS_BOOKKEEPING_TABLE', 'Bookkeeping');
const TABLE_SPONSOR_CRM = tableName('DATAOPS_SPONSOR_CRM_TABLE', 'SponsorCrm');
const TABLE_NEWSLETTER_SLOTS = tableName('DATAOPS_NEWSLETTER_SLOTS_TABLE', 'NewsletterSlots');

/**
 * Create all application tables (Tasks, Bundles, Templates) with GSIs.
 * Idempotent — silently ignores ResourceInUseException if a table already exists.
 */
async function createTables(client: DynamoDBDocumentClient): Promise<void> {
  const tableDefinitions = [
    {TableName:TABLE_NEWSLETTER_SLOTS,KeySchema:[{AttributeName:'PK',KeyType:'HASH' as const},{AttributeName:'SK',KeyType:'RANGE' as const}],AttributeDefinitions:[{AttributeName:'PK',AttributeType:'S' as const},{AttributeName:'SK',AttributeType:'S' as const},{AttributeName:'rangeKey',AttributeType:'S' as const},{AttributeName:'publicationKey',AttributeType:'S' as const}],GlobalSecondaryIndexes:[{IndexName:'GSI-Date',KeySchema:[{AttributeName:'rangeKey',KeyType:'HASH' as const},{AttributeName:'publicationKey',KeyType:'RANGE' as const}],Projection:{ProjectionType:'ALL' as const}}],BillingMode:'PAY_PER_REQUEST' as const},
    {
      TableName: TABLE_SPONSOR_CRM,
      KeySchema: [{ AttributeName: 'PK', KeyType: 'HASH' as const }, { AttributeName: 'SK', KeyType: 'RANGE' as const }],
      AttributeDefinitions: [{ AttributeName: 'PK', AttributeType: 'S' as const }, { AttributeName: 'SK', AttributeType: 'S' as const }],
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
        { AttributeName: 'bundleId', AttributeType: 'S' as const },
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
          IndexName: 'GSI-Bundle',
          KeySchema: [
            { AttributeName: 'bundleId', KeyType: 'HASH' as const },
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
      TableName: TABLE_BUNDLES,
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

  for (const def of tableDefinitions) {
    try {
      await client.send(new CreateTableCommand(def));
    } catch (err: unknown) {
      if (err instanceof Error && err.name === 'ResourceInUseException') {
        continue;
      }
      throw err;
    }
  }
}

/**
 * Delete all application tables. Used for test cleanup.
 */
async function deleteTables(client: DynamoDBDocumentClient): Promise<void> {
  const tableNames = [
    TABLE_TASKS,
    TABLE_BUNDLES,
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
  shouldAutoCreateTables,
  TABLE_TASKS,
  TABLE_BUNDLES,
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
};
