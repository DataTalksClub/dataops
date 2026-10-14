import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { createDevicePage } from '../src/surfaces/operations/device.js';
import { FakeDocument, FakeElement, findByText, nextTicks } from './support/fake-dom.mjs';
const savedDocument = globalThis.document;
const savedEvent = globalThis.CustomEvent;
afterEach(() => { globalThis.document = savedDocument; globalThis.CustomEvent = savedEvent; });
function harness(options = {}) {
  const card = new FakeElement('section'); card.id = 'device-card';
  const identity = new FakeElement('span'); identity.id = 'device-identity';
  const live = new FakeElement('div'); live.id = 'dk-live';
  const doc = new FakeDocument(card, identity, live);
  const originalCreate = doc.createElement.bind(doc);
  doc.createElement = tag => {
    const node = originalCreate(tag);
    node.dispatchEvent = event => node.dispatch(event.type, event);
    node.prepend = child => { node.children.unshift(child); child.parentElement = node; };
    node.isConnected = true;
    return node;
  };
  globalThis.document = doc;
  globalThis.CustomEvent = class { constructor(type, init) { this.type = type; this.detail = init.detail; } };
  const calls = [], urls = [], ticks = [];
  const locationRef = { href: options.href || 'https://ops.example.test/device?userCode=bcdfghjk', hostname: 'ops.example.test', assign: url => urls.push(url), replace: url => urls.push(url) };
  let clock = Date.parse('2026-10-14T10:00:00Z');
  const controller = createDevicePage({
    documentRef: doc, locationRef, historyRef: { replaceState() {} }, now: () => clock,
    setIntervalImpl: callback => { ticks.push(callback); return ticks.length; }, clearIntervalImpl() {},
    request: async (url, opts) => {
      calls.push([url, opts]);
      if (url === '/api/me') return options.meRequest ? options.meRequest() : { user: { email: 'operator@example.test' } };
      if (options.request) return options.request(url, opts);
      if (url.includes('/pending')) return { label: '<untrusted machine>', requestIp: '203.0.113.7', createdAt: new Date(clock).toISOString(), expiresAt: new Date(clock + 600000).toISOString(), same_network: options.sameNetwork };
      return { status: options.denied ? 'denied' : 'approved' };
    },
  });
  const input = () => card.querySelector('#device-code');
  const type = async value => { input().value = value; await input().dispatch('input'); };
  const submit = async () => { await card.querySelector('form').dispatch('submit'); await nextTicks(); };
  return { card, controller, calls, urls, input, type, submit, advance: ms => { clock += ms; ticks.at(-1)?.(); } };
}
test('a prefilled link requires Continue, normalizes without truncation, then explicitly approves', async () => {
  const h = harness(); await h.controller.start();
  assert.equal(h.input().value, 'BCDF-GHJK'); assert.equal(h.calls.length, 1);
  await h.type('bcdfghjkx'); assert.equal(h.input().value, 'BCDF-GHJK-X');
  assert.match(h.card.textContent, /extra character/);
  await h.type('bcdf ghjk'); await h.submit();
  assert.match(h.card.textContent, /Authorize this device/);
  assert.match(h.card.textContent, /<untrusted machine>/);
  await findByText(h.card, 'Authorize', 'button').click(); await nextTicks();
  assert.match(h.card.textContent, /Device authorized/);
  assert.deepEqual(JSON.parse(h.calls.at(-1)[1].body), { userCode: 'BCDF-GHJK', approve: true });
  h.controller.destroy();
});
test('a different network requires acknowledgement and Deny remains available', async () => {
  const h = harness({ sameNetwork: false, denied: true }); await h.controller.start(); await h.submit();
  assert.equal(findByText(h.card, 'Authorize', 'button').disabled, true);
  const checkbox = h.card.querySelector('input'); checkbox.checked = true; await checkbox.dispatch('change');
  assert.equal(findByText(h.card, 'Authorize', 'button').disabled, false);
  await findByText(h.card, 'Deny', 'button').click(); await nextTicks();
  assert.match(h.card.textContent, /Request denied/); assert.equal(h.card.querySelector('button'), null);
  h.controller.destroy();
});
test('the countdown expires and returns to an empty Enter step', async () => {
  const h = harness(); await h.controller.start(); await h.submit(); h.advance(541000);
  assert.match(h.card.textContent, /0:59/); h.advance(60000);
  assert.match(h.card.textContent, /Code expired/);
  await findByText(h.card, 'Enter another code', 'button').click(); assert.equal(h.input().value, '');
  h.controller.destroy();
});
for (const [status, title, action] of [[404, 'Code not found', 'Enter another code'], [401, 'Sign in to continue', 'Sign in'], [429, 'Slow down', 'Try again'], [503, "Couldn't reach DataOps", 'Try again']]) {
  test(`device error ${status} states a recovery action without revealing server details`, async () => {
    const h = harness({ request: async () => { throw Object.assign(new Error('private server details'), { status, retryAfter: 2 }); } });
    await h.controller.start(); await h.submit(); assert.match(h.card.textContent, new RegExp(title));
    assert.doesNotMatch(h.card.textContent, /private server details/);
    if (status === 429) h.advance(3000);
    await findByText(h.card, action, 'button').click(); await nextTicks();
    if (status === 401) assert.match(h.urls[0], /return_to=/);
    h.controller.destroy();
  });
}
test('editing a pending code discards a stale lookup, and decisions reject double clicks', async () => {
  let resolve;
  const h = harness({ request: () => new Promise(done => { resolve = done; }) });
  await h.controller.start(); await h.submit(); await h.type('WXZB-CDFG');
  resolve({ label: 'Stale machine' }); await nextTicks();
  assert.equal(h.input().value, 'WXZB-CDFG'); assert.doesNotMatch(h.card.textContent, /Stale machine/);
  h.controller.destroy();
});
test('decision submission is single-flight even when another click is dispatched', async () => {
  let resolveDecision;
  let decisions = 0;
  const h = harness({ request: async (url) => {
    if (url.includes('/pending')) return { label: 'Machine', requestIp: '203.0.113.7', createdAt: '2026-10-14T10:00:00Z', expiresAt: '2026-10-14T10:10:00Z' };
    decisions++;
    return new Promise(resolve => { resolveDecision = resolve; });
  } });
  await h.controller.start(); await h.submit();
  const first = findByText(h.card, 'Authorize', 'button').click();
  await nextTicks();
  await findByText(h.card, 'Authorizing…', 'button').click();
  assert.equal(decisions, 1);
  resolveDecision({ status: 'approved' }); await first;
  assert.match(h.card.textContent, /Device authorized/);
  h.controller.destroy();
});

test('identity failures block consent until the identity is known', async () => {
  let ready = false;
  const h = harness({ meRequest: async () => {
    if (!ready) throw Object.assign(new Error('unavailable'), { status: 503 });
    return { user: { email: 'operator@example.test' } };
  } });
  await h.controller.start();
  assert.match(h.card.textContent, /Couldn.t reach DataOps/);
  assert.equal(h.calls.filter(([url]) => url.includes('/pending')).length, 0);
  ready = true;
  await findByText(h.card, 'Try again', 'button').click(); await nextTicks();
  assert.equal(h.input().value, 'BCDF-GHJK');
  await h.submit(); assert.match(h.card.textContent, /operator@example.test/);
  h.controller.destroy();
});
