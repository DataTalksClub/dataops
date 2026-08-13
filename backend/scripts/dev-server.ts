import http from 'node:http';
import https from 'node:https';
import type { ClientRequest, RequestOptions } from 'node:http';
import type { LambdaEvent, LambdaResponse } from '../src/types';

const PORT = parsePort(process.env.PORT || '3001');
const HOST = process.env.DATAOPS_DEV_BACKEND_HOST || '127.0.0.1';
const REPRESENTATIVE_MODE = process.env.DATAOPS_DEV_REPRESENTATIVE_MODE === 'true';
const SEED_MODE = process.env.DATAOPS_DEV_SEED_MODE || 'default';
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

function parsePort(value: string): number {
  if (!/^\d+$/.test(value)) throw new Error('PORT must be a numeric TCP port');
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be between 1 and 65535');
  return port;
}

function assertLoopbackListener(): void {
  if (!LOOPBACK_HOSTS.has(HOST)) throw new Error('Development backend host must be loopback');
  if (SEED_MODE !== 'default' && SEED_MODE !== 'none') {
    throw new Error('DATAOPS_DEV_SEED_MODE must be default or none');
  }
  if (REPRESENTATIVE_MODE && SEED_MODE !== 'none') {
    throw new Error('Representative mode requires DATAOPS_DEV_SEED_MODE=none');
  }
}

function requestHostname(input: string | URL | RequestOptions): string {
  if (typeof input === 'string' || input instanceof URL) {
    return new URL(input).hostname;
  }
  const raw = input.hostname || input.host || '';
  if (raw === '::1' || raw === '[::1]') return '::1';
  if (raw.startsWith('[')) return raw.slice(1, raw.indexOf(']'));
  return raw.split(':')[0];
}

function assertLoopbackTarget(input: string | URL | RequestOptions): void {
  const hostname = requestHostname(input);
  if (!LOOPBACK_HOSTS.has(hostname)) {
    throw new Error('External network access is disabled for the local representative replica');
  }
}

function installRepresentativeNetworkGuard(): void {
  if (!REPRESENTATIVE_MODE) return;

  const originalFetch = globalThis.fetch.bind(globalThis);
  globalThis.fetch = ((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const target = input instanceof Request ? input.url : input;
    assertLoopbackTarget(target as string | URL);
    return originalFetch(input, init);
  }) as typeof fetch;

  const mutableHttp = http as unknown as {
    request: typeof http.request;
    get: typeof http.get;
  };
  const mutableHttps = https as unknown as {
    request: typeof https.request;
    get: typeof https.get;
  };
  const originalHttpRequest = http.request.bind(http);
  const originalHttpsRequest = https.request.bind(https);

  mutableHttp.request = ((...args: Parameters<typeof http.request>): ClientRequest => {
    assertLoopbackTarget(args[0] as string | URL | RequestOptions);
    return originalHttpRequest(...args);
  }) as typeof http.request;
  mutableHttp.get = ((...args: Parameters<typeof http.get>): ClientRequest => {
    const request = mutableHttp.request(...args as Parameters<typeof http.request>);
    request.end();
    return request;
  }) as typeof http.get;
  mutableHttps.request = ((...args: Parameters<typeof https.request>): ClientRequest => {
    assertLoopbackTarget(args[0] as string | URL | RequestOptions);
    return originalHttpsRequest(...args);
  }) as typeof https.request;
  mutableHttps.get = ((...args: Parameters<typeof https.get>): ClientRequest => {
    const request = mutableHttps.request(...args as Parameters<typeof https.request>);
    request.end();
    return request;
  }) as typeof https.get;
}

function queryParameters(parsed: URL): Record<string, string> | null {
  const parameters: Record<string, string> = {};
  for (const [key, value] of parsed.searchParams.entries()) parameters[key] = value;
  return Object.keys(parameters).length > 0 ? parameters : null;
}

function writeLambdaResponse(response: http.ServerResponse, result: LambdaResponse): void {
  if (result.headers) {
    for (const [key, value] of Object.entries(result.headers)) response.setHeader(key, value);
  }
  response.writeHead(result.statusCode);
  if (!result.body) {
    response.end();
  } else if (result.isBase64Encoded) {
    response.end(Buffer.from(result.body, 'base64'));
  } else if (result.headers?.['Content-Disposition'] || result.headers?.['content-disposition']) {
    response.end(Buffer.from(result.body, 'binary'));
  } else {
    response.end(result.body);
  }
}

assertLoopbackListener();
installRepresentativeNetworkGuard();

async function main(): Promise<void> {
  const [{ setupLocalEnvironment }, { stopLocal }] = await Promise.all([
    import('./setup-local'),
    import('./local-dynamodb'),
  ]);

  if (!process.env.DYNAMODB_ENDPOINT) {
    await setupLocalEnvironment({ persistent: true, seed: SEED_MODE === 'default' });
  } else if (SEED_MODE === 'default') {
    const [{ seed: seedUsers }, { seed: seedTemplates }, { seed: seedRecurring }] = await Promise.all([
      import('./seed-users'),
      import('./seed-templates'),
      import('./seed-recurring'),
    ]);
    await seedUsers();
    await seedTemplates();
    await seedRecurring();
  }

  const { handler } = await import('../src/handler');

  const server = http.createServer(async (request, response) => {
    const parsed = new URL(request.url || '/', `http://${HOST}:${PORT}`);
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk as Uint8Array));
    const contentType = request.headers['content-type'] || '';
    const multipart = contentType.includes('multipart/form-data');
    const textual = /^(?:application\/(?:json|[^;]+\+json|x-www-form-urlencoded|xml)|text\/)/i.test(contentType);
    const bytes = chunks.length > 0 ? Buffer.concat(chunks) : null;
    const base64Body = Boolean(bytes && !multipart && !textual);
    const body = bytes
      ? bytes.toString(base64Body ? 'base64' : multipart ? 'binary' : 'utf8')
      : null;
    const headers = Object.fromEntries(
      Object.entries(request.headers)
        .filter((entry): entry is [string, string | string[]] => entry[1] !== undefined)
        .map(([key, value]) => [key, Array.isArray(value) ? value.join(', ') : value]),
    );
    if (REPRESENTATIVE_MODE) {
      delete headers.authorization;
      delete headers.cookie;
      delete headers['x-user-id'];
    }
    const event: LambdaEvent = {
      httpMethod: request.method || 'GET',
      path: parsed.pathname,
      headers,
      body,
      isBase64Encoded: base64Body,
      queryStringParameters: queryParameters(parsed),
    };

    try {
      const result = await handler(event, {}) as LambdaResponse;
      writeLambdaResponse(response, result);
    } catch (error) {
      console.error('Handler error:', error);
      response.writeHead(500, { 'content-type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify({ error: 'Internal server error' }));
    }
  });

  let stopping = false;
  async function shutdown(signal: string): Promise<void> {
    if (stopping) return;
    stopping = true;
    console.log(`Received ${signal}; shutting down development backend.`);
    const forced = setTimeout(() => {
      server.closeAllConnections();
    }, 2_000);
    forced.unref();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    clearTimeout(forced);
    await stopLocal();
  }

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      void shutdown(signal)
        .then(() => { process.exitCode = 0; })
        .catch((error) => {
          console.error('Development backend shutdown failed:', error);
          process.exitCode = 1;
        });
    });
  }

  if (SEED_MODE === 'none') console.log('Seed mode none; existing local tables are unchanged.');
  try {
    await new Promise<void>((resolve, reject) => {
      const startupError = (error: Error) => reject(error);
      server.once('error', startupError);
      server.listen(PORT, HOST, () => {
        server.off('error', startupError);
        console.log(`Development backend ready on http://${HOST}:${PORT}`);
        resolve();
      });
    });
  } catch (error) {
    await stopLocal();
    throw error;
  }

  server.on('error', (error) => {
    console.error(`Development backend failed on ${HOST}:${PORT}:`, error);
    void shutdown('server error').finally(() => {
      process.exitCode = 1;
    });
  });
}

void main().catch((error) => {
  console.error('Development backend startup failed:', error);
  process.exitCode = 1;
});
