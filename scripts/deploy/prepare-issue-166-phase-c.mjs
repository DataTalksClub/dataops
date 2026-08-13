#!/usr/bin/env node

import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDirectory, '..', '..');
const templatePath = resolve(process.argv[2] ?? resolve(repoRoot, '.aws-sam', 'build', 'template.yaml'));
const tasksLogicalId = 'DataOpsTasksTable';

function fail(message) {
  throw new Error(`Issue #166 Phase C refused: ${message}`);
}

function stable(value) {
  return JSON.stringify(value);
}

function requireResource(template, logicalId, type) {
  const resource = template?.Resources?.[logicalId];
  if (!resource || resource.Type !== type || !resource.Properties) {
    fail(`${logicalId} must start as a ${type} resource`);
  }
  return resource;
}

function exactKeySchema(value, expected) {
  return stable(value) === stable(expected);
}

const template = yaml.safeLoad(readFileSync(templatePath, 'utf8'));
if (!template || typeof template !== 'object' || Array.isArray(template)) {
  fail('the built SAM template is not a mapping');
}
if (template.Metadata?.DataOpsIssue166Cutover !== undefined) {
  fail('the source artifact already contains an issue #166 cutover marker');
}

const tasks = requireResource(template, tasksLogicalId, 'AWS::DynamoDB::Table');
const properties = tasks.Properties;
const taskNamedTables = Object.entries(template.Resources ?? {}).filter(([, resource]) =>
  resource?.Type === 'AWS::DynamoDB::Table'
    && [stable({ 'Fn::Sub': '${AWS::StackName}-tasks' }), stable('dataops-v1-tasks')]
      .includes(stable(resource?.Properties?.TableName)),
);
if (taskNamedTables.length !== 1 || taskNamedTables[0][0] !== tasksLogicalId) {
  fail('the source artifact must contain exactly one canonical Tasks table and no alternate');
}
if (tasks.DeletionPolicy !== 'Retain' || tasks.UpdateReplacePolicy !== 'Retain') {
  fail('the source Tasks table must retain its steady-state Retain/Retain policies');
}
if (stable(properties.TableName) !== stable({ 'Fn::Sub': '${AWS::StackName}-tasks' })) {
  fail('the source Tasks table must use the canonical fixed stack name');
}
if (properties.BillingMode !== 'PAY_PER_REQUEST'
    || stable(properties.SSESpecification) !== stable({ SSEEnabled: true })
    || stable(properties.PointInTimeRecoverySpecification) !== stable({ PointInTimeRecoveryEnabled: true })) {
  fail('the source Tasks table must have exact billing, encryption, and PITR settings');
}
const expectedTags = [
  { Key: 'Project', Value: 'DataOps' },
  { Key: 'App', Value: 'DataOpsV1' },
  { Key: 'DataClass', Value: 'ExecutionState' },
];
if (stable(properties.Tags) !== stable(expectedTags)) {
  fail('the source Tasks table must have the exact runtime ownership tags');
}
const expectedAttributes = ['PK', 'SK', 'bundleId', 'cardId', 'date', 'status'];
const attributes = (properties.AttributeDefinitions ?? []).map(({ AttributeName }) => AttributeName).sort();
if (stable(attributes) !== stable(expectedAttributes)) {
  fail('the source Tasks table does not have the exact transitional attributes');
}
if (!exactKeySchema(properties.KeySchema, [
  { AttributeName: 'PK', KeyType: 'HASH' },
  { AttributeName: 'SK', KeyType: 'RANGE' },
])) {
  fail('the source Tasks table does not have the exact primary key');
}
const expectedIndexes = new Map([
  ['GSI-Date', [{ AttributeName: 'date', KeyType: 'HASH' }, { AttributeName: 'status', KeyType: 'RANGE' }]],
  ['GSI-Card', [{ AttributeName: 'cardId', KeyType: 'HASH' }, { AttributeName: 'date', KeyType: 'RANGE' }]],
  ['GSI-Bundle', [{ AttributeName: 'bundleId', KeyType: 'HASH' }, { AttributeName: 'date', KeyType: 'RANGE' }]],
  ['GSI-Status', [{ AttributeName: 'status', KeyType: 'HASH' }, { AttributeName: 'date', KeyType: 'RANGE' }]],
]);
for (const index of properties.GlobalSecondaryIndexes ?? []) {
  if (!expectedIndexes.has(index.IndexName)
      || !exactKeySchema(index.KeySchema, expectedIndexes.get(index.IndexName))
      || stable(index.Projection) !== stable({ ProjectionType: 'ALL' })) {
    fail('the source Tasks table does not have the exact transitional indexes');
  }
  expectedIndexes.delete(index.IndexName);
}
if (expectedIndexes.size !== 0) fail('the source Tasks table does not have the exact transitional indexes');

const backend = requireResource(template, 'BackendFunction', 'AWS::Serverless::Function');
const worker = requireResource(template, 'ConversationalExecutionWorkerFunction', 'AWS::Serverless::Function');
for (const [logicalId, writer] of [
  ['BackendFunction', backend],
  ['ConversationalExecutionWorkerFunction', worker],
]) {
  if (writer.Properties.ReservedConcurrentExecutions !== undefined) {
    fail(`${logicalId} must not already declare reserved concurrency`);
  }
  if (!writer.Properties.Events || Object.keys(writer.Properties.Events).length === 0) {
    fail(`${logicalId} event sources must be present before Phase C keeps it quiesced`);
  }
  if (!stable(writer.Properties.Policies).includes(tasksLogicalId)) {
    fail(`${logicalId} must start with its canonical Tasks-table IAM dependency`);
  }
  if (stable(writer.Properties.Policies).includes('dataops-v1-tasks')) {
    fail(`${logicalId} must use the logical Tasks-table IAM dependency, not a literal ARN`);
  }
  writer.Properties.ReservedConcurrentExecutions = 0;
  delete writer.Properties.Events;
}
const workerVariables = worker.Properties.Environment?.Variables;
if (stable(workerVariables?.DATAOPS_TASKS_TABLE) !== stable({ Ref: tasksLogicalId })) {
  fail('the worker must start with the canonical Tasks-table environment dependency');
}
const tasksOutput = template.Outputs?.DataOpsTasksTableName;
if (!tasksOutput || stable(tasksOutput.Value) !== stable({ Ref: tasksLogicalId })) {
  fail('the source artifact must have the canonical Tasks-table output');
}

properties.AttributeDefinitions = properties.AttributeDefinitions.filter(({ AttributeName }) => AttributeName !== 'bundleId');
properties.GlobalSecondaryIndexes = properties.GlobalSecondaryIndexes.filter(({ IndexName }) => IndexName !== 'GSI-Bundle');
template.Metadata = {
  ...(template.Metadata ?? {}),
  DataOpsIssue166Cutover: { Issue: 166, Phase: 'C' },
};

if (stable(template).includes('bundleId') || stable(template).includes('GSI-Bundle')) {
  fail('the prepared artifact retained transitional bundle schema');
}
if (tasks.DeletionPolicy !== 'Retain' || tasks.UpdateReplacePolicy !== 'Retain'
    || stable(workerVariables.DATAOPS_TASKS_TABLE) !== stable({ Ref: tasksLogicalId })
    || stable(tasksOutput.Value) !== stable({ Ref: tasksLogicalId })) {
  fail('the prepared artifact lost ownership, environment, or output dependencies');
}
for (const writer of [backend, worker]) {
  if (writer.Properties.ReservedConcurrentExecutions !== 0 || writer.Properties.Events !== undefined
      || !stable(writer.Properties.Policies).includes(tasksLogicalId)) {
    fail('a Tasks writer was not kept closed with its recreated-table IAM dependency');
  }
}

const temporaryPath = `${templatePath}.issue-166-phase-c.tmp`;
writeFileSync(temporaryPath, yaml.safeDump(template, { lineWidth: 120, noRefs: true }), 'utf8');
renameSync(temporaryPath, templatePath);
console.log('Prepared bounded issue #166 Phase C artifact: empty final Tasks table declared and writers remain quiesced.');
