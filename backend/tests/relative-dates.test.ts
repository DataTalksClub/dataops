import { describe, it } from 'node:test';
import assert from 'node:assert';

import {
  addDays,
  berlinToday,
  isCalendarDate,
  resolveRelativeDateWord,
  resolveTaskDate,
} from '../src/relativeDates';

describe('relative dates', () => {
  it('passes absolute calendar dates through and rejects impossible ones', () => {
    assert.strictEqual(resolveTaskDate('2026-01-31', '2026-10-17'), '2026-01-31');
    assert.strictEqual(resolveTaskDate('2026-02-30', '2026-10-17'), null);
    assert.ok(isCalendarDate('2026-02-28'));
    assert.ok(!isCalendarDate('2026-02-30'));
  });

  it('resolves +Nd offsets against the given today', () => {
    assert.strictEqual(resolveTaskDate('+7d', '2026-10-17'), '2026-10-24');
    assert.strictEqual(resolveTaskDate('+3d', '2026-10-17'), '2026-10-20');
    assert.strictEqual(resolveTaskDate('+1', '2026-10-17'), '2026-10-18');
  });

  it('resolves today, tomorrow, and yesterday', () => {
    assert.strictEqual(resolveTaskDate('tomorrow', '2026-10-17'), '2026-10-18');
    assert.strictEqual(resolveTaskDate('today', '2026-10-17'), '2026-10-17');
    assert.strictEqual(resolveTaskDate('yesterday', '2026-10-17'), '2026-10-16');
  });

  it('resolves a weekday to its next occurrence, strictly after today', () => {
    // 2026-10-17 is a Saturday.
    assert.strictEqual(resolveTaskDate('mon', '2026-10-17'), '2026-10-19');
    assert.strictEqual(resolveTaskDate('Monday', '2026-10-17'), '2026-10-19');
    assert.strictEqual(resolveTaskDate('sat', '2026-10-17'), '2026-10-24');
    assert.strictEqual(resolveTaskDate('sun', '2026-10-17'), '2026-10-18');
    assert.strictEqual(resolveRelativeDateWord('fri', '2026-10-17'), '2026-10-23');
  });

  it('returns null for words that are neither dates nor relative', () => {
    assert.strictEqual(resolveTaskDate('someday', '2026-10-17'), null);
    assert.strictEqual(resolveTaskDate('', '2026-10-17'), null);
    assert.strictEqual(resolveTaskDate(undefined, '2026-10-17'), null);
  });

  it('computes the Berlin today and adds days across month ends', () => {
    assert.match(berlinToday(new Date('2026-10-17T00:30:00Z')), /^\d{4}-\d{2}-\d{2}$/);
    assert.strictEqual(addDays('2026-10-31', 1), '2026-11-01');
  });
});
