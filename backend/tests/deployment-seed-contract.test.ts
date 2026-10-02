import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';

const workflow = readFileSync(new URL('../../.github/workflows/deploy-dataops-v1.yml', import.meta.url), 'utf8');
const filter = workflow.match(/if ! jq -e '([\s\S]*?)' "\$seed_response"/)?.[1];
assert.ok(filter, 'deployment must validate the Lambda seed response');

function response(templateTotal: number) {
  return { statusCode: 200, body: JSON.stringify({
    users: { processed: 3, created: 0, updated: 0, unchanged: 3 },
    templates: { total: templateTotal, created: 0, updated: 0, unchanged: templateTotal },
    recurring: { total: 7, created: 0, updated: 0, skipped: 7, repairedTasks: 0 },
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
    { users: { processed: 4, created: 0, updated: 0, unchanged: 4 } },
    { templates: { total: 24, created: 0, updated: 0, unchanged: 23 } },
    { templates: { total: 24, created: -1, updated: 0, unchanged: 25 } },
    { templates: { total: '24', created: 0, updated: 0, unchanged: 24 } },
    { recurring: { total: 8, created: 0, updated: 0, skipped: 8, repairedTasks: 0 } },
    { recurring: { total: 7, created: 0, updated: 0, skipped: 7 } },
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
