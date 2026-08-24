import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { copyIsolatedArtifact, readValidManifest } from './build-sam-artifact.mjs';
import { launchParityTarget } from './frontend-parity-runtime.mjs';

const repoRoot = resolve(import.meta.dirname, '..', '..');
const samSource = join(repoRoot, '.aws-sam', 'build', 'BackendFunction');
const smokeRoot = join(repoRoot, '.tmp', 'issue-199', 'sam-smoke');

function assert(condition, message) {
  if (!condition) throw new Error(`SAM parity smoke failed: ${message}`);
}

function cookiePair(response) {
  const cookies = typeof response.headers.getSetCookie === 'function'
    ? response.headers.getSetCookie()
    : [response.headers.get('set-cookie')].filter(Boolean);
  const pair = cookies.map((cookie) => cookie.split(';')[0])
    .find((cookie) => cookie.startsWith('dataops_session='));
  assert(pair, 'session endpoint did not set dataops_session');
  return pair;
}

async function jsonOk(url, options, expectedStatus = 200) {
  const response = await fetch(url, options);
  assert(response.status === expectedStatus, `${options?.method || 'GET'} ${url} returned ${response.status}`);
  return response.json();
}

async function verifyAuthenticatedRole(baseURL, role) {
  const sessionResponse = await fetch(`${baseURL}/__parity__/session?role=${role}`, { redirect: 'manual' });
  assert(sessionResponse.status === 303, `${role} session returned ${sessionResponse.status}`);
  const cookie = cookiePair(sessionResponse);
  const me = await jsonOk(`${baseURL}/work/api/me`, { headers: { cookie } });
  assert(me.user?.role === role, `${role} cookie authenticated as ${me.user?.role || 'no role'}`);

  const tasksResponse = await fetch(`${baseURL}/work/api/tasks?date=2026-08-12`, { headers: { cookie } });
  assert(tasksResponse.status === 200, `${role} protected work API returned ${tasksResponse.status}`);
  const tasks = await tasksResponse.json();
  assert(Array.isArray(tasks.tasks), `${role} work API did not return a task list`);
  assert(tasks.tasks.some((task) => task.id === 'parity-task'), `${role} work API omitted parity-task`);
  return { role, userId: me.user.id, taskId: 'parity-task' };
}

async function main() {
  const manifest = readValidManifest(samSource);
  assert(manifest, `valid SAM artifact is missing; run make sam-build first: ${samSource}`);

  rmSync(smokeRoot, { recursive: true, force: true });
  mkdirSync(smokeRoot, { recursive: true });
  const runRoot = mkdtempSync(join(smokeRoot, 'run-'));
  const artifact = join(runRoot, 'artifact');
  let server;
  try {
    copyIsolatedArtifact(samSource, artifact, { allowedBoundary: runRoot });
    server = await launchParityTarget({
      mode: 'sam',
      root: artifact,
      cacheRoot: join(runRoot, 'docs-cache'),
    });

    const healthResponse = await fetch(`${server.baseURL}/__parity__/health`);
    assert(healthResponse.status === 200, `health returned ${healthResponse.status}`);
    const health = await healthResponse.json();
    assert(health.ready === true && health.target === 'sam', `unexpected health payload: ${JSON.stringify(health)}`);

    const reset = await jsonOk(`${server.baseURL}/__parity__/reset`, { method: 'POST' });
    assert(reset.reset === true && reset.count === 10, `unexpected reset payload: ${JSON.stringify(reset)}`);

    const admin = await verifyAuthenticatedRole(server.baseURL, 'admin');
    const operator = await verifyAuthenticatedRole(server.baseURL, 'operator');
    console.log(JSON.stringify({
      result: 'pass',
      artifact: 'copied SAM artifact with verified integrity manifest',
      health,
      reset,
      authenticatedWorkApi: [admin, operator],
    }, null, 2));
  } finally {
    if (server) await server.close();
    rmSync(runRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
