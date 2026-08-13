#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { resolve, sep } from 'node:path';

const sourcePath = resolve(process.argv[2] ?? '.tmp/issue-166-phase-d-readiness/source-template.json');
const backendRoot = resolve(process.argv[3] ?? '.aws-sam/build/BackendFunction');
const workerRoot = resolve(process.argv[4] ?? '.aws-sam/build/ConversationalExecutionWorkerFunction');
const expectedCommit = process.argv[5] ?? '';
const tasksLogicalId = 'DataOpsTasksTable';

function fail(message) {
  throw new Error(`Issue #166 Phase D refused: ${message}`);
}

function stable(value) {
  return JSON.stringify(value);
}

function requireResource(template, logicalId, type) {
  const resource = template?.Resources?.[logicalId];
  if (!resource || resource.Type !== type || !resource.Properties) {
    fail(`${logicalId} must be a ${type} resource`);
  }
  return resource;
}

function exactKeys(value, expected) {
  return stable(Object.keys(value ?? {}).sort()) === stable([...expected].sort());
}

function requireArtifactRoot(root, logicalId) {
  if (!existsSync(root) || !statSync(root).isDirectory()) {
    fail(`${logicalId} built artifact directory is missing`);
  }
  return root;
}

function readArtifact(root, relativePath) {
  const path = resolve(root, relativePath);
  if (!path.startsWith(`${root}${sep}`) || !existsSync(path) || !statSync(path).isFile()) {
    fail(`built artifact is missing ${relativePath}`);
  }
  return readFileSync(path, 'utf8');
}

function requireSemantics(content, label, patterns) {
  for (const pattern of patterns) {
    if (!pattern.test(content)) fail(`${label} is missing canonical behavior: ${pattern.source}`);
  }
}

if (!existsSync(sourcePath) || !statSync(sourcePath).isFile()) {
  fail('the SHA-bound source-template input is missing');
}
if (!/^[0-9a-f]{40}$/.test(expectedCommit)) {
  fail('the expected commit must be an exact 40-character SHA');
}
let envelope;
try {
  envelope = JSON.parse(readFileSync(sourcePath, 'utf8'));
} catch {
  fail('the SHA-bound source-template input must be valid JSON');
}
if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)
    || envelope.schemaVersion !== 1 || envelope.commitSha !== expectedCommit
    || !/^[0-9a-f]{64}$/.test(envelope.templateSha256 ?? '')) {
  fail('the source-template input must have the exact schema and dispatched commit SHA');
}
const template = envelope.template;
if (!template || typeof template !== 'object' || Array.isArray(template)) {
  fail('the source SAM template is not a mapping');
}
if (createHash('sha256').update(JSON.stringify(template)).digest('hex') !== envelope.templateSha256) {
  fail('the source-template input digest does not match its exact semantic payload');
}
if (template.Metadata?.DataOpsIssue166Cutover !== undefined) {
  fail('the final artifact must not retain an issue #166 cutover marker');
}

const tasks = requireResource(template, tasksLogicalId, 'AWS::DynamoDB::Table');
const properties = tasks.Properties;
const taskNamedTables = Object.entries(template.Resources ?? {}).filter(([, resource]) =>
  resource?.Type === 'AWS::DynamoDB::Table'
    && [stable({ 'Fn::Sub': '${AWS::StackName}-tasks' }), stable('dataops-v1-tasks')]
      .includes(stable(resource?.Properties?.TableName)),
);
if (taskNamedTables.length !== 1 || taskNamedTables[0][0] !== tasksLogicalId) {
  fail('the artifact must contain exactly one canonical Tasks table and no alternate');
}
if (tasks.DeletionPolicy !== 'Retain' || tasks.UpdateReplacePolicy !== 'Retain') {
  fail('the final Tasks table must retain its Retain/Retain ownership policies');
}
if (stable(properties.TableName) !== stable({ 'Fn::Sub': '${AWS::StackName}-tasks' })) {
  fail('the final Tasks table must use the canonical fixed stack name');
}
if (properties.BillingMode !== 'PAY_PER_REQUEST'
    || stable(properties.SSESpecification) !== stable({ SSEEnabled: true })
    || stable(properties.PointInTimeRecoverySpecification) !== stable({ PointInTimeRecoveryEnabled: true })) {
  fail('the final Tasks table must retain exact billing, encryption, and PITR settings');
}
if (stable(properties.Tags) !== stable([
  { Key: 'Project', Value: 'DataOps' },
  { Key: 'App', Value: 'DataOpsV1' },
  { Key: 'DataClass', Value: 'ExecutionState' },
])) {
  fail('the final Tasks table must retain the exact runtime ownership tags');
}
if (stable((properties.AttributeDefinitions ?? []).map(({ AttributeName }) => AttributeName).sort())
    !== stable(['PK', 'SK', 'cardId', 'date', 'status'])) {
  fail('the final Tasks table must contain only the canonical attributes');
}
if (stable(properties.KeySchema) !== stable([
  { AttributeName: 'PK', KeyType: 'HASH' },
  { AttributeName: 'SK', KeyType: 'RANGE' },
])) {
  fail('the final Tasks table must retain the canonical primary key');
}
const expectedIndexes = new Map([
  ['GSI-Date', [{ AttributeName: 'date', KeyType: 'HASH' }, { AttributeName: 'status', KeyType: 'RANGE' }]],
  ['GSI-Card', [{ AttributeName: 'cardId', KeyType: 'HASH' }, { AttributeName: 'date', KeyType: 'RANGE' }]],
  ['GSI-Status', [{ AttributeName: 'status', KeyType: 'HASH' }, { AttributeName: 'date', KeyType: 'RANGE' }]],
]);
for (const index of properties.GlobalSecondaryIndexes ?? []) {
  if (!expectedIndexes.has(index.IndexName)
      || stable(index.KeySchema) !== stable(expectedIndexes.get(index.IndexName))
      || stable(index.Projection) !== stable({ ProjectionType: 'ALL' })) {
    fail('the final Tasks table must contain only the three canonical GSIs');
  }
  expectedIndexes.delete(index.IndexName);
}
if (expectedIndexes.size !== 0 || stable(template).includes('bundleId') || stable(template).includes('GSI-Bundle')) {
  fail('the final Tasks table retained transitional bundle schema');
}

const backend = requireResource(template, 'BackendFunction', 'AWS::Serverless::Function');
const worker = requireResource(template, 'ConversationalExecutionWorkerFunction', 'AWS::Serverless::Function');
if (backend.Properties.CodeUri !== 'sam-build' || worker.Properties.CodeUri !== 'sam-build') {
  fail('canonical writers must use the reviewed shared SAM build source');
}
if (backend.Properties.ReservedConcurrentExecutions !== undefined
    || worker.Properties.ReservedConcurrentExecutions !== undefined) {
  fail('canonical writers must be reopened without reserved-concurrency cutover guards');
}
if (!exactKeys(backend.Properties.Events, ['DailyBackendCron', 'DailyBackendExport', 'DailyMailingExport'])
    || !exactKeys(worker.Properties.Events, ['QueuedAttemptStream', 'ExecutionRecovery', 'ExecutionHealthPulse'])) {
  fail('canonical writer event sources must be restored exactly');
}
for (const [logicalId, writer] of [
  ['BackendFunction', backend],
  ['ConversationalExecutionWorkerFunction', worker],
]) {
  if (!stable(writer.Properties.Policies).includes(tasksLogicalId)
      || stable(writer.Properties.Policies).includes('dataops-v1-tasks')) {
    fail(`${logicalId} must use the canonical logical Tasks-table IAM dependency`);
  }
}
if (stable(worker.Properties.Environment?.Variables?.DATAOPS_TASKS_TABLE) !== stable({ Ref: tasksLogicalId })
    || stable(template.Outputs?.DataOpsTasksTableName?.Value) !== stable({ Ref: tasksLogicalId })) {
  fail('the final artifact must restore canonical Tasks environment and output references');
}

requireArtifactRoot(backendRoot, 'BackendFunction');
requireArtifactRoot(workerRoot, 'ConversationalExecutionWorkerFunction');
const backendBundle = readArtifact(backendRoot, 'dist/handler.js');
const workerBundle = readArtifact(workerRoot, 'dist/execution-worker-handler.js');
const workspace = readArtifact(backendRoot, 'dist/frontend/src/core/workspace.js');
const taskActions = readArtifact(backendRoot, 'dist/frontend/src/surfaces/work-detail/task-actions.js');

requireSemantics(backendBundle, 'backend bundle', [
  /TaskVersionConflictError/,
  /CardVersionConflictError/,
  /canonical versioned shape/,
  /canonical lifecycle shape/,
  /attribute_exists\(PK\) AND #version = :expectedVersion/,
  /taskHistory/,
  /TransactWriteCommand/,
  /card-completed/,
  /card-reactivated/,
  /task_version_conflict/,
  /card_version_conflict/,
  /card_lifecycle_conflict/,
  /openTaskCount/,
]);
requireSemantics(workerBundle, 'execution worker bundle', [/version:\s*1/, /taskHistory:\s*\[\]/]);
requireSemantics(workspace, 'workspace frontend', [
  /card\.status\s*===\s*["']archived["']\s*&&\s*card\.stage\s*===\s*["']done["']/,
]);
requireSemantics(taskActions, 'task action frontend', [
  /expectedVersion/,
  /task_version_conflict/,
  /card_lifecycle_conflict/,
]);

console.log('Verified issue #166 Phase D readiness: final schema and accepted canonical writer behavior are packaged.');
