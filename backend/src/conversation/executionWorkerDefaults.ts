import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

import { ExecutorRegistry, type CapabilityExecutor } from './execution';
import { FAKE_BUILD_DIGEST } from './executionDefaults';
import { FakeCapabilityExecutor } from './executionWorker';
import { TypefullySavedDraftExecutor } from './typefullyExecutor';
import { ActorTodoExecutor } from './todoWriter';

function defaultWorkerExecutionRegistry(client: DynamoDBDocumentClient): ExecutorRegistry {
  const executors: CapabilityExecutor[] = [];
  if (process.env.CONVERSATIONAL_TODO_EXECUTOR_ENABLED === 'true') {
    executors.push(new ActorTodoExecutor(client));
  }
  executors.push(new TypefullySavedDraftExecutor(client));
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

export { defaultWorkerExecutionRegistry };
