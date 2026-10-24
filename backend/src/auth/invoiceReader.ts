import { createHash, timingSafeEqual } from 'crypto';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import type { LambdaEvent, LambdaResponse } from '../types';
import { handleInvoiceRoutes } from '../routes/invoices';
import { handleSponsorCrmRoutes } from '../routes/sponsorCrm';
import { handleCrmWorkspaceRoutes } from '../routes/crmWorkspace';
import { handleSponsorLeadRoutes } from '../routes/sponsorLeads';
import { handleSponsorNewsletterRoutes } from '../routes/sponsorNewsletters';
import { handleSponsorCommunicationRoutes } from '../routes/sponsorCommunications';
import { handleSponsorFinanceRoutes } from '../routes/sponsorFinance';
import { handleTaskRoutes } from '../routes/tasks';
import { resolveDefaultAssigneeId } from '../db/workspaceSettings';
import { listUsers } from '../db/users';
import { handleMcp } from '../mcp';

const PRINCIPAL = { id: 'invoice-reader', scopes: ['invoices:read', 'crm:read', 'crm:write'], expiresAt: null };
const response = (statusCode: number, body: unknown): LambdaResponse => ({
  statusCode, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  body: JSON.stringify(body),
});

export function isSponsorCommunicationRoute(pathname: string): boolean {
  const prefix = '/api/sponsor-crm/';
  if (!pathname.startsWith(prefix)) return false;
  const segments = pathname.slice(prefix.length).split('/');
  if (segments.some((segment) => segment.length === 0)) return false;

  const [family] = segments;
  if (family === 'deals') {
    return segments.length === 3 && segments[2] === 'communications';
  }
  if (family === 'communication-suggestions') {
    return segments.length === 3 && segments[2] === 'drafts';
  }
  if (family === 'contacts') {
    return segments.length === 3 && segments[2] === 'suppressions';
  }
  if (family !== 'communications') return false;
  return true;
}

async function handleSponsorRoute(
  reqPath: string,
  method: string,
  event: LambdaEvent,
  client: DynamoDBDocumentClient,
): Promise<LambdaResponse> {
  if (reqPath === '/api/sponsor-crm/leads' || reqPath.startsWith('/api/sponsor-crm/leads/')) {
    return await handleSponsorLeadRoutes(reqPath, method, event, client);
  }
  if (/^\/api\/sponsor-crm\/(directory|views|activity|notes)(\/|$)/.test(reqPath)) {
    const workspace = await handleCrmWorkspaceRoutes(reqPath, method, event, client);
    if (workspace) return workspace;
  }
  if (reqPath === '/api/sponsor-crm/newsletters' || reqPath.startsWith('/api/sponsor-crm/newsletters/')) {
    return await handleSponsorNewsletterRoutes(reqPath, method, event, client);
  }
  if (isSponsorCommunicationRoute(reqPath)) {
    return await handleSponsorCommunicationRoutes(reqPath, method, event, client);
  }
  const finance = await handleSponsorFinanceRoutes(reqPath, method, event, client);
  if (finance) return finance;
  return await handleSponsorCrmRoutes(reqPath, method, event, client);
}

async function resolveServiceActorId(client: DynamoDBDocumentClient): Promise<string> {
  const defaultId = await resolveDefaultAssigneeId(client);
  if (defaultId) return defaultId;
  const users = await listUsers(client);
  const activeUser = users.find((u) => !u.disabled && (u.role === 'admin' || u.role === 'operator'));
  return activeUser ? activeUser.id : 'service-agent';
}

/** A deployment-managed service credential never becomes an interactive user. */
export async function handleInvoiceReader(
  event: LambdaEvent, client: DynamoDBDocumentClient,
): Promise<LambdaResponse | null> {
  const header = Object.entries(event.headers || {}).find(([key]) => key.toLowerCase() === 'authorization')?.[1] || '';
  const token = /^Bearer\s+(\S+)$/i.exec(header)?.[1] || '';
  if (!token.startsWith('dops_svc_')) return null;
  const configured = process.env.INVOICE_READER_TOKEN_SHA256 || '';
  if (!/^dops_svc_[a-f0-9]{64}$/.test(token) || !/^[a-f0-9]{64}$/.test(configured)
    || !timingSafeEqual(createHash('sha256').update(token).digest(), Buffer.from(configured, 'hex'))) {
    return response(401, { error: 'Unauthorized' });
  }
  let path = event.path || '/';
  if (path.startsWith('/work/')) path = path.slice(5);
  if (path === '/work') path = '/';
  const cleanPath = path.split('?')[0];
  const method = (event.httpMethod || 'GET').toUpperCase();

  if (method === 'GET' && cleanPath === '/api/me') return response(200, { service: PRINCIPAL });

  // Authenticate the MCP envelope with the same service credential. Each
  // tool call re-enters this gate, retaining the exact API route restrictions
  // below; a service never becomes an interactive user through MCP.
  if (cleanPath === '/mcp') {
    return handleMcp(
      event, client,
      async (subEvent) => await handleInvoiceReader(subEvent, client) ?? response(401, { error: 'Unauthorized' }),
      { serviceAuthenticated: true },
    );
  }

  const isInvoiceAllowed = cleanPath === '/api/bookkeeping/invoices' || cleanPath === '/api/bookkeeping/invoices/readiness'
    || /^\/api\/bookkeeping\/invoices\/[a-f0-9]{64}(?:\/document)?$/.test(cleanPath);
  if (isInvoiceAllowed) {
    if (method !== 'GET') return response(403, { error: 'Service credential permits invoice reads only' });
    return handleInvoiceRoutes(cleanPath, 'GET', event, client, true);
  }

  const isCrmAllowed = cleanPath.startsWith('/api/sponsor-crm/');
  const isTaskAllowed = cleanPath === '/api/tasks' || cleanPath.startsWith('/api/tasks/');

  if (isCrmAllowed || isTaskAllowed) {
    const actorId = await resolveServiceActorId(client);
    if (!event.headers) event.headers = {};
    event.headers['x-user-id'] = actorId;
    if (isCrmAllowed) {
      return await handleSponsorRoute(cleanPath, method, event, client);
    }
    return await handleTaskRoutes(cleanPath, method, event, client);
  }

  return response(403, { error: 'Service credential permits invoice reads and CRM operations only' });
}
