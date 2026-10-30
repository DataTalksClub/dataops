import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';

const workflow = readFileSync(new URL('../../.github/workflows/deploy-dataops-v1.yml', import.meta.url), 'utf8');
const filter = workflow.match(/if ! jq -e '([\s\S]*?)' "\$seed_response"/)?.[1];
assert.ok(filter, 'deployment must validate the Lambda seed response');

function response(templateTotal: number) {
  return { statusCode: 200, body: JSON.stringify({
    templates: { total: templateTotal, created: 0, updated: 0, unchanged: templateTotal },
  }) };
}
function accepted(value: unknown) {
  const result = spawnSync('jq', ['-e', filter!], { input: JSON.stringify(value), encoding: 'utf8' });
  assert.equal(result.error, undefined, 'jq is required to verify the actual deploy gate');
  return result.status === 0;
}

test('deploy seed gate accepts valid independently authored template counts', () => {
  for (const total of [1, 11, 24, 25]) assert.equal(accepted(response(total)), true);
});

test('deploy seed gate rejects malformed counts and incomplete reconciliation', () => {
  for (const total of [0, -1, 2.5]) assert.equal(accepted(response(total)), false);
  const invalid = [
    { users: { processed: 3, created: 0, updated: 0, unchanged: 3 } },
    { templates: { total: 24, created: 0, updated: 0, unchanged: 23 } },
    { templates: { total: 24, created: -1, updated: 0, unchanged: 25 } },
    { templates: { total: '24', created: 0, updated: 0, unchanged: 24 } },
    { recurring: { total: 4, created: 0, updated: 0, skipped: 4, repairedTasks: 0 } },
    { templates: { total: 24, created: 0, updated: 0, unchanged: 24, unexpected: 1 } },
  ];
  for (const changes of invalid) {
    const current = response(24);
    current.body = JSON.stringify({ ...JSON.parse(current.body), ...changes });
    assert.equal(accepted(current), false, JSON.stringify(changes));
  }
  assert.equal(accepted({ ...response(24), statusCode: 500 }), false);
  assert.equal(accepted({ statusCode: 200, body: 'not JSON' }), false);
});

test('deploy seed step configures bounded standard throttling retries while failing on FunctionError', () => {
  const seedStep = workflow.split('- name: Project authored workflow templates')[1]?.split('\n      - name:')[0];
  assert.ok(seedStep, 'deployment workflow must define Project authored workflow templates step');
  assert.match(seedStep, /timeout-minutes:\s*10/);
  assert.match(seedStep, /AWS_RETRY_MODE:\s*standard/);
  assert.match(seedStep, /AWS_MAX_ATTEMPTS:\s*'20'/);
  assert.match(seedStep, /set -euo pipefail/);
  assert.match(seedStep, /if \[ "\$seed_error" != "None" \]; then\s+echo "Runtime seed failed inside the deployed Lambda" >&2\s+exit 1\s+fi/);
});

test('deploy seed step logs only template created, total, unchanged, and updated counts after validation', () => {
  const summaryFilter = workflow.match(/fi\s+jq -c '([^']+)' "\$seed_response"\s+echo "Authored workflow templates projected\."/)?.[1];
  assert.ok(summaryFilter, 'deployment must log a compact counts-only summary after validation');
  const sample = {
    statusCode: 200,
    headers: { 'x-internal': 'do-not-log' },
    body: JSON.stringify({
      templates: { created: 0, total: 30, unchanged: 30, updated: 0 },
    }),
  };
  const result = spawnSync('jq', ['-c', summaryFilter!], { input: JSON.stringify(sample), encoding: 'utf8' });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0);
  assert.deepEqual(JSON.parse(result.stdout.trim()), {
    templates: { created: 0, total: 30, unchanged: 30, updated: 0 },
  });
});
