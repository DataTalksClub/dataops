import { after, before, mock } from 'node:test';

/** Fix only wall-clock Date inside this suite; async/database timers stay real. */
export function useFixedDate(now: Date): void {
  // Runtime CI uses Node 20+, whose Date-only timer API is newer than the
  // project's Node 18 type declarations. Keep this type bridge test-local.
  const timers = mock.timers as unknown as {
    enable(options: { apis: ['Date']; now: Date }): void;
    reset(): void;
  };
  before(() => timers.enable({ apis: ['Date'], now }));
  after(() => timers.reset());
}
