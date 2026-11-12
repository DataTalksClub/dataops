import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { BLOCKED_RECIPIENTS, isBlockedRecipient } from '../src/identity/operatingIdentities';
import { HOLD_ATTENDEE_DENY_LIST, HOLD_REQUIRED_ATTENDEES } from '../src/calendar/holds';

describe('operating identities', () => {
  it('blocks every listed recipient regardless of case and surrounding whitespace', () => {
    for (const blocked of BLOCKED_RECIPIENTS) {
      assert.equal(isBlockedRecipient(blocked), true);
      assert.equal(isBlockedRecipient(` ${blocked.toUpperCase()} `), true);
    }
  });

  it('does not block other or empty recipients', () => {
    assert.equal(isBlockedRecipient('guest@example.com'), false);
    assert.equal(isBlockedRecipient(''), false);
    assert.equal(isBlockedRecipient(undefined), false);
  });

  it('never requires a denied attendee on a hold invite', () => {
    assert.ok(!HOLD_REQUIRED_ATTENDEES.some((email) => HOLD_ATTENDEE_DENY_LIST.includes(email)));
  });
});
