import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const { collectCapabilityEvidence } = require('../e2e/capability-evidence');
const { CAPABILITY_EVIDENCE_ANNOTATION } = require('../e2e/helpers/capability-evidence');

function matrix(roleIds = ['operator', 'admin'], stateRoleIds) {
  const state = { id: 'home.ready', coverage: { status: 'runtime' } };
  if (stateRoleIds) state.roleIds = stateRoleIds;
  return {
    capabilities: [{
      id: 'home',
      route: '/#/',
      roleIds,
      states: [state],
    }],
  };
}

function annotation(overrides = {}) {
  return {
    type: CAPABILITY_EVIDENCE_ANNOTATION,
    description: JSON.stringify({
      schemaVersion: 1,
      stateId: 'home.ready',
      route: '/#/',
      roleId: 'operator',
      ...overrides,
    }),
  };
}

test('a passed journey covers a stable state independently of title or file identity', () => {
  const first = collectCapabilityEvidence(matrix(), [{ title: 'Old human title', status: 'passed', annotations: [annotation()] }]);
  const renamed = collectCapabilityEvidence(matrix(), [{ title: 'Renamed and moved journey', status: 'passed', annotations: [annotation()] }]);
  assert.equal(first.ok, true);
  assert.equal(renamed.ok, true);
  assert.deepEqual(first.evidence.map(({ stateId }) => stateId), ['home.ready']);
});

test('an inherited capability role list needs one passing allowed role', () => {
  const summary = collectCapabilityEvidence(matrix(['operator', 'admin']), [{
    title: 'Operator journey',
    status: 'passed',
    annotations: [annotation({ roleId: 'operator' })],
  }]);
  assert.equal(summary.ok, true);
  assert.equal(summary.uncovered.length, 0);
});

test('an explicit state role list needs passing evidence for every listed role', () => {
  const complete = collectCapabilityEvidence(matrix(['operator', 'admin'], ['operator', 'admin']), [
    { title: 'Operator journey', status: 'passed', annotations: [annotation({ roleId: 'operator' })] },
    { title: 'Admin journey', status: 'passed', annotations: [annotation({ roleId: 'admin' })] },
  ]);
  assert.equal(complete.ok, true);

  const incomplete = collectCapabilityEvidence(matrix(['operator', 'admin'], ['operator', 'admin']), [
    { title: 'Operator journey', status: 'passed', annotations: [annotation({ roleId: 'operator' })] },
    { title: 'Admin journey', status: 'failed', annotations: [annotation({ roleId: 'admin' })] },
  ]);
  assert.equal(incomplete.ok, false);
  assert.deepEqual(incomplete.uncovered[0].missingRoleIds, ['admin']);
  assert.match(incomplete.errors.join('\n'), /home\.ready.*admin.*Admin journey\[admin\]=failed/s);
});

test('a did-not-run journey leaves its stable state uncovered', () => {
  const summary = collectCapabilityEvidence(matrix(), []);
  assert.equal(summary.ok, false);
  assert.deepEqual(summary.uncovered[0].missingRoleIds, ['operator', 'admin']);
  assert.match(summary.errors.join('\n'), /home\.ready.*no passing journey/s);
});

for (const status of ['failed', 'timedOut', 'skipped', 'interrupted']) {
  test(`${status} evidence is excluded and diagnosed`, () => {
    const summary = collectCapabilityEvidence(matrix(), [{ title: 'Non-passing journey', status, annotations: [annotation()] }]);
    assert.equal(summary.ok, false);
    assert.match(summary.errors.join('\n'), new RegExp(`home\\.ready.*${status}`, 's'));
  });
}

test('unknown states, wrong roles, wrong routes, and duplicate evidence fail', () => {
  for (const bad of [
    [annotation({ stateId: 'home.unknown' }), /unknown capability state/],
    [annotation({ roleId: 'admin' }), /disallowed role/],
    [annotation({ route: '/#/tasks' }), /expected \/#\//],
  ]) {
    const summary = collectCapabilityEvidence(matrix(['operator']), [{ title: 'Bad journey', status: 'passed', annotations: [bad[0]] }]);
    assert.equal(summary.ok, false);
    assert.match(summary.errors.join('\n'), bad[1]);
  }
  const duplicate = collectCapabilityEvidence(matrix(), [{
    title: 'Duplicate journey',
    status: 'passed',
    annotations: [annotation(), annotation()],
  }]);
  assert.equal(duplicate.ok, false);
  assert.match(duplicate.errors.join('\n'), /duplicate capability evidence/);
});

test('the same exact claim from distinct passed journeys fails globally', () => {
  const summary = collectCapabilityEvidence(matrix(), [
    { title: 'First passing journey', status: 'passed', annotations: [annotation()] },
    { title: 'Second passing journey', status: 'passed', annotations: [annotation()] },
  ]);
  assert.equal(summary.ok, false);
  assert.match(summary.errors.join('\n'), /Second passing journey.*home\.ready.*First passing journey/);
});

test('malformed annotations fail without being interpreted as coverage', () => {
  const summary = collectCapabilityEvidence(matrix(), [{
    title: 'Malformed journey',
    status: 'passed',
    annotations: [{ type: CAPABILITY_EVIDENCE_ANNOTATION, description: '{' }],
  }]);
  assert.equal(summary.ok, false);
  assert.match(summary.errors.join('\n'), /malformed/);
  assert.equal(summary.uncovered[0].stateId, 'home.ready');
});
