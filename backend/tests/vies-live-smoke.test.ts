import { describe, it } from 'node:test';
import assert from 'node:assert';
import { lookupVies } from '../src/vies/client';

// Opt-in only: VIES_LIVE_SMOKE=1 node --import tsx --test tests/vies-live-smoke.test.ts
// The European Commission's service is rate-limited and occasionally flaky, so
// normal CI never calls it. The smoke asserts a definitive answer for the
// European Commission's own published VAT ID and accepts either verdict;
// only an unavailable service fails.
describe('VIES live smoke', () => {
  it('gets a definitive answer from the production service', { skip: process.env.VIES_LIVE_SMOKE !== '1' }, async () => {
    const answer = await lookupVies('DE', '811907980');
    assert.ok(
      answer.kind === 'valid' || answer.kind === 'not-found',
      `expected a definitive VIES answer, got: ${answer.kind} (${answer.kind === 'unavailable' ? answer.error : ''})`,
    );
  });
});
