import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { FakeDocument, findByText } from './support/fake-dom.mjs';
import { renderCardGuestInvitation } from '../src/surfaces/work-detail/card-summary.js';
const originalDocument = globalThis.document;
afterEach(() => { globalThis.document = originalDocument; });
const render = (intake, context = {}) => {
  globalThis.document = new FakeDocument();
  return renderCardGuestInvitation({ request: async () => { throw new Error('No request expected'); }, workApiUrl: path => path, ...context }, { id: 'synthetic-card', guestIntake: intake });
};
test('receipt requires provider message evidence before displaying sent', () => {
  for (const status of ['queued', 'preparing', 'sent']) {
    const section = render({ status, recipient: 'guest@example.test' });
    assert.match(section.textContent, /Invitation preparing/);
    assert.doesNotMatch(section.textContent, /Invitation sent/);
    assert.equal(section.querySelector('button'), null);
  }
  const section = render({ status: 'sent', messageId: 'synthetic-message', sentAt: '2030-11-01T09:15:00Z', recipient: 'guest@example.test', startIso: '2030-12-02T12:00:00Z' });
  assert.match(section.textContent, /Invitation sent/);
  assert.match(section.textContent, /Proposed time:/);
  assert.match(section.querySelector('[data-invitation-sent-at]').textContent, /1 Nov 2030.*10:15/);
  assert.match(section.querySelector('a').href, /synthetic-message$/);
});
test('failure and missing contact point to their Task, never send automatically on render', () => {
  for (const status of ['failed', 'contact-pending']) {
    const section = render({ status, taskId: 'synthetic-task', error: 'Contact details need attention' });
    assert.match(section.querySelector('a').href, /taskId=synthetic-task/);
    assert.equal(section.querySelector('button'), null);
  }
  assert.equal(render(undefined), null);
});
test('only a skipped first invitation exposes send action; clicking queues once', async () => {
  const calls = [];
  let reloads = 0;
  const section = render({ status: 'skipped' }, { request: async (...args) => { calls.push(args); }, reload: async () => { reloads++; } });
  const button = findByText(section, 'Send invitation', 'button');
  await button.click();
  await button.click();
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], '/api/cards/synthetic-card/guest-intake/send');
  assert.equal(calls[0][1].method, 'POST');
  assert.equal(reloads, 1);
  assert.match(section.textContent, /Invitation preparing/);
  assert.doesNotMatch(section.textContent, /Invitation sent/);
});
test('preparing receipt refreshes to sent or failed and stops after terminal evidence', async () => {
  for (const status of ['sent', 'failed']) {
    const scheduled = [];
    let requests = 0;
    const section = render({ status: 'queued' }, {
      schedule: callback => { scheduled.push(callback); return scheduled.length; }, cancel: () => {},
      request: async () => { requests++; return { card: { id: 'synthetic-card', guestIntake: { status, ...(status === 'sent' ? { messageId: 'receipt-id' } : { taskId: 'failed-task', error: 'Delivery failed' }) } } }; },
    });
    assert.equal(scheduled.length, 1);
    await scheduled[0]();
    assert.equal(requests, 1);
    assert.equal(scheduled.length, 1);
    assert.match(section.textContent, status === 'sent' ? /Invitation sent/ : /Invitation could not be sent/);
  }
});
test('closing the Card stops pending invitation checks without another request', async () => {
  const scheduled = [];
  let requests = 0;
  const section = render({ status: 'preparing' }, { schedule: callback => { scheduled.push(callback); return 1; }, cancel: () => {}, request: async () => { requests++; } });
  section.remove();
  await scheduled[0]();
  assert.equal(requests, 0);
});

test('paused and cancelled receipts show honest states without background polling on parked Cards', () => {
  for (const status of ['paused', 'cancelled']) {
    const scheduled = [];
    const section = render({ status }, { schedule: callback => { scheduled.push(callback); return 1; } });
    assert.match(section.textContent, new RegExp(`Invitation ${status}`));
    assert.doesNotMatch(section.textContent, /Invitation preparing/);
    assert.equal(scheduled.length, 0);
  }
  globalThis.document = new FakeDocument();
  const scheduled = [];
  renderCardGuestInvitation({ request: async () => ({}), workApiUrl: x => x, schedule: callback => { scheduled.push(callback); return 1; } }, { id: 'active-card', status: 'active', guestIntake: { status: 'paused' } });
  assert.equal(scheduled.length, 1, 'resumed active Card refreshes its paused receipt');
});
