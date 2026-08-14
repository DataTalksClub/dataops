import { after, describe, it } from 'node:test';
import assert from 'node:assert';
import path from 'node:path';

import { handler } from '../src/handler';
import { stopLocal } from '../scripts/local-dynamodb';
import { serveCanonicalFrontend } from '../src/docs/portal';
import { DEPLOYED_FRONTEND_FILE_LIST } from '../src/docs/frontendAssets';

const repoRoot = path.resolve(__dirname, '..', '..');

function expectedContentType(assetPath: string): RegExp {
  if (assetPath.endsWith('.html')) return /text\/html/;
  if (assetPath.endsWith('.css')) return /text\/css/;
  if (assetPath.endsWith('.js')) return /application\/javascript/;
  throw new Error(`Unhandled canonical frontend asset type: ${assetPath}`);
}

describe('one canonical frontend', () => {
  after(async () => {
    await stopLocal();
  });

  it('serves the canonical root and every manifest-declared same-origin asset', async () => {
    const root = await handler({ httpMethod: 'GET', path: '/' }, {});
    assert.strictEqual(root.statusCode, 200);
    assert.match(root.headers?.['Content-Type'] || '', /text\/html/);

    for (const assetPath of DEPLOYED_FRONTEND_FILE_LIST) {
      const requestPath = `/${assetPath}`;
      const response = await handler({ httpMethod: 'GET', path: requestPath }, {});
      assert.strictEqual(response.statusCode, 200, `${requestPath} must be served by the real handler`);
      assert.match(
        response.headers?.['Content-Type'] || '',
        expectedContentType(assetPath),
        `${requestPath} must have its current manifest-derived content type`,
      );
    }
  });

  it('rejects the retired namespace, traversal, and undeclared static assets', async () => {
    for (const requestPath of [
      '/public/app.js',
      '/public/api.js',
      '/src/../package.json',
      '/src/not-in-the-canonical-manifest.js',
    ]) {
      const response = await handler({ httpMethod: 'GET', path: requestPath }, {});
      assert.strictEqual(response.statusCode, 404, `${requestPath} must not reach the canonical artifact`);
    }
  });

  it('fails explicitly when the canonical artifact is missing', () => {
    const previous = process.env.FRONTEND_ROOT;
    process.env.FRONTEND_ROOT = path.join(repoRoot, 'missing-canonical-frontend');
    try {
      const response = serveCanonicalFrontend({ httpMethod: 'GET', path: '/' });
      assert.strictEqual(response?.statusCode, 500);
      assert.deepStrictEqual(JSON.parse(response?.body || '{}'), {
        error: 'Canonical frontend artifact is missing',
      });
    } finally {
      if (previous === undefined) delete process.env.FRONTEND_ROOT;
      else process.env.FRONTEND_ROOT = previous;
    }
  });
});
