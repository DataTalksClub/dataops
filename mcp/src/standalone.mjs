#!/usr/bin/env node
/** Start the standalone DataOps MCP proxy: `node src/standalone.mjs [--port N] [--bind ADDR] [--upstream URL]`. */
import { startProxyServer } from './proxy.mjs';

const args = process.argv.slice(2);
function flag(name, fallback) {
  const hit = args.find((a) => a === name || a.startsWith(`${name}=`));
  if (!hit) return fallback;
  if (hit.includes('=')) return hit.slice(name.length + 1);
  const next = args[args.indexOf(hit) + 1];
  return next && !next.startsWith('--') ? next : fallback;
}

const port = Number(flag('--port', process.env.MCP_PORT || '8080'));
const bind = flag('--bind', process.env.MCP_BIND || '127.0.0.1');
const upstreamBase = (flag('--upstream', process.env.DATAOPS_URL || 'https://ops.dtcdev.click') || '').replace(/\/$/, '');

const server = await startProxyServer({ port, bind, upstreamBase });
const address = server.address();
console.log(`dataops-mcp listening on ${address.address}:${address.port} -> ${upstreamBase}`);
