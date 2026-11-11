import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import { changeReadiness, readinessView, hasValidMaterialConfirmation, advanceForMaterialChange, READINESS_CRITERIA } from '../src/sponsorCrm/readiness';
import { communicationCandidates, evaluateCommunicationSuggestions } from '../src/sponsorCommunications/suggestions';
import { evaluateSponsorBookingAlerts } from '../src/sponsorCrm/alerts';
import { listAllNotifications } from '../src/db/notifications';
import { handler } from '../src/handler';
import { createTables, startLocal, stopLocal } from '../scripts/local-dynamodb';
import { getClient } from '../src/db/client';
import { createUserWithId } from '../src/db/users';
import { setDefaultAssignee } from '../src/db/workspaceSettings';
const now = '2026-11-11T12:00:00.000Z';
const confirmation = { action: 'confirm', checkId: 'original', criterion: 'materials-approved', materialVersion: 1, link: 'https://example.test/evidence' };

test('two later checks inherit original provenance; every independent gate stays pending', () => {
  let record: Record<string, unknown> = {};
  record.readiness = changeReadiness(record, confirmation, 'reviewer', now);
  for (const checkId of ['later-1', 'later-2']) record.readiness = changeReadiness(record, { ...confirmation, action: 'check', checkId }, 'other', now);
  for (const criterion of READINESS_CRITERIA.filter(c => c !== 'materials-approved')) record.readiness = changeReadiness(record, { ...confirmation, action: 'check', checkId: criterion, criterion }, 'other', now);
  const view = readinessView(record);
  for (const check of view.checks.slice(1, 3)) {
    assert.equal(check.status, 'verified'); assert.equal(check.inherited, true); assert.equal(check.sourceCheckId, 'original');
    assert.deepEqual(check.originalEvidence, { link: confirmation.link, date: now, reviewer: 'reviewer' });
  }
  assert.ok(view.checks.slice(3).every(c => c.status === 'pending'));
  assert.equal(hasValidMaterialConfirmation(record), true);
  record.readiness = changeReadiness(record, { action: 'material-change', materialVersion: 1 }, 'reviewer', now);
  assert.ok(readinessView(record).checks.every(c => c.status === 'invalidated'));
  assert.equal(hasValidMaterialConfirmation(record), false);
  record.readiness = changeReadiness(record, { ...confirmation, action: 'check', checkId: 'new-version', materialVersion: 2 }, 'reviewer', now);
  assert.equal(readinessView(record).checks.at(-1)!.status, 'pending');
  assert.throws(() => changeReadiness(record, confirmation, 'reviewer', now), /Material version changed/);
});

test('revocation, URL replacement/reversion, submitted-only and archived records do not suppress reminders', () => {
  const slot = { plannedPublicationDate: '2026-11-14', materialDeadline: '2026-11-10', artifactUrls: ['https://example.test/copy'] };
  let record: Record<string, unknown> = { ...slot };
  const candidates = () => communicationCandidates({ status: 'agreed' }, [record], '2026-11-11', { materialsReminderDays: [3], followUpDays: 7 }).filter(c => c.type === 'materials-reminder');
  assert.equal(candidates().length, 2, 'URL presence is not approval');
  record.readiness = changeReadiness(record, { ...confirmation, criterion: 'materials-submitted' }, 'reviewer', now);
  assert.equal(candidates().length, 2);
  record.readiness = changeReadiness(record, { ...confirmation, checkId: 'approval' }, 'reviewer', now);
  assert.equal(candidates().length, 0);
  record.readiness = changeReadiness(record, { action: 'revoke', checkId: 'approval', materialVersion: 1 }, 'reviewer', now);
  assert.equal(candidates().length, 2);
  record.readiness = changeReadiness(record, { ...confirmation, checkId: 'rechecked' }, 'reviewer', now);
  const replaced = { artifactUrls: ['https://example.test/revised'] };
  record = { ...record, ...replaced, readiness: advanceForMaterialChange(record, replaced) };
  assert.equal(candidates().length, 2);
  record = { ...record, ...slot, readiness: advanceForMaterialChange(record, slot) };
  assert.equal(readinessView(record).materialVersion, 3);
  assert.equal(candidates().length, 2);
  assert.equal(hasValidMaterialConfirmation({ readiness: changeReadiness({}, confirmation, 'reviewer', now), archivedAt: now }), false);
});

test('invalid confirmations fail closed and caller cannot select provenance', () => {
  for (const body of [{ ...confirmation, link: 'http://example.test' }, { ...confirmation, criterion: 'anything' }, { ...confirmation, checkId: '' }]) assert.throws(() => changeReadiness({}, body, 'reviewer', now));
  assert.throws(() => changeReadiness({}, confirmation, '', now));
  const result = changeReadiness({}, { ...confirmation, reviewer: 'forged', date: '1999-01-01' }, 'real', now);
  assert.equal(result.checks[0].evidence!.reviewer, 'real');
  assert.equal(result.checks[0].evidence!.date, now);
});

let client: Awaited<ReturnType<typeof getClient>>;
before(async () => { const port = await startLocal(); client = await getClient(port); await createTables(client); await createUserWithId(client, 'readiness-reviewer', { name: 'Synthetic', email: 'reviewer@example.test', role: 'admin' }); await setDefaultAssignee(client, { defaultAssigneeId: 'readiness-reviewer', expectedVersion: 0 }); });
after(stopLocal);
const invoke = (method: string, path: string, body?: unknown) => handler({ httpMethod: method, path, headers: { 'x-user-id': 'readiness-reviewer' }, body: body === undefined ? null : JSON.stringify(body) }, {});
const data = (response: any) => JSON.parse(response.body);
test('existing CRM API stores version-guarded checks atomically and reminder alerts resume after change', async () => {
  const org = data(await invoke('POST', '/api/sponsor-crm/organizations', { displayName: 'Synthetic readiness' }));
  const deal = data(await invoke('POST', '/api/sponsor-crm/deals', { organizationId: org.id, status: 'agreed' }));
  const slot = data(await invoke('POST', '/api/sponsor-crm/deliverables', { dealId: deal.id, channel: 'main', plannedPublicationDate: '2026-11-14', materialDeadline: '2026-11-10', artifactUrls: ['https://example.test/copy'] }));
  const path = `/api/sponsor-crm/deliverables/${slot.id}`;
  let response = await invoke('POST', `${path}/readiness`, { ...confirmation, version: slot.version });
  assert.equal(response.statusCode, 200, response.body);
  let view = data(response);
  assert.equal(view.checks[0].originalEvidence.reviewer, 'readiness-reviewer');
  const oldVersion = view.version;
  for (const checkId of ['later1', 'later2']) {
    response = await invoke('POST', `${path}/readiness`, { ...confirmation, action: 'check', checkId, version: view.version });
    assert.equal(response.statusCode, 200, response.body); view = data(response);
    assert.equal(view.checks.at(-1).inherited, true);
  }
  assert.equal((await invoke('POST', `${path}/readiness`, { ...confirmation, checkId: 'stale', version: oldVersion })).statusCode, 409);
  assert.equal((await invoke('PUT', path, { version: view.version, readiness: {} })).statusCode, 400);
  await evaluateSponsorBookingAlerts(client, '2026-11-11');
  const activeMaterials = async () => (await listAllNotifications(client)).filter(n => !n.dismissed && (n.metadata as any)?.sponsorDeliverableId === slot.id && String((n.metadata as any)?.sponsorAlertRule).startsWith('materials-'));
  assert.equal((await activeMaterials()).length, 0);
  response = await invoke('PUT', path, { version: view.version, artifactUrls: ['https://example.test/new-copy'] });
  assert.equal(response.statusCode, 200, response.body);
  view = data(await invoke('GET', `${path}/readiness`));
  assert.equal(view.materialVersion, 2); assert.ok(view.checks.every((c: any) => c.status === 'invalidated'));
  await evaluateSponsorBookingAlerts(client, '2026-11-11');
  assert.equal((await activeMaterials()).length, 2);
  response = await invoke('POST', `${path}/readiness`, { ...confirmation, checkId: 'reconfirm', materialVersion: 2, version: view.version });
  assert.equal(response.statusCode, 200, response.body);
  view = data(response);
  await evaluateSponsorBookingAlerts(client, '2026-11-11');
  assert.equal((await activeMaterials()).length, 0);
  response = await invoke('POST', `${path}/readiness`, { action: 'material-change', materialVersion: 2, version: view.version });
  assert.equal(data(response).materialVersion, 3);
});

test('stored materials suggestions become ineligible immediately and cannot produce a draft while confirmed', async () => {
  const org = data(await invoke('POST', '/api/sponsor-crm/organizations', { displayName: 'Synthetic reminder guard' }));
  const person = data(await invoke('POST', '/api/sponsor-crm/contacts', { organizationId: org.id, name: 'Synthetic', emails: ['nobody@example.invalid'] }));
  const deal = data(await invoke('POST', '/api/sponsor-crm/deals', { organizationId: org.id, status: 'agreed', primaryContactId: person.id }));
  const deadline = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  const slot = data(await invoke('POST', '/api/sponsor-crm/deliverables', { dealId: deal.id, channel: 'main', materialDeadline: deadline }));
  await evaluateCommunicationSuggestions(client);
  const historyPath = `/api/sponsor-crm/deals/${deal.id}/communications`;
  let response = await invoke('GET', historyPath);
  assert.equal(response.statusCode, 200, response.body);
  const suggestion = data(response).items.find((item: any) => item.communicationType === 'materials-reminder');
  assert.equal(suggestion.eligible, true);
  response = await invoke('POST', `/api/sponsor-crm/deliverables/${slot.id}/readiness`, { ...confirmation, version: slot.version });
  assert.equal(response.statusCode, 200, response.body);
  const confirmed = data(response);
  response = await invoke('GET', historyPath);
  assert.equal(data(response).items.find((item: any) => item.id === suggestion.id).eligible, false);
  response = await invoke('POST', `/api/sponsor-crm/communication-suggestions/${suggestion.id}/drafts`, { contactId: person.id, recipient: 'nobody@example.invalid' });
  assert.equal(response.statusCode, 409, response.body);
  assert.match(data(response).error, /Materials reminder is no longer eligible/);
  await invoke('POST', `/api/sponsor-crm/deliverables/${slot.id}/readiness`, { version: confirmed.version, materialVersion: 1, action: 'material-change' });
  response = await invoke('GET', historyPath);
  assert.equal(data(response).items.find((item: any) => item.id === suggestion.id).eligible, true);
});
