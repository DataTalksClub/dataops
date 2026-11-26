import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import yaml from 'js-yaml';

const repoRoot = resolve(import.meta.dirname, '../..');
const workflow = yaml.load(readFileSync(resolve(repoRoot, '.github/workflows/deploy-dataops-v1.yml'), 'utf8'));
const jobSteps = (job) => job.steps || [];
const runSources = (steps) => steps.flatMap((step) => typeof step.run === 'string' ? [step.run] : []);
const withoutComments = (source) => source.split('\n').filter((line) => !/^\s*#/.test(line)).join('\n');

const SEED_STEP = 'Project authored workflow templates';
const HOLD_STEP = 'Verify scheduled calendar hold expiry';
const stepNamed = (name) => {
  const step = jobSteps(workflow.jobs.deploy).find((candidate) => candidate.name === name);
  assert.ok(step, `deploy needs the "${name}" step`);
  return step;
};

// The events the deployed Lambda routes in handler.ts, byte for byte as the
// workflow passed them inline before the payloads moved into files.
const SEED_EVENT = '{"source":"dataops.deploy","detail-type":"Runtime Seed","detail":{"dataopsAction":"sync-runtime-seeds"}}';
const DRY_EVENT = '{"source":"aws.events","detail-type":"Scheduled Event","detail":{"dataopsAction":"calendar-holds-expire","dryRun":true}}';
const LIVE_EVENT = '{"source":"aws.events","detail-type":"Scheduled Event","detail":{"dataopsAction":"calendar-holds-expire"}}';
const SEED = 'sync-runtime-seeds@unset';
const DRY = 'calendar-holds-expire@true';
const LIVE = 'calendar-holds-expire@unset';
const FUNCTION_NAME = 'dataops-v1-BackendFunction-mock000';

// AWS CLI v1 stand-in: its parser rejects --cli-binary-format (v2-only), a payload
// is accepted only as fileb:// raw bytes, and every invoke is logged for the test.
const AWS_CLI_V1_MOCK = `#!/usr/bin/env bash
set -euo pipefail
[ $# -ge 2 ] || { echo "mock aws: usage: aws <service> <operation> ..." >&2; exit 2; }
case "$1 $2" in
  "cloudformation describe-stack-resource")
    [ "$*" == "cloudformation describe-stack-resource --stack-name dataops-v1 --logical-resource-id BackendFunction --query StackResourceDetail.PhysicalResourceId --output text" ] \\
      || { echo "mock aws: unexpected describe-stack-resource arguments: $*" >&2; exit 2; }
    echo "${FUNCTION_NAME}"
    exit 0
    ;;
  "lambda invoke") shift 2 ;;
  *) echo "mock aws: unexpected call: $*" >&2; exit 2 ;;
esac
function_name="" payload="" query="" output="" response_file=""
while [ $# -gt 0 ]; do
  case "$1" in
    --function-name) function_name="$2"; shift 2 ;;
    --payload) payload="$2"; shift 2 ;;
    --query) query="$2"; shift 2 ;;
    --output) output="$2"; shift 2 ;;
    -*) echo "Unknown options: $1" >&2; exit 255 ;;
    *) response_file="$1"; shift ;;
  esac
done
[ "$query" = "FunctionError" ] && [ "$output" = "text" ] && [ -n "$function_name" ] && [ -n "$response_file" ] \\
  || { echo "mock aws: invoke must keep --function-name, --query FunctionError, --output text and the response file" >&2; exit 2; }
case "$payload" in
  fileb://*) ;;
  *) echo "mock aws: --payload must reference a fileb:// file, got: $payload" >&2; exit 2 ;;
esac
payload_file="$(printf '%s' "$payload" | cut -c8-)"
[ -f "$payload_file" ] || { echo "mock aws: missing payload file: $payload_file" >&2; exit 2; }
kind="$(jq -r '.detail.dataopsAction' "$payload_file")@$(jq -r '.detail.dryRun // "unset"' "$payload_file")"
printf '%s\\t' "$kind" >> "$MOCK_INVOKE_LOG"
base64 -w 0 "$payload_file" >> "$MOCK_INVOKE_LOG"
printf '\\t%s\\t%s\\n' "$function_name" "$response_file" >> "$MOCK_INVOKE_LOG"
function_error="None"
if [ "$MOCK_FUNCTION_ERROR" = "$kind" ]; then function_error="Unhandled"; fi
if [ "$function_error" = "Unhandled" ]; then
  jq -cn '{errorMessage: "mock function error", errorType: "Error", requestId: "mock-request", stackTrace: []}' > "$response_file"
  echo "$function_error"
  exit 0
fi
case "$kind" in
  sync-runtime-seeds@unset)
    templates='{"created":0,"deleted":0,"total":11,"unchanged":11,"updated":0}'
    if [ "$MOCK_CONTRACT_VIOLATION" = "$kind" ]; then
      templates='{"created":0,"deleted":0,"total":0,"unchanged":0,"updated":0}'
    fi
    jq -cn --arg body "{\\"templates\\":$templates}" '{statusCode: 200, headers: {}, body: $body, isBase64Encoded: false}' > "$response_file"
    ;;
  calendar-holds-expire@*)
    dry_run=true
    if [ "$kind" = "calendar-holds-expire@unset" ]; then dry_run=false; fi
    if [ "$MOCK_CONTRACT_VIOLATION" = "$kind" ]; then
      if [ "$dry_run" = true ]; then dry_run=false; else dry_run=true; fi
    fi
    jq -cn --argjson dryRun "$dry_run" \\
      '{statusCode: 200, headers: {"Content-Type": "application/json"}, body: ({dryRun: $dryRun, activeCount: 0, expired: [], followUps: [], note: "mock"} | tojson), isBase64Encoded: false}' > "$response_file"
    ;;
  *) echo "mock aws: unexpected event: $kind" >&2; exit 2 ;;
esac
echo "$function_error"
`;

function harness(t) {
  const root = mkdtempSync(join(tmpdir(), 'dataops-deploy-invoke-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const bin = join(root, 'bin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'aws'), AWS_CLI_V1_MOCK);
  chmodSync(join(bin, 'aws'), 0o755);
  const runnerTemp = join(root, 'runner-temp');
  mkdirSync(runnerTemp);
  const invokeLog = join(root, 'invokes.log');
  writeFileSync(invokeLog, '');
  return {
    // GitHub Actions runs a `run:` block as `bash -e <script>`. The mock is the
    // only `aws` on PATH; mockEnv selects the invoked function's behaviour.
    run(step, mockEnv = {}) {
      const script = join(root, 'step.sh');
      writeFileSync(script, step.run);
      const result = spawnSync('bash', ['-e', script], {
        cwd: root,
        encoding: 'utf8',
        env: {
          PATH: `${bin}:/usr/bin:/bin`,
          HOME: root,
          RUNNER_TEMP: runnerTemp,
          MOCK_INVOKE_LOG: invokeLog,
          MOCK_FUNCTION_ERROR: '',
          MOCK_CONTRACT_VIOLATION: '',
          ...step.env,
          ...mockEnv,
        },
      });
      assert.equal(result.error, undefined, 'bash is required to run the deploy steps');
      const invocations = readFileSync(invokeLog, 'utf8').split('\n').filter(Boolean).map((line) => {
        const [kind, payload, functionName] = line.split('\t');
        return { kind, payload: Buffer.from(payload, 'base64').toString('utf8'), functionName };
      });
      return { code: result.status, stdout: result.stdout, stderr: result.stderr, invocations };
    },
  };
}

test('deploy workflow never passes the v2-only --cli-binary-format to aws', () => {
  for (const job of Object.values(workflow.jobs)) {
    for (const source of runSources(jobSteps(job))) {
      assert.doesNotMatch(withoutComments(source), /--cli-binary-format/,
        `${job.name} must stay parseable by the AWS CLI v1 on the self-hosted runner`);
    }
  }
});

test('every Lambda invoke in the deploy workflow loads its payload through fileb://', () => {
  const sources = runSources(jobSteps(workflow.jobs.deploy)).map(withoutComments);
  const invokeCount = sources.reduce((count, source) => count + source.split('aws lambda invoke').length - 1, 0);
  const payloads = sources.flatMap((source) => [...source.matchAll(/--payload\s+(\S+)/g)].map(([, value]) => value));
  assert.equal(payloads.length, invokeCount, 'each aws lambda invoke must pass exactly one --payload');
  for (const value of payloads) assert.match(value, /^"?fileb:\/\//, `--payload must be a fileb:// reference: ${value}`);
});

test('every run step of the deploy workflow is valid bash', () => {
  for (const job of Object.values(workflow.jobs)) {
    for (const source of runSources(jobSteps(job))) {
      const result = spawnSync('bash', ['-n'], { input: source, encoding: 'utf8' });
      assert.equal(result.error, undefined, 'bash is required to syntax-check the deploy steps');
      assert.equal(result.status, 0, result.stderr);
    }
  }
});

test('template seed step invokes the deployed Lambda with the exact Runtime Seed event', (t) => {
  const result = harness(t).run(stepNamed(SEED_STEP));
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(result.invocations, [{ kind: SEED, payload: SEED_EVENT, functionName: FUNCTION_NAME }]);
  assert.match(result.stdout, /Authored workflow templates projected\./);
});

test('calendar hold expiry step invokes the exact dry-run event, then the exact live event', (t) => {
  const result = harness(t).run(stepNamed(HOLD_STEP));
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(result.invocations, [
    { kind: DRY, payload: DRY_EVENT, functionName: FUNCTION_NAME },
    { kind: LIVE, payload: LIVE_EVENT, functionName: FUNCTION_NAME },
  ]);
  assert.match(result.stdout, /Scheduled calendar hold expiry verified\./);
});

test('FunctionError stops each invoke before the step can report success', (t) => {
  const cases = [
    [SEED_STEP, SEED, 'Runtime seed failed inside the deployed Lambda', 'Authored workflow templates projected', 1],
    [HOLD_STEP, DRY, 'Scheduled calendar-holds-expire dryRun failed inside the deployed Lambda', 'Scheduled calendar hold expiry verified', 1],
    [HOLD_STEP, LIVE, 'Scheduled calendar-holds-expire live run failed inside the deployed Lambda', 'Scheduled calendar hold expiry verified', 2],
  ];
  for (const [stepName, kind, message, success, invokeCount] of cases) {
    const result = harness(t).run(stepNamed(stepName), { MOCK_FUNCTION_ERROR: kind });
    assert.equal(result.code, 1, `${kind}: expected the FunctionError guard to fail the step`);
    assert.ok(result.stderr.includes(message), `${kind}: expected "${message}" on stderr`);
    assert.ok(!result.stdout.includes(success), `${kind}: must not report success`);
    assert.equal(result.invocations.length, invokeCount, `${kind}: a failed invoke must stop before the next one`);
  }
});

test('a response outside the reconciliation contract fails the step', (t) => {
  const seed = harness(t).run(stepNamed(SEED_STEP), { MOCK_CONTRACT_VIOLATION: SEED });
  assert.equal(seed.code, 1, 'an empty template projection must fail the seed step');
  assert.ok(seed.stderr.includes('Runtime seed did not confirm the authored-template reconciliation contract'));
  assert.ok(seed.stderr.includes('"templates":0'), 'the failure must log the numeric counts');

  const dry = harness(t).run(stepNamed(HOLD_STEP), { MOCK_CONTRACT_VIOLATION: DRY });
  assert.equal(dry.code, 1, 'a dry-run response that is not a dry run must fail the step');
  assert.equal(dry.invocations.length, 1, 'the live run must not follow a rejected dry run');

  const live = harness(t).run(stepNamed(HOLD_STEP), { MOCK_CONTRACT_VIOLATION: LIVE });
  assert.equal(live.code, 1, 'a live response that claims to be a dry run must fail the step');
  assert.equal(live.invocations.length, 2);
});
