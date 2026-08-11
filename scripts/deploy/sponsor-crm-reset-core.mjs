import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  CONTRACT as GSI_CONTRACT,
  canonicalJson,
  digest,
  inspectProcessedPrefix,
  validateCallerIdentity,
  validateStack,
} from "./sponsor-crm-gsi-core.mjs";

export const CONTRACT = Object.freeze({
  ...GSI_CONTRACT,
  actor: "alexeygrigorev",
  owner: "DataTalksClub",
  role: "dataops-github-actions-deploy",
  roleArn: "arn:aws:iam::817685572750:role/dataops-github-actions-deploy",
  tableArn: "arn:aws:dynamodb:eu-west-1:817685572750:table/dataops-v1-sponsor-crm",
  recordSchema: "dataops.sponsor-reset/v1",
  fixtureSchema: "dataops.sponsor-reset-prefix-0/v1",
  evidenceBucket: "aws-sam-cli-managed-default-samclisourcebucket-dgwncwijmnpd",
  evidenceBucketArn: "arn:aws:s3:::aws-sam-cli-managed-default-samclisourcebucket-dgwncwijmnpd",
  evidenceBucketOwner: "817685572750",
  evidenceManagedStack: "aws-sam-cli-managed-default",
  evidenceManagedResource: "SamCliSourceBucket",
  evidencePrefix: "dataops-v1/private/sponsor-crm-reset/v1/",
});

export const PHASES = Object.freeze([
  "preflight",
  "disable-protection",
  "delete",
  "create",
  "execute",
  "verify",
  "cleanup-candidate",
  "restore-protection",
  "abandon",
]);

export const MUTATION_PHASES = Object.freeze([
  "disable-protection",
  "delete",
  "create",
  "execute",
  "cleanup-candidate",
  "restore-protection",
]);

export const PHASE_ORDINAL = Object.freeze({
  preflight: 0,
  "disable-protection": 10,
  delete: 20,
  create: 30,
  execute: 40,
  verify: 50,
  "cleanup-candidate": 60,
  "restore-protection": 70,
  abandon: 90,
});

export const NO_RECEIPT = "none";
export const NO_RECEIPT_DIGEST = "sha256:none";

export const PROTECTED_FILES = Object.freeze({
  "infra/template.full.yaml": "4c7ba50dbbe6b1ae65b0dfcf7c0f439c5b8b688d7e9504d75a336713b4b13550",
  ".github/workflows/deploy-dataops-v1.yml": "4611d88891fcb3031a94b0140b7238686e6e68feb68824ac7332d1a71180b14c",
  ".github/workflows/migrate-sponsor-crm-gsis.yml": "e5e64ced853b5ca7a391a9f979c4fd6e50811d5daec5775bd605f8c184384c1f",
  "scripts/deploy/sponsor-crm-gsi-core.mjs": "fe5a2944b8da2721e8a1df061b1ac283ccea2e6ce35df20920229e5c4fc94b10",
  "scripts/deploy/sponsor-crm-gsi-migrator.mjs": "e5b076b75ee03fa47aa263bba6cf766b847045805dab35f7a13c36c6a049bd35",
  "scripts/deploy/sponsor-crm-gsi-guard.mjs": "ca2ccdfec35fdfeb114800b5146d2e9c057b16132ab861cb6ea2ce6195923aaa",
});

const HEX = /^[0-9a-f]{64}$/;
const SHA = /^[0-9a-f]{40}$/;
const RECEIPT = /^sr1-([0-9a-f]{64})-([0-9a-f]{64})$/;
const TABLE_ID = /^[A-Za-z0-9._-]{8,128}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const FIXTURE_PATH = fileURLToPath(new URL("./fixtures/sponsor-crm-prefix-0.processed.json", import.meta.url));
const ACCEPTED_REFERENCE_IDS = Object.freeze([
  "BackendFunction",
  "BackendFunctionRole",
]);
const PSEUDO_PARAMETER_VALUES = Object.freeze({
  "AWS::AccountId": GSI_CONTRACT.account,
  "AWS::Partition": "aws",
  "AWS::Region": GSI_CONTRACT.region,
  "AWS::StackName": GSI_CONTRACT.stack,
});
const CANDIDATE_REQUIRED_FIELDS = Object.freeze([
  "Capabilities", "ChangeSetId", "ChangeSetName", "CreationTime", "DeploymentMode", "Description",
  "ExecutionStatus", "IncludeNestedStacks", "NotificationARNs", "Parameters", "RollbackConfiguration", "StackDriftStatus",
  "StackId", "StackName", "Status",
]);
const CANDIDATE_OPTIONAL_FIELDS = Object.freeze([
  "ChangeSetType", "DeploymentConfig", "ImportExistingResources", "OnStackFailure", "ParentChangeSetId", "RoleARN", "RootChangeSetId",
  "StatusReason", "Tags",
]);

export function validateRuntimeEnvironment(env) {
  assert.equal(env.GITHUB_EVENT_NAME, "workflow_dispatch", "dispatch-only");
  assert.equal(env.GITHUB_ACTOR, CONTRACT.actor, "actor mismatch");
  assert.equal(env.GITHUB_REPOSITORY, CONTRACT.repository, "repository mismatch");
  assert.equal(env.GITHUB_REPOSITORY_OWNER, CONTRACT.owner, "owner mismatch");
  assert.equal(env.GITHUB_REF, CONTRACT.ref, "ref mismatch");
  assert.match(env.GITHUB_SHA ?? "", SHA, "SHA mismatch");
  assert.match(env.GITHUB_RUN_ID ?? "", /^[1-9][0-9]{0,19}$/, "run ID mismatch");
  assert.match(env.GITHUB_RUN_ATTEMPT ?? "", /^[1-9][0-9]?$/, "attempt mismatch");
  assert.equal(env.AWS_REGION, CONTRACT.region, "region mismatch");
  assert.equal(env.AWS_DEFAULT_REGION, CONTRACT.region, "default region mismatch");
  assert.equal(env.AWS_ROLE_ARN, CONTRACT.roleArn, "role input mismatch");
  for (const name of ["AWS_ENDPOINT_URL", "AWS_ENDPOINT_URL_S3", "AWS_CA_BUNDLE"]) {
    assert.ok(!env[name], `${name} override rejected`);
  }
  assert.ok(PHASES.includes(env.SPONSOR_RESET_PHASE), "unknown phase");
  assert.match(env.SPONSOR_RESET_STACK_ID_DIGEST ?? "", /^sha256:[0-9a-f]{64}$/, "StackId digest anchor malformed");
  parseReceiptInputs(env.SPONSOR_RESET_RECEIPT_ID, env.SPONSOR_RESET_RECEIPT_DIGEST);
  assert.equal(typeof env.SPONSOR_RESET_APPROVAL, "string", "approval missing");
  assert.ok(env.SPONSOR_RESET_APPROVAL.length <= 512, "approval too long");
  for (const [name, value] of Object.entries(env)) {
    if (typeof value === "string" && /production|prod-crossing/i.test(value)) {
      assert.fail(`production marker rejected in ${name}`);
    }
  }
}

export function parseReceiptInputs(receiptId, receiptDigest) {
  if (receiptId === NO_RECEIPT || receiptDigest === NO_RECEIPT_DIGEST) {
    assert.equal(receiptId, NO_RECEIPT, "receipt sentinels must be paired");
    assert.equal(receiptDigest, NO_RECEIPT_DIGEST, "receipt sentinels must be paired");
    return undefined;
  }
  const match = RECEIPT.exec(receiptId ?? "");
  assert.ok(match, "receipt ID malformed");
  assert.equal(receiptDigest, `sha256:${match[2]}`, "receipt digest does not bind receipt ID");
  return Object.freeze({ receiptId, operationId: match[1], completionDigest: match[2] });
}

export function validateStackIdAnchor(stackId, anchor) {
  assert.match(stackId ?? "", /^arn:aws:cloudformation:eu-west-1:817685572750:stack\/dataops-v1\//);
  assert.equal(`sha256:${digest(stackId)}`, anchor, "StackId private anchor mismatch");
  return digest(stackId);
}

export function validateIdentity(caller) { validateCallerIdentity(caller); }

export function validateStackBaseline(stack, stackIdAnchor, { allowExecuteInProgress = false } = {}) {
  if (allowExecuteInProgress && ["UPDATE_IN_PROGRESS", "UPDATE_COMPLETE_CLEANUP_IN_PROGRESS"].includes(stack?.StackStatus)) {
    assert.equal(stack.StackName, CONTRACT.stack, "stack identity mismatch");
  } else {
    validateStack(stack);
  }
  validateStackIdAnchor(stack.StackId, stackIdAnchor);
  assert.ok(Array.isArray(stack.Parameters), "stack parameters missing");
  assert.ok(Array.isArray(stack.Capabilities), "stack capabilities missing");
  assert.equal(stack.RoleARN, undefined, "alternate stack role rejected");
  assert.equal(stack.EnableTerminationProtection ?? false, false);
  return {
    stackId: stack.StackId,
    stackIdDigest: digest(stack.StackId),
    parameterKeys: stack.Parameters.map(({ ParameterKey }) => ParameterKey),
    capabilities: [...stack.Capabilities].sort(),
    stackConfigurationDigest: digest({
      parameters: stack.Parameters,
      capabilities: [...stack.Capabilities].sort(),
    }),
  };
}

export function loadPrefixZeroFixture(path = FIXTURE_PATH) {
  const fixture = JSON.parse(readFileSync(path, "utf8"));
  assert.equal(fixture.schema, CONTRACT.fixtureSchema);
  assert.match(fixture.fixtureDigest ?? "", HEX);
  const unsigned = structuredClone(fixture);
  delete unsigned.fixtureDigest;
  assert.equal(digest(unsigned), fixture.fixtureDigest, "fixture self-digest mismatch");
  assert.deepEqual(
    [...new Set(fixture.references.map(({ logicalId }) => logicalId))].sort(),
    [...ACCEPTED_REFERENCE_IDS],
    "fixture logical-ID allowlist changed",
  );
  assert.deepEqual(fixture.references, sortReferences(fixture.references), "fixture references are not sorted");
  return fixture;
}

export function validateProcessedBaseline(template, fixture = loadPrefixZeroFixture()) {
  assert.equal(inspectProcessedPrefix(template), 0, "reset baseline must be prefix 0");
  assert.deepEqual(template?.Resources?.[CONTRACT.logicalId], fixture.tableResource, "processed table differs from canonical prefix-0 fixture");
  const actual = collectSponsorReferences(template);
  assert.deepEqual(actual, fixture.references, "processed Sponsor dependency inventory changed");
  return {
    templateDigest: digest(template),
    fixtureDigest: fixture.fixtureDigest,
    dependencyDigest: digest(actual),
    references: actual,
  };
}

export function dependencyInventory(template, fixture = loadPrefixZeroFixture()) {
  return validateProcessedBaseline(template, fixture).references;
}

export function collectSponsorReferences(template) {
  const found = [];
  assert.ok(template?.Resources && typeof template.Resources === "object", "processed Resources missing");
  walk(template, "", (value, pointer, ancestors) => {
    const parts = pointer.split("/");
    const logicalId = parts[1] === "Resources" ? unescapePointer(parts[2] ?? "") : undefined;
    if (logicalId === CONTRACT.logicalId) return;
    const reference = classifyReference(value, pointer);
    if (!reference) return;
    assert.equal(parts[1], "Resources", `Sponsor reference outside Resources at ${pointer}`);
    const resource = template.Resources?.[logicalId];
    assert.ok(resource, `reference outside a resource at ${pointer}`);
    const actions = nearestActions(ancestors);
    found.push({
      logicalId,
      resourceType: resource.Type,
      pointer,
      form: reference.form,
      value: reference.value,
      classification: classifyDependency(logicalId, resource.Type),
      actions,
    });
  });
  return sortReferences(found);
}

function classifyReference(value, pointer = "unknown") {
  if (typeof value === "string") {
    if (pointer === `/Resources/${CONTRACT.logicalId}/Metadata/SamResourceId` && value === CONTRACT.logicalId) return undefined;
    if (value === CONTRACT.physicalTable) return { form: "literal-table-name", value };
    if (value === CONTRACT.tableArn) return { form: "literal-table-arn", value };
    if (value.startsWith(`${CONTRACT.tableArn}/stream/`)) return { form: "literal-stream-arn", value };
    if (value.includes(CONTRACT.logicalId) || value.includes(CONTRACT.physicalTable) || value.includes(CONTRACT.tableArn)) {
      assert.fail(`unsupported configured Sponsor reference at ${pointer}`);
    }
    return undefined;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  if (Object.keys(value).length !== 1) return undefined;
  if (value.Ref === CONTRACT.logicalId) return { form: "Ref", value: value.Ref };
  if (Array.isArray(value["Fn::GetAtt"]) && value["Fn::GetAtt"][0] === CONTRACT.logicalId) {
    return { form: "Fn::GetAtt", value: value["Fn::GetAtt"] };
  }
  if (Object.hasOwn(value, "Fn::Sub")) {
    const expression = value["Fn::Sub"];
    const template = Array.isArray(expression) ? expression[0] : expression;
    assert.equal(typeof template, "string", "Sponsor Fn::Sub template is malformed");
    if (template.includes(`\${${CONTRACT.logicalId}.`)) return { form: "Fn::Sub", value: expression };
  }
  const resolved = resolveSemanticString(value);
  if (isSponsorTarget(resolved)) {
    return {
      form: Object.hasOwn(value, "Fn::Join") ? "Fn::Join" : "Fn::Sub",
      value: structuredClone(value[Object.hasOwn(value, "Fn::Join") ? "Fn::Join" : "Fn::Sub"]),
    };
  }
  return undefined;
}

function resolveSemanticString(value) {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length !== 1) return undefined;
  if (Object.hasOwn(value, "Ref")) {
    if (value.Ref === CONTRACT.logicalId) return CONTRACT.physicalTable;
    return PSEUDO_PARAMETER_VALUES[value.Ref];
  }
  if (Object.hasOwn(value, "Fn::GetAtt")) {
    const getAtt = value["Fn::GetAtt"];
    if (!Array.isArray(getAtt) || getAtt.length !== 2 || getAtt[0] !== CONTRACT.logicalId) return undefined;
    if (getAtt[1] === "Arn") return CONTRACT.tableArn;
    if (getAtt[1] === "StreamArn") return `${CONTRACT.tableArn}/stream/<generated>`;
    return undefined;
  }
  if (Object.hasOwn(value, "Fn::Join")) {
    const join = value["Fn::Join"];
    assert.ok(Array.isArray(join) && join.length === 2, "Fn::Join shape is malformed");
    assert.equal(typeof join[0], "string", "Fn::Join delimiter is malformed");
    assert.ok(Array.isArray(join[1]), "Fn::Join values are malformed");
    const parts = join[1].map(resolveSemanticString);
    if (parts.some((part) => part === undefined)) return undefined;
    return parts.join(join[0]);
  }
  if (Object.hasOwn(value, "Fn::Sub")) {
    const expression = value["Fn::Sub"];
    const template = Array.isArray(expression) ? expression[0] : expression;
    const variables = Array.isArray(expression) ? expression[1] : {};
    assert.equal(typeof template, "string", "Fn::Sub template is malformed");
    assert.ok(variables && typeof variables === "object" && !Array.isArray(variables), "Fn::Sub variables are malformed");
    if (Array.isArray(expression)) assert.equal(expression.length, 2, "Fn::Sub shape is malformed");
    let unresolved = false;
    const resolved = template.replace(/\$\{([^}!][^}]*)\}/g, (match, name) => {
      let replacement;
      if (Object.hasOwn(variables, name)) replacement = resolveSemanticString(variables[name]);
      else if (name === CONTRACT.logicalId) replacement = CONTRACT.physicalTable;
      else if (name === `${CONTRACT.logicalId}.Arn`) replacement = CONTRACT.tableArn;
      else if (name === `${CONTRACT.logicalId}.StreamArn`) replacement = `${CONTRACT.tableArn}/stream/<generated>`;
      else replacement = PSEUDO_PARAMETER_VALUES[name];
      if (replacement === undefined) {
        unresolved = true;
        return match;
      }
      return replacement;
    });
    return unresolved ? undefined : resolved.replace(/\$\{!([^}]+)\}/g, "\${$1}");
  }
  return undefined;
}

function isSponsorTarget(value) {
  return typeof value === "string" && (
    value === CONTRACT.physicalTable
    || value === CONTRACT.tableArn
    || value.startsWith(`${CONTRACT.tableArn}/`)
  );
}

function classifyDependency(logicalId, resourceType) {
  assert.ok(ACCEPTED_REFERENCE_IDS.includes(logicalId), `unreviewed Sponsor dependency ${logicalId}`);
  if (resourceType === "AWS::IAM::Role") return "generated-role";
  if (logicalId === "SponsorPrivateArchiveFunction") return "reader";
  if (resourceType === "AWS::Lambda::Function") return "writer";
  assert.fail(`unsupported Sponsor dependency classification ${logicalId}`);
}

function nearestActions(ancestors) {
  for (let index = ancestors.length - 1; index >= 0; index -= 1) {
    const candidate = ancestors[index];
    if (candidate && typeof candidate === "object" && Object.hasOwn(candidate, "Action") && Object.hasOwn(candidate, "Resource")) {
      return (Array.isArray(candidate.Action) ? candidate.Action : [candidate.Action]).slice().sort();
    }
  }
  return [];
}

function walk(value, pointer, visit, ancestors = []) {
  visit(value, pointer, ancestors);
  if (classifyReference(value, pointer)) return;
  if (Array.isArray(value)) {
    value.forEach((item, index) => walk(item, `${pointer}/${index}`, visit, [...ancestors, value]));
  } else if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      walk(item, `${pointer}/${escapePointer(key)}`, visit, [...ancestors, value]);
    }
  }
}

function sortReferences(values) {
  return structuredClone(values).sort((a, b) => a.pointer.localeCompare(b.pointer));
}

export function validateResource(resource, stackId, { present }) {
  assert.equal(resource.LogicalResourceId, CONTRACT.logicalId);
  assert.equal(resource.ResourceType, "AWS::DynamoDB::Table");
  assert.equal(resource.PhysicalResourceId, CONTRACT.physicalTable);
  assert.equal(resource.StackId, stackId);
  if (present) assert.equal(resource.ResourceStatus, "CREATE_COMPLETE");
  if (!present) assert.equal(resource.ResourceStatus, "DELETE_COMPLETE");
}

export function validateLiveTable(table, { priorTableId, deletionProtection, allowDeleting = false, allowUpdating = false } = {}) {
  assert.equal(table.TableName, CONTRACT.physicalTable);
  assert.equal(table.TableArn, CONTRACT.tableArn);
  assert.match(table.TableId ?? "", TABLE_ID);
  if (priorTableId !== undefined) assert.notEqual(table.TableId, priorTableId);
  assert.ok(table.TableStatus === "ACTIVE" || (allowDeleting && table.TableStatus === "DELETING") || (allowUpdating && table.TableStatus === "UPDATING"));
  assert.deepEqual(table.KeySchema, [
    { AttributeName: "PK", KeyType: "HASH" },
    { AttributeName: "SK", KeyType: "RANGE" },
  ]);
  assert.deepEqual(table.AttributeDefinitions, [
    { AttributeName: "PK", AttributeType: "S" },
    { AttributeName: "SK", AttributeType: "S" },
  ]);
  assert.deepEqual(table.GlobalSecondaryIndexes ?? [], []);
  assert.deepEqual(table.LocalSecondaryIndexes ?? [], []);
  assert.deepEqual(table.Replicas ?? [], []);
  assert.equal(table.BillingModeSummary?.BillingMode, "PAY_PER_REQUEST");
  if (table.TableClassSummary !== undefined) assert.equal(table.TableClassSummary.TableClass, "STANDARD");
  assert.equal(table.SSEDescription?.Status, "ENABLED");
  assert.equal(typeof table.DeletionProtectionEnabled, "boolean", "deletion protection not explicit");
  if (deletionProtection !== undefined) assert.equal(table.DeletionProtectionEnabled, deletionProtection);
  assert.equal(table.StreamSpecification, undefined, "legacy prefix-0 table unexpectedly has streams enabled");
  assert.equal(table.LatestStreamArn, undefined, "legacy prefix-0 table unexpectedly has a stream ARN");
  return {
    tableArn: table.TableArn,
    tableId: table.TableId,
    tableStatus: table.TableStatus,
    tableDigest: digest(stableTable(table)),
    deletionProtection: table.DeletionProtectionEnabled,
  };
}

export function validateAuxiliaryTableState({ backups, ttl, tags }, stackId, { owned, resource }) {
  assert.equal(backups?.ContinuousBackupsDescription?.PointInTimeRecoveryDescription?.PointInTimeRecoveryStatus, "ENABLED");
  assert.deepEqual(ttl?.TimeToLiveDescription, { TimeToLiveStatus: "DISABLED" });
  const actualTags = normalizeTags(tags?.Tags);
  const expectedTags = owned ? [
      { Key: "aws:cloudformation:logical-id", Value: CONTRACT.logicalId },
      { Key: "aws:cloudformation:stack-id", Value: stackId },
      { Key: "aws:cloudformation:stack-name", Value: CONTRACT.stack },
    ] : [];
  if (owned) {
    assert.equal(resource?.StackId, stackId);
    assert.equal(resource?.LogicalResourceId, CONTRACT.logicalId);
    assert.equal(resource?.PhysicalResourceId, CONTRACT.physicalTable);
    assert.equal(resource?.ResourceType, "AWS::DynamoDB::Table");
    assert.equal(resource?.ResourceStatus, "CREATE_COMPLETE");
    // DynamoDB can omit CloudFormation's reserved system tags. When it does,
    // the exact stack-resource binding above remains the ownership proof.
    if (actualTags.length > 0) assert.deepEqual(actualTags, expectedTags);
  } else {
    assert.deepEqual(actualTags, expectedTags);
  }
}

export function validateCandidate(changeSet, expected, changes) {
  assert.equal(changeSet.ChangeSetId, expected.candidateArn);
  assert.equal(changeSet.ChangeSetName, expected.name);
  assert.match(changeSet.ChangeSetId?.split("/").at(-1) ?? "", UUID);
  assert.equal(changeSet.StackId, expected.stackId);
  assert.equal(digest(changeSet.StackId), expected.stackIdDigest);
  assert.equal(changeSet.StackName, CONTRACT.stack);
  if (changeSet.ChangeSetType !== undefined) assert.equal(changeSet.ChangeSetType, "UPDATE");
  assert.equal(changeSet.DeploymentMode, "REVERT_DRIFT");
  assert.equal(changeSet.StackDriftStatus, "DRIFTED");
  if (changeSet.DeploymentConfig !== undefined) {
    assert.deepEqual(changeSet.DeploymentConfig, { Mode: "STANDARD", DisableRollback: false });
  }
  assert.equal(changeSet.Status, "CREATE_COMPLETE");
  assert.equal(changeSet.ExecutionStatus, "AVAILABLE");
  assert.match(changeSet.CreationTime ?? "", /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  assert.equal(changeSet.Description, expected.description);
  validateCandidateParameters(changeSet.Parameters, expected.parameters);
  assert.deepEqual([...(changeSet.Capabilities ?? [])].sort(), expected.capabilities);
  assert.equal(changeSet.RoleARN, undefined);
  assert.deepEqual(changeSet.NotificationARNs ?? [], []);
  assert.equal(changeSet.IncludeNestedStacks ?? false, false);
  assert.deepEqual(changeSet.RollbackConfiguration?.RollbackTriggers ?? [], []);
  assert.equal(changeSet.RollbackConfiguration?.MonitoringTimeInMinutes ?? 0, 0);
  assert.deepEqual(changeSet.Tags ?? [], []);
  assert.equal(changeSet.OnStackFailure ?? undefined, undefined);
  assert.equal(changeSet.ImportExistingResources ?? false, false);
  assert.equal(changeSet.ParentChangeSetId ?? undefined, undefined);
  assert.equal(changeSet.RootChangeSetId ?? undefined, undefined);
  const normalizedChanges = validateChangeList(changes);
  const candidateSummary = sanitizedCandidate(changeSet);
  const candidateFields = Object.keys(candidateSummary);
  const allowedFields = new Set([...CANDIDATE_REQUIRED_FIELDS, ...CANDIDATE_OPTIONAL_FIELDS]);
  assert.ok(CANDIDATE_REQUIRED_FIELDS.every((field) => candidateFields.includes(field)), "candidate response required fields changed");
  assert.ok(candidateFields.every((field) => allowedFields.has(field)), "candidate response has an unknown field");
  const normalized = { changeSet: candidateSummary, changes: normalizedChanges };
  return { candidateDigest: digest(normalized), candidate: normalized };
}

function validateCandidateParameters(actual, expected) {
  assert.ok(Array.isArray(actual) && Array.isArray(expected), "candidate parameters missing");
  const normalize = (values, { response }) => values.map((parameter) => {
    const allowed = response
      ? ["ParameterKey", "ParameterValue", ...(Object.hasOwn(parameter, "UsePreviousValue") ? ["UsePreviousValue"] : [])]
      : ["ParameterKey", "ParameterValue", "UsePreviousValue"];
    assertExactFields(parameter, allowed);
    assert.equal(typeof parameter.ParameterKey, "string");
    assert.equal(typeof parameter.ParameterValue, "string");
    if (Object.hasOwn(parameter, "UsePreviousValue")) assert.equal(parameter.UsePreviousValue, true);
    return { ParameterKey: parameter.ParameterKey, ParameterValue: parameter.ParameterValue };
  }).sort((left, right) => left.ParameterKey.localeCompare(right.ParameterKey));
  assert.deepEqual(normalize(actual, { response: true }), normalize(expected, { response: false }), "candidate parameters changed");
}

export function validateCandidatePage(page, first = page) {
  assert.ok(Array.isArray(page?.Changes), "candidate page changes missing");
  const pageFields = Object.keys(page);
  const allowed = new Set([...CANDIDATE_REQUIRED_FIELDS, ...CANDIDATE_OPTIONAL_FIELDS, "Changes", "NextToken"]);
  assert.ok(CANDIDATE_REQUIRED_FIELDS.every((field) => pageFields.includes(field)), "candidate page required fields changed");
  assert.ok(pageFields.every((field) => allowed.has(field)), "candidate page has an unknown field");
  if (Object.hasOwn(page, "NextToken")) assert.ok(typeof page.NextToken === "string" && page.NextToken.length > 0 && page.NextToken.length <= 4096);
  assert.deepEqual(sanitizedCandidate(page), sanitizedCandidate(first), "candidate page invariant fields changed");
  return page;
}

export function bindCandidateInventory(candidates, candidate) {
  assert.equal(candidates?.length, 1, "candidate inventory must be singleton");
  const summary = candidates[0];
  assert.equal(summary.ChangeSetId, candidate.candidateArn, "candidate inventory ARN changed");
  assert.equal(digest(summary.ChangeSetId), candidate.candidateArnDigest, "candidate inventory ARN digest changed");
  assert.equal(summary.ChangeSetName, candidate.name, "candidate inventory name changed");
  assert.equal(summary.Status, "CREATE_COMPLETE", "candidate inventory status changed");
  assert.equal(summary.ExecutionStatus, "AVAILABLE", "candidate inventory execution status changed");
  assert.equal(digest(candidate.candidateDetails), candidate.candidateDigest, "candidate detail digest changed");
  const inventoryDigest = digest(candidates);
  if (candidate.candidateInventoryDigest !== undefined) assert.equal(candidate.candidateInventoryDigest, inventoryDigest, "candidate inventory digest changed");
  return inventoryDigest;
}

export function validateChangeList(changes) {
  assert.equal(changes.length, 3, "candidate must contain exactly three reviewed resource changes");
  for (const change of changes) {
    assert.deepEqual(Object.keys(change).sort(), ["ResourceChange", "Type"], "candidate Change fields changed");
    assert.equal(change.Type, "Resource", "candidate Change type changed");
  }
  const sorted = structuredClone(changes).sort((a, b) => a.ResourceChange.LogicalResourceId.localeCompare(b.ResourceChange.LogicalResourceId));
  const byId = new Map(sorted.map(({ ResourceChange }) => [ResourceChange?.LogicalResourceId, ResourceChange]));
  assert.equal(byId.size, 3, "candidate logical resource inventory changed");
  validateBackendFunctionDependency(byId.get("BackendFunction"));
  validateBackendRoleDependency(byId.get("BackendFunctionRole"));
  validateTableAdd(byId.get(CONTRACT.logicalId));
  return sorted;
}

function validateModifyEnvelope(change, { logicalId, type, physicalId, ignored }) {
  assert.ok(change, "required candidate effect missing");
  assertExactFields(change, [
    "Action", "AfterContext", "BeforeContext", "Details", "LogicalResourceId", "PhysicalResourceId", "Replacement",
    "ResourceDriftIgnoredAttributes", "ResourceDriftStatus", "ResourceType", "Scope",
  ]);
  assert.equal(change.LogicalResourceId, logicalId);
  assert.equal(change.ResourceType, type);
  assert.equal(change.PhysicalResourceId, physicalId);
  assert.equal(change.Action, "Modify");
  assert.equal(change.Replacement, "False");
  assert.deepEqual(change.Scope, ["Properties"]);
  assert.equal(change.ResourceDriftStatus, "IN_SYNC");
  assert.deepEqual(change.ResourceDriftIgnoredAttributes, ignored);
  assert.equal(change.Details.length, 1, "dependency change detail inventory changed");
  return {
    before: parseCandidateJson(change.BeforeContext, `${logicalId} BeforeContext`),
    after: parseCandidateJson(change.AfterContext, `${logicalId} AfterContext`),
    detail: change.Details[0],
  };
}

function validateTableAdd(change) {
  assert.ok(change, "required table recreation effect missing");
  assertExactFields(change, [
    "Action", "AfterContext", "Details", "LogicalResourceId", "PhysicalResourceId", "PreviousDeploymentContext",
    "ResourceDriftIgnoredAttributes", "ResourceDriftStatus", "ResourceType", "Scope",
  ]);
  assert.equal(change.LogicalResourceId, CONTRACT.logicalId);
  assert.equal(change.PhysicalResourceId, CONTRACT.physicalTable);
  assert.equal(change.ResourceType, "AWS::DynamoDB::Table");
  assert.equal(change.Action, "Add");
  assert.deepEqual(change.Scope, []);
  assert.equal(change.ResourceDriftStatus, "DELETED");
  assert.deepEqual(change.ResourceDriftIgnoredAttributes, []);
  assert.deepEqual(change.Details, []);
  const expected = expectedTableContext();
  assert.deepEqual(parseCandidateJson(change.AfterContext, "table AfterContext"), expected);
  assert.deepEqual(parseCandidateJson(change.PreviousDeploymentContext, "table PreviousDeploymentContext"), expected);
}

function validateBackendFunctionDependency(change) {
  const { before, after, detail } = validateModifyEnvelope(change, {
    logicalId: "BackendFunction",
    type: "AWS::Lambda::Function",
    physicalId: matchPhysicalId(change?.PhysicalResourceId, /^dataops-v1-BackendFunction-[A-Za-z0-9]+$/),
    ignored: [
      { Path: "/Properties/Code/S3Bucket", Reason: "WRITE_ONLY_PROPERTY" },
      { Path: "/Properties/Code/S3Key", Reason: "WRITE_ONLY_PROPERTY" },
    ],
  });
  assertExactFields(detail, ["CausingEntity", "ChangeSource", "Evaluation", "Target"]);
  assert.equal(detail.CausingEntity, CONTRACT.logicalId);
  assert.equal(detail.ChangeSource, "ResourceReference");
  assert.equal(detail.Evaluation, "Static");
  assert.deepEqual(detail.Target, {
    Attribute: "Properties",
    Name: "Environment",
    RequiresRecreation: "Never",
    Path: "/Properties/Environment/Variables/DATAOPS_SPONSOR_CRM_TABLE",
    BeforeValue: CONTRACT.physicalTable,
    AfterValue: "{{changeSet:KNOWN_AFTER_APPLY}}",
    BeforeValueFrom: "ACTUAL_STATE",
    AfterValueFrom: "TEMPLATE",
    AttributeChangeType: "Modify",
  });
  assert.equal(before?.Properties?.Environment?.Variables?.DATAOPS_SPONSOR_CRM_TABLE, CONTRACT.physicalTable);
  assert.equal(after?.Properties?.Environment?.Variables?.DATAOPS_SPONSOR_CRM_TABLE, "{{changeSet:KNOWN_AFTER_APPLY}}");
  after.Properties.Environment.Variables.DATAOPS_SPONSOR_CRM_TABLE = CONTRACT.physicalTable;
  assert.deepEqual(after, before, "BackendFunction changed outside the recreated table reference");
}

function validateBackendRoleDependency(change) {
  const { before, after, detail } = validateModifyEnvelope(change, {
    logicalId: "BackendFunctionRole",
    type: "AWS::IAM::Role",
    physicalId: matchPhysicalId(change?.PhysicalResourceId, /^dataops-v1-BackendFunctionRole-[A-Za-z0-9]+$/),
    ignored: [{ Path: "/Properties/ManagedPolicyArns", Reason: "WRITE_ONLY_PROPERTY" }],
  });
  assertExactFields(detail, ["ChangeSource", "Evaluation", "Target"]);
  assert.equal(detail.ChangeSource, "DirectModification");
  assert.equal(detail.Evaluation, "Static");
  assertExactFields(detail.Target, [
    "AfterValue", "AfterValueFrom", "Attribute", "AttributeChangeType", "BeforeValue", "BeforeValueFrom", "Name", "Path",
    "RequiresRecreation",
  ]);
  assert.deepEqual({
    Attribute: detail.Target.Attribute,
    Name: detail.Target.Name,
    RequiresRecreation: detail.Target.RequiresRecreation,
    Path: detail.Target.Path,
    BeforeValueFrom: detail.Target.BeforeValueFrom,
    AfterValueFrom: detail.Target.AfterValueFrom,
    AttributeChangeType: detail.Target.AttributeChangeType,
  }, {
    Attribute: "Properties",
    Name: "Policies",
    RequiresRecreation: "Never",
    Path: "/Properties/Policies/0/PolicyDocument",
    BeforeValueFrom: "ACTUAL_STATE",
    AfterValueFrom: "TEMPLATE",
    AttributeChangeType: "Modify",
  });
  const beforePolicy = parseCandidateJson(detail.Target.BeforeValue, "BackendFunctionRole policy before value");
  const afterPolicy = parseCandidateJson(detail.Target.AfterValue, "BackendFunctionRole policy after value");
  validateBackendRolePolicyReference(beforePolicy, afterPolicy);
  assert.deepEqual(
    normalizeBackendRolePolicy(before?.Properties?.Policies?.[0]?.PolicyDocument),
    normalizeBackendRolePolicy(beforePolicy),
  );
  assert.deepEqual(
    normalizeBackendRolePolicy(after?.Properties?.Policies?.[0]?.PolicyDocument),
    normalizeBackendRolePolicy(afterPolicy),
  );
  assert.deepEqual(normalizeBackendRoleContext(after), normalizeBackendRoleContext(before), "BackendFunctionRole changed outside the recreated table reference");
}

function validateBackendRolePolicyReference(before, after) {
  assertExactFields(before, ["Statement", "Version"]);
  assertExactFields(after, ["Statement", "Version"]);
  assert.equal(before.Version, "2008-10-17");
  assert.equal(after.Version, before.Version);
  assert.equal(before.Statement?.length, 1);
  assert.equal(after.Statement?.length, 1);
  const fixtureActions = loadPrefixZeroFixture().references.find(({ logicalId }) => logicalId === "BackendFunctionRole")?.actions;
  for (const statement of [before.Statement[0], after.Statement[0]]) {
    assertExactFields(statement, ["Action", "Effect", "Resource"]);
    assert.equal(statement.Effect, "Allow");
    assert.deepEqual([...statement.Action].sort(), [...fixtureActions].sort());
    assert.equal(new Set(statement.Action).size, fixtureActions.length);
  }
  assert.equal(before.Statement[0].Resource.filter((value) => value === CONTRACT.tableArn).length, 1);
  assert.equal(after.Statement[0].Resource.filter((value) => value === "{{changeSet:KNOWN_AFTER_APPLY}}").length, 1);
  const rebound = after.Statement[0].Resource.map((value) => value === "{{changeSet:KNOWN_AFTER_APPLY}}" ? CONTRACT.tableArn : value);
  assert.deepEqual(rebound, before.Statement[0].Resource, "BackendFunctionRole policy changed outside the table ARN reference");
}

function normalizeBackendRoleContext(context) {
  const normalized = structuredClone(context);
  for (const policy of normalized?.Properties?.Policies ?? []) {
    policy.PolicyDocument = normalizeBackendRolePolicy(policy.PolicyDocument, { rebind: true });
  }
  return normalized;
}

function normalizeBackendRolePolicy(policy, { rebind = false } = {}) {
  const normalized = structuredClone(policy);
  for (const statement of normalized?.Statement ?? []) {
    if (Array.isArray(statement.Action)) statement.Action.sort();
    if (Array.isArray(statement.Resource)) {
      statement.Resource = statement.Resource
        .map((value) => rebind && value === "{{changeSet:KNOWN_AFTER_APPLY}}" ? CONTRACT.tableArn : value)
        .sort();
    }
  }
  return normalized;
}

function expectedTableContext() {
  const fixture = loadPrefixZeroFixture().tableResource;
  return {
    Properties: {
      AttributeDefinitions: structuredClone(fixture.Properties.AttributeDefinitions),
      BillingMode: fixture.Properties.BillingMode,
      KeySchema: structuredClone(fixture.Properties.KeySchema),
      PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: "true" },
      SSESpecification: { SSEEnabled: "true" },
      TableName: CONTRACT.physicalTable,
    },
    DeletionPolicy: fixture.DeletionPolicy,
    Metadata: structuredClone(fixture.Metadata),
    UpdateReplacePolicy: fixture.UpdateReplacePolicy,
  };
}

function parseCandidateJson(value, label) {
  assert.equal(typeof value, "string", `${label} must be JSON text`);
  const parsed = JSON.parse(value);
  assert.ok(parsed && typeof parsed === "object" && !Array.isArray(parsed), `${label} must be a JSON object`);
  return parsed;
}

function matchPhysicalId(value, pattern) {
  assert.match(value ?? "", pattern, "candidate physical resource identity changed");
  return value;
}

export function deriveResetId({ stackIdDigest, sha, fixtureDigest, oldTableIdDigest }) {
  assert.match(stackIdDigest ?? "", HEX);
  assert.match(sha ?? "", SHA);
  for (const value of [fixtureDigest, oldTableIdDigest]) assert.match(value ?? "", HEX);
  return digest({ schema: CONTRACT.recordSchema, repository: CONTRACT.repository, stackIdDigest, sha, fixtureDigest, oldTableIdDigest });
}

export function deriveOperationId({ resetId, phase, sourceSha, priorCompletionDigest, plannedTargetDigest }) {
  assert.match(resetId ?? "", HEX);
  assert.ok(PHASES.includes(phase));
  assert.match(sourceSha ?? "", SHA);
  assert.ok(priorCompletionDigest === NO_RECEIPT || HEX.test(priorCompletionDigest));
  assert.match(plannedTargetDigest ?? "", HEX);
  return digest({ schema: CONTRACT.recordSchema, resetId, ordinal: PHASE_ORDINAL[phase], phase, sourceSha, priorCompletionDigest, plannedTargetDigest });
}

export function operationPrefix(resetId, phase, operationId) {
  assert.match(resetId ?? "", HEX);
  assert.match(operationId ?? "", HEX);
  assert.ok(PHASES.includes(phase));
  return `${CONTRACT.evidencePrefix}runs/${resetId}/operations/${String(PHASE_ORDINAL[phase]).padStart(3, "0")}-${phase}-${operationId}/`;
}

export function intentKey(identity) { return `${operationPrefix(identity.resetId, identity.phase, identity.operationId)}intent.json`; }
export function completionKey(identity, completionDigest) {
  assert.match(completionDigest ?? "", HEX);
  return `${operationPrefix(identity.resetId, identity.phase, identity.operationId)}completion-${completionDigest}.json`;
}

export function makeIntent({ identity, prior, prestate, approval, target, expectedPostcondition, github }) {
  const record = sealRecord({
    schema: CONTRACT.recordSchema,
    kind: "intent",
    ...identity,
    repository: github.repository,
    ref: github.ref,
    sourceSha: github.sha,
    actor: github.actor,
    priorReceipt: prior?.receiptId ?? NO_RECEIPT,
    priorCompletionDigest: prior?.completionDigest ?? NO_RECEIPT,
    stackIdDigest: identity.stackIdDigest,
    prestate,
    prestateDigest: digest(prestate),
    approvalDigest: digest(approval),
    target: {
      service: target.service,
      operation: target.operation,
      targetIdentityDigest: target.targetIdentityDigest,
      fixedArgvDigest: digest(target.argv),
      clientToken: target.clientToken ?? null,
    },
    expectedPostcondition,
    expectedPostconditionDigest: digest(expectedPostcondition),
    github: { runId: github.runId, runAttempt: github.runAttempt },
  });
  validateIntent(record);
  return Object.freeze(record);
}

export function makeCompletion({ intent, intentDigest, outcome, poststate, prior, candidate }) {
  assert.ok(["executed-and-verified", "observed-complete-on-resume"].includes(outcome));
  const record = sealRecord({
    schema: CONTRACT.recordSchema,
    kind: "completion",
    resetId: intent.resetId,
    ordinal: intent.ordinal,
    phase: intent.phase,
    operationId: intent.operationId,
    plannedTargetDigest: intent.plannedTargetDigest,
    stackIdDigest: intent.stackIdDigest,
    repository: intent.repository,
    ref: intent.ref,
    sourceSha: intent.sourceSha,
    actor: intent.actor,
    intentKey: intentKey(intent),
    intentDigest,
    outcome,
    poststate,
    poststateDigest: digest(poststate),
    priorReceipt: prior?.receiptId ?? NO_RECEIPT,
    priorCompletionDigest: prior?.completionDigest ?? NO_RECEIPT,
    candidate: candidate ?? null,
    nextPhase: nextPhase(intent.phase, poststate),
    nextReceipt: null,
    chainDigest: digest({ resetId: intent.resetId, operationId: intent.operationId, intentDigest, priorCompletionDigest: prior?.completionDigest ?? NO_RECEIPT, poststateDigest: digest(poststate), candidateDigest: candidate?.candidateDigest ?? null }),
  });
  validateCompletion(record);
  return Object.freeze(record);
}

export function recordDigest(record) {
  const unsigned = structuredClone(record);
  delete unsigned.recordDigest;
  return digest(unsigned);
}

export function receiptFor(completion) {
  validateCompletion(completion);
  const completionDigest = recordDigest(completion);
  return Object.freeze({
    receiptId: `sr1-${completion.operationId}-${completionDigest}`,
    receiptDigest: `sha256:${completionDigest}`,
    operationId: completion.operationId,
    completionDigest,
  });
}

export function validateIntent(record) {
  assertExactFields(record, [
    "actor", "approvalDigest", "expectedPostcondition", "expectedPostconditionDigest", "github", "kind",
    "operationId", "ordinal", "phase", "plannedTargetDigest", "prestate", "prestateDigest",
    "priorCompletionDigest", "priorReceipt", "recordDigest", "ref", "repository", "resetId", "schema",
    "sourceSha", "stackIdDigest", "target",
  ]);
  validateCommonRecord(record, "intent");
  assert.equal(record.ordinal, PHASE_ORDINAL[record.phase]);
  assert.match(record.prestateDigest ?? "", HEX);
  assert.equal(record.prestateDigest, digest(record.prestate));
  assert.match(record.approvalDigest ?? "", HEX);
  assert.match(record.expectedPostconditionDigest ?? "", HEX);
  assert.equal(record.expectedPostconditionDigest, digest(record.expectedPostcondition));
  assert.match(record.target?.targetIdentityDigest ?? "", HEX);
  assert.match(record.target?.fixedArgvDigest ?? "", HEX);
  assert.ok(record.target?.clientToken === null || HEX.test(record.target?.clientToken));
  assertExactFields(record.target, ["clientToken", "fixedArgvDigest", "operation", "service", "targetIdentityDigest"]);
  assertExactFields(record.github, ["runAttempt", "runId"]);
  assert.match(record.github?.runId ?? "", /^[1-9][0-9]{0,19}$/);
  assert.match(record.github?.runAttempt ?? "", /^[1-9][0-9]?$/);
  return record;
}

export function validateCompletion(record) {
  assertExactFields(record, [
    "actor", "candidate", "chainDigest", "intentDigest", "intentKey", "kind", "nextPhase", "operationId",
    "nextReceipt", "ordinal", "outcome", "phase", "plannedTargetDigest", "poststate", "poststateDigest",
    "priorCompletionDigest", "priorReceipt", "recordDigest", "ref", "repository", "resetId", "schema",
    "sourceSha", "stackIdDigest",
  ]);
  validateCommonRecord(record, "completion");
  assert.match(record.intentDigest ?? "", HEX);
  assert.equal(record.intentKey, intentKey(record));
  assert.ok(["executed-and-verified", "observed-complete-on-resume"].includes(record.outcome));
  assert.equal(record.poststateDigest, digest(record.poststate));
  assert.match(record.chainDigest ?? "", HEX);
  assert.equal(record.nextReceipt, null);
  if (record.candidate !== null) {
    assertExactFields(record.candidate, [
      "candidateArn", "candidateArnDigest", "candidateDetails", "candidateDigest", "candidateTemplateDigest",
      "candidateInventoryDigest", "candidateRequestDigest", "changeDetailsDigest", "changeSetDigest", "capabilities", "description", "name",
      "parametersDigest", "stackIdDigest",
    ]);
    assert.match(record.candidate?.candidateArnDigest ?? "", HEX);
    assert.match(record.candidate?.candidateDigest ?? "", HEX);
    assert.match(record.candidate?.candidateInventoryDigest ?? "", HEX);
    assert.match(record.candidate?.candidateRequestDigest ?? "", HEX);
    assert.match(record.candidate?.candidateTemplateDigest ?? "", HEX);
    assert.match(record.candidate?.changeDetailsDigest ?? "", HEX);
    assert.match(record.candidate?.changeSetDigest ?? "", HEX);
    assert.match(record.candidate?.parametersDigest ?? "", HEX);
    assert.equal(digest(record.candidate.candidateArn), record.candidate.candidateArnDigest);
    assert.equal(digest(record.candidate.candidateDetails), record.candidate.candidateDigest);
    assert.equal(digest(record.candidate.candidateDetails.changeSet), record.candidate.changeSetDigest);
    assert.equal(digest(record.candidate.candidateDetails.changes), record.candidate.changeDetailsDigest);
    assert.equal(record.candidate.stackIdDigest, record.stackIdDigest);
    if (record.phase === "create") assert.equal(record.candidate.candidateInventoryDigest, digest(record.poststate.candidates), "create completion candidate inventory changed");
  }
  return record;
}

function validateCommonRecord(record, type) {
  assert.equal(record.schema, CONTRACT.recordSchema);
  assert.equal(record.kind, type);
  assert.match(record.resetId ?? "", HEX);
  assert.ok(PHASES.includes(record.phase));
  assert.equal(record.ordinal, PHASE_ORDINAL[record.phase]);
  assert.match(record.operationId ?? "", HEX);
  assert.match(record.plannedTargetDigest ?? "", HEX);
  assert.match(record.stackIdDigest ?? "", HEX);
  assert.equal(record.repository, CONTRACT.repository);
  assert.equal(record.ref, CONTRACT.ref);
  assert.match(record.sourceSha ?? "", SHA);
  assert.equal(record.actor, CONTRACT.actor);
  assert.ok(record.priorReceipt === NO_RECEIPT || RECEIPT.test(record.priorReceipt));
  assert.ok(record.priorCompletionDigest === NO_RECEIPT || HEX.test(record.priorCompletionDigest));
  if (record.priorReceipt === NO_RECEIPT) assert.equal(record.priorCompletionDigest, NO_RECEIPT);
  else assert.equal(RECEIPT.exec(record.priorReceipt)[2], record.priorCompletionDigest);
  assert.match(record.recordDigest ?? "", HEX);
  assert.equal(record.recordDigest, recordDigest(record), "record self-digest mismatch");
}

function sealRecord(value) {
  const record = structuredClone(value);
  record.recordDigest = digest(record);
  return record;
}

function assertExactFields(value, fields) {
  assert.ok(value && typeof value === "object" && !Array.isArray(value));
  assert.deepEqual(Object.keys(value).sort(), [...fields].sort(), "record fields changed");
}

function nextPhase(phase, poststate) {
  if (phase === "preflight") return poststate.table?.deletionProtection ? "disable-protection" : "delete";
  return ({
    "disable-protection": "delete",
    delete: "create",
    create: "execute",
    execute: "verify",
    verify: null,
    "cleanup-candidate": "abandon",
    "restore-protection": "abandon",
    abandon: null,
  })[phase];
}

export function approvalFor(phase, priorDigest = NO_RECEIPT_DIGEST) {
  assert.ok(PHASES.includes(phase));
  return `APPROVE DISPOSABLE SPONSOR RESET ${phase.toUpperCase()} ${priorDigest}`;
}

export function validateApproval(actual, phase, priorDigest) {
  assert.equal(actual, approvalFor(phase, priorDigest), "typed approval mismatch");
}

export function assertPoststateEqual(before, after, allowedPaths = []) {
  const left = structuredClone(before);
  const right = structuredClone(after);
  for (const pointer of allowedPaths) {
    deletePointer(left, pointer);
    deletePointer(right, pointer);
  }
  assert.deepEqual(right, left, "poststate changed outside reviewed paths");
}

function deletePointer(value, pointer) {
  const parts = pointer.split("/").slice(1).map(unescapePointer);
  const leaf = parts.pop();
  let cursor = value;
  for (const part of parts) cursor = cursor?.[part];
  if (Array.isArray(cursor) && /^\d+$/.test(leaf ?? "")) cursor.splice(Number(leaf), 1);
  else if (cursor && leaf !== undefined) delete cursor[leaf];
}

function normalizeTags(tags) {
  assert.ok(Array.isArray(tags));
  return tags.map(({ Key, Value }) => ({ Key, Value })).sort((a, b) => a.Key.localeCompare(b.Key));
}

function stableTable(table) {
  const copy = structuredClone(table);
  delete copy.CreationDateTime;
  delete copy.ItemCount;
  delete copy.TableSizeBytes;
  delete copy.ProvisionedThroughput;
  return copy;
}

function sanitizedCandidate(value) {
  const copy = structuredClone(value);
  delete copy.Changes;
  delete copy.NextToken;
  return copy;
}

function escapePointer(value) { return value.replaceAll("~", "~0").replaceAll("/", "~1"); }
function unescapePointer(value) { return value.replaceAll("~1", "/").replaceAll("~0", "~"); }
function escapeRegex(value) { return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

export { canonicalJson, digest };
