import { describe, it } from 'node:test';
import assert from 'node:assert';

import {
  cronFieldMatches,
  cronMatchesCivilDate,
  moveWeekendToMonday,
  nextOccurrenceDate,
  parseCronExpression,
  scheduleDatesOccurringOn,
  scheduleOccursOn,
} from '../src/cron/cronMatch';
import { describeSchedule, nextRunLabel, recurringConfigView } from '../src/cron/scheduleView';

describe('cron matching', () => {
  describe('parseCronExpression', () => {
    it('accepts the shapes the generator honours', () => {
      assert.deepStrictEqual(parseCronExpression('0 9 * * *'), {
        minute: '0',
        hour: '9',
        dayOfMonth: '*',
        month: '*',
        dayOfWeek: '*',
      });
      assert.deepStrictEqual(parseCronExpression('  0   9 1-5 * *  '), {
        minute: '0',
        hour: '9',
        dayOfMonth: '1-5',
        month: '*',
        dayOfWeek: '*',
      });
    });

    it('rejects a wrong field count', () => {
      assert.strictEqual(parseCronExpression('0 9 * *'), null);
      assert.strictEqual(parseCronExpression('0 9 * * * *'), null);
      assert.strictEqual(parseCronExpression(''), null);
    });

    it('rejects syntax it would silently ignore', () => {
      for (const expression of [
        '0 9 1,,2 * *',
        '0 9 1- * *',
        '0 9 -1 * *',
        '0 9 * * ?',
        '0 9 L * *',
        '0 9 * * MON',
        '60 9 * * *',
        '0 24 * * *',
        '0 9 0 * *',
        '*/0 9 * * *',
        '0 9 * * 8',
      ]) {
        assert.strictEqual(parseCronExpression(expression), null, expression);
      }
    });

    it('accepts 7 as Sunday alongside 0', () => {
      assert.ok(parseCronExpression('0 9 * * 7'));
      assert.ok(parseCronExpression('0 9 * * 0-7'));
    });
  });

  describe('cronFieldMatches', () => {
    it('matches wildcard, literals, lists, and steps', () => {
      assert.strictEqual(cronFieldMatches('*', 0), true);
      assert.strictEqual(cronFieldMatches('*', 31), true);
      assert.strictEqual(cronFieldMatches('3', 3), true);
      assert.strictEqual(cronFieldMatches('3', 4), false);
      assert.strictEqual(cronFieldMatches('1,3,5', 5), true);
      assert.strictEqual(cronFieldMatches('1,3,5', 2), false);
      assert.strictEqual(cronFieldMatches('*/2', 4), true);
      assert.strictEqual(cronFieldMatches('*/2', 3), false);
    });

    it('matches ranges and range steps the browser also supports', () => {
      assert.strictEqual(cronFieldMatches('1-5', 1), true);
      assert.strictEqual(cronFieldMatches('1-5', 5), true);
      assert.strictEqual(cronFieldMatches('1-5', 6), false);
      assert.strictEqual(cronFieldMatches('1-5/2', 1), true);
      assert.strictEqual(cronFieldMatches('1-5/2', 3), true);
      assert.strictEqual(cronFieldMatches('1-5/2', 5), true);
      assert.strictEqual(cronFieldMatches('1-5/2', 2), false);
      assert.strictEqual(cronFieldMatches('1-5/2', 4), false);
    });

    it('rejects unsupported syntax instead of matching nothing', () => {
      for (const field of ['1,,2', '1-', '', '?', 'L', 'MON']) {
        assert.strictEqual(cronFieldMatches(field, 1), false, field);
      }
    });
  });

  describe('cronMatchesCivilDate', () => {
    // 2028 is a leap year, so every one of these civil dates exists.
    it('matches daily, weekly, monthly, and yearly schedules', () => {
      assert.strictEqual(cronMatchesCivilDate(parseCronExpression('0 9 * * *')!, '2028-01-15'), true);
      // 2028-02-02 is a Wednesday.
      assert.strictEqual(cronMatchesCivilDate(parseCronExpression('0 9 * * 3')!, '2028-02-02'), true);
      assert.strictEqual(cronMatchesCivilDate(parseCronExpression('0 9 * * 3')!, '2028-02-01'), false);
      assert.strictEqual(cronMatchesCivilDate(parseCronExpression('0 9 15 * *')!, '2028-06-15'), true);
      assert.strictEqual(cronMatchesCivilDate(parseCronExpression('0 9 15 * *')!, '2028-06-14'), false);
      assert.strictEqual(cronMatchesCivilDate(parseCronExpression('0 9 25 12 *')!, '2028-12-25'), true);
      assert.strictEqual(cronMatchesCivilDate(parseCronExpression('0 9 25 12 *')!, '2028-11-25'), false);
    });

    it('honours day-of-week ranges and 7 as Sunday', () => {
      // 2028-02-01 is a Tuesday, 2028-02-05 is a Saturday, 2028-02-06 a Sunday.
      assert.strictEqual(cronMatchesCivilDate(parseCronExpression('0 9 * * 1-5')!, '2028-02-01'), true);
      assert.strictEqual(cronMatchesCivilDate(parseCronExpression('0 9 * * 1-5')!, '2028-02-05'), false);
      assert.strictEqual(cronMatchesCivilDate(parseCronExpression('0 9 * * 7')!, '2028-02-06'), true);
      assert.strictEqual(cronMatchesCivilDate(parseCronExpression('0 9 * * 0')!, '2028-02-06'), true);
    });

    it('resolves a civil date independently of the instant that produced it', () => {
      const sixth = parseCronExpression('0 9 6 10 *')!;
      // 2028-10-06 is a Friday; the surrounding instants all land on it.
      assert.ok(cronMatchesCivilDate(sixth, '2028-10-06'));
      assert.strictEqual(cronMatchesCivilDate(sixth, '2028-10-05'), false);
      assert.strictEqual(cronMatchesCivilDate(sixth, '2028-10-07'), false);
    });
  });

  describe('moveWeekendToMonday', () => {
    it('moves Saturday and Sunday to the following Monday and keeps weekdays', () => {
      // 2026-10-30 is a Friday; 2026-11-01 is a Sunday.
      assert.strictEqual(moveWeekendToMonday('2026-10-30'), '2026-10-30');
      assert.strictEqual(moveWeekendToMonday('2026-10-31'), '2026-11-02');
      assert.strictEqual(moveWeekendToMonday('2026-11-01'), '2026-11-02');
      assert.strictEqual(moveWeekendToMonday('2026-11-02'), '2026-11-02');
      // Across a month and a year end.
      assert.strictEqual(moveWeekendToMonday('2028-12-30'), '2029-01-01');
    });
  });

  describe('scheduleDatesOccurringOn', () => {
    it('gives Monday the weekend schedule dates that move onto it', () => {
      const daily = parseCronExpression('0 9 * * *')!;
      assert.deepStrictEqual(scheduleDatesOccurringOn(daily, '2026-11-02'), ['2026-10-31', '2026-11-01', '2026-11-02']);
      assert.deepStrictEqual(scheduleDatesOccurringOn(daily, '2026-11-01'), []);
      assert.deepStrictEqual(scheduleDatesOccurringOn(daily, '2026-10-31'), []);
      assert.deepStrictEqual(scheduleDatesOccurringOn(daily, '2026-11-03'), ['2026-11-03']);
      const first = parseCronExpression('0 9 1 * *')!;
      assert.deepStrictEqual(scheduleDatesOccurringOn(first, '2026-11-02'), ['2026-11-01']);
    });
  });

  describe('scheduleOccursOn', () => {
    it('moves a monthly 1st that lands on a Sunday to the Monday', () => {
      const first = parseCronExpression('0 9 1 * *')!;
      // 2026-11-01 is a Sunday.
      assert.strictEqual(scheduleOccursOn(first, '2026-10-31'), false);
      assert.strictEqual(scheduleOccursOn(first, '2026-11-01'), false);
      assert.strictEqual(scheduleOccursOn(first, '2026-11-02'), true);
      assert.strictEqual(scheduleOccursOn(first, '2026-11-03'), false);
    });

    it('moves a monthly 1st that lands on a Saturday to the Monday', () => {
      const first = parseCronExpression('0 9 1 * *')!;
      // 2026-08-01 is a Saturday.
      assert.strictEqual(scheduleOccursOn(first, '2026-08-01'), false);
      assert.strictEqual(scheduleOccursOn(first, '2026-08-02'), false);
      assert.strictEqual(scheduleOccursOn(first, '2026-08-03'), true);
      // A weekday 1st stays where it is.
      assert.strictEqual(scheduleOccursOn(first, '2026-10-01'), true);
    });

    it('collapses a daily schedule\'s weekend into one Monday occurrence', () => {
      const daily = parseCronExpression('0 9 * * *')!;
      const week = ['2026-10-30', '2026-10-31', '2026-11-01', '2026-11-02', '2026-11-03'];
      assert.deepStrictEqual(week.map((date) => scheduleOccursOn(daily, date)), [true, false, false, true, true]);
    });

    it('moves weekly schedules set on a weekend day to Monday', () => {
      for (const expression of ['0 9 * * 6', '0 9 * * 0', '0 9 * * 7']) {
        const weekly = parseCronExpression(expression)!;
        assert.strictEqual(scheduleOccursOn(weekly, '2026-10-31'), false, expression);
        assert.strictEqual(scheduleOccursOn(weekly, '2026-11-01'), false, expression);
        assert.strictEqual(scheduleOccursOn(weekly, '2026-11-02'), true, expression);
        assert.strictEqual(scheduleOccursOn(weekly, '2026-11-03'), false, expression);
      }
    });
  });

  describe('nextOccurrenceDate', () => {
    it('returns today when today is a weekday occurrence', () => {
      assert.strictEqual(nextOccurrenceDate('0 9 * * *', new Date('2028-01-14T12:00:00Z')), '2028-01-14');
    });

    it('names the Monday for a schedule date on the weekend', () => {
      // Sun 1 Nov 2026 moves to Mon 2 Nov.
      assert.strictEqual(nextOccurrenceDate('0 9 1 * *', new Date('2026-10-16T12:00:00Z')), '2026-11-02');
      // A daily schedule read on a Saturday next occurs on Monday.
      assert.strictEqual(nextOccurrenceDate('0 9 * * *', new Date('2028-01-15T12:00:00Z')), '2028-01-17');
    });

    it('walks to the next matching weekday across a month boundary', () => {
      assert.strictEqual(nextOccurrenceDate('0 9 * * 1', new Date('2026-02-28T12:00:00Z')), '2026-03-02');
    });

    it('walks across a year boundary', () => {
      assert.strictEqual(nextOccurrenceDate('0 9 * * 1', new Date('2026-12-31T12:00:00Z')), '2027-01-04');
    });

    it('keeps leap days reachable, moved off the weekend', () => {
      // 2032-02-29 is a Sunday.
      assert.strictEqual(nextOccurrenceDate('0 9 29 2 *', new Date('2028-03-01T12:00:00Z')), '2032-03-01');
    });

    it('resolves the civil date through Europe/Berlin across a UTC midnight', () => {
      // 22:30 UTC on Thu 10-26 is already Fri 10-27 in Berlin, so a UTC-based
      // walk would name yesterday.
      assert.strictEqual(nextOccurrenceDate('0 9 * * *', new Date('2028-10-26T22:30:00.000Z')), '2028-10-27');
    });

    it('lands on the Monday on both sides of a Berlin DST switch', () => {
      // Fall back: 2028-10-29T01:00Z (Sunday) turns 03:00 CEST into 02:00 CET.
      // Late Saturday CEST, both 02:30s of the switch night, and late Sunday CET
      // all name Monday 10-30.
      for (const instant of ['2028-10-28T21:30:00.000Z', '2028-10-29T00:30:00.000Z', '2028-10-29T01:30:00.000Z', '2028-10-29T22:30:00.000Z']) {
        assert.strictEqual(nextOccurrenceDate('0 9 * * *', new Date(instant)), '2028-10-30', instant);
      }
      // 23:30Z on Sunday is already 00:30 CET Monday.
      assert.strictEqual(nextOccurrenceDate('0 9 * * *', new Date('2028-10-29T23:30:00.000Z')), '2028-10-30');
      // Friday 23:30Z is Saturday 01:30 CEST in Berlin: past Friday's occurrence.
      assert.strictEqual(nextOccurrenceDate('0 9 * * *', new Date('2028-10-27T23:30:00.000Z')), '2028-10-30');

      // Spring forward: 2028-03-26T01:00Z (Sunday) turns 02:00 CET into 03:00 CEST.
      for (const instant of ['2028-03-25T23:30:00.000Z', '2028-03-26T00:30:00.000Z', '2028-03-26T01:30:00.000Z', '2028-03-26T21:30:00.000Z']) {
        assert.strictEqual(nextOccurrenceDate('0 9 * * *', new Date(instant)), '2028-03-27', instant);
      }
      // 22:30Z on Sunday is already 00:30 CEST Monday.
      assert.strictEqual(nextOccurrenceDate('0 9 * * *', new Date('2028-03-26T22:30:00.000Z')), '2028-03-27');
      // A Sunday schedule on the switch day itself moves to the Monday.
      assert.strictEqual(nextOccurrenceDate('0 9 * * 0', new Date('2028-03-26T01:30:00.000Z')), '2028-03-27');
    });

    it('returns nothing for an expression that cannot match any date', () => {
      assert.strictEqual(nextOccurrenceDate('0 9 30 2 *', new Date('2028-01-15T12:00:00Z')), '');
      assert.strictEqual(nextOccurrenceDate('every wednesday', new Date('2028-01-15T12:00:00Z')), '');
    });
  });

  describe('schedule view', () => {
    it('describes the schedules it can summarise and echoes the rest', () => {
      assert.strictEqual(describeSchedule('0 9 * * *'), 'Every day at 09:00');
      assert.strictEqual(describeSchedule('30 6 * * 1'), 'Every Monday at 06:30');
      // 7 is Sunday in cron but has no weekday name of its own.
      assert.strictEqual(describeSchedule('0 9 * * 7'), 'Every Sunday at 09:00');
      assert.strictEqual(describeSchedule('0 9 * * 0'), 'Every Sunday at 09:00');
      assert.strictEqual(describeSchedule('0 9 15 * *'), 'Monthly on day 15 at 09:00');
      assert.strictEqual(describeSchedule('*/5 * * * *'), '*/5 * * * *');
      assert.strictEqual(describeSchedule('0 9 1-5 * *'), '0 9 1-5 * *');
      assert.strictEqual(describeSchedule(''), 'No schedule');
    });

    it('labels the next run relative to today', () => {
      assert.strictEqual(nextRunLabel('2028-01-15', '2028-01-15'), 'Today');
      assert.strictEqual(nextRunLabel('2028-01-16', '2028-01-15'), 'Sun 16 Jan');
      assert.strictEqual(nextRunLabel('', '2028-01-15'), '');
    });

    it('serves the persisted next run verbatim', () => {
      const view = recurringConfigView(
      {
        id: 'config-1',
        description: 'Weekly newsletter',
        cronExpression: '0 9 * * 1',
        enabled: true,
        nextRunDate: '2028-01-17',
        createdAt: '2028-01-01T08:00:00.000Z',
        updatedAt: '2028-01-01T08:00:00.000Z',
      },

        '2028-01-15',
      );

      assert.deepStrictEqual(
        { scheduleLabel: view.scheduleLabel, nextRunDate: view.nextRunDate, nextRunLabel: view.nextRunLabel },
        {
          scheduleLabel: 'Every Monday at 09:00',
          nextRunDate: '2028-01-17',
          nextRunLabel: 'Mon 17 Jan',
        },
      );
    });
  });
});
