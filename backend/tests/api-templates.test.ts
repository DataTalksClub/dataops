import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';

import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

import { handler } from '../src/handler';
import { getClient } from '../src/db/client';
import { startLocal, stopLocal } from '../scripts/local-dynamodb';
import { createTables } from '../scripts/local-dynamodb';
import { createTemplate, getTemplate } from '../src/db/templates';
import type { LambdaResponse, Template } from '../src/types';

function invoke(method: string, path: string, body?: unknown): Promise<LambdaResponse> {
  return handler({
    httpMethod: method,
    path,
    body: body === undefined ? null : JSON.stringify(body),
  }, {}) as Promise<LambdaResponse>;
}

function body(response: LambdaResponse): any {
  return JSON.parse(response.body);
}

describe('read-only workflow template API', () => {
  let client: DynamoDBDocumentClient;
  let template: Template;

  before(async () => {
    const port = await startLocal();
    client = await getClient(port);
    await createTables(client);
    template = await createTemplate(client, {
      name: 'Synthetic Git projection',
      type: 'synthetic-git-projection',
      sourcePath: 'workflow-templates/synthetic-git-projection.yaml',
      sourceRevision: 'synthetic-blob-sha',
      triggerType: 'manual',
      taskDefinitions: [{ refId: 'one', description: 'Synthetic task', offsetDays: 0 }],
    });
  });

  after(async () => {
    await stopLocal();
  });

  it('lists runtime projections with public-safe Git source metadata', async () => {
    const response = await invoke('GET', '/api/templates');
    assert.strictEqual(response.statusCode, 200);
    const listed = body(response).templates.find((item: Template) => item.id === template.id);
    assert.ok(listed);
    assert.strictEqual(listed.sourcePath, 'workflow-templates/synthetic-git-projection.yaml');
    assert.strictEqual(listed.sourceRevision, 'synthetic-blob-sha');
  });

  it('gets one projection and returns 404 for an unknown id', async () => {
    const found = await invoke('GET', `/api/templates/${template.id}`);
    assert.strictEqual(found.statusCode, 200);
    assert.strictEqual(body(found).template.id, template.id);
    assert.strictEqual((await invoke('GET', '/api/templates/missing')).statusCode, 404);
  });

  for (const [method, path] of [
    ['POST', '/api/templates'],
    ['PUT', '/api/templates/synthetic'],
    ['DELETE', '/api/templates/synthetic'],
    ['PATCH', '/api/templates/synthetic'],
  ]) {
    it(`${method} ${path} is method-not-allowed without a side effect`, async () => {
      const response = await invoke(method, path, { name: 'Must not persist' });
      assert.strictEqual(response.statusCode, 405);
      assert.strictEqual(body(response).authority, 'git-authored-workflow-templates');
      assert.strictEqual((await getTemplate(client, template.id))?.name, 'Synthetic Git projection');
    });
  }
});
