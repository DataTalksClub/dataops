// IMPORTANT: Set NODE_ENV=test BEFORE any src/ imports so dynalite uses
// memdown (in-memory, no .data/ directory written to disk).
process.env.NODE_ENV = 'test';
process.env.IS_LOCAL = 'true';

import http from 'http';
import { URL } from 'url';
import { handler } from '../src/handler';
import { getClient } from '../src/db/client';
import { createBrowserSession } from '../src/db/sessions';
import { createUserWithId } from '../src/db/users';
import { seed as seedUsers } from './seed-users';
import { seed as seedTemplates } from './seed-templates';
import type { LambdaEvent } from '../src/types';

const PORT = parseInt(process.env.PORT || '3001', 10);
let e2eBrowserSessionToken = '';
type E2eRouteFault = {
  method?: string;
  path: string;
  query?: Record<string, string>;
  status?: number;
  delayMs?: number;
  remaining?: number;
};
let e2eRouteFaults: E2eRouteFault[] = [];

function matchesRouteFault(fault: E2eRouteFault, method: string, parsed: URL): boolean {
  const apiPath = parsed.pathname.replace(/^\/work(?=\/api\/)/, '');
  if ((fault.method || 'GET').toUpperCase() !== method.toUpperCase() || fault.path !== apiPath) return false;
  return Object.entries(fault.query || {}).every(([key, value]) => parsed.searchParams.get(key) === value);
}

const server = http.createServer(async (req, res) => {
  const parsed = new URL(req.url!, `http://localhost:${PORT}`);

  // Explicit opt-in seam for production-cookie browser E2E. This server is a
  // test-only executable and the opaque token is never exposed to the test.
  if (parsed.pathname === '/__e2e__/browser-session') {
    if (!e2eBrowserSessionToken) {
      res.writeHead(404);
      res.end();
      return;
    }
    res.setHeader('set-cookie', `dataops_session=${e2eBrowserSessionToken}; Path=/; HttpOnly; SameSite=Lax`);
    res.writeHead(303, { location: '/' });
    res.end();
    return;
  }

  // Collect body
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(chunk as Buffer);
  }
  // Use binary encoding for multipart requests to preserve file content
  const contentType = req.headers['content-type'] || '';
  const isMultipart = contentType.includes('multipart/form-data');
  const body = chunks.length > 0
    ? Buffer.concat(chunks).toString(isMultipart ? 'binary' : 'utf-8')
    : null;

  // Deterministic server-side faults for route E2E. Requests still traverse
  // the browser, HTTP server, and real handler; a delay falls through to the
  // handler, while an explicit status proves non-404 transport failures.
  if (parsed.pathname === '/__e2e__/route-faults') {
    if (req.method === 'DELETE') e2eRouteFaults = [];
    else if (req.method === 'POST') {
      const payload = body ? JSON.parse(body) : {};
      e2eRouteFaults = Array.isArray(payload.faults)
        ? payload.faults.map((fault: E2eRouteFault) => ({ ...fault, remaining: fault.remaining ?? 1 }))
        : [];
    } else {
      res.writeHead(405, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'Method not allowed' }));
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ faults: e2eRouteFaults.length }));
    return;
  }

  const fault = e2eRouteFaults.find((candidate) => matchesRouteFault(candidate, req.method || 'GET', parsed) && (candidate.remaining ?? 1) > 0);
  if (fault) {
    fault.remaining = (fault.remaining ?? 1) - 1;
    if (fault.delayMs) await new Promise((resolve) => setTimeout(resolve, fault.delayMs));
    if (fault.status) {
      res.writeHead(fault.status, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: `Synthetic route failure (${fault.status})` }));
      return;
    }
  }

  // Build query string parameters
  const queryStringParameters: Record<string, string> = {};
  for (const [key, value] of parsed.searchParams.entries()) {
    queryStringParameters[key] = value;
  }

  // Build Lambda-style event
  const event: LambdaEvent = {
    httpMethod: req.method!,
    path: parsed.pathname,
    headers: req.headers as Record<string, string>,
    body: body,
    queryStringParameters:
      Object.keys(queryStringParameters).length > 0
        ? queryStringParameters
        : null,
  };

  try {
    const result = await handler(event, {});

    // Set response headers
    if (result.headers) {
      for (const [key, value] of Object.entries(result.headers)) {
        res.setHeader(key, value);
      }
    }

    res.writeHead(result.statusCode);
    // If Content-Disposition is set, treat the body as binary
    const hasDownload = result.headers?.['Content-Disposition'];
    if (hasDownload && result.body) {
      res.end(Buffer.from(result.body, 'binary'));
    } else {
      res.end(result.body || '');
    }
  } catch (err: unknown) {
    console.error('Handler error:', err);
    res.writeHead(500);
    res.end(JSON.stringify({ error: 'Internal server error' }));
  }
});

// Seed users and templates before starting the server
async function runSeeds() {
  try {
    await seedUsers();
    await seedTemplates();
    const browserUserId = process.env.E2E_BROWSER_SESSION_USER_ID;
    if (browserUserId) {
      if (process.env.E2E_BROWSER_SESSION_USER_ROLE) {
        await createUserWithId(await getClient(), browserUserId, {
          name: 'E2E browser actor',
          email: 'browser-actor@example.test',
          role: process.env.E2E_BROWSER_SESSION_USER_ROLE === 'admin' ? 'admin' : 'operator',
        });
      }
      const session = await createBrowserSession(await getClient(), browserUserId, { lifetimeSeconds: 3600 });
      e2eBrowserSessionToken = session.token;
    }
    console.log('Test server seed data initialized.');
  } catch (err) {
    console.error('Seed error (non-fatal):', err);
  }
}

export async function start(): Promise<void> {
  await runSeeds();
  return new Promise((resolve) => {
    server.listen(PORT, () => {
      console.log(`Test server listening at http://localhost:${PORT}`);
      resolve();
    });
  });
}

export async function stop(): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((err) => {
      if (err) return reject(err);
      resolve();
    });
  });
}

// Allow running directly (e.g. tsx scripts/test-server.ts)
if (require.main === module) {
  runSeeds().then(() => {
    server.listen(PORT, () => {
      console.log(`Test server listening at http://localhost:${PORT}`);
    });
  });

  process.on('SIGINT', () => {
    console.log('\nShutting down test server...');
    server.close(() => {
      process.exit(0);
    });
  });

  process.on('SIGTERM', () => {
    server.close(() => {
      process.exit(0);
    });
  });
}
