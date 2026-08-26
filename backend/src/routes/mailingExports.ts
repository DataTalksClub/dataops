import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import {
  listMailingExportsPage,
} from '../db/mailingExports';
import {
  loadMailingExportConfigs,
  publicMailingExportConfigs,
  runMailingExport,
  type MailingExportDependencies,
} from '../mailingExports/service';
import { CollectionCursorError, encodeCollectionCursor } from '../db/collectionPagination';
import { resolveInteractiveActor } from '../identity/actor';
import type { MailingExportJob } from '../mailingExports/types';
import type { LambdaEvent, LambdaResponse } from '../types';

const headers = { 'Content-Type': 'application/json' };
const response = (statusCode: number, body: unknown): LambdaResponse => ({ statusCode, headers, body: JSON.stringify(body) });
let mailingExportDependencies: MailingExportDependencies = {};

export function setMailingExportDependenciesForTests(dependencies: MailingExportDependencies): void {
  mailingExportDependencies = dependencies;
}

function publicJob(job: MailingExportJob): Omit<MailingExportJob, 'leaseOwner' | 'leaseExpiresAt'> {
  const { leaseOwner: _leaseOwner, leaseExpiresAt: _leaseExpiresAt, ...safe } = job;
  return safe;
}

export async function handleMailingExportRoutes(path: string, method: string, event: LambdaEvent, client: DynamoDBDocumentClient): Promise<LambdaResponse | null> {
  if (path === '/api/mailing-exports' && method === 'GET') {
    try {
      const configs = loadMailingExportConfigs();
      const viewer = await resolveInteractiveActor(client, event, 'work-read');
      if (!viewer.ok) return response(viewer.response.statusCode, JSON.parse(viewer.response.body));
      const pagination = event.queryStringParameters || {};
      const binding = {
        collection: 'mailing-exports',
        filters: {},
        principal: viewer.actor.id || 'test-bypass',
      };
      const page = await listMailingExportsPage(client, binding, pagination);
      const items = page.items.map(publicJob);
      return response(200, {
        configs: publicMailingExportConfigs(configs),
        exports: {
          items,
          ...(page.nextExclusiveStartKey ? {
            nextCursor: await encodeCollectionCursor(binding, page.nextExclusiveStartKey),
          } : {}),
        },
      });
    } catch (error) {
      if (error instanceof CollectionCursorError) {
        return response(400, { error: 'Invalid pagination input', code: 'invalid_pagination_input' });
      }
      throw error;
    }
  }
  if (path === '/api/mailing-exports/run' && method === 'POST') {
    let body: Record<string, unknown> = {};
    try { body = event.body ? JSON.parse(String(event.body)) : {}; } catch { return response(400, { error: 'Invalid JSON body' }); }
    const configId = String(body.configId || '');
    const config = loadMailingExportConfigs().find(item => item.id === configId);
    if (!config) return response(404, { error: 'Mailing export configuration not found' });
    const runKey = typeof body.runKey === 'string' && body.runKey ? body.runKey : new Date().toISOString().slice(0, 10);
    if (runKey.length > 120 || !/^[a-zA-Z0-9._:-]+$/.test(runKey)) return response(400, { error: 'runKey must use 1-120 letters, numbers, dot, colon, underscore, or dash' });
    const job = await runMailingExport(client, config, runKey, mailingExportDependencies);
    return response(job.status === 'failed' ? 502 : job.status === 'completed' ? 200 : 202, { export: publicJob(job) });
  }
  return null;
}
