#!/usr/bin/env node

import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDirectory, '..', '..');
const defaultTemplate = resolve(repoRoot, '.aws-sam', 'build', 'template.yaml');
const templatePath = resolve(process.argv[2] ?? defaultTemplate);
const tasksLogicalId = 'DataOpsTasksTable';
const tasksTableName = 'dataops-v1-tasks';

function fail(message) {
  throw new Error(`Issue #166 Phase B refused: ${message}`);
}

function requireResource(template, logicalId, type) {
  const resource = template?.Resources?.[logicalId];
  if (!resource || resource.Type !== type || !resource.Properties) {
    fail(`${logicalId} must start as a ${type} resource`);
  }
  return resource;
}

function stable(value) {
  return JSON.stringify(value);
}

function referencesTasks(value) {
  return stable(value).includes(tasksLogicalId);
}

function removeTaskIamDependencies(writer, logicalId) {
  const policies = writer.Properties.Policies;
  if (!Array.isArray(policies)) {
    fail(`${logicalId} must declare inline policies`);
  }

  let removed = 0;
  writer.Properties.Policies = policies.flatMap((policy) => {
    if (!referencesTasks(policy)) return [policy];

    const statement = policy?.Statement;
    if (!statement || statement.Resource === undefined) {
      fail(`${logicalId} contains an unexpected Tasks-table policy dependency`);
    }
    const resources = Array.isArray(statement.Resource)
      ? statement.Resource
      : [statement.Resource];
    const keptResources = resources.filter((resource) => !referencesTasks(resource));
    removed += resources.length - keptResources.length;
    if (keptResources.length === 0) return [];
    statement.Resource = Array.isArray(statement.Resource)
      ? keptResources
      : keptResources[0];
    if (referencesTasks(policy)) {
      fail(`${logicalId} Tasks-table policy dependency was not removed exactly`);
    }
    return [policy];
  });

  if (removed === 0) {
    fail(`${logicalId} must start with a Tasks-table IAM dependency`);
  }
}

const source = readFileSync(templatePath, 'utf8');
const template = yaml.safeLoad(source);
if (!template || typeof template !== 'object' || Array.isArray(template)) {
  fail('the built SAM template is not a mapping');
}
if (template.Metadata?.DataOpsIssue166Cutover !== undefined) {
  fail('the source artifact already contains an issue #166 cutover marker');
}

const tasks = requireResource(template, tasksLogicalId, 'AWS::DynamoDB::Table');
if (tasks.DeletionPolicy !== 'Retain' || tasks.UpdateReplacePolicy !== 'Retain') {
  fail('the source Tasks table must retain its steady-state Retain/Retain policies');
}
if (stable(tasks.Properties.TableName) !== stable({ 'Fn::Sub': '${AWS::StackName}-tasks' })) {
  fail('the source Tasks table must use the canonical fixed stack name');
}
const attributeNames = (tasks.Properties.AttributeDefinitions ?? [])
  .map(({ AttributeName }) => AttributeName)
  .sort();
const indexNames = (tasks.Properties.GlobalSecondaryIndexes ?? [])
  .map(({ IndexName }) => IndexName)
  .sort();
if (stable(attributeNames) !== stable(['PK', 'SK', 'bundleId', 'cardId', 'date', 'status'])) {
  fail('the source Tasks table does not have the exact transitional attributes');
}
if (stable(indexNames) !== stable(['GSI-Bundle', 'GSI-Card', 'GSI-Date', 'GSI-Status'])) {
  fail('the source Tasks table does not have the exact transitional indexes');
}

const backend = requireResource(template, 'BackendFunction', 'AWS::Serverless::Function');
const worker = requireResource(
  template,
  'ConversationalExecutionWorkerFunction',
  'AWS::Serverless::Function',
);
for (const [logicalId, writer] of [
  ['BackendFunction', backend],
  ['ConversationalExecutionWorkerFunction', worker],
]) {
  if (writer.Properties.ReservedConcurrentExecutions !== undefined) {
    fail(`${logicalId} must not already declare reserved concurrency`);
  }
  if (!writer.Properties.Events || Object.keys(writer.Properties.Events).length === 0) {
    fail(`${logicalId} event sources must be present before Phase B keeps it quiesced`);
  }
  removeTaskIamDependencies(writer, logicalId);
  writer.Properties.ReservedConcurrentExecutions = 0;
  delete writer.Properties.Events;
}

const workerVariables = worker.Properties.Environment?.Variables;
if (stable(workerVariables?.DATAOPS_TASKS_TABLE) !== stable({ Ref: tasksLogicalId })) {
  fail('the worker must start with the canonical Tasks-table environment dependency');
}
workerVariables.DATAOPS_TASKS_TABLE = tasksTableName;

const tasksOutput = template.Outputs?.DataOpsTasksTableName;
if (!tasksOutput || stable(tasksOutput.Value) !== stable({ Ref: tasksLogicalId })) {
  fail('the source artifact must have the canonical Tasks-table output');
}
delete template.Outputs.DataOpsTasksTableName;
delete template.Resources[tasksLogicalId];
template.Metadata = {
  ...(template.Metadata ?? {}),
  DataOpsIssue166Cutover: { Issue: 166, Phase: 'B' },
};

if (referencesTasks(template)) {
  fail('the prepared artifact still contains a Tasks-table logical dependency');
}
if (template.Resources[tasksLogicalId] !== undefined || template.Outputs?.DataOpsTasksTableName !== undefined) {
  fail('the Tasks resource or output was not removed');
}
for (const writer of [backend, worker]) {
  if (writer.Properties.ReservedConcurrentExecutions !== 0 || writer.Properties.Events !== undefined) {
    fail('a Task writer was not kept fully quiesced');
  }
}
if (workerVariables.DATAOPS_TASKS_TABLE !== tasksTableName) {
  fail('the worker did not receive the bounded deterministic table name');
}

const temporaryPath = `${templatePath}.issue-166-phase-b.tmp`;
writeFileSync(temporaryPath, yaml.safeDump(template, { lineWidth: 120, noRefs: true }), 'utf8');
renameSync(temporaryPath, templatePath);
console.log('Prepared bounded issue #166 Phase B artifact: old Tasks resource removed and writers remain quiesced.');
