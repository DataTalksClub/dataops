import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  BucketNotConfiguredError,
  bookkeepingDocumentsBucket,
  emailDocumentsBucket,
} from '../src/runtimePaths';

const accessors = [
  { envName: 'BOOKKEEPING_DOCUMENTS_BUCKET', read: bookkeepingDocumentsBucket },
  { envName: 'EMAIL_DOCUMENTS_BUCKET', read: emailDocumentsBucket },
] as const;

const saved = Object.fromEntries(accessors.map(({ envName }) => [envName, process.env[envName]]));

afterEach(() => {
  for (const [name, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

for (const { envName, read } of accessors) {
  test(`${read.name} returns the configured ${envName}`, () => {
    process.env[envName] = 'synthetic-configured-bucket';
    assert.equal(read(), 'synthetic-configured-bucket');
  });

  for (const unset of [undefined, '']) {
    test(`${read.name} throws a named error when ${envName} is ${unset === undefined ? 'unset' : 'empty'}`, () => {
      if (unset === undefined) delete process.env[envName];
      else process.env[envName] = unset;
      assert.throws(read, (error: unknown) => {
        assert.ok(error instanceof BucketNotConfiguredError);
        assert.equal(error.name, 'BucketNotConfiguredError');
        assert.equal(error.envName, envName);
        assert.match(error.message, new RegExp(`^${envName} is not set\\.`));
        assert.match(error.message, /never created by the application/);
        return true;
      });
    });
  }
}
