import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import test from "node:test";
import yaml from "js-yaml";
import {
  CONTRACT,
  NO_RECEIPT,
  NO_RECEIPT_DIGEST,
  PHASES,
  PROTECTED_FILES,
  approvalFor,
  assertPoststateEqual,
  bindCandidateInventory,
  canonicalJson,
  completionKey,
  deriveOperationId,
  deriveResetId,
  digest,
  intentKey,
  loadPrefixZeroFixture,
  makeCompletion,
  makeIntent,
  parseReceiptInputs,
  receiptFor,
  recordDigest,
  validateCandidate,
  validateCandidatePage,
  validateChangeList,
  validateCompletion,
  validateIntent,
  validateProcessedBaseline,
  validateRuntimeEnvironment,
  validateStackIdAnchor,
} from "./sponsor-crm-reset-core.mjs";
import { AwsCli, S3PrivateLedger, classifyResume, runPhase } from "./sponsor-crm-reset.mjs";
import { parseTemplate } from "./sponsor-crm-gsi-core.mjs";

const SHA = "a".repeat(40);
const STACK_ID = "arn:aws:cloudformation:eu-west-1:817685572750:stack/dataops-v1/12345678-1234-1234-1234-123456789abc";
const STACK_ANCHOR = `sha256:${digest(STACK_ID)}`;
const OLD_ID = "old-table-id-12345678";
const NEW_ID = "new-table-id-12345678";
const CANDIDATE_CREATED = "2026-08-11T12:00:00.000Z";
const TABLE_RECREATION = Object.freeze({
  AttributeDefinitions: "Conditionally", BillingMode: "Never", KeySchema: "Always",
  PointInTimeRecoverySpecification: "Never", SSESpecification: "Never", TableName: "Always",
});

function dispatchEnv(phase, prior, approval) {
  const receiptId = prior?.receipt_id ?? NO_RECEIPT;
  const receiptDigest = prior?.receipt_digest ?? NO_RECEIPT_DIGEST;
  return {
    GITHUB_EVENT_NAME: "workflow_dispatch",
    GITHUB_ACTOR: CONTRACT.actor,
    GITHUB_REPOSITORY: CONTRACT.repository,
    GITHUB_REPOSITORY_OWNER: CONTRACT.owner,
    GITHUB_REF: CONTRACT.ref,
    GITHUB_SHA: SHA,
    GITHUB_RUN_ID: "12345",
    GITHUB_RUN_ATTEMPT: "1",
    AWS_REGION: CONTRACT.region,
    AWS_DEFAULT_REGION: CONTRACT.region,
    AWS_ROLE_ARN: CONTRACT.roleArn,
    SPONSOR_RESET_PHASE: phase,
    SPONSOR_RESET_STACK_ID_DIGEST: STACK_ANCHOR,
    SPONSOR_RESET_RECEIPT_ID: receiptId,
    SPONSOR_RESET_RECEIPT_DIGEST: receiptDigest,
    SPONSOR_RESET_APPROVAL: approval ?? approvalFor(phase, receiptDigest),
  };
}

function processed() {
  const fixture = loadPrefixZeroFixture();
  return {
    AWSTemplateFormatVersion: "2010-09-09",
    Resources: {
      [CONTRACT.logicalId]: structuredClone(fixture.tableResource),
      BackendFunction: {
        Type: "AWS::Lambda::Function",
        Properties: { Environment: { Variables: { DATAOPS_SPONSOR_CRM_TABLE: { Ref: CONTRACT.logicalId } } } },
      },
      BackendFunctionRole: {
        Type: "AWS::IAM::Role",
        Properties: { Policies: [{ PolicyDocument: { Statement: {
          Action: ["dynamodb:DeleteItem", "dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:Query", "dynamodb:Scan", "dynamodb:TransactWriteItems", "dynamodb:UpdateItem"],
          Resource: [...Array.from({ length: 15 }, (_, index) => `arn:aws:dynamodb:eu-west-1:817685572750:table/unrelated-${index}`), { "Fn::GetAtt": [CONTRACT.logicalId, "Arn"] }],
        } } }] },
      },
    },
  };
}

function table({ fresh = false, protection = false, status = "ACTIVE" } = {}) {
  return {
    TableName: CONTRACT.physicalTable,
    TableArn: CONTRACT.tableArn,
    TableId: fresh ? NEW_ID : OLD_ID,
    TableStatus: status,
    BillingModeSummary: { BillingMode: "PAY_PER_REQUEST" },
    SSEDescription: { Status: "ENABLED", SSEType: "AES256" },
    DeletionProtectionEnabled: protection,
    KeySchema: [{ AttributeName: "PK", KeyType: "HASH" }, { AttributeName: "SK", KeyType: "RANGE" }],
    AttributeDefinitions: [{ AttributeName: "PK", AttributeType: "S" }, { AttributeName: "SK", AttributeType: "S" }],
    ItemCount: 0,
    TableSizeBytes: 0,
  };
}

function candidateChanges() {
  const fixture = loadPrefixZeroFixture();
  return [
    { Type: "Resource", ResourceChange: {
      Action: "Add", LogicalResourceId: CONTRACT.logicalId, ResourceType: "AWS::DynamoDB::Table",
      Replacement: "True", Scope: ["Properties"],
      Details: Object.entries(fixture.tableResource.Properties).map(([Name, value]) => ({
        ChangeSource: "DirectModification", Evaluation: "Static",
        Target: { Attribute: "Properties", Name, RequiresRecreation: TABLE_RECREATION[Name], BeforeValue: null, AfterValue: canonicalJson(value) },
      })),
    } },
  ];
}

class MemoryLedger {
  constructor() { this.records = new Map(); this.failNextCompletion = false; this.puts = []; }
  async verifyControlPlane() {}
  async listKeys(prefix) { return [...this.records.keys()].filter((key) => key.startsWith(prefix)).sort(); }
  async getRecord(key) { const record = this.records.get(key); return record ? { record: structuredClone(record), versionId: "v1", checksum: "x" } : undefined; }
  async putRecord(key, record) {
    this.puts.push(key);
    if (key.includes("/completion-") && this.failNextCompletion) { this.failNextCompletion = false; throw new Error("simulated completion interruption"); }
    const existing = this.records.get(key);
    if (existing) assert.deepEqual(existing, record, "CAS conflict");
    else this.records.set(key, structuredClone(record));
    return { created: !existing, record: structuredClone(record), versionId: "v1", checksum: "x" };
  }
  async findReceipt(receipt) {
    const matches = [...this.records.values()].filter((record) => record.kind === "completion" && receiptFor(record).receiptId === receipt.receiptId);
    assert.equal(matches.length, 1, "opaque receipt is absent or ambiguous");
    return structuredClone(matches[0]);
  }
}

class MockAws {
  constructor({ protection = false } = {}) {
    this.present = true; this.fresh = false; this.protection = protection; this.tableStatus = "ACTIVE";
    this.candidate = false; this.candidateStatus = "CREATE_COMPLETE"; this.candidateExecution = "AVAILABLE";
    this.stackStatus = "UPDATE_ROLLBACK_COMPLETE"; this.calls = []; this.template = processed();
  }
  async pause() {
    if (this.progressOperation === "update-table") this.tableStatus = "ACTIVE";
    if (this.progressOperation === "delete-table") { this.present = false; this.tableStatus = "ACTIVE"; }
    if (this.progressOperation === "create-change-set") this.candidateStatus = "CREATE_COMPLETE";
    if (this.progressOperation === "execute-change-set") { this.candidate = false; this.present = true; this.fresh = true; this.stackStatus = "UPDATE_COMPLETE"; }
    if (this.progressOperation === "delete-change-set") this.candidate = false;
    this.progressOperation = undefined;
  }
  async call(service, operation, args = [], options = {}) {
    this.calls.push({ service, operation, args: structuredClone(args) });
    if (service === "sts") return { Account: CONTRACT.account, Arn: `arn:aws:sts::${CONTRACT.account}:assumed-role/${CONTRACT.role}/dataops-v1-sponsor-reset` };
    if (service === "cloudformation" && operation === "describe-stacks") return { Stacks: [{
      StackName: CONTRACT.stack, StackId: STACK_ID, StackStatus: this.stackStatus,
      Parameters: [{ ParameterKey: "GitHubOwner", ParameterValue: "DataTalksClub" }, { ParameterKey: "PrivateValue", ParameterValue: "opaque" }],
      Capabilities: ["CAPABILITY_AUTO_EXPAND", "CAPABILITY_IAM"],
    }] };
    if (service === "cloudformation" && operation === "describe-stack-resource") return { StackResourceDetail: {
      StackId: value(args, "--stack-name") === CONTRACT.evidenceManagedStack ? "managed-stack-id" : STACK_ID,
      LogicalResourceId: value(args, "--logical-resource-id"),
      PhysicalResourceId: value(args, "--logical-resource-id") === CONTRACT.evidenceManagedResource ? CONTRACT.evidenceBucket : CONTRACT.physicalTable,
      ResourceType: value(args, "--logical-resource-id") === CONTRACT.evidenceManagedResource ? "AWS::S3::Bucket" : "AWS::DynamoDB::Table",
      ResourceStatus: "CREATE_COMPLETE",
    } };
    if (service === "cloudformation" && operation === "get-template") return { TemplateBody: structuredClone(this.template) };
    if (service === "cloudformation" && operation === "list-stack-resources") {
      const resources = [
      { LogicalResourceId: CONTRACT.logicalId, PhysicalResourceId: CONTRACT.physicalTable, ResourceType: "AWS::DynamoDB::Table", ResourceStatus: "CREATE_COMPLETE" },
      ];
      if (this.extraStackResource) resources.push({ LogicalResourceId: "UnrelatedQueue", PhysicalResourceId: "queue", ResourceType: "AWS::SQS::Queue", ResourceStatus: "CREATE_COMPLETE" });
      return { StackResourceSummaries: resources };
    }
    if (service === "cloudformation" && operation === "list-change-sets") {
      const summaries = this.candidate ? [{
        ChangeSetId: this.inventoryArnOverride ?? this.candidateArn, ChangeSetName: this.candidateName, Status: this.candidateStatus, ExecutionStatus: this.candidateExecution,
      }] : [];
      if (this.candidate && this.extraCandidate) summaries.push({ ChangeSetId: `${this.candidateArn}-foreign`, ChangeSetName: "foreign", Status: "CREATE_COMPLETE", ExecutionStatus: "AVAILABLE" });
      return { Summaries: summaries, ...(this.paginationLoop ? { NextToken: "repeat" } : {}) };
    }
    if (service === "dynamodb" && operation === "describe-table") {
      if (!this.present) { if (options.allowNotFound) return undefined; assert.fail("unexpected absent table"); }
      return { Table: table({ fresh: this.fresh, protection: this.protection, status: this.tableStatus }) };
    }
    if (service === "dynamodb" && operation === "describe-continuous-backups") return { ContinuousBackupsDescription: { PointInTimeRecoveryDescription: { PointInTimeRecoveryStatus: "ENABLED" } } };
    if (service === "dynamodb" && operation === "describe-time-to-live") return { TimeToLiveDescription: { TimeToLiveStatus: "DISABLED" } };
    if (service === "dynamodb" && operation === "list-tags-of-resource") return { Tags: this.fresh ? [
      { Key: "aws:cloudformation:stack-name", Value: CONTRACT.stack }, { Key: "aws:cloudformation:logical-id", Value: CONTRACT.logicalId }, { Key: "aws:cloudformation:stack-id", Value: STACK_ID },
    ] : [] };
    if (service === "dynamodb" && operation === "update-table") {
      assert.deepEqual(args.slice(0, 2), ["--table-name", CONTRACT.physicalTable]);
      this.protection = args[2] === "--deletion-protection-enabled";
      if (this.interruptOperation === operation) { this.interruptOperation = undefined; this.progressOperation = operation; this.tableStatus = "UPDATING"; throw new Error("simulated mutation interruption"); }
      return { TableDescription: table({ protection: this.protection }) };
    }
    if (service === "dynamodb" && operation === "delete-table") {
      assert.deepEqual(args, ["--table-name", CONTRACT.physicalTable]);
      if (this.interruptOperation === operation) { this.interruptOperation = undefined; this.progressOperation = operation; this.tableStatus = "DELETING"; throw new Error("simulated mutation interruption"); }
      this.present = false; return { TableDescription: table() };
    }
    if (service === "cloudformation" && operation === "create-change-set") {
      assert.ok(args.includes("--use-previous-template")); assert.equal(value(args, "--deployment-mode"), "REVERT_DRIFT");
      this.candidate = true; this.candidateName = value(args, "--change-set-name"); this.candidateDescription = value(args, "--description");
      this.candidateArn = `arn:aws:cloudformation:eu-west-1:817685572750:changeSet/${this.candidateName}/33333333-3333-3333-3333-333333333333`;
      if (this.interruptOperation === operation) { this.interruptOperation = undefined; this.progressOperation = operation; this.candidateStatus = "CREATE_IN_PROGRESS"; throw new Error("simulated mutation interruption"); }
      return { Id: this.candidateArn, StackId: STACK_ID };
    }
    if (service === "cloudformation" && operation === "describe-change-set") {
      const nextToken = value(args, "--next-token");
      const allChanges = candidateChanges();
      const response = {
        ChangeSetId: this.candidateArn, ChangeSetName: this.candidateName, Description: this.candidateDescription,
        StackName: CONTRACT.stack, StackId: STACK_ID, ChangeSetType: "UPDATE", CreationTime: CANDIDATE_CREATED, Status: this.candidateStatus,
        ExecutionStatus: this.candidateExecution,
        Parameters: [{ ParameterKey: "GitHubOwner", ParameterValue: "DataTalksClub", UsePreviousValue: true }, { ParameterKey: "PrivateValue", ParameterValue: "opaque", UsePreviousValue: true }],
        Capabilities: ["CAPABILITY_AUTO_EXPAND", "CAPABILITY_IAM"], NotificationARNs: [], IncludeNestedStacks: false,
        RollbackConfiguration: { RollbackTriggers: [] },
        Changes: this.paginateCandidate ? (nextToken ? allChanges : []) : allChanges,
        ...((this.paginateCandidate && !nextToken) ? { NextToken: "candidate-page-2" } : {}),
      };
      if (nextToken && this.candidatePageMutation) this.candidatePageMutation(response);
      return response;
    }
    if (service === "cloudformation" && operation === "execute-change-set") {
      assert.equal(value(args, "--change-set-name"), this.candidateArn);
      if (this.interruptOperation === operation) { this.interruptOperation = undefined; this.progressOperation = operation; this.stackStatus = "UPDATE_IN_PROGRESS"; this.candidateExecution = "EXECUTE_IN_PROGRESS"; throw new Error("simulated mutation interruption"); }
      this.candidate = false; this.present = true; this.fresh = true; this.protection = false; this.stackStatus = "UPDATE_COMPLETE"; return {};
    }
    if (service === "cloudformation" && operation === "delete-change-set") {
      assert.equal(value(args, "--change-set-name"), this.candidateArn);
      if (this.interruptOperation === operation) { this.interruptOperation = undefined; this.progressOperation = operation; this.candidateStatus = "DELETE_IN_PROGRESS"; throw new Error("simulated mutation interruption"); }
      this.candidate = false; return {};
    }
    assert.fail(`unexpected AWS call ${service}:${operation}`);
  }
}

function value(args, flag) { const index = args.indexOf(flag); return index < 0 ? undefined : args[index + 1]; }
function targetMutations(mock) { return mock.calls.filter(({ operation }) => ["update-table", "delete-table", "create-change-set", "execute-change-set", "delete-change-set"].includes(operation)); }
async function phase(mock, ledger, name, prior) { return runPhase(dispatchEnv(name, prior), mock, ledger); }

test("canonical fixture freezes exact prefix zero and complete semantic inventory", () => {
  const fixture = loadPrefixZeroFixture();
  const baseline = validateProcessedBaseline(processed(), fixture);
  assert.equal(baseline.fixtureDigest, fixture.fixtureDigest);
  assert.equal(baseline.references.length, fixture.references.length);
  const prefixFour = parseTemplate(readFileSync("infra/template.full.yaml", "utf8"));
  assert.throws(() => validateProcessedBaseline(prefixFour), /prefix 0/);
  for (const mutate of [
    (copy) => { copy.Resources[CONTRACT.logicalId].Properties.Tags = []; },
    (copy) => { copy.Resources[CONTRACT.logicalId].Properties.GlobalSecondaryIndexes = []; },
    (copy) => { copy.Resources.UnknownWriter = { Type: "AWS::Lambda::Function", Properties: { Table: { Ref: CONTRACT.logicalId } } }; },
    (copy) => { copy.Resources.UnknownWriter = { Type: "AWS::Lambda::Function", Properties: { Table: CONTRACT.physicalTable } }; },
    (copy) => { copy.Resources.UnknownWriter = { Type: "AWS::Lambda::Function", Properties: { Table: { "Fn::Sub": "${AWS::StackName}-sponsor-crm" } } }; },
    (copy) => { copy.Resources.UnknownWriter = { Type: "AWS::Lambda::Function", Properties: { Table: { "Fn::Join": ["-", [{ Ref: "AWS::StackName" }, "sponsor", "crm"]] } } }; },
    (copy) => { copy.Resources.UnknownWriter = { Type: "AWS::Lambda::Function", Properties: { TableArn: { "Fn::Sub": "arn:${AWS::Partition}:dynamodb:${AWS::Region}:${AWS::AccountId}:table/${AWS::StackName}-sponsor-crm" } } }; },
    (copy) => { copy.Outputs = { Leak: { Value: { Ref: CONTRACT.logicalId } } }; },
  ]) {
    const changed = processed(); mutate(changed); assert.throws(() => validateProcessedBaseline(changed));
  }
});

test("records, deterministic IDs, opaque receipts, and exact schemas fail closed", () => {
  const resetId = deriveResetId({ stackIdDigest: digest(STACK_ID), sha: SHA, fixtureDigest: "1".repeat(64), oldTableIdDigest: "2".repeat(64) });
  const plannedTargetDigest = "5".repeat(64);
  const operationId = deriveOperationId({ resetId, phase: "delete", sourceSha: SHA, priorCompletionDigest: NO_RECEIPT, plannedTargetDigest });
  const identity = { resetId, ordinal: 20, phase: "delete", operationId, plannedTargetDigest, stackIdDigest: digest(STACK_ID) };
  const intent = makeIntent({ identity, prestate: { private: true }, approval: approvalFor("delete"), target: { service: "dynamodb", operation: "delete-table", argv: ["--table-name", CONTRACT.physicalTable], targetIdentityDigest: "6".repeat(64) }, expectedPostcondition: { absent: true }, github: { repository: CONTRACT.repository, ref: CONTRACT.ref, sha: SHA, actor: CONTRACT.actor, runId: "1", runAttempt: "1" } });
  validateIntent(intent); assert.equal(intentKey(intent).endsWith("/intent.json"), true);
  const completion = makeCompletion({ intent, intentDigest: recordDigest(intent), outcome: "executed-and-verified", poststate: { absent: true } });
  validateCompletion(completion); const receipt = receiptFor(completion);
  assert.deepEqual(parseReceiptInputs(receipt.receiptId, receipt.receiptDigest), { receiptId: receipt.receiptId, operationId, completionDigest: recordDigest(completion) });
  assert.equal(completionKey(intent, recordDigest(completion)).includes(recordDigest(completion)), true);
  for (const mutate of [(copy) => { copy.extra = true; }, (copy) => { copy.sourceSha = "b".repeat(40); }, (copy) => { copy.recordDigest = "0".repeat(64); }]) {
    const changed = structuredClone(intent); mutate(changed); assert.throws(() => validateIntent(changed));
  }
});

test("runtime and StackId anchor reject every public identity or handoff mismatch", () => {
  validateRuntimeEnvironment(dispatchEnv("preflight")); validateStackIdAnchor(STACK_ID, STACK_ANCHOR);
  for (const [key, bad] of [["GITHUB_EVENT_NAME", "push"], ["GITHUB_ACTOR", "mallory"], ["GITHUB_REPOSITORY", "Other/dataops"], ["GITHUB_REPOSITORY_OWNER", "Other"], ["GITHUB_REF", "refs/heads/dev"], ["GITHUB_SHA", "ABC"], ["AWS_REGION", "us-east-1"], ["AWS_DEFAULT_REGION", "us-east-1"], ["AWS_ROLE_ARN", "arn:aws:iam::817685572750:role/other"], ["SPONSOR_RESET_PHASE", "all"], ["SPONSOR_RESET_STACK_ID_DIGEST", "sha256:ABC"]]) {
    const invalid = dispatchEnv("preflight"); invalid[key] = bad; assert.throws(() => validateRuntimeEnvironment(invalid), key);
  }
  const production = dispatchEnv("preflight"); production.UNRELATED = "production"; assert.throws(() => validateRuntimeEnvironment(production));
  assert.throws(() => validateStackIdAnchor(`${STACK_ID.slice(0, -1)}d`, STACK_ANCHOR));
  assert.throws(() => parseReceiptInputs("none", `sha256:${"1".repeat(64)}`));
});

test("candidate details reconstruct the exact fixture and reject every unreviewed effect", () => {
  const expected = { candidateArn: "arn:aws:cloudformation:eu-west-1:817685572750:changeSet/reset/33333333-3333-3333-3333-333333333333", name: "reset", stackId: STACK_ID, stackIdDigest: digest(STACK_ID), description: "desc", parameters: [{ ParameterKey: "A", UsePreviousValue: true }], capabilities: ["CAPABILITY_IAM"] };
  const candidate = { ChangeSetId: expected.candidateArn, ChangeSetName: "reset", Description: "desc", StackName: CONTRACT.stack, StackId: STACK_ID, ChangeSetType: "UPDATE", CreationTime: CANDIDATE_CREATED, Status: "CREATE_COMPLETE", ExecutionStatus: "AVAILABLE", Parameters: structuredClone(expected.parameters), Capabilities: ["CAPABILITY_IAM"], NotificationARNs: [], IncludeNestedStacks: false, RollbackConfiguration: { RollbackTriggers: [] } };
  const accepted = validateCandidate(candidate, expected, candidateChanges()); assert.equal(accepted.candidateDigest, digest(accepted.candidate));
  const firstPage = { ...structuredClone(candidate), Changes: [], NextToken: "page-2" };
  const secondPage = { ...structuredClone(candidate), Changes: candidateChanges() };
  assert.doesNotThrow(() => validateCandidatePage(firstPage));
  assert.doesNotThrow(() => validateCandidatePage(secondPage, firstPage));
  for (const mutate of [
    (page) => { page.Description = "drift"; },
    (page) => { page.Unknown = true; },
  ]) { const changed = structuredClone(secondPage); mutate(changed); assert.throws(() => validateCandidatePage(changed, firstPage)); }
  for (const mutate of [
    (changes) => changes.pop(),
    (changes) => { delete changes[0].Type; },
    (changes) => { changes[0].Type = "Hook"; },
    (changes) => { changes[0].HookInvocationCount = 0; },
    (changes) => { changes[0].ResourceChange.Details[0].Evaluation = "Dynamic"; },
    (changes) => { changes[0].ResourceChange.Details[0].Target.AfterValue = "{}"; },
    (changes) => { changes[0].ResourceChange.Details.find(({ Target }) => Target.Name === "BillingMode").Target.RequiresRecreation = "Always"; },
    (changes) => { changes[0].ResourceChange.Details.push(structuredClone(changes[0].ResourceChange.Details[0])); },
    (changes) => { changes.push({ ResourceChange: { LogicalResourceId: "Evil", ResourceType: "AWS::IAM::Role", Action: "Add" } }); },
  ]) { const changed = candidateChanges(); mutate(changed); assert.throws(() => validateChangeList(changed)); }
});

test("paginated candidate creation revalidates every page and rejects invariant drift", async () => {
  const mock = new MockAws(); mock.paginateCandidate = true;
  const ledger = new MemoryLedger(); const p = await phase(mock, ledger, "preflight"); const d = await phase(mock, ledger, "delete", p);
  const created = await phase(mock, ledger, "create", d);
  assert.match(created.receipt_id, /^sr1-/);
  assert.equal(mock.calls.filter(({ operation }) => operation === "describe-change-set").length, 2);

  const changedMock = new MockAws(); changedMock.paginateCandidate = true; changedMock.candidatePageMutation = (page) => { page.Description = "second-page-drift"; };
  const changedLedger = new MemoryLedger(); const changedPreflight = await phase(changedMock, changedLedger, "preflight"); const changedDelete = await phase(changedMock, changedLedger, "delete", changedPreflight);
  await assert.rejects(() => phase(changedMock, changedLedger, "create", changedDelete), /candidate page invariant fields changed/);
});

test("post-create inventory is exactly empty-to-singleton and digest-bound", async () => {
  const mock = new MockAws(); const ledger = new MemoryLedger(); const p = await phase(mock, ledger, "preflight"); const d = await phase(mock, ledger, "delete", p);
  await phase(mock, ledger, "create", d);
  const completion = [...ledger.records.values()].find((record) => record.kind === "completion" && record.phase === "create");
  assert.equal(completion.poststate.candidates.length, 1);
  assert.equal(completion.candidate.candidateInventoryDigest, digest(completion.poststate.candidates));
  assert.equal(bindCandidateInventory(completion.poststate.candidates, completion.candidate), completion.candidate.candidateInventoryDigest);

  for (const mutate of [
    (candidateMock) => { candidateMock.extraCandidate = true; },
    (candidateMock) => { candidateMock.inventoryArnOverride = "arn:aws:cloudformation:eu-west-1:817685572750:changeSet/substituted/44444444-4444-4444-4444-444444444444"; },
  ]) {
    const candidateMock = new MockAws(); mutate(candidateMock);
    const candidateLedger = new MemoryLedger(); const root = await phase(candidateMock, candidateLedger, "preflight"); const deleted = await phase(candidateMock, candidateLedger, "delete", root);
    await assert.rejects(() => phase(candidateMock, candidateLedger, "create", deleted));
    assert.equal([...candidateLedger.records.values()].some((record) => record.kind === "completion" && record.phase === "create"), false);
  }
});

test("every dispatch phase is isolated and the receipt-only flow reaches verified prefix zero", async () => {
  const mock = new MockAws(); const ledger = new MemoryLedger();
  const preflight = await phase(mock, ledger, "preflight"); assert.deepEqual(targetMutations(mock), []);
  const deleted = await phase(mock, ledger, "delete", preflight); assert.equal(mock.present, false);
  const created = await phase(mock, ledger, "create", deleted); assert.equal(mock.candidate, true); assert.equal(mock.present, false);
  const executed = await phase(mock, ledger, "execute", created); assert.equal(mock.fresh, true);
  const verified = await phase(mock, ledger, "verify", executed);
  assert.match(verified.receipt_id, /^sr1-[0-9a-f]{64}-[0-9a-f]{64}$/);
  assert.deepEqual(targetMutations(mock).map(({ operation }) => operation), ["delete-table", "create-change-set", "execute-change-set"]);
  assert.ok(!JSON.stringify(verified).includes(STACK_ID)); assert.ok(!JSON.stringify(verified).includes(OLD_ID));
});

test("disable and old-table-only restore require explicit false and true postconditions", async () => {
  const mock = new MockAws({ protection: true }); const ledger = new MemoryLedger();
  const preflight = await phase(mock, ledger, "preflight");
  const disabled = await phase(mock, ledger, "disable-protection", preflight); assert.equal(mock.protection, false);
  const restored = await phase(mock, ledger, "restore-protection", disabled); assert.equal(mock.protection, true);
  assert.deepEqual(targetMutations(mock).map(({ operation }) => operation), ["update-table", "update-table"]);
  mock.protection = false;
  assert.equal(classifyResume("restore-protection", { table: { tableId: OLD_ID, tableStatus: "ACTIVE", deletionProtection: false } }, { oldTableId: OLD_ID, deletionProtection: true }), "precondition");
  assert.throws(() => classifyResume("restore-protection", { table: { tableId: NEW_ID, tableStatus: "ACTIVE", deletionProtection: false } }, { oldTableId: OLD_ID, deletionProtection: true }));
  void restored;
});

test("exact candidate cleanup is separate and abandon writes no target mutation", async () => {
  const mock = new MockAws(); const ledger = new MemoryLedger();
  const p = await phase(mock, ledger, "preflight"); const d = await phase(mock, ledger, "delete", p); const c = await phase(mock, ledger, "create", d);
  const before = targetMutations(mock).length; const cleaned = await phase(mock, ledger, "cleanup-candidate", c); assert.equal(mock.candidate, false);
  await phase(mock, ledger, "abandon", cleaned); assert.equal(targetMutations(mock).length, before + 1);
  assert.equal(targetMutations(mock).at(-1).operation, "delete-change-set");
});

test("cleanup never targets a candidate when inventory is not the exact approved singleton", async () => {
  const mock = new MockAws(); const ledger = new MemoryLedger();
  const p = await phase(mock, ledger, "preflight"); const d = await phase(mock, ledger, "delete", p); const c = await phase(mock, ledger, "create", d);
  mock.extraCandidate = true;
  const before = targetMutations(mock).length;
  await assert.rejects(() => phase(mock, ledger, "cleanup-candidate", c));
  assert.equal(targetMutations(mock).length, before, "ambiguous inventory triggered candidate deletion");
});

for (const [proof, mutate] of [
  ["dependency", (mock) => { mock.template.Resources.UnknownWriter = { Type: "AWS::Lambda::Function", Properties: { Table: { "Fn::Sub": "${AWS::StackName}-sponsor-crm" } } }; }],
  ["template", (mock) => { mock.template.Metadata = { UnexpectedDrift: true }; }],
  ["resource", (mock) => { mock.extraStackResource = true; }],
]) {
  test(`completed-but-unrecorded cleanup reruns full ${proof} proof before sealing`, async () => {
    const mock = new MockAws(); const ledger = new MemoryLedger();
    const p = await phase(mock, ledger, "preflight"); const d = await phase(mock, ledger, "delete", p); const c = await phase(mock, ledger, "create", d);
    ledger.failNextCompletion = true; const environment = dispatchEnv("cleanup-candidate", c);
    await assert.rejects(() => runPhase(environment, mock, ledger), /simulated completion interruption/);
    const before = targetMutations(mock).length; mutate(mock);
    await assert.rejects(() => runPhase(environment, mock, ledger));
    assert.equal(targetMutations(mock).length, before, "cleanup target was reissued after proof drift");
    assert.equal([...ledger.records.values()].some((record) => record.kind === "completion" && record.phase === "cleanup-candidate"), false);
  });
}

for (const mutationPhase of ["disable-protection", "restore-protection", "delete", "create", "execute", "cleanup-candidate"]) {
  test(`${mutationPhase} resumes completed-but-unrecorded state without reissuing`, async () => {
    const mock = new MockAws({ protection: mutationPhase === "disable-protection" || mutationPhase === "restore-protection" });
    const ledger = new MemoryLedger();
    const preflight = await phase(mock, ledger, "preflight");
    let prior = preflight;
    if (["restore-protection"].includes(mutationPhase)) prior = await phase(mock, ledger, "disable-protection", prior);
    if (["create", "execute", "cleanup-candidate"].includes(mutationPhase)) prior = await phase(mock, ledger, "delete", prior);
    if (["execute", "cleanup-candidate"].includes(mutationPhase)) prior = await phase(mock, ledger, "create", prior);
    ledger.failNextCompletion = true;
    const environment = dispatchEnv(mutationPhase, prior);
    await assert.rejects(() => runPhase(environment, mock, ledger), /simulated completion interruption/);
    const count = targetMutations(mock).length;
    const resumed = await runPhase(environment, mock, ledger);
    assert.equal(resumed.status, "observed-complete"); assert.equal(targetMutations(mock).length, count, "target mutation reissued");
  });
}

for (const [mutationPhase, operation] of [["disable-protection", "update-table"], ["restore-protection", "update-table"], ["delete", "delete-table"], ["create", "create-change-set"], ["execute", "execute-change-set"], ["cleanup-candidate", "delete-change-set"]]) {
  test(`${mutationPhase} resumes the exact in-progress service operation under its stored intent`, async () => {
    const mock = new MockAws({ protection: mutationPhase === "disable-protection" || mutationPhase === "restore-protection" });
    const ledger = new MemoryLedger(); let prior = await phase(mock, ledger, "preflight");
    if (mutationPhase === "restore-protection") prior = await phase(mock, ledger, "disable-protection", prior);
    if (["create", "execute", "cleanup-candidate"].includes(mutationPhase)) prior = await phase(mock, ledger, "delete", prior);
    if (["execute", "cleanup-candidate"].includes(mutationPhase)) prior = await phase(mock, ledger, "create", prior);
    const environment = dispatchEnv(mutationPhase, prior); mock.interruptOperation = operation;
    await assert.rejects(() => runPhase(environment, mock, ledger), /simulated mutation interruption/);
    const count = targetMutations(mock).length; const resumed = await runPhase(environment, mock, ledger);
    assert.equal(resumed.status, "observed-complete"); assert.equal(targetMutations(mock).length, count, "in-progress target was reissued");
  });
}

test("resume classifiers distinguish exact precondition, in-progress, complete, and conflict", () => {
  assert.equal(classifyResume("delete", { table: { tableId: OLD_ID, tableStatus: "ACTIVE", deletionProtection: false } }, { oldTableId: OLD_ID }), "precondition");
  assert.equal(classifyResume("delete", { table: { tableId: OLD_ID, tableStatus: "DELETING", deletionProtection: false } }, { oldTableId: OLD_ID }), "in-progress");
  assert.equal(classifyResume("delete", { table: undefined }, { oldTableId: OLD_ID }), "complete");
  assert.throws(() => classifyResume("delete", { table: { tableId: NEW_ID, tableStatus: "ACTIVE", deletionProtection: false } }, { oldTableId: OLD_ID }));
  assert.equal(classifyResume("create", { table: undefined, candidates: [{ ChangeSetName: "x", Status: "CREATE_IN_PROGRESS" }] }, { candidateName: "x" }), "in-progress");
  assert.equal(classifyResume("cleanup-candidate", { table: undefined, candidates: [{ ChangeSetId: "arn", Status: "DELETE_IN_PROGRESS" }] }, { candidateArnDigest: digest("arn") }), "in-progress");
});

test("existing completion replays exactly and branch/CAS/idempotency drift fail closed", async () => {
  const mock = new MockAws(); const ledger = new MemoryLedger(); const p = await phase(mock, ledger, "preflight");
  const environment = dispatchEnv("delete", p); const first = await runPhase(environment, mock, ledger); const count = targetMutations(mock).length;
  const replay = await runPhase(environment, mock, ledger); assert.deepEqual(replay.receipt_id, first.receipt_id); assert.equal(replay.status, "replayed"); assert.equal(targetMutations(mock).length, count);
  const intent = [...ledger.records.values()].find((record) => record.kind === "intent" && record.phase === "delete"); intent.target.clientToken = "f".repeat(64); intent.recordDigest = recordDigest(intent);
  await assert.rejects(() => runPhase(environment, mock, ledger));
});

test("an externally completed-looking mutation without its immutable intent is rejected before target mutation", async () => {
  const mock = new MockAws({ protection: true }); const ledger = new MemoryLedger(); const prior = await phase(mock, ledger, "preflight");
  mock.protection = false; const count = targetMutations(mock).length; const puts = ledger.puts.length;
  await assert.rejects(() => phase(mock, ledger, "disable-protection", prior), /no prior immutable intent/);
  assert.equal(targetMutations(mock).length, count); assert.equal(ledger.puts.length, puts, "invalid observed state wrote an intent");
});

test("execute reload rejects candidate digest/detail drift and extra active candidates before execution", async () => {
  const mock = new MockAws(); const ledger = new MemoryLedger(); const p = await phase(mock, ledger, "preflight"); const d = await phase(mock, ledger, "delete", p); const c = await phase(mock, ledger, "create", d);
  const original = mock.call.bind(mock); mock.call = async (service, operation, args, options) => {
    const response = await original(service, operation, args, options);
    if (service === "cloudformation" && operation === "describe-change-set") response.Changes[0].ResourceChange.Details[0].Target.AfterValue = "{}";
    return response;
  };
  const count = targetMutations(mock).length; await assert.rejects(() => phase(mock, ledger, "execute", c)); assert.equal(targetMutations(mock).length, count);
});

test("poststate equality rejects silent create rebasing", () => {
  const before = { stack: { digest: "a" }, candidates: [], candidate: undefined, table: undefined };
  const allowed = { stack: { digest: "a" }, candidates: [{ id: 1 }], candidate: { id: 1 }, table: undefined };
  assert.doesNotThrow(() => assertPoststateEqual(before, allowed, ["/candidates/0", "/candidate"]));
  allowed.stack.digest = "b"; assert.throws(() => assertPoststateEqual(before, allowed, ["/candidates/0", "/candidate"]));
});

test("S3 ledger uses exact bucket/prefix, conditional AES256 versioned checksum writes, and canonical rereads", async () => {
  const objects = new Map(); const calls = [];
  const fake = { async call(service, operation, args, options = {}) {
    calls.push({ service, operation, args: structuredClone(args), options });
    if (operation === "get-bucket-location") return { LocationConstraint: CONTRACT.region };
    const key = value(args, "--key");
    if (operation === "put-object") {
      const bytes = readFileSync(value(args, "--body"));
      if (objects.has(key)) return { preconditionFailed: true };
      objects.set(key, bytes); return { ServerSideEncryption: "AES256", VersionId: "v1", ChecksumSHA256: sha256Base64(bytes) };
    }
    const bytes = objects.get(key); if (!bytes && options.allowNotFound) return undefined;
    if (operation === "head-object") return { ServerSideEncryption: "AES256", VersionId: "v1", ChecksumSHA256: sha256Base64(bytes), ContentType: "application/json" };
    if (operation === "get-object") { writeFileSync(args.at(-1), bytes); return { ServerSideEncryption: "AES256", VersionId: "v1", ChecksumSHA256: sha256Base64(bytes), ContentType: "application/json" }; }
    assert.fail(`unexpected ${operation}`);
  } };
  const ledger = new S3PrivateLedger(fake); await ledger.verifyControlPlane();
  assert.deepEqual(calls[0], { service: "s3api", operation: "get-bucket-location", args: ["--bucket", CONTRACT.evidenceBucket, "--expected-bucket-owner", CONTRACT.evidenceBucketOwner], options: {} });
  const key = `${CONTRACT.evidencePrefix}runs/${"1".repeat(64)}/operations/000-preflight-${"2".repeat(64)}/intent.json`;
  const record = { canonical: true }; record.recordDigest = recordDigest(record); await ledger.putRecord(key, record); const collision = await ledger.putRecord(key, record); assert.equal(collision.created, false);
  const other = { canonical: false }; other.recordDigest = recordDigest(other); objects.set(key, Buffer.from(canonicalJson(other))); await assert.rejects(() => ledger.putRecord(key, record), /CAS collision/);
  const put = calls.find(({ operation }) => operation === "put-object");
  assert.equal(value(put.args, "--bucket"), CONTRACT.evidenceBucket); assert.equal(value(put.args, "--expected-bucket-owner"), CONTRACT.evidenceBucketOwner);
  assert.equal(value(put.args, "--if-none-match"), "*"); assert.equal(value(put.args, "--server-side-encryption"), "AES256"); assert.equal(value(put.args, "--content-type"), "application/json");
});

test("preflight intent is canonical valid JSON without undefined state fields", async () => {
  const mock = new MockAws();
  const ledger = new MemoryLedger();
  await phase(mock, ledger, "preflight");
  const intent = [...ledger.records.values()].find((record) => record.kind === "intent");
  assert.ok(intent);
  assert.deepEqual(JSON.parse(canonicalJson(intent)), intent);
});

test("an exact missing table can recover through a root create without detached recreation", async () => {
  const mock = new MockAws();
  mock.present = false;
  const ledger = new MemoryLedger();
  const created = await phase(mock, ledger, "create");
  const executed = await phase(mock, ledger, "execute", created);
  const verified = await phase(mock, ledger, "verify", executed);
  assert.equal(verified.status, "completed");
  assert.equal(mock.present, true);
  for (const record of ledger.records.values()) {
    assert.deepEqual(JSON.parse(canonicalJson(record)), record);
  }
});

test("S3 listing is bounded and rejects pagination cycles, foreign keys, missing encryption/version/checksum", async () => {
  const ledger = new S3PrivateLedger({ async call(_service, operation) {
    if (operation === "list-objects-v2") return { IsTruncated: true, NextContinuationToken: "repeat", Contents: [] };
  } });
  await assert.rejects(() => ledger.listKeys(CONTRACT.evidencePrefix));
  const bad = new S3PrivateLedger({ async call(_service, operation, args) {
    if (operation === "head-object") return { VersionId: "null", ChecksumSHA256: "x" };
    assert.fail(args);
  } });
  await assert.rejects(() => bad.getRecord(`${CONTRACT.evidencePrefix}x.json`));
  const foreign = new S3PrivateLedger({ async call() { return { IsTruncated: false, Contents: [{ Key: `${CONTRACT.evidencePrefix}outside.json`, Size: 10 }] }; } });
  await assert.rejects(() => foreign.listKeys(CONTRACT.evidencePrefix));
});

test("workflow is dispatch-only, receipt-only, minimally privileged, actor/main-role bound, and isolated", () => {
  const source = readFileSync(".github/workflows/reset-sponsor-crm-table.yml", "utf8"); const workflow = yaml.safeLoad(source, { schema: yaml.JSON_SCHEMA });
  assert.deepEqual(Object.keys(workflow.on), ["workflow_dispatch"]); assert.deepEqual(Object.keys(workflow.on.workflow_dispatch.inputs).sort(), ["approval", "phase", "receipt_digest", "receipt_id", "stack_id_digest"]);
  assert.deepEqual(workflow.on.workflow_dispatch.inputs.phase.options, PHASES); assert.deepEqual(workflow.permissions, { contents: "read" });
  assert.deepEqual(workflow.concurrency, { group: "dataops-v1-deploy", "cancel-in-progress": false }); assert.deepEqual(workflow.jobs.reset.permissions, { contents: "read", "id-token": "write" });
  assert.equal(workflow.jobs.reset.if, "github.actor == 'alexeygrigorev'"); assert.equal(workflow.jobs.reset.environment, undefined); assert.equal(workflow.env.AWS_ROLE_ARN, CONTRACT.roleArn);
  assert.ok(!/SPONSOR_RESET_EVIDENCE|secrets\.|vars\.|upload-artifact|push:|schedule:|workflow_call:|workflow_run:|sam |scan|backup|export|support|private-repo/i.test(source));
  assert.deepEqual(workflow.jobs.reset.steps.filter((step) => step.run).map((step) => step.run), ["npm ci", "node scripts/deploy/sponsor-crm-reset.mjs validate-runtime", "npm run test:sponsor-reset", "node scripts/deploy/sponsor-crm-reset.mjs"]);
});

test("protected deploy/template/guard and #136 bytes remain unchanged", () => {
  for (const [path, expected] of Object.entries(PROTECTED_FILES)) assert.equal(createHash("sha256").update(readFileSync(path)).digest("hex"), expected, path);
});

test("AWS subprocess fixes argv and redacts malformed JSON, failure, flood, timeout, and TERM ignore", () => {
  mkdirSync(".tmp", { recursive: true }); const directory = mkdtempSync(".tmp/sponsor-reset-subprocess-"); const executable = `${directory}/aws`; const argvFile = `${directory}/argv`;
  writeFileSync(executable, `#!/bin/sh\nprintf '%s\\n' "$@" > "$FAKE_ARGV_FILE"\ncase "$FAKE_MODE" in\nvalid) printf '{"Account":"817685572750"}' ;;\nmalformed) printf 'not-json' ;;\nfailure) printf 'PRIVATE-AWS-RESPONSE' >&2; exit 42 ;;\nflood) while :; do printf 'xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx'; done ;;\nhang) trap '' TERM; while :; do :; done ;;\nesac\n`, { mode: 0o700 }); chmodSync(executable, 0o700);
  const program = `import { AwsCli } from './scripts/deploy/sponsor-crm-reset.mjs'; try { process.stdout.write(JSON.stringify(await new AwsCli().call('sts','get-caller-identity'))); } catch (error) { process.stderr.write(String(error.message)); process.exitCode=7; }`;
  const invoke = (mode) => spawnSync(process.execPath, ["--input-type=module", "--eval", program], { cwd: process.cwd(), env: { ...process.env, PATH: `${directory}:${process.env.PATH}`, FAKE_MODE: mode, FAKE_ARGV_FILE: argvFile, SPONSOR_RESET_AWS_TIMEOUT_MS: "100", SPONSOR_RESET_KILL_GRACE_MS: "25", SPONSOR_RESET_MAX_OUTPUT_BYTES: "1024" }, encoding: "utf8", timeout: 3000 });
  try {
    assert.equal(invoke("valid").status, 0); assert.deepEqual(readFileSync(argvFile, "utf8").trim().split("\n"), ["sts", "get-caller-identity", "--region", CONTRACT.region, "--no-cli-pager", "--cli-connect-timeout", "5", "--cli-read-timeout", "20", "--output", "json"]);
    for (const [mode, category] of [["malformed", "aws-sts-get-caller-identity-json"], ["failure", "aws-sts-get-caller-identity"], ["flood", "aws-sts-get-caller-identity-output-limit"], ["hang", "aws-sts-get-caller-identity-timeout"]]) { const result = invoke(mode); assert.equal(result.status, 7, mode); assert.equal(result.stderr, category, mode); }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("cancellation TERM then KILL returns only a stable redacted category", async () => {
  mkdirSync(".tmp", { recursive: true }); const directory = mkdtempSync(".tmp/sponsor-reset-cancel-"); const executable = `${directory}/aws`; const started = `${directory}/started`;
  writeFileSync(executable, `#!/bin/sh\n: > "$FAKE_STARTED"\ntrap '' TERM\nwhile :; do :; done\n`, { mode: 0o700 });
  const program = `import { AwsCli } from './scripts/deploy/sponsor-crm-reset.mjs'; try { await new AwsCli().call('sts','get-caller-identity'); } catch(error) { process.stderr.write(String(error.message)); process.exitCode=7; }`;
  const child = spawn(process.execPath, ["--input-type=module", "--eval", program], { cwd: process.cwd(), env: { ...process.env, PATH: `${directory}:${process.env.PATH}`, FAKE_STARTED: started, SPONSOR_RESET_AWS_TIMEOUT_MS: "5000", SPONSOR_RESET_KILL_GRACE_MS: "25" }, stdio: ["ignore", "pipe", "pipe"] }); let stderr = ""; child.stderr.setEncoding("utf8"); child.stderr.on("data", (chunk) => { stderr += chunk; });
  try {
    for (let count = 0; count < 100 && !existsSync(started); count += 1) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.ok(existsSync(started)); child.kill("SIGTERM"); const status = await new Promise((resolve, reject) => { const timer = setTimeout(() => reject(new Error("timeout")), 3000); child.on("exit", (code) => { clearTimeout(timer); resolve(code); }); });
    assert.equal(status, 7); assert.equal(stderr, "aws-sts-get-caller-identity-cancelled");
  } finally { if (child.exitCode === null) child.kill("SIGKILL"); rmSync(directory, { recursive: true, force: true }); }
});

function sha256Base64(bytes) { return createHash("sha256").update(bytes).digest("base64"); }
