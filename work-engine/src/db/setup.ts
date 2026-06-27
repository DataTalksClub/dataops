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
const TABLE_NOTIFICATIONS = tableName('DATAOPS_NOTIFICATIONS_TABLE', 'Notifications');
const TABLE_SESSIONS = tableName('DATAOPS_SESSIONS_TABLE', 'Sessions');

/**
 * Create all application tables (Tasks, Bundles, Templates) with GSIs.
 * Idempotent — silently ignores ResourceInUseException if a table already exists.
 */
async function createTables(client: DynamoDBDocumentClient): Promise<void> {
  const tableDefinitions = [
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
    TABLE_NOTIFICATIONS,
    TABLE_SESSIONS,
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
  TABLE_NOTIFICATIONS,
  TABLE_SESSIONS,
};
