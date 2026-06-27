import { describe, it } from 'node:test';
import assert from 'node:assert';
import fs from 'fs/promises';
import path from 'path';

const root = path.join(__dirname, '..');

describe('Assistant job UI assets', () => {
  it('exposes assistant navigation, queue, and contextual workflow actions', async () => {
    const html = await fs.readFile(path.join(root, 'src/pages/index.html'), 'utf8');
    const app = await fs.readFile(path.join(root, 'src/public/app.js'), 'utf8');
    const api = await fs.readFile(path.join(root, 'src/public/api.js'), 'utf8');

    assert.ok(html.includes('href="#/assistants"'), 'navigation should include Assistants');
    assert.ok(html.includes('.assistant-job-row'), 'assistant queue rows should have stable layout CSS');
    assert.ok(api.includes('assistantJobs'), 'client API should expose assistantJobs namespace');
    assert.ok(api.includes('/api/assistant-jobs'), 'client API should call assistant job routes');
    assert.ok(app.includes('#/assistants'), 'router should include Assistants route');
    assert.ok(app.includes('renderAssistants'), 'app should render assistant queue view');
    assert.ok(app.includes('data-request-assistant-task'), 'task surfaces should request contextual assistant help');
    assert.ok(app.includes('bundle-assistant-jobs'), 'bundle detail should show assistant jobs in workflow context');
    assert.ok(app.includes('run-dry'), 'UI should expose deterministic dry-run action');
    assert.ok(app.includes('waiting_approval'), 'UI should surface approval-needed jobs');
  });
});
