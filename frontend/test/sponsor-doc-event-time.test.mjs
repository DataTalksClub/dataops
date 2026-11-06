import assert from 'node:assert/strict';
import { test } from 'node:test';
import { dualZoneEventTime, formatGuestEventTime, guestEventTimeZone } from '../src/surfaces/operations/sponsor-doc-event-time.js';
test('dual-zone labels carry both full local dates across midnight and duration', () => {
  const label = dualZoneEventTime('2030-12-02T18:00:00Z', '2030-12-02T19:00:00Z', 'Asia/Kolkata');
  assert.match(label, /Mon, 2 Dec 2030/);
  assert.match(label, /Tue, 3 Dec 2030/);
  assert.match(label, /19:00/);
  assert.match(label, /00:30/);
  assert.match(label, /60 minutes/);
  assert.match(label, /Europe\/Berlin/);
  assert.match(label, /Asia\/Kolkata/);
});
test('formatting uses IANA DST offsets at each instant and rejects non-ISO guesses', () => {
  assert.match(formatGuestEventTime('2030-03-31T00:30:00Z', '2030-03-31T01:30:00Z', 'Europe/Berlin'), /01:30.*03:30.*60 minutes/);
  assert.equal(dualZoneEventTime(undefined, undefined, 'UTC'), '');
  assert.equal(guestEventTimeZone('Asia/Kolkata'), 'Asia/Kolkata');
});
