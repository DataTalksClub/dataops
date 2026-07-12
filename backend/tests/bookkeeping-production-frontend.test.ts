import { after, before, describe, it } from 'node:test';
import assert from 'node:assert';
import path from 'path';
import { handler } from '../src/handler';
import { stopLocal } from '../src/db/client';

const frontendRoot = path.resolve(__dirname, '../../frontend');
const auth = `Basic ${Buffer.from('synthetic-operator:synthetic-password').toString('base64')}`;
const invoke = (requestPath: string) => handler({ httpMethod: 'GET', path: requestPath, headers: { authorization: auth } }, {});

describe('production portal bookkeeping frontend', () => {
  before(() => {
    process.env.DATAOPS_DOCS_DOMAIN = '1';
    process.env.FRONTEND_ROOT = frontendRoot;
    process.env.BASIC_AUTH_USERNAME = 'synthetic-operator';
    process.env.BASIC_AUTH_PASSWORD = 'synthetic-password';
  });
  after(async () => {
    delete process.env.DATAOPS_DOCS_DOMAIN;
    delete process.env.FRONTEND_ROOT;
    delete process.env.BASIC_AUTH_USERNAME;
    delete process.env.BASIC_AUTH_PASSWORD;
    await stopLocal();
  });

  it('serves Bookkeeping navigation from the real deployed frontend', async () => {
    const response = await invoke('/');
    assert.equal(response.statusCode, 200);
    assert.match(response.body, /data-workspace-view="bookkeeping"/);
  });

  it('serves the complete bookkeeping operator surface and responsive styles', async () => {
    const app = await invoke('/src/app.js');
    const css = await invoke('/src/styles.css');
    assert.equal(app.statusCode, 200);
    for (const marker of ['renderBookkeepingSurface', '/transactions', '/documents/upload', '/accounts/setup', '/reports/snapshot', 'data-unlink', 'missingEvidence']) assert.ok(app.body.includes(marker), marker);
    assert.equal(css.statusCode, 200);
    assert.match(css.body, /\.bookkeeping-surface/);
    assert.match(css.body, /@media \(max-width: 720px\)/);
  });
});
