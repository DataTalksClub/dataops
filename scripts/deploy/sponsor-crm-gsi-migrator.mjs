#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  CONTRACT,
  STAGES,
  assertSamePrefix,
  buildStageTemplate,
  canonicalJson,
  classifyChangeSetCreation,
  classifyStackExecution,
  digest,
  inspectLivePrefix,
  inspectLiveTransitionPrefix,
  inspectProcessedPrefix,
  isResumableLiveTransition,
  parseTemplate,
  safeEvidence,
  sponsorTable,
  stageIdentity,
  validateCallerIdentity,
  validateChangeSetArn,
  validateStack,
  validateStageChangeSet,
  validateTargetTemplate,
} from "./sponsor-crm-gsi-core.mjs";

const POLL_MS = Number(process.env.SPONSOR_GSI_POLL_MS ?? "15000");
const STACK_TIMEOUT_MS = Number(
  process.env.SPONSOR_GSI_STACK_TIMEOUT_MS ?? String(45 * 60 * 1000),
);
const TABLE_TIMEOUT_MS = Number(
  process.env.SPONSOR_GSI_TABLE_TIMEOUT_MS ?? String(60 * 60 * 1000),
);
const CHANGE_SET_TIMEOUT_MS = Number(
  process.env.SPONSOR_GSI_CHANGE_SET_TIMEOUT_MS ?? String(10 * 60 * 1000),
);
const AWS_CALL_TIMEOUT_MS = Number(
  process.env.SPONSOR_GSI_AWS_CALL_TIMEOUT_MS ?? "30000",
);
const AWS_KILL_GRACE_MS = Number(
  process.env.SPONSOR_GSI_AWS_KILL_GRACE_MS ?? "1000",
);
const MAX_CHANGE_SET_PAGES = 100;
const MAX_AWS_OUTPUT_BYTES = Number(
  process.env.SPONSOR_GSI_AWS_MAX_OUTPUT_BYTES ?? String(32 * 1024 * 1024),
);
const MAX_TEMPLATE_BYTES = 2 * 1024 * 1024;

let cancelled = false;
let activeAwsChild;
const cancellationWaiters = new Set();

function killProcessGroup(child, signal) {
  if (!child?.pid) return;
  try {
    process.kill(-child.pid, signal);
  } catch (error) {
    if (error?.code !== "ESRCH") throw error;
  }
}

function terminateAwsChild(record, reason) {
  if (!record || record.terminationReason) return;
  record.terminationReason = reason;
  killProcessGroup(record.child, "SIGTERM");
  record.killTimer = setTimeout(() => {
    killProcessGroup(record.child, "SIGKILL");
  }, AWS_KILL_GRACE_MS);
  record.killTimer.unref();
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    cancelled = true;
    terminateAwsChild(activeAwsChild, "cancelled");
    for (const resume of cancellationWaiters) resume();
    cancellationWaiters.clear();
  });
}

class SafeFailure extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

function fail(code) {
  throw new SafeFailure(code);
}

async function runChild({
  executable,
  argv,
  timeoutMs,
  maxOutputBytes,
  ignoreCancellation = false,
  environment = process.env,
}) {
  if (cancelled && !ignoreCancellation) fail("cancelled");
  return new Promise((resolve, reject) => {
    const child = spawn(
      executable,
      argv,
      {
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
        env: environment,
      },
    );
    const record = {
      child,
      terminationReason: undefined,
      killTimer: undefined,
    };
    assert.equal(activeAwsChild, undefined, "concurrent AWS subprocess");
    activeAwsChild = record;
    const stdout = [];
    const stderr = [];
    let outputBytes = 0;
    let spawnError;
    const timeout = setTimeout(() => {
      terminateAwsChild(record, "timeout");
    }, timeoutMs);
    timeout.unref();
    const collect = (target) => (chunk) => {
      if (record.terminationReason) return;
      outputBytes += chunk.length;
      if (outputBytes > maxOutputBytes) {
        terminateAwsChild(record, "output-limit");
        return;
      }
      target.push(chunk);
    };
    child.stdout.on("data", collect(stdout));
    child.stderr.on("data", collect(stderr));
    child.on("error", (error) => {
      spawnError = error;
    });
    child.on("close", (status, signal) => {
      clearTimeout(timeout);
      if (record.killTimer) clearTimeout(record.killTimer);
      if (activeAwsChild === record) activeAwsChild = undefined;
      if (spawnError) {
        reject(spawnError);
        return;
      }
      resolve({
        status,
        signal,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
        terminationReason: record.terminationReason,
      });
    });
  });
}

async function runAws(
  { ignoreCancellation = false } = {},
  service,
  operation,
  ...args
) {
  const argv = [
    service,
    operation,
    ...args,
    "--region",
    CONTRACT.region,
    "--no-cli-pager",
    "--cli-connect-timeout",
    "5",
    "--cli-read-timeout",
    "20",
    "--output",
    "json",
  ];
  const result = await runChild({
    executable: "aws",
    argv,
    timeoutMs: AWS_CALL_TIMEOUT_MS,
    maxOutputBytes: MAX_AWS_OUTPUT_BYTES,
    ignoreCancellation,
    environment: {
      ...process.env,
      AWS_PAGER: "",
      AWS_MAX_ATTEMPTS: "1",
      AWS_RETRY_MODE: "standard",
    },
  }).catch(() => {
    fail(`aws-${service}-${operation}`);
  });
  if (result.terminationReason === "cancelled") {
    fail("cancelled");
  }
  if (result.terminationReason === "timeout") {
    fail(`aws-${service}-${operation}-timeout`);
  }
  if (result.terminationReason === "output-limit") {
    fail(`aws-${service}-${operation}-output-limit`);
  }
  if (result.status !== 0) {
    const missing =
      operation === "describe-change-set" &&
      /ChangeSet.*does not exist|does not exist/i.test(result.stderr ?? "");
    if (missing) return undefined;
    fail(`aws-${service}-${operation}`);
  }
  try {
    return result.stdout.trim() ? JSON.parse(result.stdout) : {};
  } catch {
    fail(`aws-${service}-${operation}-json`);
  }
}

async function aws(service, operation, ...args) {
  return runAws({}, service, operation, ...args);
}

async function awsCleanup(service, operation, ...args) {
  return runAws({ ignoreCancellation: true }, service, operation, ...args);
}

async function verifyRuntime({ migration = false } = {}) {
  assert.equal(process.env.GITHUB_REPOSITORY, CONTRACT.repository);
  assert.equal(process.env.GITHUB_REPOSITORY_OWNER, "DataTalksClub");
  assert.equal(process.env.GITHUB_REF, CONTRACT.ref);
  assert.match(process.env.GITHUB_SHA ?? "", /^[0-9a-f]{40}$/);
  assert.match(
    process.env.GITHUB_RUN_ID ?? "",
    /^[1-9][0-9]{0,19}$/,
  );
  assert.match(
    process.env.GITHUB_RUN_ATTEMPT ?? "",
    /^[1-9][0-9]?$/,
  );
  if (migration) {
    if (process.env.GITHUB_EVENT_NAME !== "workflow_dispatch") {
      fail("migration-workflow-dispatch-only");
    }
    if (process.env.GITHUB_ACTOR !== "alexeygrigorev") {
      fail("migration-actor-not-approved");
    }
  } else {
    assert.ok(
      process.env.GITHUB_EVENT_NAME === "push" ||
        process.env.GITHUB_EVENT_NAME === "workflow_dispatch",
    );
  }
  assert.ok(process.env.GITHUB_WORKSPACE);
  assert.equal(process.env.AWS_REGION, CONTRACT.region);
  assert.equal(process.env.AWS_DEFAULT_REGION, CONTRACT.region);
  const caller = await aws("sts", "get-caller-identity");
  validateCallerIdentity(caller);
}

async function describeStack() {
  const response = await aws(
    "cloudformation",
    "describe-stacks",
    "--stack-name",
    CONTRACT.stack,
  );
  assert.equal(response.Stacks?.length, 1);
  return response.Stacks[0];
}

async function validateStackIdentity() {
  const stack = await describeStack();
  validateStack(stack);
  const resource = (await aws(
    "cloudformation",
    "describe-stack-resource",
    "--stack-name",
    CONTRACT.stack,
    "--logical-resource-id",
    CONTRACT.logicalId,
  ))?.StackResourceDetail;
  assert.equal(resource?.LogicalResourceId, CONTRACT.logicalId);
  assert.equal(resource?.ResourceType, "AWS::DynamoDB::Table");
  assert.equal(resource?.PhysicalResourceId, CONTRACT.physicalTable);
  return stack;
}

async function getTemplate(changeSetId, templateStage = "Processed") {
  const args = [
    "--stack-name",
    CONTRACT.stack,
    "--template-stage",
    templateStage,
  ];
  if (changeSetId) args.push("--change-set-name", changeSetId);
  const response = await aws("cloudformation", "get-template", ...args);
  return parseTemplate(response.TemplateBody);
}

async function getProcessedTemplate(changeSetId) {
  return getTemplate(changeSetId, "Processed");
}

async function describeTable() {
  const table = (await aws(
    "dynamodb",
    "describe-table",
    "--table-name",
    CONTRACT.physicalTable,
  )).Table;
  table.ContinuousBackupsDescription = (await aws(
    "dynamodb",
    "describe-continuous-backups",
    "--table-name",
    CONTRACT.physicalTable,
  )).ContinuousBackupsDescription;
  table.TimeToLiveDescription = (await aws(
    "dynamodb",
    "describe-time-to-live",
    "--table-name",
    CONTRACT.physicalTable,
  )).TimeToLiveDescription;
  table.Tags = await listTableTags(table.TableArn);
  return table;
}

function normalizeTags(tags) {
  assert.ok(Array.isArray(tags), "table tags must be an array");
  const result = tags.map((tag) => {
    assert.equal(typeof tag?.Key, "string");
    assert.equal(typeof tag?.Value, "string");
    return { Key: tag.Key, Value: tag.Value };
  }).sort((left, right) => left.Key.localeCompare(right.Key));
  assert.equal(new Set(result.map((tag) => tag.Key)).size, result.length);
  return result;
}

async function listTableTags(resourceArn) {
  assert.equal(
    resourceArn,
    `arn:aws:dynamodb:${CONTRACT.region}:${CONTRACT.account}:table/${CONTRACT.physicalTable}`,
  );
  const tags = [];
  const seen = new Set();
  let token;
  for (let page = 0; page < MAX_CHANGE_SET_PAGES; page += 1) {
    const args = ["--resource-arn", resourceArn];
    if (token) args.push("--next-token", token);
    const response = await aws("dynamodb", "list-tags-of-resource", ...args);
    assert.ok(Array.isArray(response.Tags));
    tags.push(...response.Tags);
    if (!response.NextToken) return normalizeTags(tags);
    assert.equal(typeof response.NextToken, "string");
    assert.ok(response.NextToken.length > 0 && response.NextToken.length <= 4096);
    assert.ok(!seen.has(response.NextToken), "table tag pagination loop");
    seen.add(response.NextToken);
    token = response.NextToken;
  }
  fail("table-tag-pagination-limit");
}

async function changeSet(changeSetId) {
  return aws(
    "cloudformation",
    "describe-change-set",
    "--stack-name",
    CONTRACT.stack,
    "--change-set-name",
    changeSetId,
  );
}

async function listChangeSets() {
  const summaries = [];
  const seenTokens = new Set();
  let token;
  for (let page = 0; page < MAX_CHANGE_SET_PAGES; page += 1) {
    const args = [
      "--stack-name",
      CONTRACT.stack,
      "--max-items",
      "100",
    ];
    if (token) args.push("--starting-token", token);
    const response = await aws("cloudformation", "list-change-sets", ...args);
    assert.ok(Array.isArray(response.Summaries));
    summaries.push(...response.Summaries);
    if (!response.NextToken) return summaries;
    assert.equal(typeof response.NextToken, "string");
    assert.ok(response.NextToken.length > 0 && response.NextToken.length <= 4096);
    assert.ok(!seenTokens.has(response.NextToken), "change-set pagination loop");
    seenTokens.add(response.NextToken);
    token = response.NextToken;
  }
  fail("change-set-pagination-limit");
}

async function assertNoActiveChangeSets() {
  assert.deepEqual(await listChangeSets(), [], "unexpected active change set");
}

async function assertOnlyExpectedActiveChangeSet(expected) {
  const summaries = await listChangeSets();
  assert.equal(summaries.length, 1, "unexpected active change-set count");
  assert.equal(
    summaries[0].ChangeSetId,
    expected.ChangeSetId,
    "unexpected active change-set ID",
  );
  assert.equal(
    summaries[0].ChangeSetName,
    expected.ChangeSetName,
    "unexpected active change-set name",
  );
  assert.equal(
    summaries[0].Status,
    expected.Status,
    "listed change-set status changed",
  );
  assert.equal(
    summaries[0].ExecutionStatus,
    expected.ExecutionStatus,
    "listed change-set execution status changed",
  );
}

async function assertExactChangeSetTemplate(changeSetId, stagedTemplate) {
  const candidateTemplate = await getProcessedTemplate(changeSetId);
  assert.equal(
    digest(candidateTemplate),
    digest(stagedTemplate),
    "change-set processed template mismatch",
  );
}

async function waitForDeletedChangeSet(changeSetId) {
  const deadline = Date.now() + CHANGE_SET_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const current = await changeSet(changeSetId);
    if (!current) return;
    validateChangeSetArn(current);
    assert.equal(
      current.ChangeSetId,
      changeSetId,
      "deleted change-set ID changed",
    );
    if (current.Status === "DELETE_COMPLETE") return;
    await pause();
  }
  fail("change-set-delete-timeout");
}

async function validateStaleStageCandidate(
  candidate,
  identity,
  stagedTemplate,
  stack,
) {
  const parts = candidate.Description?.split("/") ?? [];
  assert.equal(parts.length, 7, "stale change-set description shape changed");
  assert.equal(parts[0], "dataops-sponsor-gsi");
  assert.equal(parts[1], "v3");
  assert.equal(parts[2], String(identity.ordinal));
  assert.equal(parts[3], identity.binding);
  assert.match(parts[4], /^[1-9][0-9]{0,19}:[1-9][0-9]?$/);
  const [runId, attempt] = parts[4].split(":");
  const currentRunId = process.env.GITHUB_RUN_ID;
  const currentAttempt = process.env.GITHUB_RUN_ATTEMPT;
  assert.ok(
    BigInt(runId) < BigInt(currentRunId) ||
      (runId === currentRunId && Number(attempt) < Number(currentAttempt)),
    "stale change set is not from a prior run attempt",
  );
  const attemptDigest = digest({
    binding: identity.binding,
    attemptNonce: parts[4],
  });
  assert.equal(parts[5], attemptDigest, "stale attempt digest changed");
  assert.equal(
    parts[6],
    identity.stagedTemplateDigest,
    "stale staged-template digest changed",
  );
  assert.equal(
    candidate.ChangeSetName,
    `dataops-sponsor-gsi-${identity.ordinal}-${identity.binding.slice(0, 16)}-${attemptDigest.slice(0, 16)}`,
    "stale change-set name changed",
  );
  await assertExactChangeSetTemplate(candidate.ChangeSetId, stagedTemplate);
  validateStageChangeSet(
    candidate,
    {
      ...identity,
      name: candidate.ChangeSetName,
      description: candidate.Description,
    },
    identity.ordinal - 1,
    stack.StackId,
    expectedStageParameters(stack),
  );
  assert.equal(
    candidate.ExecutionStatus,
    "AVAILABLE",
    "prior-run stage candidate was already executed or became ambiguous",
  );
}

async function findOrClearStageCandidate(
  identity,
  stagedTemplate,
  stack,
  processed,
  prefix,
  baselineSnapshot,
) {
  const summaries = await listChangeSets();
  assert.ok(
    summaries.length <= 1,
    "unexpected active change-set count",
  );
  let current;
  for (const summary of summaries) {
    assert.ok(summary.ChangeSetId, "listed change set has no immutable ID");
    const described = await changeSet(summary.ChangeSetId);
    assert.ok(described, "listed change set disappeared");
    assert.equal(
      described.ChangeSetId,
      summary.ChangeSetId,
      "listed change-set ID changed",
    );
    assert.equal(
      described.ChangeSetName,
      summary.ChangeSetName,
      "listed change-set name changed",
    );
    assert.equal(
      described.Status,
      summary.Status,
      "listed change-set status changed",
    );
    assert.equal(
      described.ExecutionStatus,
      summary.ExecutionStatus,
      "listed change-set execution status changed",
    );
    validateChangeSetArn(described);
    if (described.ChangeSetName === identity.name) {
      assert.ok(!current, "duplicate current stage change set");
      current = described;
      continue;
    }
    if (
      described.ChangeSetName?.startsWith(
        `dataops-sponsor-gsi-`,
      )
    ) {
      await validateStaleStageCandidate(
        described,
        identity,
        stagedTemplate,
        stack,
      );
      await assertImmediatePreexecute(
        stack,
        processed,
        prefix,
        baselineSnapshot,
      );
      await assertOnlyExpectedActiveChangeSet(described);
      const pinnedId = described.ChangeSetId;
      const immediate = await changeSet(pinnedId);
      assert.ok(immediate, "stale change set disappeared before deletion");
      assert.equal(
        immediate.ChangeSetId,
        pinnedId,
        "stale change-set ID changed before deletion",
      );
      await validateStaleStageCandidate(
        immediate,
        identity,
        stagedTemplate,
        stack,
      );
      await aws(
        "cloudformation",
        "delete-change-set",
        "--stack-name",
        CONTRACT.stack,
        "--change-set-name",
        pinnedId,
      );
      await waitForDeletedChangeSet(pinnedId);
      continue;
    }
    fail("unexpected-active-change-set");
  }
  if (current) {
    await assertOnlyExpectedActiveChangeSet(current);
    return current;
  }
  await assertNoActiveChangeSets();
  return undefined;
}

async function managedBucket() {
  const response = await aws(
    "cloudformation",
    "describe-stacks",
    "--stack-name",
    "aws-sam-cli-managed-default",
  );
  const stack = response.Stacks?.[0];
  assert.ok(stack);
  const bucket = stack.Outputs?.find(
    (output) => output.OutputKey === "SourceBucket",
  )?.OutputValue;
  assert.match(bucket ?? "", /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/);
  return bucket;
}

function writePrivate(path, value) {
  writeFileSync(path, value, { encoding: "utf8", mode: 0o600 });
  chmodSync(path, 0o600);
}

function previousParameters(stack) {
  return expectedStageParameters(stack).map(({ ParameterKey }) => ({
    ParameterKey,
    UsePreviousValue: true,
  }));
}

function expectedStageParameters(stack) {
  assert.ok(Array.isArray(stack.Parameters), "stack parameters are missing");
  const result = stack.Parameters.map((parameter) => {
    assert.match(parameter?.ParameterKey ?? "", /^[A-Za-z][A-Za-z0-9]*$/);
    assert.equal(typeof parameter?.ParameterValue, "string");
    return {
      ParameterKey: parameter.ParameterKey,
      ParameterValue: parameter.ParameterValue,
      UsePreviousValue: true,
    };
  }).sort((left, right) => left.ParameterKey.localeCompare(right.ParameterKey));
  assert.equal(
    new Set(result.map((parameter) => parameter.ParameterKey)).size,
    result.length,
    "duplicate stack parameter",
  );
  return result;
}

function stableContinuousBackups(description) {
  const stable = structuredClone(description);
  const recovery = stable?.PointInTimeRecoveryDescription;
  if (recovery) {
    delete recovery.EarliestRestorableDateTime;
    delete recovery.LatestRestorableDateTime;
  }
  return stable;
}

function migrationSnapshot(stack, processed, table) {
  const definition = structuredClone(sponsorTable(processed));
  const tags = normalizeTags(table.Tags);
  const tagValues = new Map(tags.map((tag) => [tag.Key, tag.Value]));
  delete definition.Properties.AttributeDefinitions;
  delete definition.Properties.GlobalSecondaryIndexes;
  assert.equal(definition.DeletionPolicy, "Retain");
  assert.equal(definition.UpdateReplacePolicy, "Retain");
  assert.equal(
    table.TableArn,
    `arn:aws:dynamodb:${CONTRACT.region}:${CONTRACT.account}:table/${CONTRACT.physicalTable}`,
  );
  assert.match(table.TableId ?? "", /^[A-Za-z0-9_.-]{8,128}$/);
  assert.deepEqual(
    table.KeySchema,
    [
      { AttributeName: "PK", KeyType: "HASH" },
      { AttributeName: "SK", KeyType: "RANGE" },
    ],
  );
  assert.equal(table.BillingModeSummary?.BillingMode, "PAY_PER_REQUEST");
  assert.equal(table.SSEDescription?.Status, "ENABLED");
  assert.equal(
    table.ContinuousBackupsDescription?.PointInTimeRecoveryDescription
      ?.PointInTimeRecoveryStatus,
    "ENABLED",
  );
  assert.equal(
    tagValues.get("aws:cloudformation:stack-id"),
    stack.StackId,
    "DynamoDB stack-id ownership tag mismatch",
  );
  assert.equal(
    tagValues.get("aws:cloudformation:logical-id"),
    CONTRACT.logicalId,
    "DynamoDB logical-id ownership tag mismatch",
  );
  assert.equal(
    tagValues.get("aws:cloudformation:stack-name"),
    CONTRACT.stack,
    "DynamoDB stack-name ownership tag mismatch",
  );
  return {
    stackId: stack.StackId,
    logicalId: CONTRACT.logicalId,
    physicalId: CONTRACT.physicalTable,
    tableName: table.TableName,
    tableArn: table.TableArn,
    tableId: table.TableId,
    keySchema: table.KeySchema,
    billingModeSummary: table.BillingModeSummary,
    sseDescription: table.SSEDescription,
    continuousBackupsDescription: stableContinuousBackups(
      table.ContinuousBackupsDescription,
    ),
    timeToLiveDescription: table.TimeToLiveDescription,
    streamSpecification: table.StreamSpecification,
    latestStreamArn: table.LatestStreamArn,
    latestStreamLabel: table.LatestStreamLabel,
    tags,
    retainedDefinition: definition,
  };
}

async function assertImmediatePreexecute(
  expectedStack,
  expectedProcessed,
  expectedPrefix,
  baselineSnapshot,
) {
  const stack = await validateStackIdentity();
  assert.equal(stack.StackId, expectedStack.StackId, "stack ID changed");
  assert.equal(stack.StackStatus, expectedStack.StackStatus, "stack status changed");
  const processed = await getProcessedTemplate();
  assert.equal(
    digest(processed),
    digest(expectedProcessed),
    "processed baseline changed before stage execution",
  );
  assert.equal(inspectProcessedPrefix(processed), expectedPrefix);
  const live = await describeTable();
  assert.equal(assertSamePrefix(processed, live), expectedPrefix);
  assert.deepEqual(
    migrationSnapshot(stack, processed, live),
    baselineSnapshot,
    "Sponsor CRM pre-execution identity/configuration changed",
  );
}

async function createStageChangeSet({
  identity,
  template,
  stack,
  directory,
}) {
  const templatePath = join(directory, "stage-template.json");
  const parametersPath = join(directory, "parameters.json");
  writePrivate(templatePath, `${canonicalJson(template)}\n`);
  writePrivate(parametersPath, `${JSON.stringify(previousParameters(stack))}\n`);

  const bucket = await managedBucket();
  const key = `dataops-v1/migrations/sponsor-crm/${identity.identity}.json`;
  const templateUrl = `https://${bucket}.s3.${CONTRACT.region}.amazonaws.com/${key}`;

  try {
    const object = await aws(
      "s3api",
      "put-object",
      "--bucket",
      bucket,
      "--key",
      key,
      "--body",
      templatePath,
    );
    assert.ok(object.ETag);
    const created = await aws(
      "cloudformation",
      "create-change-set",
      "--stack-name",
      CONTRACT.stack,
      "--change-set-name",
      identity.name,
      "--description",
      identity.description,
      "--client-token",
      identity.attemptDigest,
      "--change-set-type",
      "UPDATE",
      "--no-include-nested-stacks",
      "--template-url",
      templateUrl,
      "--parameters",
      `file://${parametersPath}`,
      "--capabilities",
      "CAPABILITY_IAM",
      "CAPABILITY_AUTO_EXPAND",
    );
    assert.equal(created.StackId, stack.StackId);
    validateChangeSetArn({
      ChangeSetId: created.Id,
      ChangeSetName: identity.name,
    });
    return await waitForChangeSet(created.Id);
  } finally {
    await awsCleanup(
      "s3api",
      "delete-object",
      "--bucket",
      bucket,
      "--key",
      key,
    );
  }
}

async function waitForChangeSet(changeSetId) {
  const deadline = Date.now() + CHANGE_SET_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (cancelled) fail("cancelled");
    const current = await changeSet(changeSetId);
    if (current) {
      validateChangeSetArn(current);
      assert.equal(
        current.ChangeSetId,
        changeSetId,
        "created change-set ID changed",
      );
    }
    const classification = classifyChangeSetCreation(current?.Status);
    if (classification === "success") return current;
    if (classification === "failure") fail("change-set-terminal-failure");
    await pause();
  }
  fail("change-set-timeout");
}

async function waitForStackUpdate(changeSetId) {
  const deadline = Date.now() + STACK_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (cancelled) fail("cancelled");
    const describedChangeSet = await changeSet(changeSetId);
    if (describedChangeSet) {
      validateChangeSetArn(describedChangeSet);
      assert.equal(
        describedChangeSet.ChangeSetId,
        changeSetId,
        "executed change-set ID changed",
      );
    }
    const stack = await describeStack();
    const classification = classifyStackExecution(
      describedChangeSet?.ExecutionStatus,
      stack.StackStatus,
    );
    if (classification === "success") return;
    if (classification === "failure") fail("stack-update-terminal-failure");
    await pause();
  }
  fail("stack-update-timeout");
}

async function waitForTable(
  prefix,
  expectedProcessed,
  expectedStack,
  baselineSnapshot,
) {
  const deadline = Date.now() + TABLE_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (cancelled) fail("cancelled");
    const live = await describeTable();
    const processed = await getProcessedTemplate();
    assert.equal(
      digest(processed),
      digest(expectedProcessed),
      "full Processed template changed during table wait",
    );
    assert.equal(inspectProcessedPrefix(processed), prefix);
    assert.equal(inspectLiveTransitionPrefix(live), prefix);
    assert.deepEqual(
      migrationSnapshot(expectedStack, processed, live),
      baselineSnapshot,
      "Sponsor CRM identity/configuration changed during table wait",
    );
    try {
      if (inspectLivePrefix(live) === prefix) return processed;
    } catch {
      // Only the already validated target index may still be creating/backfilling.
    }
    await pause();
  }
  fail("table-index-timeout");
}

function pause() {
  if (cancelled) return Promise.resolve();
  return new Promise((resolve) => {
    const resume = () => {
      clearTimeout(timeout);
      cancellationWaiters.delete(resume);
      resolve();
    };
    const timeout = setTimeout(resume, POLL_MS);
    cancellationWaiters.add(resume);
  });
}

function validateSourceAndBuild(sourcePath, buildPath) {
  const sourceBody = readFileSync(sourcePath, "utf8");
  const buildBody = readFileSync(buildPath, "utf8");
  assert.ok(
    Buffer.byteLength(sourceBody) <= MAX_TEMPLATE_BYTES &&
      Buffer.byteLength(buildBody) <= MAX_TEMPLATE_BYTES,
    "migration template exceeds size bound",
  );
  const sourceTemplate = parseTemplate(sourceBody);
  const buildTemplate = parseTemplate(buildBody);
  const source = validateTargetTemplate(sourceTemplate);
  const build = validateTargetTemplate(buildTemplate);
  assert.equal(
    source.targetDigest,
    build.targetDigest,
    "source/build Sponsor CRM targets disagree",
  );
  return {
    targetDigest: source.targetDigest,
    sourceTemplate,
    buildTemplate,
    sourceDigest: digest(sourceTemplate),
    buildDigest: digest(buildTemplate),
  };
}

async function migrate(sourcePath, buildPath) {
  await verifyRuntime({ migration: true });
  const { targetDigest } = validateSourceAndBuild(sourcePath, buildPath);
  let stack = await validateStackIdentity();
  let processed = await getProcessedTemplate();
  let prefix = inspectProcessedPrefix(processed);
  let live = await describeTable();
  const initialProcessed = structuredClone(processed);
  const initialPrefix = prefix;
  const baselineSnapshot = migrationSnapshot(stack, processed, live);
  try {
    assert.equal(inspectLivePrefix(live), prefix);
  } catch {
    assert.ok(
      isResumableLiveTransition(live, prefix),
      "live table is not an exact resumable transition",
    );
    processed = await waitForTable(
      prefix,
      initialProcessed,
      stack,
      baselineSnapshot,
    );
    stack = await validateStackIdentity();
    live = await describeTable();
    assert.equal(assertSamePrefix(processed, live), prefix);
    assert.deepEqual(
      migrationSnapshot(stack, processed, live),
      baselineSnapshot,
      "Sponsor CRM identity/configuration changed while resuming",
    );
  }

  console.log(safeEvidence({ event: "migration-start", prefix }));
  while (prefix < STAGES.length) {
    const ordinal = prefix;
    const staged = buildStageTemplate(processed, ordinal);
    const identity = stageIdentity({
      repository: process.env.GITHUB_REPOSITORY,
      ref: process.env.GITHUB_REF,
      deploymentDigest: process.env.GITHUB_SHA,
      targetDigest,
      baselineTemplate: processed,
      ordinal,
      stagedTemplate: staged,
      attemptNonce: `${process.env.GITHUB_RUN_ID}:${process.env.GITHUB_RUN_ATTEMPT}`,
    });
    let candidate = await findOrClearStageCandidate(
      identity,
      staged,
      stack,
      processed,
      prefix,
      baselineSnapshot,
    );
    if (candidate) {
      assert.equal(candidate.ChangeSetName, identity.name);
      assert.equal(candidate.Description, identity.description);
      assert.equal(candidate.StackName, CONTRACT.stack);
      assert.equal(candidate.StackId, stack.StackId);
      if (
        candidate.Status === "CREATE_PENDING" ||
        candidate.Status === "CREATE_IN_PROGRESS"
      ) {
        candidate = await waitForChangeSet(candidate.ChangeSetId);
      }
      await assertExactChangeSetTemplate(candidate.ChangeSetId, staged);
      validateStageChangeSet(
        candidate,
        identity,
        ordinal,
        stack.StackId,
        expectedStageParameters(stack),
      );
    } else {
      const temporaryRoot = join(process.env.GITHUB_WORKSPACE, ".tmp");
      mkdirSync(temporaryRoot, { recursive: true, mode: 0o700 });
      chmodSync(temporaryRoot, 0o700);
      const directory = mkdtempSync(
        join(temporaryRoot, "dataops-sponsor-gsi-"),
        { encoding: "utf8" },
      );
      chmodSync(directory, 0o700);
      try {
        candidate = await createStageChangeSet({
          identity,
          template: staged,
          stack,
          directory,
        });
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
      await assertExactChangeSetTemplate(candidate.ChangeSetId, staged);
      validateStageChangeSet(
        candidate,
        identity,
        ordinal,
        stack.StackId,
        expectedStageParameters(stack),
      );
    }

    if (candidate.ExecutionStatus === "AVAILABLE") {
      await assertImmediatePreexecute(
        stack,
        processed,
        prefix,
        baselineSnapshot,
      );
      await assertOnlyExpectedActiveChangeSet(candidate);
      const pinnedId = candidate.ChangeSetId;
      const immediate = await changeSet(pinnedId);
      assert.ok(immediate, "stage change set disappeared before execution");
      assert.equal(immediate.ChangeSetId, pinnedId);
      validateStageChangeSet(
        immediate,
        identity,
        ordinal,
        stack.StackId,
        expectedStageParameters(stack),
      );
      await assertExactChangeSetTemplate(pinnedId, staged);
      console.log(
        safeEvidence({
          event: "stage-execute",
          ordinal: ordinal + 1,
          indexName: STAGES[ordinal].IndexName,
          identity: identity.identity,
        }),
      );
      await aws(
        "cloudformation",
        "execute-change-set",
        "--stack-name",
        CONTRACT.stack,
        "--change-set-name",
        pinnedId,
      );
      await waitForStackUpdate(candidate.ChangeSetId);
    }

    processed = await waitForTable(
      ordinal + 1,
      staged,
      stack,
      baselineSnapshot,
    );
    assert.equal(
      digest(processed),
      digest(staged),
      "completed stage Processed template changed",
    );
    stack = await validateStackIdentity();
    live = await describeTable();
    prefix = assertSamePrefix(processed, live);
    assert.equal(prefix, ordinal + 1);
    assert.deepEqual(
      migrationSnapshot(stack, processed, live),
      baselineSnapshot,
      "Sponsor CRM non-GSI identity/configuration changed during migration",
    );
    console.log(
      safeEvidence({
        event: "stage-complete",
        ordinal: prefix,
        indexName: STAGES[ordinal].IndexName,
        identity: identity.identity,
        prefix,
        status: stack.StackStatus,
      }),
    );
  }
  let expectedFinalProcessed = initialProcessed;
  for (let ordinal = initialPrefix; ordinal < STAGES.length; ordinal += 1) {
    expectedFinalProcessed = buildStageTemplate(expectedFinalProcessed, ordinal);
  }
  const finalStack = await validateStackIdentity();
  assert.equal(finalStack.StackId, stack.StackId, "final stack ID changed");
  assert.equal(finalStack.StackStatus, stack.StackStatus, "final stack status changed");
  const finalProcessed = await getProcessedTemplate();
  assert.equal(
    digest(finalProcessed),
    digest(expectedFinalProcessed),
    "final full Processed template changed",
  );
  const finalLive = await describeTable();
  assert.equal(assertSamePrefix(finalProcessed, finalLive), STAGES.length);
  assert.deepEqual(
    migrationSnapshot(finalStack, finalProcessed, finalLive),
    baselineSnapshot,
    "Sponsor CRM final migration snapshot changed",
  );
  await assertNoActiveChangeSets();
  console.log(
    safeEvidence({
      event: "migration-complete",
      prefix,
      identity: digest({ targetDigest, prefix }),
    }),
  );
}

function usage() {
  fail("usage");
}

async function main() {
  assert.ok(Number.isFinite(POLL_MS) && POLL_MS > 0);
  assert.ok(Number.isFinite(STACK_TIMEOUT_MS) && STACK_TIMEOUT_MS > 0);
  assert.ok(Number.isFinite(TABLE_TIMEOUT_MS) && TABLE_TIMEOUT_MS > 0);
  assert.ok(Number.isFinite(CHANGE_SET_TIMEOUT_MS) && CHANGE_SET_TIMEOUT_MS > 0);
  assert.ok(Number.isFinite(AWS_CALL_TIMEOUT_MS) && AWS_CALL_TIMEOUT_MS > 0);
  assert.ok(Number.isFinite(AWS_KILL_GRACE_MS) && AWS_KILL_GRACE_MS > 0);
  assert.ok(
    Number.isInteger(MAX_AWS_OUTPUT_BYTES) &&
      MAX_AWS_OUTPUT_BYTES >= 1024 &&
      MAX_AWS_OUTPUT_BYTES <= 32 * 1024 * 1024,
  );
  const [command, ...args] = process.argv.slice(2);
  if (command === "migrate" && args.length === 2) {
    await migrate(args[0], args[1]);
    return;
  }
  usage();
}

main().catch((error) => {
  const code = error instanceof SafeFailure ? error.code : "contract-violation";
  console.error(`Sponsor CRM GSI deployment gate failed closed: ${code}`);
  process.exitCode = 1;
});
