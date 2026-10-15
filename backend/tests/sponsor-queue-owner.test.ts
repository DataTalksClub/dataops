import { it } from 'node:test';
import assert from 'node:assert/strict';
import { computeQueue, defaultOwner, ALEXEY_USER_ID, VALERIIA_USER_ID } from '../src/sponsorCrm/model';

it('uses workspace ownership for ordinary chores and retains dedicated decision/copy routing', () => {
  for (const why of ['follow_up', 'send_invoice', 'chase_payment', 'send_stats', 'chase_materials']) {
    assert.equal(defaultOwner('synthetic-operator', why, 'main'), 'synthetic-operator');
  }
  assert.equal(defaultOwner('synthetic-operator', 'price'), ALEXEY_USER_ID);
  assert.equal(defaultOwner('synthetic-operator', 'chase_materials', 'workshop'), VALERIIA_USER_ID);
  assert.equal(defaultOwner(null, 'send_invoice'), '');
});

it('leaves unset workspace chores unassigned rather than selecting a historical person', () => {
  const items = computeQueue({
    organizations: [{ id: 'org', displayName: 'Synthetic', lastOutboundAt: '2026-06-01' }],
    deals: [{ id: 'deal', organizationId: 'org', status: 'agreed', agreementDate: '2026-06-01' }],
    deliverables: [], finance: new Map(), today: '2026-07-01', actorId: 'synthetic-operator', defaultAssigneeId: null,
  });
  assert.ok(items.length > 0);
  assert.ok(items.every(item => item.owner === ''));
});
