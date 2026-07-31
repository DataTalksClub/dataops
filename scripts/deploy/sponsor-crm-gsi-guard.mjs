#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import {
  CONTRACT,
  STAGES,
  assertSamePrefix,
  parseTemplate,
  safeEvidence,
  validateCallerIdentity,
  validateStack,
  validateTargetTemplate,
} from "./sponsor-crm-gsi-core.mjs";

const AWS_CALL_TIMEOUT_MS = Number(
  process.env.SPONSOR_GSI_AWS_CALL_TIMEOUT_MS ?? "30000",
);
const AWS_KILL_GRACE_MS = Number(
  process.env.SPONSOR_GSI_AWS_KILL_GRACE_MS ?? "1000",
);
const MAX_AWS_OUTPUT_BYTES = Number(
  process.env.SPONSOR_GSI_AWS_MAX_OUTPUT_BYTES ?? String(32 * 1024 * 1024),
);
const MAX_TEMPLATE_BYTES = 2 * 1024 * 1024;
const MAX_TAG_PAGES = 100;

class SafeFailure extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

function fail(code) {
  throw new SafeFailure(code);
}

function killGroup(child, signal) {
  if (!child?.pid) return;
  try {
    process.kill(-child.pid, signal);
  } catch (error) {
    if (error?.code !== "ESRCH") throw error;
  }
}

async function aws(service, operation, ...args) {
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
  const result = await new Promise((resolve, reject) => {
    const child = spawn("aws", argv, {
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        AWS_PAGER: "",
        AWS_MAX_ATTEMPTS: "1",
        AWS_RETRY_MODE: "standard",
      },
    });
    const stdout = [];
    const stderr = [];
    let bytes = 0;
    let termination;
    let killTimer;
    const terminate = (reason) => {
      if (termination) return;
      termination = reason;
      killGroup(child, "SIGTERM");
      killTimer = setTimeout(() => killGroup(child, "SIGKILL"), AWS_KILL_GRACE_MS);
      killTimer.unref();
    };
    const timeout = setTimeout(() => terminate("timeout"), AWS_CALL_TIMEOUT_MS);
    timeout.unref();
    const collect = (target) => (chunk) => {
      if (termination) return;
      bytes += chunk.length;
      if (bytes > MAX_AWS_OUTPUT_BYTES) {
        terminate("output-limit");
        return;
      }
      target.push(chunk);
    };
    child.stdout.on("data", collect(stdout));
    child.stderr.on("data", collect(stderr));
    child.on("error", reject);
    child.on("close", (status) => {
      clearTimeout(timeout);
      if (killTimer) clearTimeout(killTimer);
      resolve({
        status,
        termination,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      });
    });
  }).catch(() => fail(`aws-${service}-${operation}`));
  if (result.termination) fail(`aws-${service}-${operation}-${result.termination}`);
  if (result.status !== 0) fail(`aws-${service}-${operation}`);
  try {
    return result.stdout.trim() ? JSON.parse(result.stdout) : {};
  } catch {
    fail(`aws-${service}-${operation}-json`);
  }
}

async function tableTags(resourceArn) {
  const tags = [];
  const seenTokens = new Set();
  let token;
  for (let page = 0; page < MAX_TAG_PAGES; page += 1) {
    const args = ["--resource-arn", resourceArn];
    if (token) args.push("--next-token", token);
    const response = await aws("dynamodb", "list-tags-of-resource", ...args);
    assert.ok(Array.isArray(response.Tags));
    tags.push(...response.Tags);
    if (!response.NextToken) {
      const values = new Map();
      for (const tag of tags) {
        assert.equal(typeof tag?.Key, "string");
        assert.equal(typeof tag?.Value, "string");
        assert.ok(!values.has(tag.Key), "duplicate DynamoDB tag");
        values.set(tag.Key, tag.Value);
      }
      return values;
    }
    assert.equal(typeof response.NextToken, "string");
    assert.ok(
      response.NextToken.length > 0 && response.NextToken.length <= 4096,
    );
    assert.ok(!seenTokens.has(response.NextToken), "table tag pagination loop");
    seenTokens.add(response.NextToken);
    token = response.NextToken;
  }
  fail("table-tag-pagination-limit");
}

async function main() {
  assert.ok(Number.isFinite(AWS_CALL_TIMEOUT_MS) && AWS_CALL_TIMEOUT_MS > 0);
  assert.ok(Number.isFinite(AWS_KILL_GRACE_MS) && AWS_KILL_GRACE_MS > 0);
  assert.ok(
    Number.isInteger(MAX_AWS_OUTPUT_BYTES) &&
      MAX_AWS_OUTPUT_BYTES >= 1024 &&
      MAX_AWS_OUTPUT_BYTES <= 32 * 1024 * 1024,
  );
  assert.equal(process.argv.length, 3);
  assert.equal(process.env.GITHUB_REPOSITORY, CONTRACT.repository);
  assert.equal(process.env.GITHUB_REPOSITORY_OWNER, "DataTalksClub");
  assert.equal(process.env.GITHUB_REF, CONTRACT.ref);
  assert.match(process.env.GITHUB_SHA ?? "", /^[0-9a-f]{40}$/);
  assert.ok(
    process.env.GITHUB_EVENT_NAME === "push" ||
      process.env.GITHUB_EVENT_NAME === "workflow_dispatch",
  );
  assert.equal(process.env.AWS_REGION, CONTRACT.region);
  assert.equal(process.env.AWS_DEFAULT_REGION, CONTRACT.region);

  const source = readFileSync(process.argv[2], "utf8");
  assert.ok(
    Buffer.byteLength(source) > 0 &&
      Buffer.byteLength(source) <= MAX_TEMPLATE_BYTES,
  );
  const target = parseTemplate(source);
  const targetIdentity = validateTargetTemplate(target);

  validateCallerIdentity(await aws("sts", "get-caller-identity"));
  const stackResponse = await aws(
    "cloudformation",
    "describe-stacks",
    "--stack-name",
    CONTRACT.stack,
  );
  assert.equal(stackResponse.Stacks?.length, 1);
  const stack = stackResponse.Stacks[0];
  validateStack(stack);
  const resource = (await aws(
    "cloudformation",
    "describe-stack-resource",
    "--stack-name",
    CONTRACT.stack,
    "--logical-resource-id",
    CONTRACT.logicalId,
  )).StackResourceDetail;
  assert.equal(resource?.LogicalResourceId, CONTRACT.logicalId);
  assert.equal(resource?.ResourceType, "AWS::DynamoDB::Table");
  assert.equal(resource?.PhysicalResourceId, CONTRACT.physicalTable);

  const processed = parseTemplate((await aws(
    "cloudformation",
    "get-template",
    "--stack-name",
    CONTRACT.stack,
    "--template-stage",
    "Processed",
  )).TemplateBody);
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
  assert.equal(
    table.TableArn,
    `arn:aws:dynamodb:${CONTRACT.region}:${CONTRACT.account}:table/${CONTRACT.physicalTable}`,
  );
  assert.match(table.TableId ?? "", /^[A-Za-z0-9_.-]{8,128}$/);
  const tags = await tableTags(table.TableArn);
  assert.equal(
    tags.get("aws:cloudformation:stack-id"),
    stack.StackId,
    "DynamoDB stack-id ownership tag mismatch",
  );
  assert.equal(
    tags.get("aws:cloudformation:logical-id"),
    CONTRACT.logicalId,
    "DynamoDB logical-id ownership tag mismatch",
  );
  assert.equal(
    tags.get("aws:cloudformation:stack-name"),
    CONTRACT.stack,
    "DynamoDB stack-name ownership tag mismatch",
  );
  const prefix = assertSamePrefix(processed, table);
  if (prefix !== STAGES.length) {
    fail("dispatch-migrate-sponsor-crm-gsis");
  }
  console.log(
    safeEvidence({
      event: "deployment-guard-ready",
      prefix,
      identity: targetIdentity.targetDigest,
    }),
  );
}

main().catch((error) => {
  const code = error instanceof SafeFailure ? error.code : "contract-violation";
  console.error(`Sponsor CRM deployment guard failed closed: ${code}`);
  process.exitCode = 1;
});
