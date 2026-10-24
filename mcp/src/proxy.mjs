/**
 * Standalone DataOps MCP proxy.
 *
 * Speaks MCP Streamable HTTP (stateless, JSON responses) on POST /mcp and
 * forwards tool calls to a DataOps portal (`--upstream`, default
 * DATAOPS_URL) using the caller's own `Authorization: Bearer` DataOps
 * credential. The proxy never mints, stores or logs credentials: the token
 * is validated against upstream `/api/me` on every MCP request and then
 * forwarded unchanged.
 *
 * Auth is the DataOps auth: run `dataops login` (device flow, browser
 * approval) and present the resulting API token as the Bearer token.
 */
import { createServer } from 'node:http';
import { GUIDE, SERVER_INFO, TOOL_DEFINITIONS, validateRoute } from './tools.mjs';

const MAX_BODY_BYTES = 256 * 1024;
const UPSTREAM_TIMEOUT_MS = 50_000;

function sendJson(res, status, body, extraHeaders = {}) {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...extraHeaders });
  res.end(payload);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let bytes = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      bytes += chunk.length;
      if (bytes > MAX_BODY_BYTES) {
        reject(new Error('request too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function upstreamFetch(base, route, { method = 'GET', body, token }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
  timer.unref?.();
  try {
    const res = await fetch(base + route, {
      method,
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    return { status: res.status, text, json };
  } finally {
    clearTimeout(timer);
  }
}

function rpcError(id, code, message) {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } };
}

function toolResult(id, result) {
  const text = JSON.stringify(result);
  if (Buffer.byteLength(text) > 1024 * 1024) return rpcError(id, -32603, 'Response too large');
  return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text }] } };
}

/** Validate the caller's token against upstream, return the /api/me payload. */
export async function validateCaller(upstreamBase, authorization) {
  const token = typeof authorization === 'string' && authorization.startsWith('Bearer ')
    ? authorization.slice('Bearer '.length).trim()
    : '';
  if (!token) return null;
  try {
    const me = await upstreamFetch(upstreamBase, '/api/me', { token });
    if (me.status !== 200 || !me.json) return null;
    return { token, me: me.json };
  } catch {
    return null;
  }
}

export function createProxyHandler({ upstreamBase }) {
  const base = String(upstreamBase || '').replace(/\/$/, '');
  if (!base.startsWith('http://') && !base.startsWith('https://')) throw new Error('Upstream must be an http(s) URL');

  async function callTool(name, args, token) {
    if (name === 'dataops_guide') return GUIDE;
    if (name === 'dataops_read') {
      const route = validateRoute(args?.route);
      const out = await upstreamFetch(base, route, { method: 'GET', token });
      if (out.status === 401 || out.status === 403) throw new Error('Upstream refused the credential');
      if (out.status >= 400) throw new Error(`Upstream ${out.status}`);
      return out.json ?? { raw: out.text };
    }
    if (name === 'dataops_write') {
      const method = args?.method;
      if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) throw new Error('Invalid write method');
      const route = validateRoute(args?.route);
      const out = await upstreamFetch(base, route, { method, body: args?.body ?? {}, token });
      if (out.status === 401 || out.status === 403) throw new Error('Upstream refused the credential');
      if (out.status >= 400) throw new Error(`Upstream ${out.status}`);
      return out.json ?? { raw: out.text };
    }
    throw new Error(`Unknown tool: ${name}`);
  }

  function negotiateVersion(params) {
    const offered = params?.protocolVersion;
    const supported = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
    if (typeof offered === 'string' && supported.includes(offered)) return offered;
    return '2025-11-25';
  }

  async function handleMessage(message, caller) {
    if (!message || typeof message !== 'object' || message.jsonrpc !== '2.0') {
      return rpcError(message?.id, -32600, 'Invalid JSON-RPC request');
    }
    const { id, method, params } = message;
    if (typeof method === 'string' && method.startsWith('notifications/')) return null;
    if (method === 'initialize') {
      return {
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: negotiateVersion(params),
          capabilities: { tools: {} },
          serverInfo: { ...SERVER_INFO },
        },
      };
    }
    if (method === 'ping') return { jsonrpc: '2.0', id, result: {} };
    if (method === 'tools/list') {
      return {
        jsonrpc: '2.0',
        id,
        result: {
          tools: TOOL_DEFINITIONS.map((t) => ({
            name: t.name,
            description: t.description,
            inputSchema: t.inputSchema,
            annotations: t.annotations,
          })),
        },
      };
    }
    if (method === 'tools/call') {
      const toolName = params?.name;
      if (!TOOL_DEFINITIONS.some((t) => t.name === toolName)) return rpcError(id, -32602, `Unknown tool: ${toolName}`);
      try {
        const result = await callTool(toolName, params?.arguments ?? {}, caller.token);
        return toolResult(id, result);
      } catch (error) {
        return { jsonrpc: '2.0', id, result: { isError: true, content: [{ type: 'text', text: `Operation failed: ${error.message}` }] } };
      }
    }
    return rpcError(id, -32601, `Method not found: ${method}`);
  }

  return async function requestHandler(req, res) {
    const url = new URL(req.url || '/', 'http://localhost');
    if (url.pathname === '/health' && req.method === 'GET') {
      return sendJson(res, 200, { status: 'ok', service: SERVER_INFO.name, upstream: base });
    }
    if (url.pathname !== '/mcp' && url.pathname !== '/mcp/') {
      return sendJson(res, 404, { error: 'not_found' });
    }
    if (req.method === 'GET') {
      res.writeHead(405, { Allow: 'POST', 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'method_not_allowed' }));
    }
    if (req.method !== 'POST') {
      res.writeHead(405, { Allow: 'POST', 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'method_not_allowed' }));
    }
    const caller = await validateCaller(base, req.headers.authorization);
    if (!caller) {
      return sendJson(res, 401, { error: 'Unauthorized' }, { 'WWW-Authenticate': 'Bearer realm="DataOps"' });
    }
    let raw;
    try {
      raw = await readBody(req);
    } catch {
      return sendJson(res, 413, { error: 'request_too_large' });
    }
    let message;
    try {
      message = JSON.parse(raw || 'null');
    } catch {
      return sendJson(res, 400, rpcError(null, -32700, 'Parse error'));
    }
    try {
      if (Array.isArray(message)) {
        const out = [];
        for (const item of message) {
          const r = await handleMessage(item, caller);
          if (r !== null) out.push(r);
        }
        if (!out.length) {
          res.writeHead(202);
          return res.end();
        }
        return sendJson(res, 200, out);
      }
      const response = await handleMessage(message, caller);
      if (response === null) {
        res.writeHead(202);
        return res.end();
      }
      return sendJson(res, 200, response);
    } catch {
      return sendJson(res, 500, rpcError(message?.id ?? null, -32603, 'Internal error'));
    }
  };
}

export function startProxyServer({ port = 8080, bind = '127.0.0.1', upstreamBase }) {
  const handler = createProxyHandler({ upstreamBase });
  const server = createServer(handler);
  return new Promise((resolve) => {
    server.listen(port, bind, () => resolve(server));
  });
}
