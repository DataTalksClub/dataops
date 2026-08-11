#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  CONTRACT,
  MUTATION_PHASES,
  NO_RECEIPT,
  NO_RECEIPT_DIGEST,
  PHASES,
  PHASE_ORDINAL,
  approvalFor,
  assertPoststateEqual,
  bindCandidateInventory,
  canonicalJson,
  completionKey,
  deriveOperationId,
  deriveResetId,
  digest,
  intentKey,
  makeCompletion,
  makeIntent,
  operationPrefix,
  parseReceiptInputs,
  receiptFor,
  recordDigest,
  validateApproval,
  validateAuxiliaryTableState,
  validateCandidate,
  validateCandidatePage,
  validateCompletion,
  validateIdentity,
  validateIntent,
  validateLiveTable,
  validateProcessedBaseline,
  validateRuntimeEnvironment,
  validateStackBaseline,
} from "./sponsor-crm-reset-core.mjs";
import { parseTemplate } from "./sponsor-crm-gsi-core.mjs";

const AWS_TIMEOUT_MS = bounded("SPONSOR_RESET_AWS_TIMEOUT_MS", 30_000, 100, 60_000);
const KILL_GRACE_MS = bounded("SPONSOR_RESET_KILL_GRACE_MS", 1_000, 10, 10_000);
const MAX_OUTPUT = bounded("SPONSOR_RESET_MAX_OUTPUT_BYTES", 4 * 1024 * 1024, 1024, 16 * 1024 * 1024);
const MAX_PAGES = 100;
const MAX_KEYS = 200;
const MAX_POLLS = 180;
const POLL_MS = bounded("SPONSOR_RESET_POLL_MS", 15_000, 0, 60_000);

let cancelled = false;
let active;
let checkpoint = "startup";
const PRIVATE_KEY = new RegExp(`^${escapeRegex(CONTRACT.evidencePrefix)}runs/[0-9a-f]{64}/operations/\\d{3}-[a-z-]+-[0-9a-f]{64}/(?:intent\\.json|completion-[0-9a-f]{64}\\.json)$`);

export class SafeFailure extends Error {
  constructor(code) { super(code); this.code = code; }
}

function fail(code) { throw new SafeFailure(code); }

function terminate(record, reason) {
  if (!record || record.reason) return;
  record.reason = reason;
  try { process.kill(-record.child.pid, "SIGTERM"); } catch (error) {
    if (error?.code !== "ESRCH") throw error;
  }
  record.killTimer = setTimeout(() => {
    try { process.kill(-record.child.pid, "SIGKILL"); } catch (error) {
      if (error?.code !== "ESRCH") throw error;
    }
  }, KILL_GRACE_MS);
  record.killTimer.unref();
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    cancelled = true;
    terminate(active, "cancelled");
  });
}

export class AwsCli {
  async call(service, operation, args = [], { allowNotFound = false, allowPrecondition = false } = {}) {
    if (cancelled) fail("cancelled");
    const argv = [
      service, operation, ...args,
      "--region", CONTRACT.region,
      "--no-cli-pager",
      "--cli-connect-timeout", "5",
      "--cli-read-timeout", "20",
      "--output", "json",
    ];
    const result = await this.run(argv);
    if (result.reason) fail(`aws-${service}-${operation}-${result.reason}`);
    if (result.status !== 0) {
      if (allowNotFound && /ResourceNotFoundException|NoSuchKey|404|does not exist|not found/i.test(result.stderr)) return undefined;
      if (allowPrecondition && /PreconditionFailed|HTTP status code: 412|status code 412/i.test(result.stderr)) return { preconditionFailed: true };
      fail(`aws-${service}-${operation}`);
    }
    try { return result.stdout.trim() ? JSON.parse(result.stdout) : {}; } catch { fail(`aws-${service}-${operation}-json`); }
  }

  run(argv) {
    return new Promise((resolve, reject) => {
      const child = spawn("aws", argv, {
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, AWS_PAGER: "", AWS_MAX_ATTEMPTS: "1", AWS_RETRY_MODE: "standard" },
      });
      assert.equal(active, undefined, "concurrent AWS subprocess rejected");
      const record = { child, reason: undefined, killTimer: undefined };
      active = record;
      const stdout = [];
      const stderr = [];
      let size = 0;
      let spawnError;
      const timer = setTimeout(() => terminate(record, "timeout"), AWS_TIMEOUT_MS);
      timer.unref();
      const collect = (target) => (chunk) => {
        if (record.reason) return;
        size += chunk.length;
        if (size > MAX_OUTPUT) return terminate(record, "output-limit");
        target.push(chunk);
      };
      child.stdout.on("data", collect(stdout));
      child.stderr.on("data", collect(stderr));
      child.on("error", (error) => { spawnError = error; });
      child.on("close", (status, signal) => {
        clearTimeout(timer);
        if (record.killTimer) clearTimeout(record.killTimer);
        if (active === record) active = undefined;
        if (spawnError) return reject(new SafeFailure("aws-spawn"));
        resolve({ status, signal, stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8"), reason: record.reason });
      });
    });
  }

  pause() { return new Promise((resolve) => setTimeout(resolve, POLL_MS)); }
}

export class S3PrivateLedger {
  constructor(aws) { this.aws = aws; }

  async verifyControlPlane() {
    const location = await this.aws.call("s3api", "get-bucket-location", this.#bucketArgs());
    assert.ok(location.LocationConstraint === CONTRACT.region || location.LocationConstraint === "EU");
  }

  async listKeys(prefix) {
    assertPrivatePrefix(prefix);
    const values = [];
    let token;
    const seen = new Set();
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const response = await this.aws.call("s3api", "list-objects-v2", [
        ...this.#bucketArgs(), "--prefix", prefix, "--max-keys", "100",
        ...(token ? ["--continuation-token", token] : []),
      ]);
      for (const item of response.Contents ?? []) {
        assertPrivateKey(item.Key);
        assert.ok(Number.isInteger(item.Size) && item.Size > 0 && item.Size <= MAX_OUTPUT);
        assert.ok(!values.includes(item.Key), "duplicate ledger key");
        values.push(item.Key);
        assert.ok(values.length <= MAX_KEYS, "ledger key limit exceeded");
      }
      if (!response.IsTruncated) {
        assert.equal(response.NextContinuationToken, undefined);
        return values.sort();
      }
      token = response.NextContinuationToken;
      assert.ok(typeof token === "string" && token.length > 0 && token.length <= 4096 && !seen.has(token));
      seen.add(token);
    }
    fail("ledger-pagination-limit");
  }

  async getRecord(key, { allowNotFound = false } = {}) {
    assertPrivateKey(key);
    const head = await this.aws.call("s3api", "head-object", [...this.#bucketArgs(), "--key", key, "--checksum-mode", "ENABLED"], { allowNotFound });
    if (head === undefined) return undefined;
    validateObjectMetadata(head);
    const directory = mkdtempSync(join(tmpdir(), "sponsor-reset-private-read-"));
    const file = join(directory, "record.json");
    try {
      const response = await this.aws.call("s3api", "get-object", [
        ...this.#bucketArgs(), "--key", key, "--checksum-mode", "ENABLED", file,
      ], { allowNotFound });
      assert.ok(response, "ledger object disappeared after HEAD");
      validateObjectMetadata(response);
      assert.equal(response.VersionId, head.VersionId, "ledger object version changed during read");
      const bytes = readFileSync(file);
      assert.ok(bytes.length > 0 && bytes.length <= MAX_OUTPUT);
      const checksum = sha256Base64(bytes);
      assert.equal(head.ChecksumSHA256, checksum, "ledger HEAD checksum mismatch");
      assert.equal(response.ChecksumSHA256, checksum, "ledger GET checksum mismatch");
      const record = JSON.parse(bytes.toString("utf8"));
      assert.equal(canonicalJson(record), bytes.toString("utf8"), "ledger JSON is not canonical");
      assert.match(record.recordDigest ?? "", /^[0-9a-f]{64}$/, "ledger record digest missing");
      assert.equal(recordDigest(record), record.recordDigest, "ledger canonical body digest changed");
      return { record, versionId: response.VersionId, checksum };
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }

  async putRecord(key, record) {
    assertPrivateKey(key);
    const bytes = Buffer.from(canonicalJson(record), "utf8");
    assert.ok(bytes.length > 0 && bytes.length <= MAX_OUTPUT);
    const directory = mkdtempSync(join(tmpdir(), "sponsor-reset-private-write-"));
    const file = join(directory, "record.json");
    try {
      writeFileSync(file, bytes, { mode: 0o600, flag: "wx" });
      const response = await this.aws.call("s3api", "put-object", [
        ...this.#bucketArgs(), "--key", key, "--body", file,
        "--if-none-match", "*",
        "--server-side-encryption", "AES256",
        "--checksum-algorithm", "SHA256",
        "--checksum-sha256", sha256Base64(bytes),
        "--content-type", "application/json",
      ], { allowPrecondition: true });
      if (!response.preconditionFailed) validateObjectMetadata(response);
      const stored = await this.getRecord(key);
      assert.deepEqual(stored.record, record, "immutable ledger CAS collision");
      assert.equal(stored.checksum, sha256Base64(bytes));
      return { created: !response.preconditionFailed, ...stored };
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }

  async findReceipt(receipt) {
    const keys = await this.listKeys(CONTRACT.evidencePrefix);
    const suffix = `/completion-${receipt.completionDigest}.json`;
    const matches = keys.filter((key) => key.endsWith(suffix) && key.includes(`-${receipt.operationId}/`));
    assert.equal(matches.length, 1, "opaque receipt is absent or ambiguous");
    const fetched = await this.getRecord(matches[0]);
    validateCompletion(fetched.record);
    assert.equal(receiptFor(fetched.record).receiptId, receipt.receiptId);
    return fetched.record;
  }

  #bucketArgs() {
    return ["--bucket", CONTRACT.evidenceBucket, "--expected-bucket-owner", CONTRACT.evidenceBucketOwner];
  }
}

export async function runPhase(env, aws = new AwsCli(), ledger = new S3PrivateLedger(aws)) {
  checkpoint = "runtime-input";
  validateRuntimeEnvironment(env);
  const phase = env.SPONSOR_RESET_PHASE;
  const suppliedReceipt = parseReceiptInputs(env.SPONSOR_RESET_RECEIPT_ID, env.SPONSOR_RESET_RECEIPT_DIGEST);
  validateApproval(env.SPONSOR_RESET_APPROVAL, phase, env.SPONSOR_RESET_RECEIPT_DIGEST);
  checkpoint = "caller-identity";
  validateIdentity(await aws.call("sts", "get-caller-identity"));
  checkpoint = "evidence-control";
  await ledger.verifyControlPlane();

  checkpoint = "stack-baseline";
  const stackProbe = await describeStack(aws);
  const stack = validateStackBaseline(stackProbe, env.SPONSOR_RESET_STACK_ID_DIGEST, { allowExecuteInProgress: phase === "execute" });
  let suppliedCompletion;
  checkpoint = "receipt-load";
  if (suppliedReceipt) suppliedCompletion = await ledger.findReceipt(suppliedReceipt);
  checkpoint = "initial-state";
  const preliminary = suppliedCompletion
    ? undefined
    : await observeState(aws, env, stackProbe, phase, undefined);
  const resetSeed = suppliedCompletion
    ? undefined
    : resetSeedFrom(preliminary, phase);
  const resetId = suppliedCompletion?.resetId ?? deriveResetId({ stackIdDigest: stack.stackIdDigest, sha: env.GITHUB_SHA, ...resetSeed });
  checkpoint = "ledger-lineage";
  const ledgerState = await loadLedger(ledger, resetId);
  validateLedgerLineage(ledgerState, resetId, env.GITHUB_SHA, stack.stackIdDigest);
  const prior = suppliedReceipt ? resolveReceipt(ledgerState, suppliedReceipt) : undefined;
  if (suppliedCompletion) assert.deepEqual(suppliedCompletion, prior.completion);
  const root = [...ledgerState.operations.values()].find(({ intent }) => intent?.phase === "preflight");
  if (root?.completion) {
    assert.equal(root.intent.sourceSha, env.GITHUB_SHA, "receipt source SHA changed");
    assert.equal(root.intent.stackIdDigest, stack.stackIdDigest, "receipt StackId anchor changed");
    assert.equal(deriveResetId({ stackIdDigest: stack.stackIdDigest, sha: env.GITHUB_SHA, ...resetSeedFrom(root.completion.poststate) }), resetId, "reset identity seed changed");
  }
  validateTransition(phase, prior);
  const priorCompletionDigest = prior?.receipt.completionDigest ?? NO_RECEIPT;
  checkpoint = "phase-state";
  const before = preliminary ?? await observeState(aws, env, stackProbe, phase, prior?.completion);
  if (!prior && phase === "cleanup-candidate") {
    before.candidate = await reloadOrphanCandidate(aws, before);
  }
  if (prior && ["create", "execute", "verify", "cleanup-candidate"].includes(phase)) {
    const oldTable = lineageTable(prior.completion);
    if (oldTable !== undefined) before.oldTable ??= oldTable;
  }
  if (phase === "execute" && !before.table && !String(before.stackStatus).endsWith("_IN_PROGRESS")) {
    before.candidate = await reloadApprovedCandidate(aws, before, prior.completion);
  }
  if (prior && phase === "cleanup-candidate" && !before.table && before.candidates.length === 1
    && before.candidates[0].Status === "CREATE_COMPLETE" && before.candidates[0].ExecutionStatus === "AVAILABLE") {
    before.candidate = await reloadApprovedCandidate(aws, before, prior.completion);
  }
  checkpoint = "phase-plan";
  const plannedTargetDigest = targetPlanDigest(phase, before, prior?.completion);
  const operationId = deriveOperationId({ resetId, phase, sourceSha: env.GITHUB_SHA, priorCompletionDigest, plannedTargetDigest });
  const identity = { resetId, ordinal: PHASE_ORDINAL[phase], phase, operationId, plannedTargetDigest, stackIdDigest: stack.stackIdDigest };
  const existing = ledgerState.operations.get(operationId);
  if (existing?.completion) {
    await verifyExistingCompletion(phase, aws, before, existing.completion, prior?.completion);
    return publicResult(receiptFor(existing.completion), "replayed");
  }
  assertNoBranch(ledgerState, priorCompletionDigest, operationId);
  const operation = planOperation(phase, identity, before, prior?.completion);
  if (MUTATION_PHASES.includes(phase)) {
    const initialClassification = classifyResume(phase, before, operation.expected, prior?.completion);
    if (initialClassification !== "precondition") assert.ok(existing?.intent, "observed mutation has no prior immutable intent");
  }
  const proposedIntent = makeIntent({
    identity, prior: prior?.receipt, prestate: before, approval: env.SPONSOR_RESET_APPROVAL,
    target: operation.target, expectedPostcondition: operation.expected,
    github: { repository: env.GITHUB_REPOSITORY, ref: env.GITHUB_REF, sha: env.GITHUB_SHA, actor: env.GITHUB_ACTOR, runId: env.GITHUB_RUN_ID, runAttempt: env.GITHUB_RUN_ATTEMPT },
  });
  const intent = existing?.intent ?? proposedIntent;
  if (existing?.intent) {
    assert.equal(intent.plannedTargetDigest, plannedTargetDigest);
    assert.equal(intent.approvalDigest, digest(env.SPONSOR_RESET_APPROVAL));
    assert.deepEqual(intent.target, proposedIntent.target, "same-intent target drift");
    assert.deepEqual(intent.expectedPostcondition, proposedIntent.expectedPostcondition, "same-intent postcondition drift");
  }
  checkpoint = "intent-persist";
  const storedIntent = await ledger.putRecord(intentKey(identity), intent);
  validateIntent(storedIntent.record);
  const intentDigest = recordDigest(intent);

  const afterIntent = await ledger.getRecord(intentKey(identity));
  assert.equal(recordDigest(afterIntent.record), intentDigest, "intent reread digest mismatch");

  checkpoint = "phase-execution";
  const result = await executeOrObserve(phase, aws, env, before, operation, prior?.completion, { intent, resumingIntent: Boolean(existing?.intent) });
  const completion = makeCompletion({
    intent,
    intentDigest,
    outcome: result.observed ? "observed-complete-on-resume" : "executed-and-verified",
    poststate: result.state,
    prior: prior?.receipt,
    candidate: result.candidate ?? prior?.completion?.candidate ?? null,
  });
  const receipt = receiptFor(completion);
  checkpoint = "completion-persist";
  const storedCompletion = await ledger.putRecord(completionKey(identity, receipt.completionDigest), completion);
  validateCompletion(storedCompletion.record);
  assert.equal(recordDigest(storedCompletion.record), receipt.completionDigest);
  return publicResult(receipt, result.observed ? "observed-complete" : "completed");
}

async function loadLedger(ledger, resetId) {
  const runPrefix = `${CONTRACT.evidencePrefix}runs/${resetId}/`;
  const keys = await ledger.listKeys(runPrefix);
  const operations = new Map();
  const completions = new Map();
  for (const key of keys) {
    const match = new RegExp(`^${escapeRegex(CONTRACT.evidencePrefix)}runs/${resetId}/operations/(\\d{3})-([a-z-]+)-([0-9a-f]{64})/(intent\\.json|completion-([0-9a-f]{64})\\.json)$`).exec(key);
    assert.ok(match, "unrecognized object in private reset prefix");
    const [, ordinalText, phase, operationId, filename, namedDigest] = match;
    assert.ok(PHASES.includes(phase));
    assert.equal(Number(ordinalText), PHASE_ORDINAL[phase]);
    const fetched = await ledger.getRecord(key);
    const value = fetched.record;
    assert.equal(value.resetId, resetId);
    assert.equal(value.phase, phase);
    assert.equal(value.operationId, operationId);
    const slot = operations.get(operationId) ?? {};
    if (filename === "intent.json") {
      assert.equal(slot.intent, undefined, "duplicate intent");
      validateIntent(value);
      assert.equal(key, intentKey(value));
      slot.intent = value;
    } else {
      assert.equal(slot.completion, undefined, "multiple completions for operation");
      validateCompletion(value);
      assert.equal(recordDigest(value), namedDigest);
      assert.equal(key, completionKey(value, namedDigest));
      slot.completion = value;
      const receipt = receiptFor(value);
      assert.equal(completions.has(receipt.completionDigest), false, "duplicate completion digest");
      completions.set(receipt.completionDigest, { completion: value, receipt });
    }
    operations.set(operationId, slot);
  }
  const children = new Map();
  for (const { intent, completion } of operations.values()) {
    if (completion) {
      assert.ok(intent, "completion without intent");
      assert.equal(completion.intentDigest, recordDigest(intent));
      assert.equal(completion.priorReceipt, intent.priorReceipt, "completion prior receipt changed");
      assert.equal(completion.priorCompletionDigest, intent.priorCompletionDigest, "completion predecessor changed");
      for (const field of ["resetId", "ordinal", "phase", "operationId", "plannedTargetDigest", "stackIdDigest", "repository", "ref", "sourceSha", "actor"]) {
        assert.equal(completion[field], intent[field], `completion ${field} changed`);
      }
    }
    if (!intent) continue;
    const expectedId = deriveOperationId({ resetId, phase: intent.phase, sourceSha: intent.sourceSha, priorCompletionDigest: intent.priorCompletionDigest, plannedTargetDigest: intent.plannedTargetDigest });
    assert.equal(intent.operationId, expectedId, "operation identity does not bind prior receipt");
    const priorDigest = intent.priorCompletionDigest;
    assert.equal(children.has(priorDigest), false, "branched reset lineage");
    children.set(priorDigest, intent.operationId);
    if (priorDigest !== NO_RECEIPT) assert.ok(completions.has(priorDigest), "intent references missing prior completion");
  }
  return { operations, completions };
}

async function verifyExistingCompletion(phase, aws, before, completion, prior) {
  let current = before;
  if (phase === "create") {
    const candidate = await reloadApprovedCandidate(aws, before, completion);
    current = { ...before, candidate, oldTable: lineageTable(prior) };
  } else if (phase === "delete" || phase === "cleanup-candidate") {
    current = { ...before, oldTable: lineageTable(prior) };
  }
  assert.deepEqual(current, completion.poststate, "recorded completion postcondition no longer holds");
}

function validateLedgerLineage(ledgerState, resetId, sourceSha, stackIdDigest) {
  const intents = [...ledgerState.operations.values()].map(({ intent }) => intent).filter(Boolean);
  if (intents.length === 0) return;
  const roots = intents.filter(({ priorCompletionDigest }) => priorCompletionDigest === NO_RECEIPT);
  assert.equal(roots.length, 1, "reset lineage must have exactly one root");
  assert.ok(["preflight", "create", "cleanup-candidate"].includes(roots[0].phase), "reset root phase is not reviewed");
  for (const intent of intents) {
    assert.equal(intent.resetId, resetId);
    assert.equal(intent.sourceSha, sourceSha, "ledger source SHA changed");
    assert.equal(intent.stackIdDigest, stackIdDigest, "ledger StackId anchor changed");
    if (intent.priorCompletionDigest === NO_RECEIPT) continue;
    const prior = ledgerState.completions.get(intent.priorCompletionDigest);
    assert.ok(prior, "ledger predecessor missing");
    assert.equal(intent.priorReceipt, prior.receipt.receiptId, "ledger prior receipt changed");
    validateTransition(intent.phase, prior);
  }
}

function assertNoBranch(ledgerState, priorCompletionDigest, operationId) {
  for (const { intent } of ledgerState.operations.values()) {
    if (intent?.priorCompletionDigest === priorCompletionDigest) {
      assert.equal(intent.operationId, operationId, "reset lineage branch rejected");
    }
  }
}

function resolveReceipt(ledgerState, supplied) {
  const found = ledgerState.completions.get(supplied.completionDigest);
  assert.ok(found, "receipt not found in anchored reset lineage");
  assert.equal(found.receipt.receiptId, supplied.receiptId, "receipt operation binding mismatch");
  return found;
}

function resetSeedFrom(state, phase = "preflight") {
  const table = state.oldTable ?? state.table;
  if (!table?.tableId) {
    assert.ok(["create", "cleanup-candidate"].includes(phase), "reset root requires the exact old table identity");
    assert.equal(state.table, undefined, "recovery create requires the table to be absent");
    assert.equal(state.candidates.length, phase === "create" ? 0 : 1, "recovery candidate inventory changed");
  }
  return {
    fixtureDigest: state.fixtureDigest,
    oldTableIdDigest: table?.tableId ? digest(table.tableId) : digest(`reviewed-missing-table-recovery:${phase}`),
  };
}

function targetPlanDigest(phase, before, prior) {
  const oldTable = lineageTable(prior) ?? before.table;
  return digest({
    schema: CONTRACT.recordSchema,
    phase,
    stackIdDigest: before.stack.stackIdDigest,
    physicalTargetDigest: digest(CONTRACT.physicalTable),
    oldTableIdDigest: digest(oldTable?.tableId ?? NO_RECEIPT),
    candidateDigest: prior?.candidate?.candidateDigest ?? null,
    serviceOperation: ({
      preflight: "none:preflight",
      "disable-protection": "dynamodb:update-table:false",
      delete: "dynamodb:delete-table",
      create: "cloudformation:create-change-set:REVERT_DRIFT",
      execute: "cloudformation:execute-change-set",
      verify: "none:verify",
      "cleanup-candidate": "cloudformation:delete-change-set",
      "restore-protection": "dynamodb:update-table:true",
      abandon: "none:abandon",
    })[phase],
  });
}

function validateTransition(phase, prior) {
  const allowed = {
    preflight: [undefined],
    "disable-protection": ["preflight"],
    delete: ["preflight", "disable-protection"],
    create: [undefined, "delete"],
    execute: ["create"],
    verify: ["execute"],
    "cleanup-candidate": [undefined, "create"],
    "restore-protection": ["disable-protection"],
    abandon: ["preflight", "disable-protection", "delete", "create", "execute", "verify", "cleanup-candidate"],
  }[phase];
  assert.ok(allowed.includes(prior?.completion.phase), "receipt is not a valid predecessor for phase");
}

function planOperation(phase, identity, before, prior) {
  const token = digest({ schema: CONTRACT.recordSchema, phase, operationId: identity.operationId });
  const targetIdentityDigest = digest({ stackIdDigest: identity.stackIdDigest, table: CONTRACT.physicalTable, candidateDigest: prior?.candidate?.candidateDigest ?? null });
  const none = { service: "none", operation: phase, argv: [], clientToken: null, targetIdentityDigest };
  if (phase === "preflight") {
    assert.equal(before.candidates.length, 0, "preflight requires an empty candidate inventory");
    return { target: none, expected: { stateDigest: digest(before) } };
  }
  if (phase === "disable-protection") {
    assert.equal(before.candidates.length, 0, "disable requires an empty candidate inventory");
    return {
      target: { service: "dynamodb", operation: "update-table", argv: ["--table-name", CONTRACT.physicalTable, "--no-deletion-protection-enabled"], clientToken: null, targetIdentityDigest },
      expected: { tablePresent: true, deletionProtection: false },
    };
  }
  if (phase === "delete") {
    assert.equal(before.candidates.length, 0, "delete requires an empty candidate inventory");
    return {
      target: { service: "dynamodb", operation: "delete-table", argv: ["--table-name", CONTRACT.physicalTable], clientToken: null, targetIdentityDigest },
      expected: { tablePresent: false, oldTableId: (lineageTable(prior) ?? before.table)?.tableId },
    };
  }
  if (phase === "create") {
    const name = `dataops-sponsor-reset-${identity.operationId.slice(0, 24)}`;
    const description = `${CONTRACT.recordSchema}/${identity.operationId}`;
    const parameters = before.stack.parameterKeys.map((ParameterKey) => ({ ParameterKey, UsePreviousValue: true }));
    const argv = [
      "--stack-name", before.stack.stackId, "--change-set-name", name, "--change-set-type", "UPDATE",
      "--use-previous-template", "--deployment-mode", "REVERT_DRIFT",
      "--parameters", canonicalJson(parameters),
      ...(before.stack.capabilities.length ? ["--capabilities", ...before.stack.capabilities] : []),
      "--description", description, "--client-token", token,
    ];
    return { target: { service: "cloudformation", operation: "create-change-set", argv, clientToken: token, targetIdentityDigest }, expected: { tablePresent: false, candidateName: name, description, parameters, capabilities: before.stack.capabilities } };
  }
  if (phase === "execute") {
    const candidate = prior?.candidate;
    assert.ok(candidate?.candidateArn, "create receipt has no candidate");
    if (!before.table) assert.equal(before.candidates.length, 1, "execute requires the sole approved candidate");
    const priorTableId = prior.poststate?.oldTable?.tableId ?? prior.prestate?.oldTable?.tableId;
    return {
      target: { service: "cloudformation", operation: "execute-change-set", argv: ["--change-set-name", candidate.candidateArn, "--stack-name", before.stack.stackId, "--client-request-token", token], clientToken: token, targetIdentityDigest },
      expected: {
        tablePresent: true,
        ...(priorTableId === undefined ? {} : { priorTableId }),
        candidateDigest: candidate.candidateDigest,
        candidateArnDigest: candidate.candidateArnDigest,
      },
    };
  }
  if (phase === "verify") return { target: none, expected: { tablePresent: true, candidateCount: 0 } };
  if (phase === "cleanup-candidate") {
    const candidate = prior?.candidate ?? before.candidate;
    assert.ok(candidate?.candidateArn);
    if (before.candidates.length > 0 && before.candidates[0].Status === "CREATE_COMPLETE") {
      assert.deepEqual(before.candidate, candidate, "cleanup candidate was not fully revalidated");
      bindCandidateInventory(before.candidates, candidate);
    }
    return { target: { service: "cloudformation", operation: "delete-change-set", argv: ["--change-set-name", candidate.candidateArn, "--stack-name", before.stack.stackId], clientToken: null, targetIdentityDigest }, expected: { tablePresent: false, candidateCount: 0, candidateArnDigest: candidate.candidateArnDigest } };
  }
  if (phase === "restore-protection") {
    assert.equal(before.candidates.length, 0, "restore requires an empty candidate inventory");
    const oldTable = lineageTable(prior);
    assert.ok(oldTable?.tableId, "original table identity unavailable");
    return { target: { service: "dynamodb", operation: "update-table", argv: ["--table-name", CONTRACT.physicalTable, "--deletion-protection-enabled"], clientToken: null, targetIdentityDigest }, expected: { tablePresent: true, deletionProtection: true, oldTableId: oldTable.tableId } };
  }
  assert.equal(phase, "abandon");
  assert.equal(before.candidates.length, 0, "cannot abandon an active candidate");
  assert.ok(!before.table || before.table.tableStatus === "ACTIVE", "cannot abandon an in-progress table");
  return { target: none, expected: { abandoned: true, stateDigest: digest(before) } };
}

async function executeOrObserve(phase, aws, env, before, operation, prior, { intent, resumingIntent }) {
  if (phase === "preflight" || phase === "abandon") return { observed: false, state: before };
  if (phase === "verify") {
    assertFinalState(before, prior);
    return { observed: false, state: before };
  }
  if (phase === "disable-protection" || phase === "restore-protection") {
    assert.ok(before.table, "table absent during protection change");
    assert.equal(before.candidates.length, 0, "protection change requires an empty candidate inventory");
    if (phase === "restore-protection") assert.equal(before.table.tableId, operation.expected.oldTableId, "restore applies only to the original table");
    const classification = classifyResume(phase, before, operation.expected, prior);
    if (classification !== "precondition") assert.ok(resumingIntent, "observed mutation has no prior immutable intent");
    if (phase === "disable-protection" && classification === "precondition") assert.equal(before.table.deletionProtection, true, "disable requires protection true");
    if (classification === "complete") {
      assertPoststateEqual(intent.prestate, before, ["/table/deletionProtection", "/table/tableDigest", "/table/tableStatus"]);
      return { observed: true, state: before };
    }
    if (classification === "precondition") await aws.call(operation.target.service, operation.target.operation, operation.target.argv);
    else assert.equal(classification, "in-progress");
    await waitForTable(aws, operation.expected.deletionProtection);
    const after = await observeState(aws, env, before.stack.stackId, phase, prior);
    assert.equal(after.table.deletionProtection, operation.expected.deletionProtection);
    assertPoststateEqual(intent.prestate, after, ["/table/deletionProtection", "/table/tableDigest", "/table/tableStatus"]);
    return { observed: classification === "in-progress", state: after };
  }
  if (phase === "delete") {
    assert.equal(before.candidates.length, 0, "delete requires an empty candidate inventory");
    const classification = classifyResume(phase, before, operation.expected, prior);
    if (classification !== "precondition") assert.ok(resumingIntent, "observed delete has no prior immutable intent");
    if (classification === "complete") {
      const oldTable = lineageTable(prior);
      assert.ok(oldTable, "completed delete lost original table identity");
      const completedState = { ...before, oldTable };
      assertPoststateEqual(intent.prestate, completedState, ["/table", "/oldTable"]);
      return { observed: true, state: completedState };
    }
    if (classification === "precondition") {
      assert.equal(before.table.deletionProtection, false, "delete requires explicit protection false");
      await aws.call("dynamodb", "delete-table", operation.target.argv);
    } else assert.equal(classification, "in-progress");
    await waitForAbsence(aws);
    const after = await observeState(aws, env, before.stack.stackId, phase, prior);
    assert.equal(after.table, undefined);
    const oldTable = before.table.tableStatus === "ACTIVE" ? before.table : prior?.prestate?.table;
    const completedState = { ...after, oldTable };
    assertPoststateEqual(intent.prestate, completedState, ["/table", "/oldTable"]);
    return { observed: classification === "in-progress", state: completedState };
  }
  if (phase === "create") {
    assert.equal(before.table, undefined, "create requires absent table");
    const matching = matchingCandidate(before.candidates, operation.expected.candidateName);
    const classification = classifyResume(phase, before, operation.expected, prior);
    if (classification !== "precondition") assert.ok(resumingIntent, "observed candidate has no prior immutable intent");
    assert.ok(["complete", "in-progress", "precondition"].includes(classification));
    let candidateArn = matching?.ChangeSetId;
    let observed = classification !== "precondition";
    if (!candidateArn) {
      assert.equal(before.candidates.length, 0, "ambiguous candidate inventory");
      const created = await aws.call("cloudformation", "create-change-set", operation.target.argv);
      assert.equal(created.StackId, before.stack.stackId);
      candidateArn = created.Id;
    }
    const candidate = await waitForCandidate(aws, candidateArn, {
      name: operation.expected.candidateName,
      description: operation.expected.description,
      parameters: describedParameters(before.privateParameters),
      capabilities: operation.expected.capabilities,
      stackId: before.stack.stackId,
      stackIdDigest: before.stack.stackIdDigest,
      templateDigest: before.templateDigest,
    });
    const after = await observeState(aws, env, before.stack.stackId, phase, prior, { candidate });
    const boundCandidate = { ...candidate, candidateInventoryDigest: bindCandidateInventory(after.candidates, candidate) };
    const equalityState = { ...after, candidate: boundCandidate, oldTable: lineageTable(prior) ?? null };
    assertPoststateEqual(intent.prestate, equalityState, ["/candidates/0", "/candidate", "/oldTable"]);
    return { observed, state: equalityState, candidate: boundCandidate };
  }
  if (phase === "execute") {
    assert.equal(prior.candidate.candidateDigest, operation.expected.candidateDigest, "execute candidate digest mismatch");
    assert.equal(digest(prior.candidate.candidateArn), operation.expected.candidateArnDigest);
    const classification = classifyResume(phase, before, operation.expected, prior);
    if (classification !== "precondition") assert.ok(resumingIntent, "observed execution has no prior immutable intent");
    if (classification === "complete") {
      assertFinalState(before, prior);
      assertPoststateEqual(intent.prestate, before, ["/stackStatus", "/candidates/0", "/candidate", "/table"]);
      return { observed: true, state: before, candidate: prior.candidate };
    }
    const summary = matchingCandidate(before.candidates, undefined, prior.candidate.candidateArn);
    assert.ok(summary, "approved candidate absent while table is absent");
    assert.equal(before.candidates.length, 1, "approved candidate must be the sole active candidate");
    if (classification === "in-progress") await waitForStack(aws, before.stack.stackId);
    else {
      assert.equal(classification, "precondition");
      assert.equal(summary.ExecutionStatus, "AVAILABLE", "candidate is not executable");
      const immediate = await reloadApprovedCandidate(aws, before, prior);
      assert.deepEqual(immediate, prior.candidate, "approved candidate changed after intent persistence");
      await aws.call("cloudformation", "execute-change-set", operation.target.argv);
      await waitForStack(aws, before.stack.stackId);
    }
    const after = { ...await observeState(aws, env, before.stack.stackId, phase, prior), oldTable: lineageTable(prior) ?? null };
    assertFinalState(after, prior);
    assertPoststateEqual(intent.prestate, after, ["/stackStatus", "/candidates/0", "/candidate", "/table"]);
    return { observed: classification !== "precondition", state: after, candidate: prior.candidate };
  }
  assert.equal(phase, "cleanup-candidate");
  assert.equal(before.table, undefined, "candidate cleanup only applies before execution");
  const approved = prior?.candidate ?? before.candidate;
  assert.ok(approved?.candidateArn, "cleanup has no fully reviewed candidate");
  const candidate = matchingCandidate(before.candidates, undefined, approved.candidateArn);
  const classification = classifyResume(phase, before, operation.expected, prior);
  if (classification !== "precondition") assert.ok(resumingIntent, "observed cleanup has no prior immutable intent");
  const withOriginalIdentities = (state) => ({ ...state, oldTable: lineageTable(prior) ?? null });
  const finalizeCleanup = (state) => {
    assert.equal(state.candidates.length, 0, "candidate inventory not empty after cleanup");
    const baseline = prior?.poststate ?? intent.prestate;
    assert.equal(baseline.candidates.length, 1, "approved cleanup baseline was not singleton");
    bindCandidateInventory(baseline.candidates, approved);
    const completedState = withOriginalIdentities(state);
    assertPoststateEqual(baseline, completedState, ["/candidates/0", "/candidate", "/oldTable"]);
    return completedState;
  };
  if (classification === "complete") return { observed: true, state: finalizeCleanup(before), candidate: approved };
  assert.ok(classification === "precondition" || classification === "in-progress");
  if (classification === "precondition") {
    assert.equal(before.candidates.length, 1, "cleanup requires the sole approved candidate");
    bindCandidateInventory(before.candidates, approved);
  }
  if (classification === "precondition") await aws.call("cloudformation", "delete-change-set", operation.target.argv);
  await waitForCandidateAbsence(aws, approved.candidateArn, before.stack.stackId);
  const after = await observeState(aws, env, before.stack.stackId, phase, prior);
  const completedState = finalizeCleanup(after);
  return { observed: classification === "in-progress", state: completedState, candidate: approved };
}

export function classifyResume(phase, state, expected, prior) {
  if (phase === "disable-protection" || phase === "restore-protection") {
    if (!state.table || typeof state.table.deletionProtection !== "boolean") fail("protection-state-ambiguous");
    if (state.table.tableStatus === "UPDATING") return "in-progress";
    if (state.table.tableStatus !== "ACTIVE") fail("protection-state-conflict");
    if (expected.oldTableId) assert.equal(state.table.tableId, expected.oldTableId, "protection table identity changed");
    if (state.table.deletionProtection === expected.deletionProtection) return "complete";
    if (state.table.deletionProtection === !expected.deletionProtection) return "precondition";
    fail("protection-state-conflict");
  }
  if (phase === "delete") {
    if (!state.table) return "complete";
    if (state.table.tableId === expected.oldTableId && state.table.deletionProtection === false && state.table.tableStatus !== "DELETING") return "precondition";
    if (state.table.tableId === expected.oldTableId && state.table.tableStatus === "DELETING") return "in-progress";
    fail("delete-state-conflict");
  }
  if (phase === "create") {
    if (state.table) fail("create-state-conflict");
    const candidates = state.candidates ?? [];
    if (candidates.length === 0) return "precondition";
    if (candidates.length === 1 && candidates[0].ChangeSetName === expected.candidateName && ["CREATE_PENDING", "CREATE_IN_PROGRESS"].includes(candidates[0].Status)) return "in-progress";
    if (candidates.length === 1 && candidates[0].ChangeSetName === expected.candidateName && candidates[0].Status === "CREATE_COMPLETE" && candidates[0].ExecutionStatus === "AVAILABLE") return "complete";
    fail("create-state-conflict");
  }
  if (phase === "execute") {
    if (String(state.stackStatus).endsWith("_IN_PROGRESS")) return "in-progress";
    if (state.table) return "complete";
    const candidate = (state.candidates ?? []).find(({ ChangeSetId }) => digest(ChangeSetId) === expected.candidateArnDigest);
    if (candidate?.ExecutionStatus === "AVAILABLE" && candidate.Status === "CREATE_COMPLETE") return "precondition";
    fail("execute-state-conflict");
  }
  if (phase === "cleanup-candidate") {
    if (state.table) fail("cleanup-state-conflict");
    const candidates = state.candidates ?? [];
    if (candidates.length === 0) return "complete";
    if (candidates.length === 1 && digest(candidates[0].ChangeSetId) === expected.candidateArnDigest && ["DELETE_PENDING", "DELETE_IN_PROGRESS"].includes(candidates[0].Status)) return "in-progress";
    if (candidates.length === 1 && digest(candidates[0].ChangeSetId) === expected.candidateArnDigest && candidates[0].Status === "CREATE_COMPLETE" && candidates[0].ExecutionStatus === "AVAILABLE") return "precondition";
    fail("cleanup-state-conflict");
  }
  fail("resume-classification-not-applicable");
}

async function observeState(aws, env, knownStack, phase, prior, options = {}) {
  checkpoint = "state-caller";
  const caller = await aws.call("sts", "get-caller-identity");
  validateIdentity(caller);
  checkpoint = "state-stack";
  const stackObject = typeof knownStack === "object" ? knownStack : await describeStack(aws, knownStack ?? CONTRACT.stack);
  const stack = validateStackBaseline(stackObject, env.SPONSOR_RESET_STACK_ID_DIGEST, { allowExecuteInProgress: phase === "execute" });
  const executeInProgress = phase === "execute" && String(stackObject.StackStatus).endsWith("_IN_PROGRESS");
  checkpoint = "state-template";
  const processed = parseTemplate((await aws.call("cloudformation", "get-template", ["--stack-name", stack.stackId, "--template-stage", "Processed"])).TemplateBody);
  const baseline = validateProcessedBaseline(processed);
  checkpoint = "state-resource";
  const resource = await aws.call("cloudformation", "describe-stack-resource", ["--stack-name", stack.stackId, "--logical-resource-id", CONTRACT.logicalId]);
  assert.equal(resource.StackResourceDetail?.StackId, stack.stackId);
  assert.equal(resource.StackResourceDetail?.LogicalResourceId, CONTRACT.logicalId);
  assert.equal(resource.StackResourceDetail?.PhysicalResourceId, CONTRACT.physicalTable);
  assert.equal(resource.StackResourceDetail?.ResourceType, "AWS::DynamoDB::Table");
  assert.ok(/_COMPLETE$/.test(resource.StackResourceDetail?.ResourceStatus ?? "") || (executeInProgress && /_IN_PROGRESS$/.test(resource.StackResourceDetail?.ResourceStatus ?? "")));
  checkpoint = "state-inventory";
  const resources = await listStackResources(aws, stack.stackId, { allowExecuteInProgress: executeInProgress });
  checkpoint = "state-candidates";
  const candidates = await listChangeSets(aws, stack.stackId);
  let table;
  checkpoint = "state-table";
  const described = await aws.call("dynamodb", "describe-table", ["--table-name", CONTRACT.physicalTable], { allowNotFound: true });
  if (described) {
    checkpoint = tableShapeCheckpoint(described.Table);
    if (executeInProgress && described.Table?.TableStatus !== "ACTIVE") {
      assert.equal(described.Table?.TableName, CONTRACT.physicalTable);
      assert.equal(described.Table?.TableArn, CONTRACT.tableArn);
      assert.match(described.Table?.TableId ?? "", /^[A-Za-z0-9._-]{8,128}$/);
      const oldTable = lineageTable(prior);
      if (oldTable?.tableId) assert.notEqual(described.Table.TableId, oldTable.tableId);
      table = { tableArn: described.Table.TableArn, tableId: described.Table.TableId, tableStatus: described.Table.TableStatus, inProgress: true };
    } else {
      table = validateLiveTable(described.Table, {
        allowDeleting: phase === "delete",
        allowUpdating: phase === "disable-protection" || phase === "restore-protection",
      });
    }
    if (table.tableStatus === "ACTIVE") {
      checkpoint = "state-auxiliary";
      const backups = await aws.call("dynamodb", "describe-continuous-backups", ["--table-name", CONTRACT.physicalTable]);
      const ttl = await aws.call("dynamodb", "describe-time-to-live", ["--table-name", CONTRACT.physicalTable]);
      const tags = await listTags(aws, table.tableArn);
      const original = lineageTable(prior);
      validateAuxiliaryTableState({ backups, ttl, tags }, stack.stackId, {
        owned: original === null || Boolean(original?.tableId && table.tableId !== original.tableId),
      });
    } else if (phase === "delete" || phase === "disable-protection" || phase === "restore-protection") {
      const old = lineageTable(prior);
      assert.equal(table.tableId, old?.tableId, "deleting table identity changed");
    }
  }
  return {
    stack,
    stackStatus: stackObject.StackStatus,
    privateParameters: stackObject.Parameters,
    templateDigest: baseline.templateDigest,
    fixtureDigest: baseline.fixtureDigest,
    dependencyDigest: baseline.dependencyDigest,
    resourceInventoryDigest: digest(resources.map(stableStackResource)),
    candidates,
    ...(options.candidate === undefined ? {} : { candidate: options.candidate }),
    ...(table === undefined ? {} : { table }),
  };
}

async function describeStack(aws, stackIdentifier = CONTRACT.stack) {
  const response = await aws.call("cloudformation", "describe-stacks", ["--stack-name", stackIdentifier]);
  assert.equal(response.Stacks?.length, 1);
  return response.Stacks[0];
}

async function listStackResources(aws, stackId, { allowExecuteInProgress = false } = {}) {
  const values = [];
  await paginate((token) => aws.call("cloudformation", "list-stack-resources", ["--stack-name", stackId, ...(token ? ["--next-token", token] : [])]), "NextToken", (page) => values.push(...(page.StackResourceSummaries ?? [])));
  assert.ok(values.some(({ LogicalResourceId }) => LogicalResourceId === CONTRACT.logicalId));
  for (const item of values) {
    assert.equal(typeof item.LogicalResourceId, "string");
    assert.equal(typeof item.ResourceType, "string");
    const terminal = /^(CREATE|DELETE|UPDATE|IMPORT|UPDATE_ROLLBACK)_COMPLETE$/.test(item.ResourceStatus ?? "");
    const reviewedInProgress = allowExecuteInProgress && item.LogicalResourceId === CONTRACT.logicalId && /^(CREATE|UPDATE)_IN_PROGRESS$/.test(item.ResourceStatus ?? "");
    assert.ok(terminal || reviewedInProgress, `unreviewed stack resource status ${item.ResourceStatus}`);
  }
  return values.sort((a, b) => a.LogicalResourceId.localeCompare(b.LogicalResourceId));
}

async function listChangeSets(aws, stackId) {
  const values = [];
  await paginate((token) => aws.call("cloudformation", "list-change-sets", ["--stack-name", stackId, ...(token ? ["--next-token", token] : [])]), "NextToken", (page) => values.push(...(page.Summaries ?? []).filter((item) => !["DELETE_COMPLETE", "FAILED"].includes(item.Status) && item.ExecutionStatus !== "OBSOLETE" && item.ExecutionStatus !== "EXECUTE_COMPLETE")));
  return values.sort((a, b) => String(a.ChangeSetId).localeCompare(String(b.ChangeSetId)));
}

async function listTags(aws, arn) {
  const tags = [];
  await paginate((token) => aws.call("dynamodb", "list-tags-of-resource", ["--resource-arn", arn, ...(token ? ["--next-token", token] : [])]), "NextToken", (page) => tags.push(...(page.Tags ?? [])));
  return { Tags: tags };
}

async function paginate(fetch, tokenKey, consume) {
  let token;
  const seen = new Set();
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const response = await fetch(token);
    consume(response);
    token = response[tokenKey];
    if (token === undefined) return;
    assert.ok(typeof token === "string" && token.length > 0 && token.length <= 4096 && !seen.has(token));
    seen.add(token);
  }
  fail("pagination-limit");
}

async function waitForCandidate(aws, candidateArn, expected) {
  assert.match(candidateArn ?? "", /^arn:aws:cloudformation:eu-west-1:817685572750:changeSet\//);
  for (let count = 0; count < 40; count += 1) {
    const candidate = await describeCandidate(aws, candidateArn, expected);
    if (candidate) return candidate;
    await aws.pause();
  }
  fail("candidate-timeout");
}

async function describeCandidate(aws, candidateArn, expected) {
  const changes = [];
  let token;
  const seen = new Set();
  let first;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const response = await aws.call("cloudformation", "describe-change-set", [
      "--change-set-name", candidateArn, "--stack-name", expected.stackId,
      ...(token ? ["--next-token", token] : []), "--include-property-values",
    ]);
    if (["CREATE_PENDING", "CREATE_IN_PROGRESS"].includes(response.Status)) return undefined;
    checkpoint = `candidate-${safeCandidateStatus(response.Status)}-${safeCandidateExecution(response.ExecutionStatus)}`;
    first ??= response;
    validateCandidatePage(response, first);
    changes.push(...(response.Changes ?? []));
    token = response.NextToken;
    if (!token) {
      checkpoint = "candidate-semantic-validation";
      const validated = validateCandidate(first, { ...expected, candidateArn }, changes);
      checkpoint = "candidate-template-validation";
      const candidateTemplate = parseTemplate((await aws.call("cloudformation", "get-template", ["--stack-name", expected.stackId, "--change-set-name", candidateArn, "--template-stage", "Processed"])).TemplateBody);
      const baseline = validateProcessedBaseline(candidateTemplate);
      assert.equal(baseline.templateDigest, expected.templateDigest, "candidate Processed template changed");
      return {
        candidateArn,
        candidateArnDigest: digest(candidateArn),
        candidateDigest: validated.candidateDigest,
        candidateDetails: validated.candidate,
        candidateTemplateDigest: baseline.templateDigest,
        candidateRequestDigest: digest({ name: expected.name, description: expected.description, parameters: expected.parameters, capabilities: expected.capabilities, stackIdDigest: expected.stackIdDigest }),
        changeDetailsDigest: digest(validated.candidate.changes),
        changeSetDigest: digest(validated.candidate.changeSet),
        name: expected.name,
        description: expected.description,
        parametersDigest: digest(expected.parameters),
        capabilities: expected.capabilities,
        stackIdDigest: expected.stackIdDigest,
      };
    }
    assert.ok(typeof token === "string" && token.length <= 4096 && !seen.has(token));
    seen.add(token);
  }
  fail("candidate-pagination-limit");
}

function safeCandidateStatus(value) {
  return ["CREATE_COMPLETE", "FAILED"].includes(value) ? value.toLowerCase().replace("_", "-") : "other";
}

function safeCandidateExecution(value) {
  return ["AVAILABLE", "UNAVAILABLE"].includes(value) ? value.toLowerCase() : "other";
}

async function reloadApprovedCandidate(aws, state, completion) {
  const approved = completion.candidate;
  assert.ok(approved?.candidateArn);
  assert.equal(state.candidates.length, 1, "approved candidate must be the sole active candidate");
  const summary = matchingCandidate(state.candidates, undefined, approved.candidateArn);
  assert.ok(summary, "approved candidate is not the sole active candidate");
  const candidate = await waitForCandidate(aws, approved.candidateArn, {
    name: approved.name,
    description: approved.description,
    parameters: describedParameters(state.privateParameters),
    capabilities: approved.capabilities,
    stackId: state.stack.stackId,
    stackIdDigest: state.stack.stackIdDigest,
    templateDigest: state.templateDigest,
  });
  const rebound = { ...candidate, candidateInventoryDigest: bindCandidateInventory(state.candidates, approved) };
  assert.deepEqual(rebound, approved, "approved candidate digest/details changed");
  return rebound;
}

async function reloadOrphanCandidate(aws, state) {
  assert.equal(state.table, undefined, "orphan cleanup requires the table to be absent");
  assert.equal(state.candidates.length, 1, "orphan cleanup requires exactly one active candidate");
  const summary = state.candidates[0];
  assert.match(summary.ChangeSetName ?? "", /^dataops-sponsor-reset-[0-9a-f]{24}$/);
  const descriptionMatch = /^dataops\.sponsor-reset\/v1\/([0-9a-f]{64})$/.exec(summary.Description ?? "");
  assert.ok(descriptionMatch, "orphan candidate description is not reset-bound");
  assert.equal(summary.ChangeSetName, `dataops-sponsor-reset-${descriptionMatch[1].slice(0, 24)}`);
  assert.equal(summary.Status, "CREATE_COMPLETE");
  assert.equal(summary.ExecutionStatus, "AVAILABLE");
  const candidate = await waitForCandidate(aws, summary.ChangeSetId, {
    name: summary.ChangeSetName,
    description: summary.Description,
    parameters: describedParameters(state.privateParameters),
    capabilities: state.stack.capabilities,
    stackId: state.stack.stackId,
    stackIdDigest: state.stack.stackIdDigest,
    templateDigest: state.templateDigest,
  });
  return { ...candidate, candidateInventoryDigest: bindCandidateInventory(state.candidates, candidate) };
}

async function waitForTable(aws, desiredProtection) {
  for (let count = 0; count < MAX_POLLS; count += 1) {
    const response = await aws.call("dynamodb", "describe-table", ["--table-name", CONTRACT.physicalTable]);
    if (response.Table?.TableStatus === "ACTIVE" && response.Table.DeletionProtectionEnabled === desiredProtection) return;
    await aws.pause();
  }
  fail("table-timeout");
}

async function waitForAbsence(aws) {
  for (let count = 0; count < MAX_POLLS; count += 1) {
    if (await aws.call("dynamodb", "describe-table", ["--table-name", CONTRACT.physicalTable], { allowNotFound: true }) === undefined) return;
    await aws.pause();
  }
  fail("delete-timeout");
}

async function waitForStack(aws, stackId) {
  for (let count = 0; count < MAX_POLLS; count += 1) {
    const stack = await describeStack(aws, stackId);
    assert.equal(stack.StackId, stackId);
    if (stack.StackStatus === "UPDATE_COMPLETE") return;
    if (!String(stack.StackStatus).endsWith("_IN_PROGRESS")) fail("stack-execution-failed");
    await aws.pause();
  }
  fail("stack-timeout");
}

async function waitForCandidateAbsence(aws, candidateArn, stackId) {
  for (let count = 0; count < 40; count += 1) {
    if ((await listChangeSets(aws, stackId)).every(({ ChangeSetId }) => ChangeSetId !== candidateArn)) return;
    await aws.pause();
  }
  fail("candidate-delete-timeout");
}

function matchingCandidate(candidates, name, arn) {
  const matches = candidates.filter((item) => (!name || item.ChangeSetName === name) && (!arn || item.ChangeSetId === arn));
  assert.ok(matches.length <= 1, "ambiguous matching candidates");
  return matches[0];
}

function assertFinalState(state, prior) {
  assert.ok(state.table, "replacement table absent");
  const oldTable = prior?.poststate?.oldTable ?? prior?.prestate?.oldTable ?? prior?.prestate?.table;
  if (oldTable?.tableId) assert.notEqual(state.table.tableId, oldTable.tableId);
  assert.equal(state.table.deletionProtection, false, "recreated table protection must match the prefix-0 fixture default");
  assert.equal(state.candidates.length, 0, "candidate inventory not empty after execution");
}

function lineageTable(prior) {
  if (prior?.poststate && Object.hasOwn(prior.poststate, "oldTable")) return prior.poststate.oldTable;
  if (prior?.prestate && Object.hasOwn(prior.prestate, "oldTable")) return prior.prestate.oldTable;
  return prior?.poststate?.table ?? prior?.prestate?.table;
}

function tableShapeCheckpoint(table) {
  const status = table?.TableStatus === "ACTIVE" ? "active" : table?.TableStatus === "CREATING" ? "creating" : table?.TableStatus === "UPDATING" ? "updating" : "other-status";
  const keys = JSON.stringify(table?.KeySchema) === JSON.stringify([
    { AttributeName: "PK", KeyType: "HASH" },
    { AttributeName: "SK", KeyType: "RANGE" },
  ]) ? "keys-ok" : "keys-other";
  const attributes = Array.isArray(table?.AttributeDefinitions) ? Math.min(table.AttributeDefinitions.length, 9) : "other";
  const indexes = Array.isArray(table?.GlobalSecondaryIndexes) ? Math.min(table.GlobalSecondaryIndexes.length, 9) : 0;
  const stream = table?.StreamSpecification || table?.LatestStreamArn ? "stream" : "no-stream";
  return `state-table-${status}-${keys}-attrs-${attributes}-gsis-${indexes}-${stream}`;
}

function describedParameters(parameters) {
  return parameters.map(({ ParameterKey, ParameterValue }) => ({ ParameterKey, ParameterValue, UsePreviousValue: true }));
}

function stableStackResource(value) {
  const copy = structuredClone(value);
  delete copy.LastUpdatedTimestamp;
  return copy;
}

function validateObjectMetadata(value) {
  assert.equal(value.ServerSideEncryption, "AES256", "ledger object is not AES256 encrypted");
  assert.ok(typeof value.VersionId === "string" && value.VersionId.length > 0 && value.VersionId !== "null", "ledger bucket versioning is required");
  assert.match(value.ChecksumSHA256 ?? "", /^[A-Za-z0-9+/]{43}=$/, "ledger checksum missing");
  if (value.ContentType !== undefined) assert.equal(value.ContentType, "application/json", "ledger object content type changed");
}

function assertPrivatePrefix(prefix) {
  assert.ok(prefix === CONTRACT.evidencePrefix || new RegExp(`^${escapeRegex(CONTRACT.evidencePrefix)}runs/[0-9a-f]{0,64}(?:/.*)?$`).test(prefix));
  assert.ok(!prefix.includes("..") && !prefix.includes("//"));
  assert.ok(prefix.length <= 512);
}

function assertPrivateKey(key) {
  assertPrivatePrefix(key);
  assert.ok(key.length <= 1024 && PRIVATE_KEY.test(key), "ledger key grammar rejected");
}

function sha256Base64(bytes) { return createHash("sha256").update(bytes).digest("base64"); }
function escapeRegex(value) { return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

function publicResult(receipt, status) {
  return Object.freeze({ receipt_id: receipt.receiptId, receipt_digest: receipt.receiptDigest, status });
}

export function validateWorkspaceCheckout(env) {
  assert.equal(process.cwd(), env.GITHUB_WORKSPACE, "workspace path mismatch");
  const head = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8", timeout: 5000, maxBuffer: 4096, stdio: ["ignore", "pipe", "ignore"] }).trim();
  assert.equal(head, env.GITHUB_SHA, "checked-out SHA mismatch");
}

function bounded(name, fallback, minimum, maximum) {
  const value = Number(process.env[name] ?? fallback);
  assert.ok(Number.isInteger(value) && value >= minimum && value <= maximum, `${name} out of bounds`);
  return value;
}

async function main() {
  try {
    if (process.argv[2] === "validate-runtime") {
      validateRuntimeEnvironment(process.env);
      validateWorkspaceCheckout(process.env);
      process.stdout.write("Sponsor reset dispatch identity validated before AWS\n");
      return;
    }
    validateWorkspaceCheckout(process.env);
    const result = await runPhase(process.env);
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    const code = error instanceof SafeFailure ? error.code : error?.code === "ERR_ASSERTION" ? `reset-contract-${checkpoint}` : "reset-contract-failed";
    process.stderr.write(`Sponsor reset failed closed: ${code}\n`);
    process.exitCode = 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) await main();

export { approvalFor, NO_RECEIPT, NO_RECEIPT_DIGEST, MUTATION_PHASES };
