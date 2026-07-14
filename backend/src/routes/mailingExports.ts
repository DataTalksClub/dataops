import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import {
  listMailingExports,
  loadMailingExportConfigs,
  publicMailingExportConfigs,
  runMailingExport,
} from '../mailingExports/service';
import type { MailingExportJob } from '../mailingExports/types';
import type { LambdaEvent, LambdaResponse } from '../types';

const headers = { 'Content-Type': 'application/json' };
const response = (statusCode: number, body: unknown): LambdaResponse => ({ statusCode, headers, body: JSON.stringify(body) });

function publicJob(job: MailingExportJob): Omit<MailingExportJob, 'leaseOwner' | 'leaseExpiresAt'> {
  const { leaseOwner: _leaseOwner, leaseExpiresAt: _leaseExpiresAt, ...safe } = job;
  return safe;
}

export async function handleMailingExportRoutes(path: string, method: string, event: LambdaEvent, client: DynamoDBDocumentClient): Promise<LambdaResponse | null> {
  if (path === '/api/mailing-exports' && method === 'GET') {
    const configs = loadMailingExportConfigs();
    return response(200, { configs: publicMailingExportConfigs(configs), exports: (await listMailingExports(client)).map(publicJob) });
  }
  if (path === '/api/mailing-exports/run' && method === 'POST') {
    let body: Record<string, unknown> = {};
    try { body = event.body ? JSON.parse(String(event.body)) : {}; } catch { return response(400, { error: 'Invalid JSON body' }); }
    const configId = String(body.configId || '');
    const config = loadMailingExportConfigs().find(item => item.id === configId);
    if (!config) return response(404, { error: 'Mailing export configuration not found' });
    const runKey = typeof body.runKey === 'string' && body.runKey ? body.runKey : new Date().toISOString().slice(0, 10);
    if (runKey.length > 120 || !/^[a-zA-Z0-9._:-]+$/.test(runKey)) return response(400, { error: 'runKey must use 1-120 letters, numbers, dot, colon, underscore, or dash' });
    const job = await runMailingExport(client, config, runKey);
    return response(job.status === 'failed' ? 502 : job.status === 'completed' ? 200 : 202, { export: publicJob(job) });
  }
  return null;
}
