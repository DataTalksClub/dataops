import { ExecutorRegistry, type CapabilityExecutor } from './execution';
import { FakeCapabilityExecutor } from './executionWorker';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { ActorTodoExecutor } from './todoWriter';
import { TypefullyProposalRenderExecutor } from './typefullySpec';

const FAKE_BUILD_DIGEST = `sha256:${'f'.repeat(64)}`;

function defaultExecutionRegistry(
  client: DynamoDBDocumentClient
): ExecutorRegistry {
  // Executors are a static build-time registry. Rollout eligibility is checked
  // before approval, leasing, and dispatch rather than changing registration.
  const executors: CapabilityExecutor[] = [
    new ActorTodoExecutor(client),
    new TypefullyProposalRenderExecutor(),
  ];
  if (process.env.NODE_ENV === 'test' && process.env.CONVERSATIONAL_FAKE_EXECUTOR_ENABLED === 'true') {
    executors.push(new FakeCapabilityExecutor(
      'fake.effect',
      FAKE_BUILD_DIGEST,
      'todo:create:self',
      'provider_idempotency'
    ));
  }
  return new ExecutorRegistry(executors);
}

export { FAKE_BUILD_DIGEST, defaultExecutionRegistry };
