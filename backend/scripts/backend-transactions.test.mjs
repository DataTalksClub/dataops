import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { dirname, join, resolve } from 'node:path';
import yaml from 'js-yaml';

const scriptDir = dirname(import.meta.filename);
const repoRoot = resolve(scriptDir, '../..');
const read = (path) => readFileSync(join(repoRoot, path), 'utf8');
const rootPackage = JSON.parse(read('package.json'));
const backendPackage = JSON.parse(read('backend/package.json'));
const makefile = read('Makefile');
const workflowText = read('.github/workflows/deploy-dataops-v1.yml');
const workflow = yaml.load(workflowText);
const aggregateScriptPath = 'scripts/test-backend-transactions.sh';
const aggregateCommand = 'npm run test:backend:transactions';
const aggregateSource = read(aggregateScriptPath);

const retainedCommands = Object.keys(backendPackage.scripts)
  .filter((name) => /^test:.+-transaction$/.test(name));
assert.equal(retainedCommands.length, 7,
  `expected seven official transaction suites; found ${retainedCommands.join(', ')}`);

const aggregateDefinition = aggregateSource.match(/^transaction_suites=\(\n((?:  '[^']+'\n)+)\)$/m);
assert.ok(aggregateDefinition, 'aggregate script must declare its ordered suites in transaction_suites');
const aggregatedCommands = [...aggregateDefinition[1].matchAll(/'([^']+)'/g)].map(([_, command]) => command);
assert.deepEqual(aggregatedCommands, retainedCommands,
  'the aggregate must contain every retained package transaction command in canonical order');

function transactionScriptPath(command) {
  const match = backendPackage.scripts[command].match(/^bash (scripts\/.+\.sh)$/);
  assert.ok(match, `${command} must invoke one owned transaction shell script`);
  return match[1];
}

function transactionScript(command) {
  return read(join('backend', transactionScriptPath(command)));
}

function assertContainerSafety(source, path) {
  assert.match(source, /--publish 127\.0\.0\.1::8000/, `${path} must bind DynamoDB Local only to loopback`);
  assert.match(source, /mapping="\$\(docker port "\$container_id" 8000\/tcp\)"/,
    `${path} must discover a dynamic host port`);
  assert.equal(
    source.includes(String.raw`^127\.0\.0\.1:[0-9]+$`),
    true,
    `${path} must reject non-loopback mappings`,
  );
  assert.match(source, /DynamoDB Local did not publish one loopback-only port/,
    `${path} must name the loopback mapping failure`);
  assert.match(source, /^container_id="\$container_name"$/m,
    `${path} must make its owned container name removable during launch`);
  assert.match(source, /curl [^\n]*--connect-timeout 1 [^\n]*--max-time 2/,
    `${path} readiness probe must be time-bounded`);
  assert.match(source, /--test-force-exit/, `${path} must prevent an open handle from leaking the test process`);
  assert.match(source, /^trap cleanup EXIT$/m, `${path} must remove its container through an EXIT trap`);
  assert.match(source, /^trap 'exit 130' INT$/m, `${path} must convert SIGINT into deterministic cleanup`);
  assert.match(source, /^trap 'exit 143' TERM$/m, `${path} must convert SIGTERM into deterministic cleanup`);
  assert.match(source, /docker rm -f "\$container_id"/, `${path} must force-remove its DynamoDB Local container`);
}

test('root aggregate invokes the seven retained transaction suites once', () => {
  assert.equal(rootPackage.scripts['test:backend:transactions'], `bash ${aggregateScriptPath}`);
  assert.equal(new Set(aggregatedCommands).size, aggregatedCommands.length,
    'each retained transaction suite must appear exactly once');
  assert.match(aggregateSource, /^set -euo pipefail$/m);
  assert.match(
    aggregateSource,
    /timeout --kill-after=30s 10m npm --prefix backend run "\$suite" &\n  suite_pid="\$\!"\n  wait "\$suite_pid"\n  suite_status=\$\?/,
    'the aggregate must wait for each owned suite and preserve its exit status',
  );
  assert.match(aggregateSource, /^trap 'interrupt_suite INT 130' INT$/m,
    'the aggregate must deterministically interrupt the active suite on SIGINT');
  assert.match(aggregateSource, /^trap 'interrupt_suite TERM 143' TERM$/m,
    'the aggregate must deterministically interrupt the active suite on SIGTERM');
  assert.doesNotMatch(aggregateSource, /timeout[^\n]*\s\|\|/, 'a timed suite must not swallow failure');
  assert.doesNotMatch(aggregateSource, /retry/i, 'failing suites must never be retried');
});

test('every transaction harness owns a bounded isolated loopback DynamoDB Local', () => {
  const paths = retainedCommands.map(transactionScriptPath);
  assert.equal(new Set(paths).size, paths.length, 'each transaction suite must own its script');
  const containers = paths.map((path) =>
    read(join('backend', path)).match(/container_name="([^"]+)/)?.[1]);
  assert.equal(new Set(containers).size, containers.length, 'DynamoDB Local containers must not share names');
  paths.forEach((path) => assertContainerSafety(read(join('backend', path)), path));
});

test('provider controls and intentional environments remain in transaction scripts', () => {
  const providerControls = [
    'CONVERSATIONAL_TELEGRAM_INGRESS_ENABLED=false',
    'CONVERSATIONAL_EXECUTION_ENABLED=false',
    'CONVERSATIONAL_ENABLED_PLUGINS=none',
    'CONVERSATIONAL_TYPEFULLY_EXTERNAL_EXECUTION_ENABLED=false',
    'CONVERSATIONAL_TELEGRAM_VOICE_ENABLED=false',
    'CONVERSATIONAL_TELEGRAM_PHOTO_ENABLED=false',
  ];
  const controlledPaths = [
    transactionScriptPath('test:execution-transaction'),
    transactionScriptPath('test:telegram-transaction'),
    transactionScriptPath('test:todo-transaction'),
    transactionScriptPath('test:typefully-transaction'),
  ];
  for (const path of controlledPaths) {
    const source = read(join('backend', path));
    for (const control of providerControls) {
      assert.equal(source.includes(control), true, `${path} must retain ${control}`);
    }
  }

  const expectedEnvironments = {
    'test:execution-transaction': 'test',
    'test:telegram-transaction': 'production',
    'test:sponsor-finance-transaction': 'test',
    'test:sponsor-communications-transaction': 'test',
    'test:task-card-transaction': 'production',
    'test:todo-transaction': 'test',
    'test:typefully-transaction': 'production',
  };
  for (const [command, environment] of Object.entries(expectedEnvironments)) {
    const source = transactionScript(command);
    assert.match(
      source,
      new RegExp(`^NODE_ENV=${environment} \\\\`, 'm'),
      `${transactionScriptPath(command)} must preserve NODE_ENV=${environment}`,
    );
  }
});

test('make ci uses the same blocking aggregate as deployment checks', () => {
  const targetName = 'test-backend-transactions';
  const targetDefinition = makefile.match(new RegExp(`^${targetName}:\\n((?:\\t.*\\n)+)`, 'm'));
  assert.ok(targetDefinition, `Makefile needs ${targetName}`);
  assert.equal(targetDefinition[1].trim(), aggregateCommand);
  assert.equal(
    makefile.includes("'make test-backend-transactions' 'Run all seven blocking DynamoDB transaction suites.'"),
    true,
    'help text must document the transaction target',
  );

  const ciDefinition = makefile.match(/^ci:\n((?:\t.*\n)+)/m);
  assert.ok(ciDefinition, 'Makefile needs ci target');
  const ciCommands = ciDefinition[1].trim().split('\n').map((line) => line.trim());
  assert.deepEqual(ciCommands.slice(1, 3), ['$(MAKE) test-backend', `$(MAKE) ${targetName}`],
    'ci must insert transaction parity immediately after backend tests');
  assert.equal(ciCommands.filter((line) => line === `$(MAKE) ${targetName}`).length, 1,
    `${targetName} must appear in ci exactly once`);

  const commandsFor = ({ steps = [] } = {}) => steps
    .flatMap((step) => typeof step.run === 'string' ? [step.run.trim()] : []);
  const checkCommands = commandsFor(workflow.jobs.checks);
  const checkSteps = workflow.jobs.checks.steps || [];
  const workflowCommands = Object.values(workflow.jobs || {}).flatMap(commandsFor);
  assert.equal(workflowCommands.filter((command) => command === aggregateCommand).length, 1,
    'deploy workflow must invoke the aggregate exactly once');
  assert.equal(checkCommands.filter((command) => command === aggregateCommand).length, 1,
    'checks must own the aggregate exactly once');
  assert.ok(checkCommands.indexOf(aggregateCommand) < checkCommands.indexOf('npm --prefix backend run build'),
    'checks must reject transaction regressions before building the backend');
  assert.equal(commandsFor(workflow.jobs.deploy).filter((command) => command === 'make sam-build').length, 1,
    'deploy must contain the single packaged SAM build path');
  assert.equal(checkCommands.includes('make sam-build'), false,
    'checks must not duplicate the packaged SAM build');
  assert.equal(checkSteps.some((step) => String(step.uses || '').startsWith('aws-actions/configure-aws-credentials')),
    false,
    'checks must not configure AWS credentials',
  );
  assert.doesNotMatch(JSON.stringify(workflow), /AWS_(?:ACCESS_KEY_ID|SECRET_ACCESS_KEY|SESSION_TOKEN)/,
    'the deploy workflow must use OIDC rather than static AWS credentials');
  assert.equal(workflow.jobs.deploy.needs, 'checks', 'deploy must wait for the aggregate checks job');
  assert.equal(workflow.jobs.checks['timeout-minutes'], 60, 'checks must have the 60-minute CI limit');
  assert.doesNotMatch(workflowText, /test:task-card-transaction/,
    'retired Task/Card-only CI shortcut must stay absent');
  assert.doesNotMatch(makefile, /test:task-card-transaction/,
    'Makefile must not reintroduce the retired Task/Card-only shortcut');
  for (const command of retainedCommands) {
    assert.doesNotMatch(workflowText, new RegExp(command),
      `${command} must enter deployment only through the aggregate`);
    assert.doesNotMatch(makefile, new RegExp(command),
      `${command} must enter make targets only through the aggregate`);
  }
});
