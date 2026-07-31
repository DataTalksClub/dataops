import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import test from "node:test";
import {
  CONTRACT,
  STAGES,
  assertOnlyGsiFieldsChanged,
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
  validateStack,
  validateStageChangeSet,
  validateTargetTemplate,
} from "./sponsor-crm-gsi-core.mjs";

const STACK_ID =
  "arn:aws:cloudformation:eu-west-1:817685572750:stack/dataops-v1/12345678-1234-1234-1234-123456789abc";
const TEST_STACK_PARAMETERS = [
  { ParameterKey: "GitHubOwner", ParameterValue: "DataTalksClub" },
  { ParameterKey: "GitHubRepo", ParameterValue: "dataops" },
];
const DESCRIBED_STAGE_PARAMETERS = TEST_STACK_PARAMETERS.map((parameter) => ({
  ...parameter,
  UsePreviousValue: true,
}));
const SYSTEM_TAGS = [
  { Key: "aws:cloudformation:logical-id", Value: CONTRACT.logicalId },
  { Key: "aws:cloudformation:stack-id", Value: STACK_ID },
  { Key: "aws:cloudformation:stack-name", Value: CONTRACT.stack },
];

function processed(prefix = 0) {
  return {
    AWSTemplateFormatVersion: "2010-09-09",
    Parameters: { Unrelated: { Type: "String", NoEcho: true } },
    Resources: {
      Unrelated: {
        Type: "AWS::SQS::Queue",
        Properties: { QueueName: { "Fn::Sub": "${AWS::StackName}-private" } },
      },
      [CONTRACT.logicalId]: {
        Type: "AWS::DynamoDB::Table",
        DeletionPolicy: "Retain",
        UpdateReplacePolicy: "Retain",
        Properties: {
          TableName: { "Fn::Sub": "${AWS::StackName}-sponsor-crm" },
          BillingMode: "PAY_PER_REQUEST",
          SSESpecification: { SSEEnabled: true },
          PointInTimeRecoverySpecification: {
            PointInTimeRecoveryEnabled: true,
          },
          AttributeDefinitions: [
            { AttributeName: "PK", AttributeType: "S" },
            { AttributeName: "SK", AttributeType: "S" },
            ...STAGES.slice(0, prefix).flatMap((entry) => entry.attributes),
          ],
          KeySchema: [
            { AttributeName: "PK", KeyType: "HASH" },
            { AttributeName: "SK", KeyType: "RANGE" },
          ],
          GlobalSecondaryIndexes: STAGES.slice(0, prefix).map(
            (entry) => entry.index,
          ),
        },
      },
    },
  };
}

function targetTemplate() {
  return parseTemplate(readFileSync("infra/template.full.yaml", "utf8"));
}

const TABLE_ARN =
  "arn:aws:dynamodb:eu-west-1:817685572750:table/dataops-v1-sponsor-crm";
const TABLE_ID = "synthetic-table-id-12345678";
const SSE_DESCRIPTION = {
  Status: "ENABLED",
  SSEType: "KMS",
  KMSMasterKeyArn:
    "arn:aws:kms:eu-west-1:817685572750:key/12345678-1234-1234-1234-123456789abc",
};
const STREAM_LABEL = "2026-07-31T00:00:00.000";
function live(prefix = 0) {
  return {
    TableName: CONTRACT.physicalTable,
    TableArn: TABLE_ARN,
    TableId: TABLE_ID,
    TableStatus: "ACTIVE",
    BillingModeSummary: { BillingMode: "PAY_PER_REQUEST" },
    SSEDescription: structuredClone(SSE_DESCRIPTION),
    ContinuousBackupsDescription: {
      PointInTimeRecoveryDescription: {
        PointInTimeRecoveryStatus: "ENABLED",
      },
    },
    KeySchema: [
      { AttributeName: "PK", KeyType: "HASH" },
      { AttributeName: "SK", KeyType: "RANGE" },
    ],
    AttributeDefinitions: [
      { AttributeName: "PK", AttributeType: "S" },
      { AttributeName: "SK", AttributeType: "S" },
      ...STAGES.slice(0, prefix).flatMap((entry) => entry.attributes),
    ],
    GlobalSecondaryIndexes: STAGES.slice(0, prefix).map((entry) => ({
      ...entry.index,
      IndexStatus: "ACTIVE",
      Backfilling: false,
    })),
    StreamSpecification: {
      StreamEnabled: true,
      StreamViewType: "NEW_AND_OLD_IMAGES",
    },
    LatestStreamLabel: STREAM_LABEL,
    LatestStreamArn: `${TABLE_ARN}/stream/${STREAM_LABEL}`,
    Tags: [],
    TimeToLiveDescription: {
      AttributeName: "ttl",
      TimeToLiveStatus: "ENABLED",
    },
  };
}

function resourceChange(properties = [
  "AttributeDefinitions",
  "GlobalSecondaryIndexes",
]) {
  return {
    Action: "Modify",
    LogicalResourceId: CONTRACT.logicalId,
    ResourceType: "AWS::DynamoDB::Table",
    Replacement: "False",
    Details: properties.map((Name) => ({
      Target: {
        Attribute: "Properties",
        Name,
        RequiresRecreation: "Never",
      },
      ChangeSource: "DirectModification",
      Evaluation: "Static",
    })),
  };
}

function identity(template = processed(0), ordinal = 0) {
  const stagedTemplate = buildStageTemplate(template, ordinal);
  return stageIdentity({
    repository: CONTRACT.repository,
    ref: CONTRACT.ref,
    deploymentDigest: "a".repeat(40),
    targetDigest: "b".repeat(64),
    baselineTemplate: template,
    ordinal,
    stagedTemplate,
    attemptNonce: "100:1",
  });
}

function stageChangeSet(template = processed(0), ordinal = 0) {
  const expectedIdentity = identity(template, ordinal);
  return {
    ChangeSetId:
      `arn:aws:cloudformation:eu-west-1:817685572750:changeSet/${expectedIdentity.name}/12345678-1234-1234-1234-123456789abc`,
    ChangeSetName: expectedIdentity.name,
    Description: expectedIdentity.description,
    StackName: CONTRACT.stack,
    StackId: STACK_ID,
    Status: "CREATE_COMPLETE",
    ExecutionStatus: "AVAILABLE",
    Parameters: structuredClone(DESCRIBED_STAGE_PARAMETERS),
    Capabilities: ["CAPABILITY_IAM", "CAPABILITY_AUTO_EXPAND"],
    NotificationARNs: [],
    IncludeNestedStacks: false,
    ChangeSetType: "UPDATE",
    RollbackConfiguration: {
      RollbackTriggers: [],
      MonitoringTimeInMinutes: 0,
    },
    Tags: [],
    ImportExistingResources: false,
    Changes: [{ ResourceChange: resourceChange() }],
  };
}

const FAKE_AWS = String.raw`#!/usr/bin/env node
const fs = require("node:fs");
const statePath = process.env.FAKE_AWS_STATE;
const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
if (state.ignoreTermination) process.on("SIGTERM", () => {});
const [service, operation, ...args] = process.argv.slice(2);
const value = (flag) => {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
};
const save = () => fs.writeFileSync(statePath, JSON.stringify(state));
const output = (body) => {
  save();
  process.stdout.write(JSON.stringify(body));
};
const fail = (message = "synthetic failure") => {
  save();
  process.stderr.write(message);
  process.exit(255);
};
state.calls ??= [];
state.calls.push({ service, operation, args });
save();
const operationKey = service + ":" + operation;
if (state.hangOperation === operationKey) {
  state.hangStarted = operationKey;
  save();
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10000);
  state.hangCompleted = operationKey;
  save();
}
if (state.floodOperation === operationKey) {
  process.stdout.write("x".repeat(2 * 1024 * 1024));
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10000);
}
if (state.failOperation === operationKey) fail();

const stages = [
  ["GSI-Communication", "GSI1PK", "GSI1SK"],
  ["GSI-SponsorSendDue", "GSI2PK", "GSI2SK"],
  ["GSI-SponsorSendLookup", "GSI3PK", "GSI3SK"],
  ["GSI-SponsorBookingCommunication", "GSI4PK", "GSI4SK"],
];
const attributes = (prefix) => [
  { AttributeName: "PK", AttributeType: "S" },
  { AttributeName: "SK", AttributeType: "S" },
  ...stages.slice(0, prefix).flatMap(([, hash, range]) => [
    { AttributeName: hash, AttributeType: "S" },
    { AttributeName: range, AttributeType: "S" },
  ]),
];
const indexes = (prefix, transition = false) =>
  stages.slice(0, prefix).map(([IndexName, hash, range], ordinal) => ({
    IndexName,
    KeySchema: [
      { AttributeName: hash, KeyType: "HASH" },
      { AttributeName: range, KeyType: "RANGE" },
    ],
    Projection: { ProjectionType: "ALL" },
    IndexStatus:
      transition && ordinal === prefix - 1 ? "CREATING" : "ACTIVE",
    Backfilling: transition && ordinal === prefix - 1,
  }));
const activeSummaries = () =>
  (state.changeSets ?? [])
    .filter((item) => item.listed !== false)
    .map((item) => ({
      ChangeSetId: item.ChangeSetId,
      ChangeSetName: item.ChangeSetName,
      Status: item.Status,
      ExecutionStatus: item.ExecutionStatus,
    }));
const candidate = (identity) =>
  (state.changeSets ?? []).find(
    (item) => item.ChangeSetId === identity || item.ChangeSetName === identity,
  );

if (service === "sts" && operation === "get-caller-identity") {
  output({
    Account: "817685572750",
    Arn: "arn:aws:sts::817685572750:assumed-role/dataops-github-actions-deploy/test",
  });
} else if (service === "cloudformation" && operation === "describe-stacks") {
  if (value("--stack-name") === "aws-sam-cli-managed-default") {
    output({ Stacks: [{ Outputs: [{ OutputKey: "SourceBucket", OutputValue: "aws-sam-cli-managed-default-test" }] }] });
  } else {
    state.dataopsStackDescribeCount =
      (state.dataopsStackDescribeCount ?? 0) + 1;
    const preexecute = state.dataopsStackDescribeCount >= 2;
    output({
      Stacks: [{
        StackName: "dataops-v1",
        StackId: preexecute && state.preexecuteStackId
          ? state.preexecuteStackId
          : (state.stackId ??
            "arn:aws:cloudformation:eu-west-1:817685572750:stack/dataops-v1/12345678-1234-1234-1234-123456789abc"),
        StackStatus: preexecute && state.preexecuteStackStatus
          ? state.preexecuteStackStatus
          : (state.stackStatus ?? "UPDATE_COMPLETE"),
        Parameters: state.stackParameters ?? [],
        Tags: state.stackTags ?? [],
      }],
    });
  }
} else if (service === "cloudformation" && operation === "describe-stack-resource") {
  state.stackResourceDescribeCount =
    (state.stackResourceDescribeCount ?? 0) + 1;
  const preexecute = state.stackResourceDescribeCount >= 2;
  output({ StackResourceDetail: {
    LogicalResourceId: preexecute && state.preexecuteLogicalResourceId
      ? state.preexecuteLogicalResourceId
      : (state.logicalResourceId ?? "DataOpsSponsorCrmTable"),
    ResourceType: "AWS::DynamoDB::Table",
    PhysicalResourceId: preexecute && state.preexecutePhysicalResourceId
      ? state.preexecutePhysicalResourceId
      : (state.physicalResourceId ?? "dataops-v1-sponsor-crm"),
  } });
} else if (service === "cloudformation" && operation === "get-template") {
  const identity = value("--change-set-name");
  if (identity) {
    const item = candidate(identity);
    if (!item) fail("ChangeSet does not exist");
    output({
      TemplateBody:
        value("--template-stage") === "Original"
          ? (item.originalTemplate ?? item.template)
          : (item.processedTemplate ?? item.template),
    });
  } else {
    state.processedTemplateReadCount =
      (state.processedTemplateReadCount ?? 0) + 1;
    output({
      TemplateBody:
        state.processedTemplateReadCount >= 2 && state.preexecuteProcessed
          ? state.preexecuteProcessed
          : state.processed,
    });
  }
} else if (service === "cloudformation" && operation === "list-change-sets") {
  state.listCount = (state.listCount ?? 0) + 1;
  if (state.paginationCycle) {
    output({ Summaries: [], NextToken: "cycle-token" });
  } else if (
    state.substituteOnList === state.listCount
  ) {
    output({
      Summaries:
        state.substituteSummaries ?? [state.substituteSummary],
    });
  } else if (state.pagination && !value("--starting-token")) {
    output({ Summaries: state.paginationFirst ?? [], NextToken: "page-2" });
  } else {
    output({ Summaries: activeSummaries() });
  }
} else if (service === "cloudformation" && operation === "describe-change-set") {
  const item = candidate(value("--change-set-name"));
  if (!item) fail("ChangeSet does not exist");
  state.describeCount = (state.describeCount ?? 0) + 1;
  if (
    state.substituteDescribeId ||
    state.substituteOnDescribe === state.describeCount
  ) {
    const substituted = {
      ...item,
      ChangeSetId: item.ChangeSetId.replace(
        "12345678-1234-1234-1234-123456789abc",
        "87654321-1234-1234-1234-123456789abc",
      ),
    };
    state.substituteDescribeId = false;
    output(substituted);
  } else {
    output(item);
  }
} else if (service === "cloudformation" && operation === "create-change-set") {
  if (state.mode === "hang-create") {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10000);
  }
  const name = value("--change-set-name");
  const requestParameters = JSON.parse(
    fs.readFileSync(value("--parameters").replace(/^file:\/\//, ""), "utf8"),
  );
  const describedParameters = requestParameters.map((parameter) => ({
    ParameterKey: parameter.ParameterKey,
    ParameterValue: (state.stackParameters ?? []).find(
      (item) => item.ParameterKey === parameter.ParameterKey,
    )?.ParameterValue,
    UsePreviousValue: parameter.UsePreviousValue,
  }));
  const item = {
    ChangeSetId:
      "arn:aws:cloudformation:eu-west-1:817685572750:changeSet/" +
      name +
      "/12345678-1234-1234-1234-123456789abc",
    ChangeSetName: name,
    Description: value("--description"),
    StackName: "dataops-v1",
    StackId: "arn:aws:cloudformation:eu-west-1:817685572750:stack/dataops-v1/12345678-1234-1234-1234-123456789abc",
    Status: state.mode === "create-pending"
      ? "CREATE_IN_PROGRESS"
      : "CREATE_COMPLETE",
    ExecutionStatus: "AVAILABLE",
    Parameters: state.candidateParameters ?? describedParameters,
    Capabilities: state.candidateCapabilities ??
      ["CAPABILITY_IAM", "CAPABILITY_AUTO_EXPAND"],
    RoleARN: state.candidateRoleArn,
    NotificationARNs: state.candidateNotificationArns ?? [],
    IncludeNestedStacks: state.candidateIncludeNestedStacks ?? false,
    ChangeSetType: state.candidateChangeSetType ?? "UPDATE",
    RollbackConfiguration: state.candidateRollbackConfiguration ?? {
      RollbackTriggers: [],
      MonitoringTimeInMinutes: 0,
    },
    Tags: state.candidateTags ?? [],
    OnStackFailure: state.candidateOnStackFailure,
    ImportExistingResources: state.candidateImportExistingResources ?? false,
    ParentChangeSetId: state.candidateParentChangeSetId,
    RootChangeSetId: state.candidateRootChangeSetId,
    Changes: [{ ResourceChange: {
      Action: "Modify",
      LogicalResourceId: "DataOpsSponsorCrmTable",
      ResourceType: "AWS::DynamoDB::Table",
      Replacement: "False",
      Details: ["AttributeDefinitions", "GlobalSecondaryIndexes"].map((Name) => ({
        Target: { Attribute: "Properties", Name, RequiresRecreation: "Never" },
        ChangeSource: "DirectModification",
        Evaluation: "Static",
      })),
    } }],
    template: state.uploaded,
  };
  state.changeSets ??= [];
  state.changeSets.push(item);
  output({
    Id: state.createResponseId ?? item.ChangeSetId,
    StackId: state.createResponseStackId ?? item.StackId,
  });
} else if (service === "cloudformation" && operation === "execute-change-set") {
  const item = candidate(value("--change-set-name"));
  if (!item) fail();
  item.ExecutionStatus = "EXECUTE_COMPLETE";
  item.listed = false;
  state.processed = state.postProcessedTemplate ?? item.template;
  state.prefix =
    item.template.Resources.DataOpsSponsorCrmTable.Properties
      .GlobalSecondaryIndexes.length;
  state.executed ??= [];
  state.executed.push(item.ChangeSetName);
  if (state.postTableId !== undefined) state.tableId = state.postTableId;
  if (state.postTableName !== undefined) state.tableName = state.postTableName;
  if (state.postTableArn !== undefined) state.tableArn = state.postTableArn;
  if (state.postKeySchema !== undefined) state.keySchema = state.postKeySchema;
  if (state.postBillingModeSummary !== undefined) {
    state.billingModeSummary = state.postBillingModeSummary;
  }
  if (state.postSseDescription !== undefined) {
    state.sseDescription = state.postSseDescription;
  }
  if (state.postPitrStatus !== undefined) state.pitrStatus = state.postPitrStatus;
  if (state.postContinuousBackupsStatus !== undefined) {
    state.continuousBackupsStatus = state.postContinuousBackupsStatus;
  }
  if (state.postPitrRecoveryPeriodInDays !== undefined) {
    state.pitrRecoveryPeriodInDays = state.postPitrRecoveryPeriodInDays;
  }
  if (state.postPitrEarliest !== undefined) {
    state.pitrEarliest = state.postPitrEarliest;
  }
  if (state.postPitrLatest !== undefined) state.pitrLatest = state.postPitrLatest;
  if (state.postTtlAttribute !== undefined) {
    state.ttlAttribute = state.postTtlAttribute;
  }
  if (state.postTtlStatus !== undefined) state.ttlStatus = state.postTtlStatus;
  if (state.postStreamSpecification !== undefined) {
    state.streamSpecification = state.postStreamSpecification;
  }
  if (state.postStreamLabel !== undefined) {
    state.streamLabel = state.postStreamLabel;
  }
  if (state.postStreamArn !== undefined) state.streamArn = state.postStreamArn;
  if (state.postTableTags !== undefined) state.tableTags = state.postTableTags;
  if (state.postPhysicalResourceId !== undefined) {
    state.physicalResourceId = state.postPhysicalResourceId;
  }
  output({});
} else if (service === "cloudformation" && operation === "delete-change-set") {
  const item = candidate(value("--change-set-name"));
  if (!item) fail("ChangeSet does not exist");
  item.listed = false;
  item.Status = "DELETE_COMPLETE";
  state.deleted ??= [];
  state.deleted.push(item.ChangeSetName);
  output({});
} else if (service === "dynamodb" && operation === "describe-table") {
  state.tableDescribeCount = (state.tableDescribeCount ?? 0) + 1;
  const preexecute = state.tableDescribeCount >= 2;
  const transition = (state.transitionReads ?? 0) > 0;
  if (transition) state.transitionReads -= 1;
  const prefix = preexecute && state.preexecutePrefix !== undefined
    ? state.preexecutePrefix
    : state.prefix;
  output({ Table: {
    TableName: preexecute && state.preexecuteTableName
      ? state.preexecuteTableName
      : (state.tableName ?? "dataops-v1-sponsor-crm"),
    TableArn: preexecute && state.preexecuteTableArn
      ? state.preexecuteTableArn
      : (state.tableArn ??
        "arn:aws:dynamodb:eu-west-1:817685572750:table/dataops-v1-sponsor-crm"),
    TableId: preexecute && state.preexecuteTableId
      ? state.preexecuteTableId
      : (state.tableId ?? "synthetic-table-id-12345678"),
    TableStatus: transition ? "UPDATING" : "ACTIVE",
    BillingModeSummary: state.billingModeSummary ??
      { BillingMode: "PAY_PER_REQUEST" },
    SSEDescription: state.sseDescription ?? {
      Status: "ENABLED",
      SSEType: "KMS",
      KMSMasterKeyArn: "arn:aws:kms:eu-west-1:817685572750:key/12345678-1234-1234-1234-123456789abc",
    },
    KeySchema: state.keySchema ?? [
      { AttributeName: "PK", KeyType: "HASH" },
      { AttributeName: "SK", KeyType: "RANGE" },
    ],
    AttributeDefinitions: attributes(prefix),
    GlobalSecondaryIndexes: indexes(prefix, transition),
    StreamSpecification: state.streamSpecification ?? {
      StreamEnabled: true,
      StreamViewType: "NEW_AND_OLD_IMAGES",
    },
    LatestStreamLabel:
      state.streamLabel ?? "2026-07-31T00:00:00.000",
    LatestStreamArn:
      state.streamArn ??
      "arn:aws:dynamodb:eu-west-1:817685572750:table/dataops-v1-sponsor-crm/stream/2026-07-31T00:00:00.000",
  } });
} else if (service === "dynamodb" && operation === "describe-continuous-backups") {
  output({ ContinuousBackupsDescription: {
    ContinuousBackupsStatus: state.continuousBackupsStatus ?? "ENABLED",
    PointInTimeRecoveryDescription: {
      PointInTimeRecoveryStatus: state.pitrStatus ?? "ENABLED",
      RecoveryPeriodInDays: state.pitrRecoveryPeriodInDays ?? 35,
      EarliestRestorableDateTime: state.pitrEarliest ?? 1785456000,
      LatestRestorableDateTime: state.pitrLatest ?? 1785460000,
    },
  } });
} else if (service === "dynamodb" && operation === "describe-time-to-live") {
  output({ TimeToLiveDescription: {
    AttributeName: state.ttlAttribute ?? "ttl",
    TimeToLiveStatus: state.ttlStatus ?? "ENABLED",
  } });
} else if (service === "dynamodb" && operation === "list-tags-of-resource") {
  state.tagListCount = (state.tagListCount ?? 0) + 1;
  if (
    state.injectCandidateOnTagListCount === state.tagListCount &&
    state.injectedCandidate
  ) {
    state.changeSets ??= [];
    state.changeSets.push(state.injectedCandidate);
  }
  output({ Tags: state.tableTags ?? ${JSON.stringify(SYSTEM_TAGS)} });
} else if (service === "s3api" && operation === "put-object") {
  state.uploaded = JSON.parse(fs.readFileSync(value("--body"), "utf8"));
  save();
  if (state.mode === "hang-put") {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10000);
  }
  output({ ETag: "synthetic", ChecksumSHA256: value("--checksum-sha256") });
} else if (service === "s3api" && operation === "delete-object") {
  state.cleanupCount = (state.cleanupCount ?? 0) + 1;
  if (state.mode === "delete-fail") fail();
  state.uploaded = null;
  output({});
} else {
  fail("unsupported synthetic operation");
}
`;

function fakeHarness(initialState, overrides = {}) {
  mkdirSync(".tmp", { recursive: true, mode: 0o700 });
  const directory = mkdtempSync(join(".tmp", "sponsor-gsi-process-"));
  chmodSync(directory, 0o700);
  const awsPath = join(directory, "aws");
  const statePath = join(directory, "state.json");
  writeFileSync(awsPath, FAKE_AWS, { mode: 0o700 });
  chmodSync(awsPath, 0o700);
  writeFileSync(
    statePath,
    JSON.stringify({
      stackParameters: structuredClone(TEST_STACK_PARAMETERS),
      tableTags: structuredClone(SYSTEM_TAGS),
      ...initialState,
    }),
    { mode: 0o600 },
  );
  const env = {
    ...process.env,
    PATH: `${directory}:${process.env.PATH}`,
    FAKE_AWS_STATE: statePath,
    GITHUB_REPOSITORY: "DataTalksClub/dataops",
    GITHUB_REPOSITORY_OWNER: "DataTalksClub",
    GITHUB_REF: "refs/heads/main",
    GITHUB_SHA: "a".repeat(40),
    GITHUB_RUN_ID: "100",
    GITHUB_RUN_ATTEMPT: "1",
    GITHUB_EVENT_NAME: "workflow_dispatch",
    GITHUB_ACTOR: "alexeygrigorev",
    GITHUB_WORKSPACE: process.cwd(),
    AWS_REGION: CONTRACT.region,
    AWS_DEFAULT_REGION: CONTRACT.region,
    SPONSOR_GSI_POLL_MS: "5",
    SPONSOR_GSI_STACK_TIMEOUT_MS: "2000",
    SPONSOR_GSI_TABLE_TIMEOUT_MS: "2000",
    SPONSOR_GSI_CHANGE_SET_TIMEOUT_MS: "2000",
    SPONSOR_GSI_AWS_CALL_TIMEOUT_MS: "2000",
    SPONSOR_GSI_AWS_KILL_GRACE_MS: "50",
    ...overrides,
  };
  return {
    directory,
    statePath,
    env,
    readState: () => {
      for (let attempt = 0; attempt < 100; attempt += 1) {
        try {
          return JSON.parse(readFileSync(statePath, "utf8"));
        } catch {
          Atomics.wait(
            new Int32Array(new SharedArrayBuffer(4)),
            0,
            0,
            2,
          );
        }
      }
      throw new Error("synthetic state remained unreadable");
    },
    writeState: (mutate) => {
      const state = JSON.parse(readFileSync(statePath, "utf8"));
      mutate(state);
      writeFileSync(statePath, JSON.stringify(state), { mode: 0o600 });
    },
    cleanup: () => rmSync(directory, { recursive: true, force: true }),
  };
}

function runFakeMigration(harness) {
  return spawnSync(
    process.execPath,
    [
      "scripts/deploy/sponsor-crm-gsi-migrator.mjs",
      "migrate",
      "infra/template.full.yaml",
      "infra/template.full.yaml",
    ],
    {
      cwd: process.cwd(),
      env: harness.env,
      encoding: "utf8",
      timeout: 15000,
    },
  );
}

function runFakeGuard(harness) {
  return spawnSync(
    process.execPath,
    [
      "scripts/deploy/sponsor-crm-gsi-guard.mjs",
      "infra/template.full.yaml",
    ],
    {
      cwd: process.cwd(),
      env: harness.env,
      encoding: "utf8",
      timeout: 15000,
    },
  );
}

function mutationCalls(state) {
  const mutating = new Set([
    "cloudformation:create-change-set",
    "cloudformation:delete-change-set",
    "cloudformation:execute-change-set",
    "s3api:put-object",
    "s3api:delete-object",
    "dynamodb:update-table",
  ]);
  return (state.calls ?? []).filter((call) =>
    mutating.has(`${call.service}:${call.operation}`),
  );
}

async function waitForState(harness, predicate, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const state = harness.readState();
    if (predicate(state)) return state;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("synthetic state deadline exceeded");
}

function processCandidate(identityValue, template, executionStatus = "AVAILABLE") {
  return {
    ...stageChangeSet(processed(identityValue.ordinal - 1), identityValue.ordinal - 1),
    ChangeSetId:
      `arn:aws:cloudformation:eu-west-1:817685572750:changeSet/${identityValue.name}/12345678-1234-1234-1234-123456789abc`,
    ChangeSetName: identityValue.name,
    Description: identityValue.description,
    ExecutionStatus: executionStatus,
    template,
  };
}

function foreignCandidate() {
  return {
    ChangeSetId:
      "arn:aws:cloudformation:eu-west-1:817685572750:changeSet/foreign-candidate/87654321-1234-1234-1234-123456789abc",
    ChangeSetName: "foreign-candidate",
    Status: "CREATE_COMPLETE",
    ExecutionStatus: "AVAILABLE",
    listed: true,
  };
}

test("checked-in target has the exact canonical four-stage schema", () => {
  const source = parseTemplate(readFileSync("infra/template.full.yaml", "utf8"));
  assert.match(validateTargetTemplate(source).targetDigest, /^[0-9a-f]{64}$/);
});

test("CloudFormation short-form YAML intrinsics parse without evaluation", () => {
  const template = parseTemplate(`
Resources:
  DataOpsSponsorCrmTable:
    Type: AWS::DynamoDB::Table
    DeletionPolicy: Retain
    UpdateReplacePolicy: Retain
    Properties:
      TableName: !Sub \${AWS::StackName}-sponsor-crm
      AttributeDefinitions:
        - { AttributeName: PK, AttributeType: S }
        - { AttributeName: SK, AttributeType: S }
      KeySchema:
        - { AttributeName: PK, KeyType: HASH }
        - { AttributeName: SK, KeyType: RANGE }
`);
  assert.deepEqual(
    sponsorTable(template).Properties.TableName,
    { "Fn::Sub": "${AWS::StackName}-sponsor-crm" },
  );
});

test("template parsing preserves date-like CloudFormation strings", () => {
  const parsed = parseTemplate(`
AWSTemplateFormatVersion: 2010-09-09
Resources: {}
`);
  assert.equal(parsed.AWSTemplateFormatVersion, "2010-09-09");
});

test("canonical JSON and digests are independent of object key order", () => {
  assert.equal(canonicalJson({ b: 2, a: 1 }), canonicalJson({ a: 1, b: 2 }));
  assert.equal(digest({ b: 2, a: 1 }), digest({ a: 1, b: 2 }));
});

for (let prefix = 0; prefix <= STAGES.length; prefix += 1) {
  test(`exact processed/live prefix ${prefix} resumes safely`, () => {
    assert.equal(inspectProcessedPrefix(processed(prefix)), prefix);
    assert.equal(inspectLivePrefix(live(prefix)), prefix);
    assert.equal(assertSamePrefix(processed(prefix), live(prefix)), prefix);
    if (prefix < STAGES.length) {
      const next = buildStageTemplate(processed(prefix), prefix);
      assert.equal(inspectProcessedPrefix(next), prefix + 1);
      assertOnlyGsiFieldsChanged(processed(prefix), next);
    }
  });
}

test("stage generation preserves all unrelated normalized template content", () => {
  const before = processed(2);
  const after = buildStageTemplate(before, 2);
  assert.deepEqual(after.Resources.Unrelated, before.Resources.Unrelated);
  assert.deepEqual(after.Parameters, before.Parameters);
  assert.deepEqual(
    sponsorTable(after).Properties.PointInTimeRecoverySpecification,
    sponsorTable(before).Properties.PointInTimeRecoverySpecification,
  );
  assert.equal(
    Object.hasOwn(sponsorTable(after).Properties, "TimeToLiveSpecification"),
    false,
  );
  assert.equal(
    Object.hasOwn(sponsorTable(after).Properties, "StreamSpecification"),
    false,
  );
});

test("deterministic identity binds deployment, target, baseline, ordinal, and schema", () => {
  const first = identity();
  assert.deepEqual(first, identity());
  assert.notEqual(
    first.identity,
    stageIdentity({
    repository: CONTRACT.repository,
    ref: CONTRACT.ref,
      deploymentDigest: "c".repeat(40),
      targetDigest: "b".repeat(64),
      baselineTemplate: processed(0),
      ordinal: 0,
      stagedTemplate: buildStageTemplate(processed(0), 0),
      attemptNonce: "100:1",
    }).identity,
  );
  assert.notEqual(first.identity, identity(processed(1), 1).identity);
  const retry = stageIdentity({
    repository: CONTRACT.repository,
    ref: CONTRACT.ref,
    deploymentDigest: "a".repeat(40),
    targetDigest: "b".repeat(64),
    baselineTemplate: processed(0),
    ordinal: 0,
    stagedTemplate: buildStageTemplate(processed(0), 0),
    attemptNonce: "100:2",
  });
  assert.equal(first.binding, retry.binding);
  assert.notEqual(first.identity, retry.identity);
  assert.notEqual(first.name, retry.name);
  for (const attemptNonce of ["0:1", "100:0", "100:100", "other:1"]) {
    assert.throws(() =>
      stageIdentity({
    repository: CONTRACT.repository,
    ref: CONTRACT.ref,
        deploymentDigest: "a".repeat(40),
        targetDigest: "b".repeat(64),
        baselineTemplate: processed(0),
        ordinal: 0,
        stagedTemplate: buildStageTemplate(processed(0), 0),
        attemptNonce,
      }),
    );
  }
});

const invalidPrefixMutations = [
  ["gap", () => [STAGES[1].index]],
  [
    "wrong order",
    () => [STAGES[1].index, STAGES[0].index],
  ],
  [
    "wrong key",
    () => [
      {
        ...STAGES[0].index,
        KeySchema: [
          { AttributeName: "GSI1SK", KeyType: "HASH" },
          { AttributeName: "GSI1PK", KeyType: "RANGE" },
        ],
      },
    ],
  ],
  [
    "wrong projection",
    () => [
      { ...STAGES[0].index, Projection: { ProjectionType: "KEYS_ONLY" } },
    ],
  ],
  [
    "extra index",
    () => [
      ...STAGES.map((entry) => entry.index),
      {
        IndexName: "GSI-Extra",
        KeySchema: [],
        Projection: { ProjectionType: "ALL" },
      },
    ],
  ],
];

for (const [name, mutate] of invalidPrefixMutations) {
  test(`processed schema fails closed on ${name}`, () => {
    const template = processed(0);
    sponsorTable(template).Properties.GlobalSecondaryIndexes = mutate();
    assert.throws(() => inspectProcessedPrefix(template));
  });
}

test("processed schema rejects extra, missing, wrong-type, and reordered attributes", () => {
  const mutations = [
    (items) => [...items, { AttributeName: "extra", AttributeType: "S" }],
    (items) => items.slice(0, -1),
    (items) =>
      items.map((item) =>
        item.AttributeName === "GSI1PK"
          ? { ...item, AttributeType: "N" }
          : item,
      ),
    (items) => [items[1], items[0], ...items.slice(2)],
  ];
  for (const mutate of mutations) {
    const template = processed(1);
    const properties = sponsorTable(template).Properties;
    properties.AttributeDefinitions = mutate(properties.AttributeDefinitions);
    assert.throws(() => inspectProcessedPrefix(template));
  }
});

test("processed/live disagreement, backfill, and non-active table fail closed", () => {
  assert.throws(() => assertSamePrefix(processed(1), live(0)));
  const backfill = live(1);
  backfill.GlobalSecondaryIndexes[0].Backfilling = true;
  assert.throws(() => inspectLivePrefix(backfill));
  const creating = live(1);
  creating.TableStatus = "UPDATING";
  assert.throws(() => inspectLivePrefix(creating));
});

test("table waiter permits only the next target index to be creating", () => {
  const creating = live(1);
  creating.TableStatus = "UPDATING";
  creating.GlobalSecondaryIndexes[0].IndexStatus = "CREATING";
  creating.GlobalSecondaryIndexes[0].Backfilling = true;
  assert.equal(inspectLiveTransitionPrefix(creating), 1);
  assert.equal(isResumableLiveTransition(creating, 1), true);
  assert.throws(() => inspectLivePrefix(creating));

  const priorCreating = live(2);
  priorCreating.TableStatus = "UPDATING";
  priorCreating.GlobalSecondaryIndexes[0].IndexStatus = "CREATING";
  assert.throws(() => isResumableLiveTransition(priorCreating, 2));
  assert.throws(() => inspectLiveTransitionPrefix(priorCreating));

  const deleting = live(1);
  deleting.TableStatus = "UPDATING";
  deleting.GlobalSecondaryIndexes[0].IndexStatus = "DELETING";
  assert.throws(() => inspectLiveTransitionPrefix(deleting));
});

test("stage transform rejects stale ordinal and detects unrelated mutation", () => {
  assert.throws(() => buildStageTemplate(processed(1), 0));
  const before = processed(0);
  const after = buildStageTemplate(before, 0);
  after.Resources.Unrelated.Properties.QueueName = "changed";
  assert.throws(() => assertOnlyGsiFieldsChanged(before, after));
});

test("stack preflight permits only explicit terminal states", () => {
  const StackId =
    "arn:aws:cloudformation:eu-west-1:817685572750:stack/dataops-v1/12345678-1234-1234-1234-123456789abc";
  for (const StackStatus of [
    "CREATE_COMPLETE",
    "UPDATE_COMPLETE",
    "UPDATE_ROLLBACK_COMPLETE",
    "IMPORT_COMPLETE",
  ]) {
    validateStack({ StackName: CONTRACT.stack, StackId, StackStatus });
  }
  for (const StackStatus of [
    "UPDATE_IN_PROGRESS",
    "UPDATE_ROLLBACK_IN_PROGRESS",
    "UPDATE_FAILED",
    "ROLLBACK_COMPLETE",
  ]) {
    assert.throws(() =>
      validateStack({ StackName: CONTRACT.stack, StackId, StackStatus }),
    );
  }
  assert.throws(() =>
    validateStack({
      StackName: CONTRACT.stack,
      StackId: StackId.replace(":817685572750:", ":000000000000:"),
      StackStatus: "UPDATE_COMPLETE",
    }),
  );
});

test("caller identity is pinned to the exact GitHub Actions deployment role", () => {
  validateCallerIdentity({
    Account: CONTRACT.account,
    Arn: `arn:aws:sts::${CONTRACT.account}:assumed-role/dataops-github-actions-deploy/dataops-v1-deploy`,
  });
  assert.throws(() =>
    validateCallerIdentity({
      Account: "000000000000",
      Arn: "arn:aws:sts::000000000000:assumed-role/dataops-github-actions-deploy/session",
    }),
  );
  assert.throws(() =>
    validateCallerIdentity({
      Account: CONTRACT.account,
      Arn: `arn:aws:sts::${CONTRACT.account}:assumed-role/other/session`,
    }),
  );
});

test("bounded waiter classifications stop on failures and rollbacks", () => {
  assert.equal(classifyChangeSetCreation(undefined), "waiting");
  assert.equal(classifyChangeSetCreation("CREATE_PENDING"), "waiting");
  assert.equal(classifyChangeSetCreation("CREATE_IN_PROGRESS"), "waiting");
  assert.equal(classifyChangeSetCreation("CREATE_COMPLETE"), "success");
  assert.equal(classifyChangeSetCreation("FAILED"), "failure");

  assert.equal(
    classifyStackExecution("EXECUTE_IN_PROGRESS", "UPDATE_IN_PROGRESS"),
    "waiting",
  );
  assert.equal(
    classifyStackExecution("EXECUTE_COMPLETE", "UPDATE_COMPLETE"),
    "success",
  );
  for (const status of [
    "UPDATE_FAILED",
    "UPDATE_ROLLBACK_COMPLETE",
    "ROLLBACK_COMPLETE",
  ]) {
    assert.equal(
      classifyStackExecution("OBSOLETE", status),
      "failure",
      status,
    );
  }
});

test("target validation rejects stale GSI, TTL, stream, and preservation contracts", () => {
  const source = parseTemplate(readFileSync("infra/template.full.yaml", "utf8"));
  const mutations = [
    (properties) => {
      properties.GlobalSecondaryIndexes[0].Projection.ProjectionType =
        "KEYS_ONLY";
    },
    (properties) => {
      properties.TimeToLiveSpecification.Enabled = false;
    },
    (properties) => {
      properties.StreamSpecification.StreamViewType = "KEYS_ONLY";
    },
    (properties) => {
      properties.BillingMode = "PROVISIONED";
    },
    (properties) => {
      properties.SSESpecification.SSEEnabled = false;
    },
    (properties) => {
      properties.PointInTimeRecoverySpecification.PointInTimeRecoveryEnabled =
        false;
    },
    (properties) => {
      properties.TableName = "replacement-table";
    },
    (properties) => {
      properties.KeySchema.reverse();
    },
    (properties) => {
      properties.Tags = [{ Key: "unbound", Value: "tag" }];
    },
  ];
  for (const mutate of mutations) {
    const candidate = structuredClone(source);
    mutate(sponsorTable(candidate).Properties);
    assert.throws(() => validateTargetTemplate(candidate));
  }
});

test("stage change-set validator accepts only one exact non-replacing modify", () => {
  const template = processed(0);
  validateStageChangeSet(
    stageChangeSet(template),
    identity(template),
    0,
    STACK_ID,
    DESCRIBED_STAGE_PARAMETERS,
  );

  const mutations = [
    (changeSet) => {
      changeSet.Changes.push({ ResourceChange: resourceChange() });
    },
    (changeSet) => {
      changeSet.Changes[0].ResourceChange.Action = "Add";
    },
    (changeSet) => {
      changeSet.Changes[0].ResourceChange.LogicalResourceId = "Other";
    },
    (changeSet) => {
      changeSet.Changes[0].ResourceChange.Replacement = "Conditional";
    },
    (changeSet) => {
      changeSet.Changes[0].ResourceChange.Details[0].Target.Name = "Tags";
    },
    (changeSet) => {
      changeSet.Changes[0].ResourceChange.Details[0].Target.RequiresRecreation =
        "Conditionally";
    },
    (changeSet) => {
      changeSet.Description = "collision";
    },
    (changeSet) => {
      changeSet.ExecutionStatus = "OBSOLETE";
    },
    (changeSet) => {
      changeSet.StackId = changeSet.StackId.replace(
        ":817685572750:",
        ":000000000000:",
      );
    },
    (changeSet) => {
      changeSet.Parameters[0].ParameterValue = "evil";
    },
    (changeSet) => {
      changeSet.Parameters[0].UsePreviousValue = false;
    },
    (changeSet) => {
      changeSet.Capabilities = ["CAPABILITY_IAM"];
    },
    (changeSet) => {
      changeSet.RoleARN = "arn:aws:iam::817685572750:role/evil";
    },
    (changeSet) => {
      changeSet.NotificationARNs = [
        "arn:aws:sns:eu-west-1:817685572750:evil",
      ];
    },
    (changeSet) => {
      changeSet.IncludeNestedStacks = true;
    },
    (changeSet) => {
      changeSet.ChangeSetType = "CREATE";
    },
    (changeSet) => {
      changeSet.RollbackConfiguration.RollbackTriggers = [
        {
          Arn: "arn:aws:cloudwatch:eu-west-1:817685572750:alarm:evil",
          Type: "AWS::CloudWatch::Alarm",
        },
      ];
    },
    (changeSet) => {
      changeSet.RollbackConfiguration.MonitoringTimeInMinutes = 1;
    },
    (changeSet) => {
      changeSet.Tags = [{ Key: "evil", Value: "tag" }];
    },
    (changeSet) => {
      changeSet.OnStackFailure = "DELETE";
    },
    (changeSet) => {
      changeSet.ImportExistingResources = true;
    },
    (changeSet) => {
      changeSet.ParentChangeSetId = changeSet.ChangeSetId;
    },
    (changeSet) => {
      changeSet.RootChangeSetId = changeSet.ChangeSetId;
    },
  ];
  for (const mutate of mutations) {
    const candidate = structuredClone(stageChangeSet(template));
    mutate(candidate);
    assert.throws(() =>
      validateStageChangeSet(
        candidate,
        identity(template),
        0,
        STACK_ID,
        DESCRIBED_STAGE_PARAMETERS,
      ),
    );
  }
});

test("safe evidence is allowlisted and rejects unsafe status/index values", () => {
  const evidence = safeEvidence({
    event: "stage-complete",
    ordinal: 1,
    indexName: STAGES[0].IndexName,
    identity: "a".repeat(64),
    prefix: 1,
    status: "UPDATE_COMPLETE",
  });
  assert.deepEqual(JSON.parse(evidence), {
    event: "stage-complete",
    ordinal: 1,
    indexName: STAGES[0].IndexName,
    digest: "a".repeat(64),
    prefix: 1,
    status: "UPDATE_COMPLETE",
  });
  assert.throws(() =>
    safeEvidence({ event: "bad", indexName: "private-value" }),
  );
  assert.throws(() =>
    safeEvidence({ event: "bad", status: "UPDATE_COMPLETE\nsecret" }),
  );
});

test("process runtime executes four sequential content-bound stages from prefix zero", () => {
  const harness = fakeHarness({
    processed: processed(0),
    prefix: 0,
    changeSets: [],
  });
  try {
    const result = runFakeMigration(harness);
    assert.equal(result.status, 0, result.stderr);
    const state = harness.readState();
    assert.equal(state.executed.length, 4);
    assert.deepEqual(
      state.executed.map((name) => Number(name.split("-")[3])),
      [1, 2, 3, 4],
    );
    assert.equal(state.prefix, 4);
    assert.equal(state.cleanupCount, 4);
    const executeCalls = state.calls.filter(
      (call) =>
        call.service === "cloudformation" &&
        call.operation === "execute-change-set",
    );
    assert.equal(executeCalls.length, 4);
    assert.ok(
      executeCalls.every((call) =>
        call.args[
          call.args.indexOf("--change-set-name") + 1
        ].startsWith(
          "arn:aws:cloudformation:eu-west-1:817685572750:changeSet/",
        ),
      ),
    );
    for (const executeCall of executeCalls) {
      const executePosition = state.calls.indexOf(executeCall);
      const preceding = state.calls.slice(0, executePosition);
      const positions = [
        preceding.findLastIndex(
          (call) =>
            call.service === "cloudformation" &&
            call.operation === "describe-stacks" &&
            call.args.includes(CONTRACT.stack),
        ),
        preceding.findLastIndex(
          (call) =>
            call.service === "cloudformation" &&
            call.operation === "describe-stack-resource",
        ),
        preceding.findLastIndex(
          (call) =>
            call.service === "cloudformation" &&
            call.operation === "get-template" &&
            !call.args.includes("--change-set-name"),
        ),
        preceding.findLastIndex(
          (call) =>
            call.service === "dynamodb" &&
            call.operation === "describe-table",
        ),
        preceding.findLastIndex(
          (call) =>
            call.service === "cloudformation" &&
            call.operation === "list-change-sets",
        ),
        preceding.findLastIndex(
          (call) =>
            call.service === "cloudformation" &&
            call.operation === "describe-change-set",
        ),
        preceding.findLastIndex(
          (call) =>
            call.service === "cloudformation" &&
            call.operation === "get-template" &&
            call.args.includes("--change-set-name"),
        ),
      ];
      assert.ok(positions.every((position) => position >= 0));
      assert.deepEqual(positions, [...positions].sort((left, right) => left - right));
    }
    assert.ok(
      state.calls.some(
        (call) =>
          call.service === "cloudformation" &&
          call.operation === "list-change-sets",
      ),
    );
    const createCalls = state.calls.filter(
      (call) =>
        call.service === "cloudformation" &&
        call.operation === "create-change-set",
    );
    assert.equal(createCalls.length, 4);
    for (const [ordinal, call] of createCalls.entries()) {
      assert.ok(call.args.includes("--no-include-nested-stacks"));
      assert.equal(
        call.args[call.args.indexOf("--stack-name") + 1],
        CONTRACT.stack,
      );
      assert.equal(
        call.args[call.args.indexOf("--change-set-type") + 1],
        "UPDATE",
      );
      assert.ok(!call.args.includes("--role-arn"));
      assert.ok(!call.args.includes("--notification-arns"));
      assert.ok(!call.args.includes("--rollback-configuration"));
      assert.ok(!call.args.includes("--tags"));
      assert.ok(!call.args.includes("--on-stack-failure"));
      assert.ok(!call.args.includes("--import-existing-resources"));
      const capabilities = call.args.indexOf("--capabilities");
      assert.deepEqual(
        call.args.slice(capabilities + 1, capabilities + 3),
        ["CAPABILITY_IAM", "CAPABILITY_AUTO_EXPAND"],
      );
      assert.equal(call.args[capabilities + 3], "--region");
      assert.match(
        call.args[call.args.indexOf("--client-token") + 1],
        /^[0-9a-f]{64}$/,
      );
      assert.equal(
        call.args[call.args.indexOf("--client-token") + 1],
        state.changeSets[ordinal].Description.split("/")[5],
      );
      assert.ok(
        call.args[call.args.indexOf("--parameters") + 1].startsWith("file://"),
      );
    }
    assert.ok(
      !state.calls.some(
        (call) =>
          call.service === "dynamodb" && call.operation === "update-table",
      ),
    );
    assert.equal(state.calls.at(-1).service, "cloudformation");
    assert.equal(state.calls.at(-1).operation, "list-change-sets");
  } finally {
    harness.cleanup();
  }
});

test("stage migration refuses every push before AWS or mutation", () => {
  for (let prefix = 0; prefix < STAGES.length; prefix += 1) {
    const harness = fakeHarness(
      {
        processed: processed(prefix),
        prefix,
        changeSets: [],
      },
      {
        GITHUB_EVENT_NAME: "push",
        GITHUB_ACTOR: "synthetic",
      },
    );
    try {
      const result = runFakeMigration(harness);
      assert.notEqual(result.status, 0);
      assert.match(
        result.stderr,
        /failed closed: migration-workflow-dispatch-only/,
      );
      assert.deepEqual(mutationCalls(harness.readState()), []);
    } finally {
      harness.cleanup();
    }
  }
});

test("process runtime resumes terminal CloudFormation with exact target backfilling", () => {
  const harness = fakeHarness({
    processed: processed(1),
    prefix: 1,
    transitionReads: 2,
    changeSets: [],
  });
  try {
    const result = runFakeMigration(harness);
    assert.equal(result.status, 0, result.stderr);
    const state = harness.readState();
    assert.deepEqual(
      state.executed.map((name) => Number(name.split("-")[3])),
      [2, 3, 4],
    );
    assert.equal(state.prefix, 4);
  } finally {
    harness.cleanup();
  }
});

test("initial transition wait rejects a valid TableId replacement before baseline adoption", () => {
  const harness = fakeHarness({
    processed: processed(1),
    prefix: 1,
    transitionReads: 2,
    preexecuteTableId: "different-valid-table-id-12345678",
    changeSets: [],
  });
  try {
    const result = runFakeMigration(harness);
    assert.notEqual(result.status, 0);
    const state = harness.readState();
    assert.equal(state.executed, undefined);
    assert.deepEqual(mutationCalls(state), []);
  } finally {
    harness.cleanup();
  }
});

test("process runtime can retry after a bounded backfill timeout", () => {
  const harness = fakeHarness(
    {
      processed: processed(1),
      prefix: 1,
      transitionReads: 100,
      changeSets: [],
    },
    { SPONSOR_GSI_TABLE_TIMEOUT_MS: "200" },
  );
  try {
    const first = runFakeMigration(harness);
    assert.notEqual(first.status, 0);
    assert.match(first.stderr, /failed closed: table-index-timeout/);
    const state = harness.readState();
    assert.equal(state.executed, undefined);
    state.transitionReads = 1;
    writeFileSync(harness.statePath, JSON.stringify(state), { mode: 0o600 });
    harness.env.SPONSOR_GSI_TABLE_TIMEOUT_MS = "2000";
    const retry = runFakeMigration(harness);
    assert.equal(retry.status, 0, retry.stderr);
    assert.deepEqual(
      harness.readState().executed.map((name) => Number(name.split("-")[3])),
      [2, 3, 4],
    );
  } finally {
    harness.cleanup();
  }
});

test("process runtime rejects processed/live prefix disagreement before listing or mutation", () => {
  const harness = fakeHarness({
    processed: processed(1),
    prefix: 0,
    changeSets: [],
  });
  try {
    const result = runFakeMigration(harness);
    assert.notEqual(result.status, 0);
    const state = harness.readState();
    assert.equal(state.executed, undefined);
    assert.ok(
      !state.calls.some(
        (call) =>
          call.service === "cloudformation" &&
          call.operation === "list-change-sets",
      ),
    );
  } finally {
    harness.cleanup();
  }
});

test("process runtime exhausts pagination and refuses an unexpected active change set", () => {
  const harness = fakeHarness({
    processed: processed(0),
    prefix: 0,
    pagination: true,
    paginationFirst: [],
    changeSets: [{
      ChangeSetId:
        "arn:aws:cloudformation:eu-west-1:817685572750:changeSet/operator/12345678-1234-1234-1234-123456789abc",
      ChangeSetName: "operator",
      Status: "CREATE_COMPLETE",
      ExecutionStatus: "AVAILABLE",
      StackName: CONTRACT.stack,
      StackId: STACK_ID,
    }],
  });
  try {
    const result = runFakeMigration(harness);
    assert.notEqual(result.status, 0);
    const state = harness.readState();
    const listCalls = state.calls.filter(
      (call) =>
        call.service === "cloudformation" &&
        call.operation === "list-change-sets",
    );
    assert.equal(listCalls.length, 2);
    assert.ok(listCalls[1].args.includes("--starting-token"));
    assert.equal(state.executed, undefined);
  } finally {
    harness.cleanup();
  }
});

test("process runtime rejects a pagination token cycle before mutation", () => {
  const harness = fakeHarness({
    processed: processed(0),
    prefix: 0,
    paginationCycle: true,
    changeSets: [],
  });
  try {
    const result = runFakeMigration(harness);
    assert.notEqual(result.status, 0);
    const state = harness.readState();
    assert.equal(
      state.calls.filter(
        (call) =>
          call.service === "cloudformation" &&
          call.operation === "list-change-sets",
      ).length,
      2,
    );
    assert.deepEqual(mutationCalls(state), []);
  } finally {
    harness.cleanup();
  }
});

test("process runtime rejects multiple active candidates even with the expected name", () => {
  const baseline = processed(0);
  const staged = buildStageTemplate(baseline, 0);
  const target = validateTargetTemplate(
    parseTemplate(readFileSync("infra/template.full.yaml", "utf8")),
  );
  const expected = stageIdentity({
    repository: CONTRACT.repository,
    ref: CONTRACT.ref,
    deploymentDigest: "a".repeat(40),
    targetDigest: target.targetDigest,
    baselineTemplate: baseline,
    ordinal: 0,
    stagedTemplate: staged,
    attemptNonce: "100:1",
  });
  const first = processCandidate(expected, staged);
  const second = structuredClone(first);
  second.ChangeSetId = second.ChangeSetId.replace(
    "12345678-1234-1234-1234-123456789abc",
    "87654321-1234-1234-1234-123456789abc",
  );
  const harness = fakeHarness({
    processed: baseline,
    prefix: 0,
    changeSets: [first, second],
  });
  try {
    const result = runFakeMigration(harness);
    assert.notEqual(result.status, 0);
    assert.deepEqual(mutationCalls(harness.readState()), []);
  } finally {
    harness.cleanup();
  }
});

test("process runtime rejects exact-name immutable-ID substitution on relist", () => {
  const baseline = processed(0);
  const staged = buildStageTemplate(baseline, 0);
  const target = validateTargetTemplate(
    parseTemplate(readFileSync("infra/template.full.yaml", "utf8")),
  );
  const expected = stageIdentity({
    repository: CONTRACT.repository,
    ref: CONTRACT.ref,
    deploymentDigest: "a".repeat(40),
    targetDigest: target.targetDigest,
    baselineTemplate: baseline,
    ordinal: 0,
    stagedTemplate: staged,
    attemptNonce: "100:1",
  });
  const current = processCandidate(expected, staged);
  const summary = {
    ChangeSetId: current.ChangeSetId.replace(
      "12345678-1234-1234-1234-123456789abc",
      "87654321-1234-1234-1234-123456789abc",
    ),
    ChangeSetName: current.ChangeSetName,
    Status: current.Status,
    ExecutionStatus: current.ExecutionStatus,
  };
  for (const substituteSummary of [
    summary,
    {
      ...summary,
      ChangeSetId: current.ChangeSetId,
      Status: "CREATE_IN_PROGRESS",
    },
  ]) {
    const harness = fakeHarness({
      processed: baseline,
      prefix: 0,
      changeSets: [current],
      substituteOnList: 2,
      substituteSummary,
    });
    try {
      const result = runFakeMigration(harness);
      assert.notEqual(result.status, 0);
      assert.equal(harness.readState().executed, undefined);
      assert.deepEqual(mutationCalls(harness.readState()), []);
    } finally {
      harness.cleanup();
    }
  }
});

test("process runtime rejects immutable-ID substitution after create", () => {
  const harness = fakeHarness({
    processed: processed(0),
    prefix: 0,
    changeSets: [],
    substituteDescribeId: true,
  });
  try {
    const result = runFakeMigration(harness);
    assert.notEqual(result.status, 0);
    const state = harness.readState();
    assert.equal(state.executed, undefined);
    assert.equal(state.cleanupCount, 1);
    assert.equal(state.uploaded, null);
  } finally {
    harness.cleanup();
  }
});

test("process runtime validates create response stack and immutable IDs", () => {
  for (const mutation of [
    {
      createResponseStackId:
        "arn:aws:cloudformation:eu-west-1:817685572750:stack/other/12345678-1234-1234-1234-123456789abc",
    },
    {
      createResponseId:
        "arn:aws:cloudformation:eu-west-1:817685572750:changeSet/evil/12345678-1234-1234-1234-123456789abc",
    },
  ]) {
    const harness = fakeHarness({
      processed: processed(3),
      prefix: 3,
      changeSets: [],
      ...mutation,
    });
    try {
      const result = runFakeMigration(harness);
      assert.notEqual(result.status, 0);
      const state = harness.readState();
      assert.equal(state.executed, undefined);
      assert.equal(state.cleanupCount, 1);
      assert.equal(state.uploaded, null);
    } finally {
      harness.cleanup();
    }
  }
});

test("process runtime rejects mutated stage request bindings before execution", () => {
  const mutations = [
    { candidateParameters: [] },
    { candidateCapabilities: ["CAPABILITY_IAM"] },
    { candidateRoleArn: "arn:aws:iam::817685572750:role/evil" },
    {
      candidateNotificationArns: [
        "arn:aws:sns:eu-west-1:817685572750:evil",
      ],
    },
    { candidateIncludeNestedStacks: true },
    { candidateChangeSetType: "CREATE" },
    {
      candidateRollbackConfiguration: {
        RollbackTriggers: [
          {
            Arn: "arn:aws:cloudwatch:eu-west-1:817685572750:alarm:evil",
            Type: "AWS::CloudWatch::Alarm",
          },
        ],
        MonitoringTimeInMinutes: 0,
      },
    },
    {
      candidateRollbackConfiguration: {
        RollbackTriggers: [],
        MonitoringTimeInMinutes: 1,
      },
    },
    { candidateTags: [{ Key: "evil", Value: "tag" }] },
    { candidateOnStackFailure: "DELETE" },
    { candidateImportExistingResources: true },
    {
      candidateParentChangeSetId:
        "arn:aws:cloudformation:eu-west-1:817685572750:changeSet/parent/12345678-1234-1234-1234-123456789abc",
    },
    {
      candidateRootChangeSetId:
        "arn:aws:cloudformation:eu-west-1:817685572750:changeSet/root/12345678-1234-1234-1234-123456789abc",
    },
  ];
  for (const mutation of mutations) {
    const harness = fakeHarness({
      processed: processed(3),
      prefix: 3,
      changeSets: [],
      ...mutation,
    });
    try {
      const result = runFakeMigration(harness);
      assert.notEqual(result.status, 0);
      assert.equal(harness.readState().executed, undefined);
    } finally {
      harness.cleanup();
    }
  }
});

test("process runtime repeats the full retained preflight immediately before execution", () => {
  const mutations = [
    { preexecuteStackStatus: "CREATE_COMPLETE" },
    {
      preexecuteStackId:
        "arn:aws:cloudformation:eu-west-1:817685572750:stack/dataops-v1/87654321-1234-1234-1234-123456789abc",
    },
    { preexecuteLogicalResourceId: "OtherTable" },
    { preexecutePhysicalResourceId: "different-table" },
    { preexecuteProcessed: processed(2) },
    { preexecutePrefix: 2 },
    { preexecuteTableId: "different-table-id-12345678" },
  ];
  for (const mutation of mutations) {
    const harness = fakeHarness({
      processed: processed(3),
      prefix: 3,
      changeSets: [],
      ...mutation,
    });
    try {
      const result = runFakeMigration(harness);
      assert.notEqual(result.status, 0);
      assert.equal(harness.readState().executed, undefined);
    } finally {
      harness.cleanup();
    }
  }
});

test("process runtime preserves the full non-GSI table snapshot after every stage", () => {
  const mutations = [
    { postTableId: "different-table-id-12345678" },
    {
      postTableArn:
        "arn:aws:dynamodb:eu-west-1:817685572750:table/different-table",
    },
    {
      postKeySchema: [
        { AttributeName: "SK", KeyType: "HASH" },
        { AttributeName: "PK", KeyType: "RANGE" },
      ],
    },
    { postBillingModeSummary: { BillingMode: "PROVISIONED" } },
    {
      postSseDescription: {
        Status: "ENABLED",
        SSEType: "AES256",
      },
    },
    { postPitrStatus: "DISABLED" },
    { postContinuousBackupsStatus: "DISABLED" },
    { postPitrRecoveryPeriodInDays: 7 },
    { postTtlAttribute: "expires_at" },
    { postTtlStatus: "DISABLED" },
    {
      postStreamSpecification: {
        StreamEnabled: true,
        StreamViewType: "KEYS_ONLY",
      },
    },
    { postStreamLabel: "2026-07-31T00:00:01.000" },
    {
      postStreamArn:
        `${TABLE_ARN}/stream/2026-07-31T00:00:01.000`,
    },
    {
      postTableTags: [
        ...SYSTEM_TAGS,
        { Key: "changed", Value: "during-migration" },
      ],
    },
    { postPhysicalResourceId: "different-table" },
  ];
  for (const mutation of mutations) {
    const harness = fakeHarness({
      processed: processed(3),
      prefix: 3,
      changeSets: [],
      ...mutation,
    });
    try {
      const result = runFakeMigration(harness);
      assert.notEqual(result.status, 0);
      assert.equal(harness.readState().executed?.length, 1);
    } finally {
      harness.cleanup();
    }
  }
});

test("process runtime ignores only advancing PITR restoration timestamps", () => {
  const harness = fakeHarness({
    processed: processed(3),
    prefix: 3,
    changeSets: [],
    postPitrEarliest: 1785457000,
    postPitrLatest: 1785461000,
  });
  try {
    const result = runFakeMigration(harness);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(harness.readState().executed?.length, 1);
  } finally {
    harness.cleanup();
  }
});

test("process runtime rejects unrelated full Processed drift after a stage", () => {
  const drifted = processed(4);
  drifted.Resources.Unrelated.Properties.QueueName = "unrelated-drift";
  const harness = fakeHarness({
    processed: processed(3),
    prefix: 3,
    changeSets: [],
    postProcessedTemplate: drifted,
  });
  try {
    const result = runFakeMigration(harness);
    assert.notEqual(result.status, 0);
    assert.equal(harness.readState().executed?.length, 1);
  } finally {
    harness.cleanup();
  }
});

test("completion rejects unrelated same-prefix full Processed drift", () => {
  const drifted = processed(4);
  drifted.Resources.Unrelated.Properties.QueueName = "unrelated-final-drift";
  const harness = fakeHarness({
    processed: processed(4),
    prefix: 4,
    changeSets: [],
    preexecuteProcessed: drifted,
  });
  try {
    const result = runFakeMigration(harness);
    assert.notEqual(result.status, 0);
    assert.equal(harness.readState().executed, undefined);
  } finally {
    harness.cleanup();
  }
});

test("completion makes empty paginated inventory the literal final AWS read", () => {
  const harness = fakeHarness({
    processed: processed(4),
    prefix: 4,
    changeSets: [],
    injectCandidateOnTagListCount: 2,
    injectedCandidate: foreignCandidate(),
  });
  try {
    const result = runFakeMigration(harness);
    assert.notEqual(result.status, 0);
    const state = harness.readState();
    assert.equal(state.calls.at(-1).service, "cloudformation");
    assert.equal(state.calls.at(-1).operation, "list-change-sets");
    assert.equal(state.executed, undefined);
  } finally {
    harness.cleanup();
  }
});

test("process runtime rejects an EVIL same-name change set before execution", () => {
  const baseline = processed(0);
  const staged = buildStageTemplate(baseline, 0);
  const target = validateTargetTemplate(
    parseTemplate(readFileSync("infra/template.full.yaml", "utf8")),
  );
  const expected = stageIdentity({
    repository: CONTRACT.repository,
    ref: CONTRACT.ref,
    deploymentDigest: "a".repeat(40),
    targetDigest: target.targetDigest,
    baselineTemplate: baseline,
    ordinal: 0,
    stagedTemplate: staged,
    attemptNonce: "100:1",
  });
  const evil = structuredClone(staged);
  sponsorTable(evil).Properties.AttributeDefinitions.push({
    AttributeName: "EVIL",
    AttributeType: "S",
  });
  const harness = fakeHarness({
    processed: baseline,
    prefix: 0,
    changeSets: [processCandidate(expected, evil)],
  });
  try {
    const result = runFakeMigration(harness);
    assert.notEqual(result.status, 0);
    const state = harness.readState();
    assert.equal(state.executed, undefined);
    assert.match(result.stderr, /failed closed: contract-violation/);
  } finally {
    harness.cleanup();
  }
});

test("fresh dispatch deletes one exact prior-run unexecuted candidate and creates fresh", () => {
  const baseline = processed(0);
  const staged = buildStageTemplate(baseline, 0);
  const target = validateTargetTemplate(
    parseTemplate(readFileSync("infra/template.full.yaml", "utf8")),
  );
  const stale = stageIdentity({
    repository: CONTRACT.repository,
    ref: CONTRACT.ref,
    deploymentDigest: "a".repeat(40),
    targetDigest: target.targetDigest,
    baselineTemplate: baseline,
    ordinal: 0,
    stagedTemplate: staged,
    attemptNonce: "99:7",
  });
  const harness = fakeHarness({
    processed: baseline,
    prefix: 0,
    changeSets: [processCandidate(stale, staged, "AVAILABLE")],
  });
  try {
    const result = runFakeMigration(harness);
    assert.equal(result.status, 0, result.stderr);
    const state = harness.readState();
    assert.deepEqual(state.deleted, [stale.name]);
    const deleteCall = state.calls.find(
      (call) =>
        call.service === "cloudformation" &&
        call.operation === "delete-change-set",
    );
    assert.equal(
      deleteCall.args[deleteCall.args.indexOf("--change-set-name") + 1],
      state.changeSets[0].ChangeSetId,
    );
    assert.equal(state.executed.length, 4);
    assert.notEqual(state.executed[0], stale.name);
    assert.equal(
      state.changeSets.filter((candidate) => candidate.listed !== false).length,
      0,
    );
  } finally {
    harness.cleanup();
  }
});

test("fresh dispatch revalidates singleton candidate and retained state before deletion", () => {
  const baseline = processed(0);
  const staged = buildStageTemplate(baseline, 0);
  const target = validateTargetTemplate(
    parseTemplate(readFileSync("infra/template.full.yaml", "utf8")),
  );
  const staleIdentity = stageIdentity({
    repository: CONTRACT.repository,
    ref: CONTRACT.ref,
    deploymentDigest: "a".repeat(40),
    targetDigest: target.targetDigest,
    baselineTemplate: baseline,
    ordinal: 0,
    stagedTemplate: staged,
    attemptNonce: "99:7",
  });
  const stale = processCandidate(staleIdentity, staged);
  const staleSummary = {
    ChangeSetId: stale.ChangeSetId,
    ChangeSetName: stale.ChangeSetName,
    Status: stale.Status,
    ExecutionStatus: stale.ExecutionStatus,
  };
  for (const mutation of [
    {
      substituteOnList: 2,
      substituteSummaries: [staleSummary, foreignCandidate()],
    },
    { substituteOnDescribe: 2 },
    { preexecuteTableId: "different-valid-table-id-12345678" },
  ]) {
    const harness = fakeHarness({
      processed: baseline,
      prefix: 0,
      changeSets: [stale],
      ...mutation,
    });
    try {
      const result = runFakeMigration(harness);
      assert.notEqual(result.status, 0);
      const state = harness.readState();
      assert.equal(state.deleted, undefined);
      assert.equal(state.executed, undefined);
    } finally {
      harness.cleanup();
    }
  }
});

test("process runtime refuses a prior-run candidate that is no longer executable", () => {
  const baseline = processed(0);
  const staged = buildStageTemplate(baseline, 0);
  const target = validateTargetTemplate(
    parseTemplate(readFileSync("infra/template.full.yaml", "utf8")),
  );
  const stale = stageIdentity({
    repository: CONTRACT.repository,
    ref: CONTRACT.ref,
    deploymentDigest: "a".repeat(40),
    targetDigest: target.targetDigest,
    baselineTemplate: baseline,
    ordinal: 0,
    stagedTemplate: staged,
    attemptNonce: "99:7",
  });
  for (const executionStatus of ["EXECUTE_FAILED", "OBSOLETE"]) {
    const harness = fakeHarness(
      {
        processed: baseline,
        prefix: 0,
        changeSets: [processCandidate(stale, staged, executionStatus)],
      },
    );
    try {
      const result = runFakeMigration(harness);
      assert.notEqual(result.status, 0);
      const state = harness.readState();
      assert.equal(state.deleted, undefined);
      assert.equal(state.executed, undefined);
    } finally {
      harness.cleanup();
    }
  }
});

test("process runtime refuses future or unrelated stale run lineage", () => {
  const baseline = processed(0);
  const staged = buildStageTemplate(baseline, 0);
  const target = validateTargetTemplate(
    parseTemplate(readFileSync("infra/template.full.yaml", "utf8")),
  );
  for (const attemptNonce of ["101:1", "100:2"]) {
    const forged = stageIdentity({
    repository: CONTRACT.repository,
    ref: CONTRACT.ref,
      deploymentDigest: "a".repeat(40),
      targetDigest: target.targetDigest,
      baselineTemplate: baseline,
      ordinal: 0,
      stagedTemplate: staged,
      attemptNonce,
    });
    const harness = fakeHarness(
      {
        processed: baseline,
        prefix: 0,
        changeSets: [
          processCandidate(forged, staged, "EXECUTE_FAILED"),
        ],
      },
    );
    try {
      const result = runFakeMigration(harness);
      assert.notEqual(result.status, 0);
      const state = harness.readState();
      assert.equal(state.deleted, undefined);
      assert.equal(state.executed, undefined);
    } finally {
      harness.cleanup();
    }
  }
});

test("fresh dispatch refuses stale binding and request-field mismatches", () => {
  const baseline = processed(0);
  const staged = buildStageTemplate(baseline, 0);
  const target = validateTargetTemplate(
    parseTemplate(readFileSync("infra/template.full.yaml", "utf8")),
  );
  const exact = stageIdentity({
    repository: CONTRACT.repository,
    ref: CONTRACT.ref,
    deploymentDigest: "a".repeat(40),
    targetDigest: target.targetDigest,
    baselineTemplate: baseline,
    ordinal: 0,
    stagedTemplate: staged,
    attemptNonce: "99:7",
  });
  const wrongCommit = stageIdentity({
    repository: CONTRACT.repository,
    ref: CONTRACT.ref,
    deploymentDigest: "b".repeat(40),
    targetDigest: target.targetDigest,
    baselineTemplate: baseline,
    ordinal: 0,
    stagedTemplate: staged,
    attemptNonce: "99:7",
  });
  const candidates = [
    processCandidate(wrongCommit, staged),
    {
      ...processCandidate(exact, staged),
      RoleARN: "arn:aws:iam::817685572750:role/evil",
    },
    {
      ...processCandidate(exact, staged),
      Parameters: [],
    },
    {
      ...processCandidate(exact, staged),
      processedTemplate: processed(2),
    },
  ];
  for (const [caseIndex, candidate] of candidates.entries()) {
    const harness = fakeHarness({
      processed: baseline,
      prefix: 0,
      changeSets: [candidate],
    });
    try {
      const result = runFakeMigration(harness);
      assert.notEqual(result.status, 0, `stale mismatch case ${caseIndex}`);
      const state = harness.readState();
      assert.equal(state.deleted, undefined);
      assert.equal(state.executed, undefined);
    } finally {
      harness.cleanup();
    }
  }
});

test("process runtime hard-times out ambiguous AWS calls and still cleans S3", () => {
  for (const [mode, expected] of [
    ["hang-put", "aws-s3api-put-object-timeout"],
    ["hang-create", "aws-cloudformation-create-change-set-timeout"],
  ]) {
    const harness = fakeHarness(
      {
        processed: processed(0),
        prefix: 0,
        mode,
        ignoreTermination: true,
        changeSets: [],
      },
      { SPONSOR_GSI_AWS_CALL_TIMEOUT_MS: "300" },
    );
    try {
      const result = runFakeMigration(harness);
      assert.notEqual(result.status, 0);
      const state = harness.readState();
      assert.equal(state.cleanupCount, 1);
      assert.equal(state.uploaded, null);
      assert.match(result.stderr, new RegExp(`failed closed: ${expected}`));
    } finally {
      harness.cleanup();
    }
  }
});

test("AWS output cap is strict and kills the flooding child before mutation", () => {
  const harness = fakeHarness(
    {
      processed: processed(0),
      prefix: 0,
      floodOperation: "sts:get-caller-identity",
      ignoreTermination: true,
      changeSets: [],
    },
    {
      SPONSOR_GSI_AWS_MAX_OUTPUT_BYTES: "1024",
      SPONSOR_GSI_AWS_CALL_TIMEOUT_MS: "2000",
    },
  );
  try {
    const result = runFakeMigration(harness);
    assert.notEqual(result.status, 0);
    assert.match(
      result.stderr,
      /failed closed: aws-sts-get-caller-identity-output-limit/,
    );
    assert.deepEqual(mutationCalls(harness.readState()), []);
  } finally {
    harness.cleanup();
  }
});

test("signal cancellation terminates the current AWS process group before completion", async () => {
  for (const operationKey of [
    "sts:get-caller-identity",
    "s3api:put-object",
    "cloudformation:create-change-set",
    "cloudformation:execute-change-set",
  ]) {
    const harness = fakeHarness({
      processed: processed(0),
      prefix: 0,
      hangOperation: operationKey,
      ignoreTermination: true,
      changeSets: [],
    });
    try {
      const child = spawn(
        process.execPath,
        [
          "scripts/deploy/sponsor-crm-gsi-migrator.mjs",
          "migrate",
          "infra/template.full.yaml",
          "infra/template.full.yaml",
        ],
        {
          cwd: process.cwd(),
          env: harness.env,
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      let stderr = "";
      child.stderr.on("data", (chunk) => {
        stderr += chunk;
      });
      await waitForState(
        harness,
        (state) => state.hangStarted === operationKey,
      );
      const started = Date.now();
      const exited = new Promise((resolve) => {
        child.once("exit", (code, signal) => resolve({ code, signal }));
      });
      child.kill("SIGTERM");
      const result = await Promise.race([
        exited,
        new Promise((_, reject) =>
          setTimeout(
            () => reject(new Error("cancelled migrator did not exit")),
            2000,
          ),
        ),
      ]);
      assert.ok(
        result.code !== 0 || result.signal,
        "cancelled migrator unexpectedly succeeded",
      );
      assert.ok(Date.now() - started < 2000);
      const state = harness.readState();
      assert.equal(state.hangCompleted, undefined);
      assert.equal(state.executed, undefined);
      assert.match(stderr, /failed closed: cancelled/);
      if (
        operationKey === "s3api:put-object" ||
        operationKey === "cloudformation:create-change-set"
      ) {
        assert.equal(state.cleanupCount, 1);
        assert.equal(state.uploaded, null);
      }
    } finally {
      harness.cleanup();
    }
  }
});

test("process runtime fails closed when cancellation-safe cleanup itself fails", () => {
  const harness = fakeHarness({
    processed: processed(0),
    prefix: 0,
    mode: "delete-fail",
    changeSets: [],
  });
  try {
    const result = runFakeMigration(harness);
    assert.notEqual(result.status, 0);
    const state = harness.readState();
    assert.equal(state.cleanupCount, 1);
    assert.equal(state.executed, undefined);
    assert.match(result.stderr, /failed closed: aws-s3api-delete-object/);
  } finally {
    harness.cleanup();
  }
});

test("process runtime refuses unapproved workflow_dispatch actor before AWS", () => {
  const harness = fakeHarness(
    { processed: processed(0), prefix: 0, changeSets: [] },
    { GITHUB_EVENT_NAME: "workflow_dispatch", GITHUB_ACTOR: "unapproved" },
  );
  try {
    const result = runFakeMigration(harness);
    assert.notEqual(result.status, 0);
    assert.deepEqual(harness.readState().calls, undefined);
  } finally {
    harness.cleanup();
  }
});

test("read-only deployment guard blocks incomplete prefixes without mutation", () => {
  const expectedCalls = [
    "sts:get-caller-identity",
    "cloudformation:describe-stacks",
    "cloudformation:describe-stack-resource",
    "cloudformation:get-template",
    "dynamodb:describe-table",
    "dynamodb:describe-continuous-backups",
    "dynamodb:list-tags-of-resource",
  ];
  for (let prefix = 0; prefix < STAGES.length; prefix += 1) {
    const harness = fakeHarness({
      processed: processed(prefix),
      prefix,
      changeSets: [],
    }, { GITHUB_EVENT_NAME: "push" });
    try {
      const result = runFakeGuard(harness);
      assert.notEqual(result.status, 0);
      assert.equal(
        result.stderr.trim(),
        "Sponsor CRM deployment guard failed closed: dispatch-migrate-sponsor-crm-gsis",
      );
      const state = harness.readState();
      assert.deepEqual(
        state.calls.map(({ service, operation }) => `${service}:${operation}`),
        expectedCalls,
      );
      assert.deepEqual(mutationCalls(state), []);
    } finally {
      harness.cleanup();
    }
  }
});

test("read-only deployment guard emits stable sanitized assertion categories", () => {
  const sensitive = "DO-NOT-LEAK-817685572750-table-id-template";
  const retainedDrift = processed(STAGES.length);
  retainedDrift.Resources[CONTRACT.logicalId].Properties.BillingMode =
    sensitive;

  const cases = [
    {
      code: "guard-cloudformation-stack-identity",
      mutation: { stackId: sensitive },
    },
    {
      code: "guard-cloudformation-stack-health",
      mutation: { stackStatus: "UPDATE_IN_PROGRESS" },
    },
    {
      code: "guard-cloudformation-resource-identity",
      mutation: { physicalResourceId: sensitive },
    },
    {
      code: "guard-table-identity",
      mutation: { tableArn: sensitive },
    },
    {
      code: "guard-cloudformation-table-tag-read",
      mutation: { tableTags: sensitive },
    },
    {
      code: "guard-cloudformation-table-stack-id",
      mutation: {
        tableTags: SYSTEM_TAGS.map((tag) =>
          tag.Key === "aws:cloudformation:stack-id"
            ? { ...tag, Value: sensitive }
            : tag,
        ),
      },
    },
    {
      code: "guard-cloudformation-table-logical-id",
      mutation: {
        tableTags: SYSTEM_TAGS.filter(
          (tag) => tag.Key !== "aws:cloudformation:logical-id",
        ),
      },
    },
    {
      code: "guard-cloudformation-table-stack-name",
      mutation: {
        tableTags: SYSTEM_TAGS.map((tag) =>
          tag.Key === "aws:cloudformation:stack-name"
            ? { ...tag, Value: sensitive }
            : tag,
        ),
      },
    },
    {
      code: "guard-processed-retained-state",
      mutation: { processed: retainedDrift },
    },
    {
      code: "guard-table-health-schema",
      mutation: { pitrStatus: sensitive },
    },
    {
      code: "guard-processed-live-prefix-drift",
      mutation: { processed: processed(0), prefix: 1 },
    },
  ];

  for (const { code, mutation } of cases) {
    const harness = fakeHarness({
      processed: processed(STAGES.length),
      prefix: STAGES.length,
      changeSets: [],
      ...mutation,
    }, { GITHUB_EVENT_NAME: "push" });
    try {
      const result = runFakeGuard(harness);
      assert.notEqual(result.status, 0);
      assert.equal(
        result.stderr.trim(),
        `Sponsor CRM deployment guard failed closed: ${code}`,
      );
      assert.ok(!result.stderr.includes(sensitive));
      assert.ok(!result.stderr.includes(TABLE_ARN));
      assert.ok(!result.stderr.includes(TABLE_ID));
      assert.ok(!result.stderr.includes(STACK_ID));
      assert.deepEqual(mutationCalls(harness.readState()), []);
    } finally {
      harness.cleanup();
    }
  }
});

test("read-only deployment guard preserves sanitized AWS tag-read failures", () => {
  const harness = fakeHarness({
    processed: processed(STAGES.length),
    prefix: STAGES.length,
    changeSets: [],
    failOperation: "dynamodb:list-tags-of-resource",
  }, { GITHUB_EVENT_NAME: "push" });
  try {
    const result = runFakeGuard(harness);
    assert.notEqual(result.status, 0);
    assert.equal(
      result.stderr.trim(),
      "Sponsor CRM deployment guard failed closed: aws-dynamodb-list-tags-of-resource",
    );
    assert.deepEqual(mutationCalls(harness.readState()), []);
  } finally {
    harness.cleanup();
  }
});

test("read-only deployment guard accepts only the exact active four-index table", () => {
  const accepted = fakeHarness({
    processed: processed(STAGES.length),
    prefix: STAGES.length,
    changeSets: [],
    ttlStatus: "DISABLED",
    streamSpecification: { StreamEnabled: false },
    streamLabel: null,
    streamArn: null,
  }, { GITHUB_EVENT_NAME: "push" });
  try {
    const result = runFakeGuard(accepted);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /deployment-guard-ready/);
    assert.deepEqual(mutationCalls(accepted.readState()), []);
  } finally {
    accepted.cleanup();
  }

  const observedDifferentTableId = fakeHarness({
    processed: processed(STAGES.length),
    prefix: STAGES.length,
    tableId: "different-valid-table-id-12345678",
    changeSets: [],
  }, { GITHUB_EVENT_NAME: "push" });
  try {
    const result = runFakeGuard(observedDifferentTableId);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(mutationCalls(observedDifferentTableId.readState()), []);
  } finally {
    observedDifferentTableId.cleanup();
  }

  for (const mutation of [
    { tableId: "" },
    { prefix: 3 },
    {
      stackId:
        "arn:aws:cloudformation:eu-west-1:817685572750:stack/dataops-v1/87654321-1234-1234-1234-123456789abc",
    },
    { logicalResourceId: "OtherTable" },
    { physicalResourceId: "different-table" },
    { tableName: "different-table" },
    {
      tableArn:
        "arn:aws:dynamodb:eu-west-1:817685572750:table/different-table",
    },
    {
      tableTags: SYSTEM_TAGS.filter(
        (tag) => tag.Key !== "aws:cloudformation:logical-id",
      ),
    },
    {
      tableTags: SYSTEM_TAGS.map((tag) =>
        tag.Key === "aws:cloudformation:stack-name"
          ? { ...tag, Value: "different-stack" }
          : tag,
      ),
    },
  ]) {
    const harness = fakeHarness({
      processed: processed(STAGES.length),
      prefix: STAGES.length,
      changeSets: [],
      ...mutation,
    }, { GITHUB_EVENT_NAME: "push" });
    try {
      const result = runFakeGuard(harness);
      assert.notEqual(result.status, 0);
      assert.deepEqual(mutationCalls(harness.readState()), []);
    } finally {
      harness.cleanup();
    }
  }
});

test("read-only deployment guard bounds hanging and flooding AWS reads", () => {
  for (const [field, failure] of [
    ["hangOperation", "timeout"],
    ["floodOperation", "(?:output-limit|timeout)"],
  ]) {
    const harness = fakeHarness(
      {
        processed: processed(STAGES.length),
        prefix: STAGES.length,
        changeSets: [],
        [field]: "dynamodb:describe-table",
        ignoreTermination: true,
      },
      {
        GITHUB_EVENT_NAME: "push",
        SPONSOR_GSI_AWS_CALL_TIMEOUT_MS:
          field === "floodOperation" ? "2000" : "200",
        ...(field === "floodOperation"
          ? { SPONSOR_GSI_AWS_MAX_OUTPUT_BYTES: "200000" }
          : {}),
      },
    );
    try {
      const result = runFakeGuard(harness);
      assert.notEqual(result.status, 0);
      assert.match(
        result.stderr,
        new RegExp(`aws-dynamodb-describe-table-${failure}`),
      );
      assert.deepEqual(mutationCalls(harness.readState()), []);
    } finally {
      harness.cleanup();
    }
  }
});

test("stage migrator and read-only guard keep separate operation surfaces", () => {
  const migrator = readFileSync(
    "scripts/deploy/sponsor-crm-gsi-migrator.mjs",
    "utf8",
  );
  const guard = readFileSync(
    "scripts/deploy/sponsor-crm-gsi-guard.mjs",
    "utf8",
  );
  assert.ok(!migrator.includes("UpdateTable"));
  assert.ok(!migrator.includes("update-table"));
  assert.ok(!migrator.includes("sam package"));
  assert.ok(!migrator.includes("sam deploy"));
  assert.ok(!migrator.includes("final-create"));
  assert.ok(!migrator.includes("final-execute"));
  assert.ok(!migrator.includes("manifest"));
  assert.ok(!migrator.includes("translator"));
  assert.match(migrator, /candidate = await createStageChangeSet/);
  assert.match(migrator, /SPONSOR_GSI_STACK_TIMEOUT_MS/);
  assert.match(migrator, /SPONSOR_GSI_TABLE_TIMEOUT_MS/);
  assert.match(migrator, /SPONSOR_GSI_CHANGE_SET_TIMEOUT_MS/);
  assert.match(migrator, /terminateAwsChild\(record, "timeout"\)/);
  assert.match(migrator, /process\.kill\(-child\.pid, signal\)/);
  assert.match(migrator, /killProcessGroup\(record\.child, "SIGKILL"\)/);
  assert.match(migrator, /"list-change-sets"/);
  assert.match(migrator, /--starting-token/);
  assert.match(migrator, /GITHUB_ACTOR !== "alexeygrigorev"/);

  for (const forbidden of [
    "create-change-set",
    "delete-change-set",
    "execute-change-set",
    "put-object",
    "delete-object",
    "update-table",
    "sam package",
    "sam deploy",
  ]) {
    assert.ok(!guard.includes(forbidden));
  }
  assert.match(guard, /dispatch-migrate-sponsor-crm-gsis/);
  assert.match(guard, /inspectProcessedPrefix\(processed\)/);
  assert.match(guard, /inspectLivePrefix\(table\)/);
  assert.match(guard, /guard-processed-live-prefix-drift/);
});

test("workflows separate protected migration from guarded unchanged app deploy", () => {
  const deploy = readFileSync(
    ".github/workflows/deploy-dataops-v1.yml",
    "utf8",
  );
  const migration = readFileSync(
    ".github/workflows/migrate-sponsor-crm-gsis.yml",
    "utf8",
  );
  const deployJob = deploy.slice(deploy.indexOf("\n  deploy:\n"));
  const guard = deployJob.indexOf(
    "node scripts/deploy/sponsor-crm-gsi-guard.mjs infra/template.full.yaml",
  );
  const oidc = deployJob.indexOf("aws-actions/configure-aws-credentials@");
  assert.ok(guard > 0);
  assert.ok(oidc > 0);
  assert.ok(guard > oidc);
  for (const operation of [
    "make sam-build",
    "sam deploy",
    "sam package",
    "aws s3api put-object",
    "aws cloudformation create-change-set",
    "aws cloudformation execute-change-set",
    "Seed runtime users, workflow templates, and recurring configs",
  ]) {
    const position = deployJob.indexOf(operation);
    if (position >= 0) assert.ok(position > guard, `${operation} precedes guard`);
  }
  const appDeploy = deployJob.indexOf("sam deploy");
  const appDeployEnd = deployJob.indexOf(
    "\n\n      - name: Seed runtime users",
    appDeploy,
  );
  assert.equal(
    digest(deployJob.slice(appDeploy, appDeployEnd).trim()),
    "5a6f6391d8be4c5b6219e5e9c94d7249d312ccab1d743b4d7bf20cb6d082d270",
    "the existing application sam deploy command changed",
  );
  assert.ok(!deploy.includes("sponsor-crm-gsi-migrator.mjs"));
  assert.ok(!deploy.includes("sam package"));
  assert.ok(!deploy.includes("final-create"));
  assert.ok(!deploy.includes("final-execute"));

  assert.match(migration, /^on:\n  workflow_dispatch:/m);
  assert.match(migration, /if: github\.actor == 'alexeygrigorev'/);
  assert.match(migration, /environment: dataops-v1-production/);
  assert.match(migration, /id-token: write/);
  assert.match(migration, /migrate infra\/template\.full\.yaml infra\/template\.full\.yaml/);
  assert.match(migration, /concurrency:\n  group: dataops-v1-deploy\n  cancel-in-progress: false/);
  assert.ok(!migration.includes("sam package"));
  assert.ok(!migration.includes("sam deploy"));
  assert.ok(!migration.includes("sponsor-crm-gsi-guard.mjs"));
});
