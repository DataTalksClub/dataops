import { ExecutorRegistry } from './execution';
import { FakeCapabilityExecutor } from './executionWorker';

const FAKE_BUILD_DIGEST = `sha256:${'f'.repeat(64)}`;

function defaultExecutionRegistry(): ExecutorRegistry {
  if (process.env.CONVERSATIONAL_FAKE_EXECUTOR_ENABLED !== 'true') {
    return new ExecutorRegistry([]);
  }
  return new ExecutorRegistry([
    new FakeCapabilityExecutor(
      'fake.effect',
      FAKE_BUILD_DIGEST,
      'todo:create:self',
      'provider_idempotency'
    ),
  ]);
}

export { FAKE_BUILD_DIGEST, defaultExecutionRegistry };
