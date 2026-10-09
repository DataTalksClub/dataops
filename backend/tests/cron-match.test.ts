import { describe, it } from 'node:test';
import assert from 'node:assert';

import {
  cronFieldMatches,
  cronMatchesCivilDate,
  cronMatchesDate,
  nextMatchingDate,
  parseCronExpression,
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

  describe('cronMatchesDate', () => {
    // 2028 is a leap year, so every one of these civil dates exists.
    it('matches daily, weekly, monthly, and yearly schedules', () => {
      assert.strictEqual(cronMatchesDate('0 9 * * *', new Date('2028-01-15T00:00:00Z')), true);
      // 2028-02-02 is a Wednesday.
      assert.strictEqual(cronMatchesDate('0 9 * * 3', new Date('2028-02-02T00:00:00Z')), true);
      assert.strictEqual(cronMatchesDate('0 9 * * 3', new Date('2028-02-01T00:00:00Z')), false);
      assert.strictEqual(cronMatchesDate('0 9 15 * *', new Date('2028-06-15T00:00:00Z')), true);
      assert.strictEqual(cronMatchesDate('0 9 15 * *', new Date('2028-06-14T00:00:00Z')), false);
      assert.strictEqual(cronMatchesDate('0 9 25 12 *', new Date('2028-12-25T00:00:00Z')), true);
      assert.strictEqual(cronMatchesDate('0 9 25 12 *', new Date('2028-11-25T00:00:00Z')), false);
    });

    it('honours day-of-week ranges and 7 as Sunday', () => {
      // 2028-02-01 is a Tuesday, 2028-02-05 is a Saturday, 2028-02-06 a Sunday.
      assert.strictEqual(cronMatchesDate('0 9 * * 1-5', new Date('2028-02-01T00:00:00Z')), true);
      assert.strictEqual(cronMatchesDate('0 9 * * 1-5', new Date('2028-02-05T00:00:00Z')), false);
      assert.strictEqual(cronMatchesDate('0 9 * * 7', new Date('2028-02-06T00:00:00Z')), true);
      assert.strictEqual(cronMatchesDate('0 9 * * 0', new Date('2028-02-06T00:00:00Z')), true);
    });

    it('rejects expressions that do not parse', () => {
      assert.strictEqual(cronMatchesDate('0 9 * *', new Date('2028-01-15T00:00:00Z')), false);
      assert.strictEqual(cronMatchesDate('every wednesday', new Date('2028-01-15T00:00:00Z')), false);
    });

    it('resolves a civil date independently of the instant that produced it', () => {
      const sixth = parseCronExpression('0 9 6 10 *')!;
      // 2028-10-06 is a Friday; the surrounding instants all land on it.
      assert.ok(cronMatchesCivilDate(sixth, '2028-10-06'));
      assert.strictEqual(cronMatchesCivilDate(sixth, '2028-10-05'), false);
      assert.strictEqual(cronMatchesCivilDate(sixth, '2028-10-07'), false);
      assert.strictEqual(cronMatchesDate('0 9 6 10 *', new Date('2028-10-06T00:00:00Z')), true);
    });
  });

  describe('nextMatchingDate', () => {
    it('returns today when today matches', () => {
      assert.strictEqual(nextMatchingDate('0 9 * * *', new Date('2028-01-15T12:00:00Z')), '2028-01-15');
    });

    it('walks to the next matching weekday across a month boundary', () => {
      assert.strictEqual(nextMatchingDate('0 9 * * 1', new Date('2026-02-28T12:00:00Z')), '2026-03-02');
    });

    it('walks across a year boundary', () => {
      assert.strictEqual(nextMatchingDate('0 9 * * 1', new Date('2026-12-31T12:00:00Z')), '2027-01-04');
    });

    it('keeps leap days reachable', () => {
      assert.strictEqual(nextMatchingDate('0 9 29 2 *', new Date('2028-03-01T12:00:00Z')), '2032-02-29');
    });

    it('resolves the civil date through Europe/Berlin across a UTC midnight', () => {
      // 22:30 UTC on 10-28 is already 10-29 in Berlin, so a UTC-based walk
      // would name yesterday.
      assert.strictEqual(nextMatchingDate('0 9 * * 0', new Date('2028-10-28T22:30:00.000Z')), '2028-10-29');
    });

    it('resolves the civil date through Europe/Berlin on both sides of a DST switch', () => {
      // Fall back: 2028-10-29T01:00Z turns 03:00 CEST into 02:00 CET.
      assert.strictEqual(nextMatchingDate('0 9 * * *', new Date('2028-10-29T00:30:00.000Z')), '2028-10-29');
      assert.strictEqual(nextMatchingDate('0 9 * * *', new Date('2028-10-29T01:30:00.000Z')), '2028-10-29');

      // Spring forward: 2028-03-26T01:00Z turns 02:00 CET into 03:00 CEST.
      assert.strictEqual(nextMatchingDate('0 9 * * *', new Date('2028-03-26T00:30:00.000Z')), '2028-03-26');
      assert.strictEqual(nextMatchingDate('0 9 * * *', new Date('2028-03-26T01:30:00.000Z')), '2028-03-26');

      // A weekday walk starting on the switch day still lands on the right Monday.
      assert.strictEqual(nextMatchingDate('0 9 * * 1', new Date('2028-10-29T01:30:00.000Z')), '2028-10-30');
    });

    it('returns nothing for an expression that cannot match any date', () => {
      assert.strictEqual(nextMatchingDate('0 9 30 2 *', new Date('2028-01-15T12:00:00Z')), '');
      assert.strictEqual(nextMatchingDate('every wednesday', new Date('2028-01-15T12:00:00Z')), '');
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
