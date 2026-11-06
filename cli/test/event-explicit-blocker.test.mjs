import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { isolateConfig, captureIo, fakePortal } from './helpers.mjs';
isolateConfig();
const original = globalThis.fetch;
const { run } = await import('../src/cli.mjs');
afterEach(() => { globalThis.fetch = original; });
test('manual Calendar-only blocker forwards explicit duration and IANA clock zone', async () => {
  const portal = fakePortal({ 'POST /api/events/card-1/propose': ({body}) => { assert.equal(body.durationMinutes,45); assert.equal(body.timeZone,'America/New_York'); return {event:{id:'hold_card-1',status:'proposed'},sync:{state:'synced'}}; } });
  const code = await run(['event','propose','card-1','--date','2030-12-19','--time','12:00','--duration','45','--time-zone','America/New_York','--guest-emails','guest@example.test'], captureIo());
  assert.equal(code,0); assert.equal(portal.length,1);
});
test('invalid duration and time zone fail before API writes', async () => {
  let calls = 0; globalThis.fetch = async () => { calls++; throw new Error('Unexpected request'); };
  for (const flags of [['--duration','0'],['--duration'],['--time-zone','Not/AZone']]) assert.equal(await run(['event','propose','card-1','--date','2030-12-19','--time','12:00',...flags],captureIo()),2);
  assert.equal(calls,0);
});
