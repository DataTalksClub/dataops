#!/usr/bin/env node

import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDirectory, '..', '..');
const defaultTemplate = resolve(repoRoot, '.aws-sam', 'build', 'template.yaml');
const templatePath = resolve(process.argv[2] ?? defaultTemplate);

function fail(message) {
  throw new Error(`Issue #166 Phase A refused: ${message}`);
}

function requireResource(template, logicalId, type) {
  const resource = template?.Resources?.[logicalId];
  if (!resource || resource.Type !== type || !resource.Properties) {
    fail(`${logicalId} must remain a ${type} resource`);
  }
  return resource;
}

function stable(value) {
  return JSON.stringify(value);
}

const source = readFileSync(templatePath, 'utf8');
const template = yaml.safeLoad(source);
if (!template || typeof template !== 'object' || Array.isArray(template)) {
  fail('the built SAM template is not a mapping');
}
if (template.Metadata?.DataOpsIssue166Cutover !== undefined) {
  fail('the artifact already contains an issue #166 cutover marker');
}

const tasks = requireResource(template, 'DataOpsTasksTable', 'AWS::DynamoDB::Table');
if (tasks.DeletionPolicy !== 'Retain' || tasks.UpdateReplacePolicy !== 'Retain') {
  fail('DataOpsTasksTable must start with Retain/Retain policies');
}
const tasksProperties = stable(tasks.Properties);

const writers = [
  requireResource(template, 'BackendFunction', 'AWS::Serverless::Function'),
  requireResource(template, 'ConversationalExecutionWorkerFunction', 'AWS::Serverless::Function'),
];
for (const writer of writers) {
  if (writer.Properties.ReservedConcurrentExecutions !== undefined) {
    fail('Task writer must not already declare reserved concurrency');
  }
  if (!writer.Properties.Events || Object.keys(writer.Properties.Events).length === 0) {
    fail('Task writer event sources must be present before Phase A removes them');
  }
}

tasks.DeletionPolicy = 'Delete';
tasks.UpdateReplacePolicy = 'Delete';
for (const writer of writers) {
  writer.Properties.ReservedConcurrentExecutions = 0;
  delete writer.Properties.Events;
}
template.Metadata = {
  ...(template.Metadata ?? {}),
  DataOpsIssue166Cutover: { Issue: 166, Phase: 'A' },
};

if (!template.Resources.DataOpsTasksTable || stable(tasks.Properties) !== tasksProperties) {
  fail('the Tasks resource or schema changed while arming Phase A');
}
if (tasks.DeletionPolicy !== 'Delete' || tasks.UpdateReplacePolicy !== 'Delete') {
  fail('the Tasks deletion policies were not armed');
}
for (const writer of writers) {
  if (writer.Properties.ReservedConcurrentExecutions !== 0 || writer.Properties.Events !== undefined) {
    fail('a Task writer was not fully quiesced');
  }
}

const temporaryPath = `${templatePath}.issue-166-phase-a.tmp`;
writeFileSync(temporaryPath, yaml.safeDump(template, { lineWidth: 120, noRefs: true }), 'utf8');
renameSync(temporaryPath, templatePath);
console.log('Prepared bounded issue #166 Phase A artifact: table retained in-stack, writers quiesced, Delete policies armed.');
