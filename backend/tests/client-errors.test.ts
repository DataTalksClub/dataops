import { describe, it } from 'node:test';
import assert from 'node:assert';

import { handleClientErrorRoute, isClientErrorReport } from '../src/routes/clientErrors';
import type { LambdaEvent } from '../src/types';

function event(body: unknown, ip = '203.0.113.9'): LambdaEvent {
  return { headers: { 'x-forwarded-for': ip, 'user-agent': 'test-agent' }, body: JSON.stringify(body) } as unknown as LambdaEvent;
}

function captureErrors(run: () => void): string[] {
  const lines: string[] = [];
  const original = console.error;
  console.error = (line: string) => { lines.push(line); };
  try { run(); } finally { console.error = original; }
  return lines;
}

describe('client error reports', () => {
  it('matches only POST /api/client-errors', () => {
    assert.ok(isClientErrorReport('POST', '/api/client-errors'));
    assert.ok(!isClientErrorReport('GET', '/api/client-errors'));
  });

  it('logs one structured ERROR line without query strings', () => {
    let status = 0;
    let body: string | undefined;
    const lines = captureErrors(() => {
      const response = handleClientErrorRoute(event({ surface: 'sponsor-doc', check: 'GET /api/sponsor-docs', status: 503, message: 'x', page: '/sponsor-docs/sdoc-1?code=SECRET' }, '198.51.100.1'));
      status = response.statusCode;
      body = response.body;
    });
    assert.equal(status, 200, 'not 204: Chromium reports a 204 POST as ERR_ABORTED');
    assert.equal(body, '{}');
    assert.equal(lines.length, 1);
    const entry = JSON.parse(lines[0]);
    assert.equal(entry.event, 'client_check_failed');
    assert.equal(entry.level, 'ERROR');
    assert.equal(entry.page, '/sponsor-docs/sdoc-1');
    assert.ok(!lines[0].includes('SECRET'));
  });

  it('throttles one address and rejects invalid JSON', () => {
    const codes: number[] = [];
    captureErrors(() => { for (let i = 0; i < 12; i += 1) codes.push(handleClientErrorRoute(event({ surface: 's' }, '198.51.100.2')).statusCode); });
    assert.equal(codes.filter((c) => c === 429).length, 2);
    assert.equal(handleClientErrorRoute({ headers: {}, body: '{' } as unknown as LambdaEvent).statusCode, 400);
  });
});
