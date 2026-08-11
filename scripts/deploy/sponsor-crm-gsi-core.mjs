import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import yaml from "js-yaml";

export const CONTRACT = Object.freeze({
  account: "817685572750",
  region: "eu-west-1",
  repository: "DataTalksClub/dataops",
  ref: "refs/heads/main",
  stack: "dataops-v1",
  logicalId: "DataOpsSponsorCrmTable",
  physicalTable: "dataops-v1-sponsor-crm",
});

export const STAGES = Object.freeze([
  stage("GSI-Communication", "GSI1PK", "GSI1SK"),
  stage("GSI-SponsorSendDue", "GSI2PK", "GSI2SK"),
  stage("GSI-SponsorSendLookup", "GSI3PK", "GSI3SK"),
  stage("GSI-SponsorBookingCommunication", "GSI4PK", "GSI4SK"),
]);

const BASE_ATTRIBUTES = Object.freeze([
  { AttributeName: "PK", AttributeType: "S" },
  { AttributeName: "SK", AttributeType: "S" },
]);

const TERMINAL_SUCCESS = new Set([
  "CREATE_COMPLETE",
  "UPDATE_COMPLETE",
  "UPDATE_ROLLBACK_COMPLETE",
  "IMPORT_COMPLETE",
]);

const IN_PROGRESS_SUFFIXES = [
  "_IN_PROGRESS",
  "_CLEANUP_IN_PROGRESS",
];
const UUID_PATTERN =
  "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";

const REEVALUATED_DEPENDENCIES = Object.freeze({
  BackendFunctionDailyBackendCronPermission: Object.freeze({ resourceType: "AWS::Lambda::Permission", replacement: "Conditional", property: "SourceArn", recreation: "Always", causingEntity: "BackendFunctionDailyBackendCron.Arn" }),
  BackendFunctionDailyBackendCron: Object.freeze({ resourceType: "AWS::Events::Rule", replacement: "False", property: "Targets", recreation: "Never", causingEntity: "BackendFunction.Arn" }),
  BackendFunctionDailyBackendExportPermission: Object.freeze({ resourceType: "AWS::Lambda::Permission", replacement: "Conditional", property: "SourceArn", recreation: "Always", causingEntity: "BackendFunctionDailyBackendExport.Arn" }),
  BackendFunctionDailyBackendExport: Object.freeze({ resourceType: "AWS::Events::Rule", replacement: "False", property: "Targets", recreation: "Never", causingEntity: "BackendFunction.Arn" }),
  BackendFunctionDailyMailingExportPermission: Object.freeze({ resourceType: "AWS::Lambda::Permission", replacement: "Conditional", property: "SourceArn", recreation: "Always", causingEntity: "BackendFunctionDailyMailingExport.Arn" }),
  BackendFunctionDailyMailingExport: Object.freeze({ resourceType: "AWS::Events::Rule", replacement: "False", property: "Targets", recreation: "Never", causingEntity: "BackendFunction.Arn" }),
  BackendFunctionRole: Object.freeze({ resourceType: "AWS::IAM::Role", replacement: "False", property: "Policies", recreation: "Never", causingEntity: "DataOpsSponsorCrmTable.Arn" }),
  BackendFunction: Object.freeze({ resourceType: "AWS::Lambda::Function", replacement: "False", property: "Role", recreation: "Never", causingEntity: "BackendFunctionRole.Arn" }),
});

function stage(IndexName, hash, range) {
  return Object.freeze({
    IndexName,
    attributes: Object.freeze([
      Object.freeze({ AttributeName: hash, AttributeType: "S" }),
      Object.freeze({ AttributeName: range, AttributeType: "S" }),
    ]),
    index: Object.freeze({
      IndexName,
      KeySchema: Object.freeze([
        Object.freeze({ AttributeName: hash, KeyType: "HASH" }),
        Object.freeze({ AttributeName: range, KeyType: "RANGE" }),
      ]),
      Projection: Object.freeze({ ProjectionType: "ALL" }),
    }),
  });
}

function intrinsicType(tag, key, kind) {
  return new yaml.Type(tag, {
    kind,
    construct(value) {
      if (key === "Ref") return { Ref: value };
      if (key === "Fn::GetAtt" && typeof value === "string") {
        return { [key]: value.split(".") };
      }
      return { [key]: value };
    },
  });
}

const INTRINSIC_DEFINITIONS = [
  ["!Ref", "Ref", "scalar"],
  ["!Sub", "Fn::Sub", "scalar"],
  ["!Sub", "Fn::Sub", "sequence"],
  ["!GetAtt", "Fn::GetAtt", "scalar"],
  ["!GetAtt", "Fn::GetAtt", "sequence"],
  ["!Join", "Fn::Join", "sequence"],
  ["!Select", "Fn::Select", "sequence"],
  ["!Split", "Fn::Split", "sequence"],
  ["!If", "Fn::If", "sequence"],
  ["!Equals", "Fn::Equals", "sequence"],
  ["!Not", "Fn::Not", "sequence"],
  ["!And", "Fn::And", "sequence"],
  ["!Or", "Fn::Or", "sequence"],
  ["!FindInMap", "Fn::FindInMap", "sequence"],
  ["!ImportValue", "Fn::ImportValue", "scalar"],
  ["!ImportValue", "Fn::ImportValue", "sequence"],
  ["!Base64", "Fn::Base64", "scalar"],
  ["!Base64", "Fn::Base64", "mapping"],
  ["!GetAZs", "Fn::GetAZs", "scalar"],
  ["!Transform", "Fn::Transform", "mapping"],
  ["!Condition", "Condition", "scalar"],
];

const CFN_SCHEMA = yaml.Schema.create(
  [yaml.JSON_SCHEMA],
  INTRINSIC_DEFINITIONS.map(([tag, key, kind]) =>
    intrinsicType(tag, key, kind),
  ),
);

export function parseTemplate(body) {
  if (isObject(body)) return structuredClone(body);
  assert.equal(typeof body, "string", "template body must be a string or object");
  const parsed = yaml.safeLoad(body, { schema: CFN_SCHEMA, json: true });
  assert.ok(isObject(parsed), "template must parse to an object");
  return parsed;
}

export function readTemplate(path) {
  return parseTemplate(readFileSync(path, "utf8"));
}

export function canonicalJson(value) {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (isObject(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function digest(value) {
  return createHash("sha256")
    .update(typeof value === "string" ? value : canonicalJson(value))
    .digest("hex");
}

export function sponsorTable(template) {
  const resource = template?.Resources?.[CONTRACT.logicalId];
  assert.ok(isObject(resource), `missing ${CONTRACT.logicalId}`);
  assert.equal(resource.Type, "AWS::DynamoDB::Table", "unexpected table resource type");
  assert.equal(resource.DeletionPolicy, "Retain", "table DeletionPolicy must stay Retain");
  assert.equal(resource.UpdateReplacePolicy, "Retain", "table UpdateReplacePolicy must stay Retain");
  assert.ok(isObject(resource.Properties), "table Properties must be an object");
  return resource;
}

export function validateTargetTemplate(template) {
  const resource = sponsorTable(template);
  const properties = resource.Properties;
  validatePreservedTableProperties(properties);
  assert.deepEqual(
    properties.TableName,
    { "Fn::Sub": "${AWS::StackName}-sponsor-crm" },
    "checked-in target table identity changed",
  );
  assert.deepEqual(
    properties.KeySchema,
    [
      { AttributeName: "PK", KeyType: "HASH" },
      { AttributeName: "SK", KeyType: "RANGE" },
    ],
    "checked-in target base key schema changed",
  );
  assert.ok(
    !Object.hasOwn(properties, "Tags"),
    "checked-in target must inherit only the exact stack tags",
  );
  assert.deepEqual(
    properties.TimeToLiveSpecification,
    { AttributeName: "ttl", Enabled: true },
    "checked-in target TTL contract changed",
  );
  assert.deepEqual(
    properties.StreamSpecification,
    { StreamViewType: "NEW_AND_OLD_IMAGES" },
    "checked-in target stream contract changed",
  );
  assert.deepEqual(
    properties.AttributeDefinitions,
    expectedAttributes(STAGES.length),
    "checked-in target attributes do not match the canonical schema",
  );
  assert.deepEqual(
    properties.GlobalSecondaryIndexes,
    STAGES.map((entry) => entry.index),
    "checked-in target indexes do not match the canonical schema/order",
  );
  return {
    targetDigest: digest({
      attributes: properties.AttributeDefinitions,
      indexes: properties.GlobalSecondaryIndexes,
    }),
  };
}

export function inspectProcessedPrefix(template) {
  const properties = sponsorTable(template).Properties;
  validatePreservedTableProperties(properties);
  assert.deepEqual(
    properties.KeySchema,
    [
      { AttributeName: "PK", KeyType: "HASH" },
      { AttributeName: "SK", KeyType: "RANGE" },
    ],
    "processed base key schema mismatch",
  );
  const attributes = properties.AttributeDefinitions;
  const indexes = properties.GlobalSecondaryIndexes ?? [];
  assert.ok(Array.isArray(attributes), "processed AttributeDefinitions must be an array");
  assert.ok(Array.isArray(indexes), "processed GlobalSecondaryIndexes must be an array");
  const prefix = prefixFromIndexes(indexes);
  assert.deepEqual(
    attributes,
    expectedAttributes(prefix),
    "processed attributes are not the exact canonical prefix",
  );
  return prefix;
}

export function inspectLivePrefix(table) {
  return inspectLiveTable(table, true);
}

export function inspectLiveTransitionPrefix(table) {
  return inspectLiveTable(table, false);
}

export function isResumableLiveTransition(table, expectedPrefix) {
  if (expectedPrefix <= 0) return false;
  if (inspectLiveTransitionPrefix(table) !== expectedPrefix) return false;
  const target = table.GlobalSecondaryIndexes[expectedPrefix - 1];
  return (
    target.IndexStatus === "CREATING" ||
    target.Backfilling === true
  );
}

function inspectLiveTable(table, requireActive) {
  assert.ok(isObject(table), "DescribeTable response is missing Table");
  assert.equal(table.TableName, CONTRACT.physicalTable, "live physical table mismatch");
  if (requireActive) {
    assert.equal(table.TableStatus, "ACTIVE", "live table is not ACTIVE");
  } else {
    assert.ok(
      table.TableStatus === "ACTIVE" || table.TableStatus === "UPDATING",
      "live table is not in an accepted waiter state",
    );
  }
  assert.equal(
    table.BillingModeSummary?.BillingMode,
    "PAY_PER_REQUEST",
    "live billing mode mismatch",
  );
  assert.equal(
    table.SSEDescription?.Status,
    "ENABLED",
    "live encryption is not enabled",
  );
  assert.equal(
    table.ContinuousBackupsDescription?.PointInTimeRecoveryDescription
      ?.PointInTimeRecoveryStatus,
    "ENABLED",
    "live point-in-time recovery is not enabled",
  );
  assert.deepEqual(
    table.KeySchema,
    [
      { AttributeName: "PK", KeyType: "HASH" },
      { AttributeName: "SK", KeyType: "RANGE" },
    ],
    "live base key schema mismatch",
  );
  const indexes = (table.GlobalSecondaryIndexes ?? []).map((item) => ({
    IndexName: item.IndexName,
    KeySchema: item.KeySchema,
    Projection: item.Projection,
  }));
  const prefix = prefixFromIndexes(indexes);
  assert.deepEqual(
    normalizedAttributes(table.AttributeDefinitions),
    normalizedAttributes(expectedAttributes(prefix)),
    "live attributes are not the exact canonical prefix",
  );
  for (let ordinal = 0; ordinal < prefix; ordinal += 1) {
    const live = table.GlobalSecondaryIndexes[ordinal];
    const targetMayBeCreating = !requireActive && ordinal === prefix - 1;
    if (targetMayBeCreating) {
      assert.ok(
        live.IndexStatus === "ACTIVE" || live.IndexStatus === "CREATING",
        `${STAGES[ordinal].IndexName} is not in an accepted waiter state`,
      );
    } else {
      assert.equal(
        live.IndexStatus,
        "ACTIVE",
        `${STAGES[ordinal].IndexName} is not ACTIVE`,
      );
    }
    if (requireActive || !targetMayBeCreating || live.IndexStatus === "ACTIVE") {
      assert.ok(
        live.Backfilling === false || live.Backfilling === undefined,
        `${STAGES[ordinal].IndexName} is still backfilling`,
      );
    }
  }
  return prefix;
}

function prefixFromIndexes(indexes) {
  assert.ok(indexes.length <= STAGES.length, "unexpected extra GSI");
  for (let ordinal = 0; ordinal < indexes.length; ordinal += 1) {
    assert.deepEqual(
      indexes[ordinal],
      STAGES[ordinal].index,
      `GSI schema/order mismatch at ordinal ${ordinal + 1}`,
    );
  }
  return indexes.length;
}

export function assertSamePrefix(processedTemplate, liveTable) {
  const processedPrefix = inspectProcessedPrefix(processedTemplate);
  const livePrefix = inspectLivePrefix(liveTable);
  assert.equal(
    processedPrefix,
    livePrefix,
    "processed template and live table prefixes disagree",
  );
  return processedPrefix;
}

export function buildStageTemplate(processedTemplate, ordinal) {
  assert.ok(
    Number.isInteger(ordinal) && ordinal >= 0 && ordinal < STAGES.length,
    "stage ordinal must be 0 through 3",
  );
  const currentPrefix = inspectProcessedPrefix(processedTemplate);
  assert.equal(ordinal, currentPrefix, "stage must add exactly the next missing GSI");

  const before = structuredClone(processedTemplate);
  const result = structuredClone(processedTemplate);
  const properties = sponsorTable(result).Properties;
  properties.AttributeDefinitions = expectedAttributes(ordinal + 1);
  properties.GlobalSecondaryIndexes = STAGES.slice(0, ordinal + 1).map(
    (entry) => structuredClone(entry.index),
  );

  assertOnlyGsiFieldsChanged(before, result);
  assert.equal(inspectProcessedPrefix(result), ordinal + 1);
  return result;
}

export function assertOnlyGsiFieldsChanged(before, after) {
  const strippedBefore = stripMutableGsiFields(before);
  const strippedAfter = stripMutableGsiFields(after);
  assert.deepEqual(
    strippedAfter,
    strippedBefore,
    "stage transformer changed content outside the two allowed GSI properties",
  );
}

function stripMutableGsiFields(template) {
  const clone = structuredClone(template);
  const properties = sponsorTable(clone).Properties;
  delete properties.AttributeDefinitions;
  delete properties.GlobalSecondaryIndexes;
  return clone;
}

export function stageIdentity({
  repository,
  ref,
  deploymentDigest,
  targetDigest,
  baselineTemplate,
  ordinal,
  stagedTemplate,
  attemptNonce,
}) {
  assert.equal(repository, CONTRACT.repository, "invalid repository binding");
  assert.equal(ref, CONTRACT.ref, "invalid ref binding");
  assert.match(deploymentDigest, /^[0-9a-f]{40,64}$/i, "invalid deployment digest");
  assert.match(targetDigest, /^[0-9a-f]{64}$/, "invalid target digest");
  assert.match(
    attemptNonce,
    /^[1-9][0-9]{0,19}:[1-9][0-9]?$/,
    "invalid attempt nonce",
  );
  const baselineDigest = digest(baselineTemplate);
  const schemaDigest = digest(STAGES[ordinal]);
  const stagedTemplateDigest = digest(stagedTemplate);
  const binding = digest({
    repository,
    ref,
    deploymentDigest: deploymentDigest.toLowerCase(),
    targetDigest,
    baselineDigest,
    ordinal: ordinal + 1,
    schemaDigest,
    stagedTemplateDigest,
  });
  const attemptDigest = digest({ binding, attemptNonce });
  return {
    ordinal: ordinal + 1,
    baselineDigest,
    schemaDigest,
    stagedTemplateDigest,
    binding,
    attemptDigest,
    identity: attemptDigest,
    name: `dataops-sponsor-gsi-${ordinal + 1}-${binding.slice(0, 16)}-${attemptDigest.slice(0, 16)}`,
    description: `dataops-sponsor-gsi/v3/${ordinal + 1}/${binding}/${attemptNonce}/${attemptDigest}/${stagedTemplateDigest}`,
  };
}

export function validateStack(stack) {
  validateStackIdentity(stack);
  validateStackHealth(stack);
}

export function validateStackIdentity(stack) {
  assert.equal(stack.StackName, CONTRACT.stack, "stack identity mismatch");
  assert.match(
    stack.StackId ?? "",
    new RegExp(
      `^arn:aws:cloudformation:eu-west-1:817685572750:stack/dataops-v1/${UUID_PATTERN}$`,
    ),
    "stack ARN identity mismatch",
  );
}

export function validateStackHealth(stack) {
  assert.ok(
    TERMINAL_SUCCESS.has(stack.StackStatus),
    `stack is not in an accepted terminal state: ${safeStatus(stack.StackStatus)}`,
  );
}

export function validateCallerIdentity(caller) {
  assert.equal(caller?.Account, CONTRACT.account, "AWS account mismatch");
  assert.match(
    caller?.Arn ?? "",
    /^arn:aws:sts::817685572750:assumed-role\/dataops-github-actions-deploy\/[^/]+$/,
    "AWS deployment role mismatch",
  );
}

export function isStackInProgress(status) {
  return (
    typeof status === "string" &&
    IN_PROGRESS_SUFFIXES.some((suffix) => status.endsWith(suffix))
  );
}

export function isStackTerminalSuccess(status) {
  return TERMINAL_SUCCESS.has(status);
}

export function classifyChangeSetCreation(status) {
  if (status === "CREATE_COMPLETE") return "success";
  if (
    status === undefined ||
    status === "CREATE_PENDING" ||
    status === "CREATE_IN_PROGRESS"
  ) {
    return "waiting";
  }
  return "failure";
}

export function classifyStackExecution(changeSetExecutionStatus, stackStatus) {
  if (
    changeSetExecutionStatus === "EXECUTE_COMPLETE" &&
    stackStatus === "UPDATE_COMPLETE"
  ) {
    return "success";
  }
  if (isStackInProgress(stackStatus) || stackStatus === "UPDATE_COMPLETE") {
    return "waiting";
  }
  return "failure";
}

export function validateStageChangeSet(
  changeSet,
  identity,
  ordinal,
  stackId,
  expectedParameters,
) {
  assert.equal(changeSet.ChangeSetName, identity.name, "change-set name collision");
  validateChangeSetArn(changeSet);
  assert.equal(changeSet.Description, identity.description, "change-set identity collision");
  assert.equal(changeSet.StackName, CONTRACT.stack, "change-set stack mismatch");
  assert.equal(changeSet.StackId, stackId, "change-set stack ARN mismatch");
  assert.equal(changeSet.Status, "CREATE_COMPLETE", "change set is not ready");
  assert.ok(
    changeSet.ExecutionStatus === "AVAILABLE" ||
      changeSet.ExecutionStatus === "EXECUTE_COMPLETE",
    "change set is not executable or completed",
  );
  assert.deepEqual(
    [...(changeSet.Capabilities ?? [])].sort(),
    ["CAPABILITY_AUTO_EXPAND", "CAPABILITY_IAM"],
    "stage capabilities changed",
  );
  assert.equal(changeSet.RoleARN, undefined, "stage role ARN must be absent");
  assert.deepEqual(
    changeSet.NotificationARNs ?? [],
    [],
    "stage notification ARNs must be empty",
  );
  assert.equal(
    changeSet.IncludeNestedStacks ?? false,
    false,
    "stage nested-stack inclusion must be false",
  );
  validateStageParameters(changeSet.Parameters, expectedParameters);
  assert.equal(changeSet.ChangeSetType, "UPDATE", "stage type changed");
  assert.deepEqual(
    changeSet.RollbackConfiguration?.RollbackTriggers ?? [],
    [],
    "stage rollback triggers must be empty",
  );
  assert.equal(
    changeSet.RollbackConfiguration?.MonitoringTimeInMinutes ?? 0,
    0,
    "stage rollback monitoring must be disabled",
  );
  assert.deepEqual(changeSet.Tags ?? [], [], "stage tags must be empty");
  assert.equal(
    changeSet.OnStackFailure ?? undefined,
    undefined,
    "stage on-stack-failure behavior must be absent",
  );
  assert.equal(
    changeSet.ImportExistingResources ?? false,
    false,
    "stage resource import must be disabled",
  );
  assert.equal(
    changeSet.ParentChangeSetId ?? undefined,
    undefined,
    "stage parent change set must be absent",
  );
  assert.equal(
    changeSet.RootChangeSetId ?? undefined,
    undefined,
    "stage root change set must be absent",
  );
  validateStageResourceChanges(changeSet.Changes);
  assert.ok(ordinal >= 0 && ordinal < STAGES.length);
}

function validateStageParameters(actual, expected) {
  const normalize = (parameters) => {
    assert.ok(Array.isArray(parameters), "stage parameters are missing");
    const normalized = parameters.map((parameter) => {
      assert.match(parameter?.ParameterKey ?? "", /^[A-Za-z][A-Za-z0-9]*$/);
      assert.equal(typeof parameter?.ParameterValue, "string");
      if (parameter.UsePreviousValue !== undefined) {
        assert.equal(parameter.UsePreviousValue, true);
      }
      return {
        ParameterKey: parameter.ParameterKey,
        ParameterValue: parameter.ParameterValue,
      };
    }).sort((left, right) => left.ParameterKey.localeCompare(right.ParameterKey));
    assert.equal(new Set(normalized.map(({ ParameterKey }) => ParameterKey)).size, normalized.length);
    return normalized;
  };
  assert.deepEqual(normalize(actual), normalize(expected), "stage parameters changed");
}

function validateStageResourceChanges(changes) {
  assert.ok(Array.isArray(changes), "stage changes are missing");
  const resources = new Map();
  for (const change of changes) {
    assert.equal(change?.Type, "Resource", "stage contains a non-resource change");
    const resource = change.ResourceChange;
    assert.equal(typeof resource?.LogicalResourceId, "string");
    assert.ok(!resources.has(resource.LogicalResourceId), "duplicate stage resource change");
    resources.set(resource.LogicalResourceId, resource);
  }
  const table = resources.get(CONTRACT.logicalId);
  assert.ok(table, "stage is missing the Sponsor CRM table change");
  resources.delete(CONTRACT.logicalId);
  if (resources.size > 0) {
    assert.deepEqual(
      [...resources.keys()].sort(),
      Object.keys(REEVALUATED_DEPENDENCIES).sort(),
      "stage dependency reevaluation closure changed",
    );
    for (const [logicalId, expected] of Object.entries(REEVALUATED_DEPENDENCIES)) {
      validateReevaluatedDependency(resources.get(logicalId), logicalId, expected);
    }
  }
  validateSponsorResourceChange(table, {
    exactProperties: new Set(["AttributeDefinitions", "GlobalSecondaryIndexes"]),
  });
}

function validateReevaluatedDependency(resource, logicalId, expected) {
  assert.equal(resource.Action, "Modify");
  assert.equal(resource.LogicalResourceId, logicalId);
  assert.match(resource.PhysicalResourceId ?? "", new RegExp(`^dataops-v1-${logicalId}-[A-Za-z0-9]{8,32}$`));
  assert.equal(resource.ResourceType, expected.resourceType);
  assert.equal(resource.Replacement, expected.replacement);
  assert.deepEqual(resource.Scope, ["Properties"]);
  assert.deepEqual(resource.Details, [{
    Target: {
      Attribute: "Properties",
      Name: expected.property,
      RequiresRecreation: expected.recreation,
    },
    Evaluation: "Dynamic",
    ChangeSource: "ResourceAttribute",
    CausingEntity: expected.causingEntity,
  }]);
}

export function validateChangeSetArn(changeSet) {
  assert.match(changeSet.ChangeSetName ?? "", /^[A-Za-z][-A-Za-z0-9]*$/);
  assert.equal(
    changeSet.ChangeSetId,
    `arn:aws:cloudformation:eu-west-1:817685572750:changeSet/${changeSet.ChangeSetName}/${changeSet.ChangeSetId?.split("/").at(-1)}`,
    "change-set ARN identity mismatch",
  );
  assert.match(
    changeSet.ChangeSetId?.split("/").at(-1) ?? "",
    new RegExp(`^${UUID_PATTERN}$`),
    "change-set ID mismatch",
  );
}

function validateSponsorResourceChange(
  resource,
  { exactProperties } = {},
) {
  assert.ok(isObject(resource), "missing resource change");
  assert.equal(resource.Action, "Modify", "Sponsor CRM change must be Modify");
  assert.equal(resource.LogicalResourceId, CONTRACT.logicalId, "logical ID mismatch");
  assert.equal(resource.PhysicalResourceId, CONTRACT.physicalTable, "physical ID mismatch");
  assert.equal(resource.ResourceType, "AWS::DynamoDB::Table", "resource type mismatch");
  assert.ok(
    resource.Replacement === "False" || resource.Replacement === false,
    "Sponsor CRM table replacement is prohibited",
  );
  assert.ok(Array.isArray(resource.Details), "resource change details are required");
  assert.ok(resource.Details.length > 0, "resource change details cannot be empty");
  assert.deepEqual(resource.Scope, ["Properties"], "Sponsor CRM scope changed");

  const properties = new Set();
  for (const detail of resource.Details) {
    const target = detail?.Target;
    assert.equal(target?.Attribute, "Properties", "unknown change target attribute");
    assert.equal(target?.RequiresRecreation, "Never", "property may require recreation");
    assert.equal(detail.ChangeSource, "DirectModification", "unknown change source");
    assert.equal(detail.Evaluation, "Static", "dynamic/unknown change evaluation");
    assert.equal(typeof target.Name, "string", "property name is missing");
    properties.add(target.Name);
  }
  if (exactProperties) {
    assert.deepEqual(properties, exactProperties, "stage changed an unexpected property");
  }
}

export function safeEvidence({
  event,
  ordinal,
  indexName,
  identity,
  prefix,
  status,
}) {
  const evidence = { event };
  if (ordinal !== undefined) evidence.ordinal = ordinal;
  if (indexName !== undefined) {
    assert.ok(STAGES.some((entry) => entry.IndexName === indexName));
    evidence.indexName = indexName;
  }
  if (identity !== undefined) {
    assert.match(identity, /^[0-9a-f]{64}$/);
    evidence.digest = identity;
  }
  if (prefix !== undefined) {
    assert.ok(Number.isInteger(prefix) && prefix >= 0 && prefix <= STAGES.length);
    evidence.prefix = prefix;
  }
  if (status !== undefined) evidence.status = safeStatus(status);
  return JSON.stringify(evidence);
}

function expectedAttributes(prefix) {
  return [
    ...BASE_ATTRIBUTES.map((item) => structuredClone(item)),
    ...STAGES.slice(0, prefix).flatMap((entry) =>
      entry.attributes.map((item) => structuredClone(item)),
    ),
  ];
}

function validatePreservedTableProperties(properties) {
  assert.equal(
    properties.BillingMode,
    "PAY_PER_REQUEST",
    "processed billing mode mismatch",
  );
  assert.deepEqual(
    properties.SSESpecification,
    { SSEEnabled: true },
    "processed encryption contract mismatch",
  );
  assert.deepEqual(
    properties.PointInTimeRecoverySpecification,
    { PointInTimeRecoveryEnabled: true },
    "processed point-in-time recovery contract mismatch",
  );
}

function normalizedAttributes(attributes) {
  assert.ok(Array.isArray(attributes), "attribute definitions must be an array");
  const normalized = attributes
    .map((attribute) => ({
      AttributeName: attribute?.AttributeName,
      AttributeType: attribute?.AttributeType,
    }))
    .sort((left, right) =>
      String(left.AttributeName).localeCompare(String(right.AttributeName)),
    );
  assert.equal(
    new Set(normalized.map((attribute) => attribute.AttributeName)).size,
    normalized.length,
    "duplicate attribute definition",
  );
  return normalized;
}

function safeStatus(status) {
  assert.match(status, /^[A-Z][A-Z0-9_]*$/, "unsafe status");
  return status;
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
