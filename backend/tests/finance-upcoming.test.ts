import { describe, it } from 'node:test';
import assert from 'node:assert';
import { businessDay, dueDates, upcomingDebits, validateScheduleEntry, type ScheduleEntry } from '../src/finance/upcoming';

// The schedule as data: the same shape the TAX_SCHEDULE# items hold.
const SCHEDULE: ScheduleEntry[] = [
  { id: 'est-soli', label: 'Income tax + Soli prepayment', taxType: 'income-tax', amount: '11042.00', currency: 'EUR', rule: { kind: 'quarterly', months: [3, 6, 9, 12], day: 10 }, source: 'Bescheid' },
  { id: 'gewst', label: 'Trade tax prepayment', taxType: 'trade-tax', amount: '3296.00', currency: 'EUR', rule: { kind: 'quarterly', months: [2, 5, 8, 11], day: 15 }, source: 'Bescheid' },
  { id: 'vat-2026-q3', label: 'VAT Q3/2026', taxType: 'vat', amount: '659.28', currency: 'EUR', rule: { kind: 'once', date: '2026-11-10' }, source: 'USt-VA' },
  { id: 'tk', label: 'TK health insurance', taxType: 'health-insurance', amount: '1179.36', currency: 'EUR', rule: { kind: 'monthly', day: 16 }, source: 'recurring', approximate: true },
];

describe('upcoming tax debits', () => {
  it('expands monthly, quarterly and one-off rules, clamping the day to the month', () => {
    assert.deepEqual(dueDates({ kind: 'quarterly', months: [2, 5, 8, 11], day: 15 }, '2026-10-01', '2027-03-01'), ['2026-11-15', '2027-02-15']);
    assert.deepEqual(dueDates({ kind: 'monthly', day: 31 }, '2027-02-01', '2027-03-31'), ['2027-02-28', '2027-03-31']);
    assert.deepEqual(dueDates({ kind: 'once', date: '2026-11-10' }, '2026-11-11', '2026-12-31'), []);
  });

  it('moves a due date past weekends and Berlin public holidays and says why', () => {
    assert.deepEqual(businessDay('2026-11-15'), { date: '2026-11-16', reason: 'due 2026-11-15 falls on Sunday' });
    assert.deepEqual(businessDay('2026-12-25'), { date: '2026-12-28', reason: 'due 2026-12-25 falls on Christmas Day / Saturday / Sunday' });
    assert.deepEqual(businessDay('2026-11-10'), { date: '2026-11-10', reason: null });
  });

  it('lists the next 60 days with the 30-day total and flags a shortfall', () => {
    const u = upcomingDebits({ schedule: SCHEDULE, today: '2026-10-31', days: 60, balance: { accountId: 'finom', amount: 5000, currency: 'EUR', asOf: '2026-10-30', source: 'statement' } });
    assert.deepEqual(u.debits.map((d) => [d.date, d.scheduleId, d.status]), [
      ['2026-11-10', 'vat-2026-q3', 'scheduled'],
      ['2026-11-16', 'tk', 'scheduled'],
      ['2026-11-16', 'gewst', 'scheduled'],
      ['2026-12-10', 'est-soli', 'scheduled'],
      ['2026-12-16', 'tk', 'scheduled'],
    ]);
    assert.equal(u.debits[2].shifted, 'due 2026-11-15 falls on Sunday');
    assert.equal(u.dueNext30, 5134.64);
    assert.equal(u.dueInWindow, 17356);
    assert.equal(u.shortfall, true);
    assert.equal(u.balance?.stale, false);
    assert.match(u.warnings.join('\n'), /Balance 5000\.00 EUR is below the 5134\.64 EUR due in the next 30 days/);
  });

  it('marks a debit paid once the ledger or a statement shows it, and flags a missed one', () => {
    const u = upcomingDebits({
      schedule: SCHEDULE, today: '2026-11-18', days: 30,
      paid: [{ id: 'tx-vat', date: '2026-11-10', amount: 659.28, kind: 'ledger' }, { id: 'st-1:4', date: '2026-11-17', amount: 1179.36, kind: 'statement' }],
      balance: { accountId: 'finom', amount: 40000, currency: 'EUR', asOf: '2026-11-01', source: 'statement' },
    });
    const by = Object.fromEntries(u.debits.map((d) => [`${d.scheduleId}@${d.date}`, d]));
    assert.equal(by['vat-2026-q3@2026-11-10'], undefined, 'outside the 7-day lookback');
    assert.equal(by['tk@2026-11-16'].status, 'paid');
    assert.equal(by['tk@2026-11-16'].matched?.id, 'st-1:4');
    assert.equal(by['gewst@2026-11-16'].status, 'not-seen');
    assert.equal(u.dueNext30, 11042 + 1179.36);
    assert.equal(u.shortfall, false);
    assert.equal(u.balance?.stale, true);
    assert.match(u.warnings.join('\n'), /Balance is 17 days old/);
    assert.match(u.warnings.join('\n'), /Trade tax prepayment due 2026-11-16 \(3296\.00 EUR\) is not in the ledger or a statement yet/);
  });

  it('says so when no balance is known instead of guessing', () => {
    const u = upcomingDebits({ schedule: SCHEDULE, today: '2026-10-31' });
    assert.equal(u.balance, null);
    assert.equal(u.shortfall, null);
    assert.match(u.warnings[0], /No account balance known/);
  });

  it('honours validity windows, so a replaced Bescheid stops producing debits', () => {
    const replaced = [{ ...SCHEDULE[1], validUntil: '2026-11-30' }, { ...SCHEDULE[1], id: 'gewst-2027', amount: '3500.00', validFrom: '2026-12-01' }];
    const u = upcomingDebits({ schedule: replaced, today: '2026-10-31', days: 120 });
    assert.deepEqual(u.debits.map((d) => [d.scheduleId, d.date, d.amount]), [['gewst', '2026-11-16', 3296], ['gewst-2027', '2027-02-15', 3500]]);
  });

  it('validates schedule entries', () => {
    assert.deepEqual(validateScheduleEntry(SCHEDULE[0] as unknown as Record<string, unknown>), []);
    assert.deepEqual(validateScheduleEntry({ id: 'X', label: '', taxType: 'tea', amount: '1,00', currency: 'USD', source: 'guess', rule: { kind: 'quarterly', months: [13], day: 40 } }).sort(),
      ['amount', 'currency', 'id', 'label', 'rule.day', 'rule.months', 'source', 'taxType']);
  });
});
