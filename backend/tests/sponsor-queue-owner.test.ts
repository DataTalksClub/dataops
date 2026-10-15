import { it } from 'node:test';
import assert from 'node:assert/strict';
import { computeQueue } from '../src/sponsorCrm/model';

it('routes every unowned chore, workshop and course materials included, to the workspace default assignee', () => {
  const items = computeQueue({
    organizations: [{ id: 'org', displayName: 'Synthetic', lastOutboundAt: '2026-06-01' }],
    deals: [{ id: 'deal', organizationId: 'org', status: 'agreed', agreementDate: '2026-06-01' }],
    deliverables: ['workshop', 'course', 'main'].map((channel) => ({
      id: `d-${channel}`, dealId: 'deal', channel, plannedPublicationDate: '2026-07-05',
    })),
    finance: new Map(), today: '2026-07-01', actorId: 'synthetic-operator', defaultAssigneeId: 'synthetic-operator',
  });
  assert.equal(items.filter((item) => item.why === 'chase_materials').length, 3);
  assert.ok(items.length > 3);
  assert.ok(items.every((item) => item.owner === 'synthetic-operator'));
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
