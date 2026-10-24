/** Lambda Function URL adapter for the standalone DataOps MCP server. */
import { Readable } from 'node:stream';
import { createProxyHandler } from './proxy.mjs';

export function createLambdaHandler({ upstreamBase }) {
  const proxy = createProxyHandler({ upstreamBase });
  return async (event) => {
    const body = typeof event.body === 'string' ? event.body : '';
    const request = Readable.from([
      Buffer.from(body, event.isBase64Encoded ? 'base64' : 'utf8'),
    ]);
    request.method = event.requestContext?.http?.method || 'GET';
    request.url = event.rawPath || '/';
    if (event.rawQueryString) request.url += `?${event.rawQueryString}`;
    request.headers = Object.fromEntries(
      Object.entries(event.headers || {}).map(([name, value]) => [name.toLowerCase(), value]),
    );
    let response;
    try {
      await proxy(request, {
        writeHead(statusCode, headers = {}) {
          response = { statusCode, headers, body: '', isBase64Encoded: false };
        },
        end(value = '') {
          response.body = String(value);
        },
      });
      return response;
    } finally {
      request.destroy();
    }
  };
}

export async function handler(event) {
  return createLambdaHandler({ upstreamBase: process.env.DATAOPS_URL })(event);
}
