import { describe, it } from 'node:test';
import assert from 'node:assert';
import { NEW_TASK_NAME, OLD_TASK_NAME, renamedIssueStats, taskNeedsRename } from '../scripts/newsletter-metrics-migrate';

describe('newsletter-metrics-migrate helpers', () => {
  it('renames stats.deliveries to stats.sent, preserving the value', () => {
    assert.deepEqual(
      renamedIssueStats({ deliveries: 99714, opens: 34886, openRate: 34.99 }),
      { opens: 34886, openRate: 34.99, sent: 99714 },
    );
  });

  it('leaves stats without the old key alone', () => {
    assert.equal(renamedIssueStats({ sent: 99714, opens: 34886 }), null);
    assert.equal(renamedIssueStats({ opens: 34886 }), null);
    assert.equal(renamedIssueStats(null), null);
    assert.equal(renamedIssueStats(undefined), null);
  });

  it('flags only open metrics tasks that still carry the spreadsheet name', () => {
    assert.equal(taskNeedsRename({ templateTaskRef: 'add-newsletter-performance', description: OLD_TASK_NAME }), true);
    assert.equal(taskNeedsRename({ templateTaskRef: 'add-newsletter-performance', description: NEW_TASK_NAME }), false);
    assert.equal(taskNeedsRename({ templateTaskRef: 'add-newsletter-performance', description: 'Something else' }), false);
    assert.equal(taskNeedsRename({ templateTaskRef: 'other-ref', description: OLD_TASK_NAME }), false);
    assert.equal(taskNeedsRename({}), false);
  });
});
