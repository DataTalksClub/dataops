import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import type { LambdaEvent, LambdaResponse } from '../types';
import { getBookkeepingItem, listBookkeepingItems, putBookkeepingItem } from '../db/bookkeeping';
import { json as response, parse } from './bookkeepingShared';
import { invoiceTotal, renderInvoice, validateTemplate, validateValues } from '../invoiceGeneration/pdf';

const base = '/api/bookkeeping/invoice-generation';
const json = (status: number, value: unknown): LambdaResponse => {
  const result = response(status, value);
  result.headers = { ...result.headers, 'Cache-Control': 'no-store' };
  return result;
};
export async function handleInvoiceGenerationRoutes(path: string, method: string, event: LambdaEvent, client: DynamoDBDocumentClient): Promise<LambdaResponse | null> {
  if (!path.startsWith(base)) return null;
  try {
    if (path === `${base}/templates` && method === 'GET')
      return json(200, { items: await listBookkeepingItems(client, 'invoice-template') });
    const body = parse(event.body || null);
    if (path === `${base}/templates` && method === 'POST') {
      const template = validateTemplate(body);
      return json(201, (await putBookkeepingItem(client, 'invoice-template', { template, name: template.name })).item);
    }
    if (path === `${base}/render` && method === 'POST') {
      if (!body || typeof body.templateId !== 'string' || !/^[a-f0-9-]{36}$/.test(body.templateId)) return json(400, { error: 'Valid templateId required' });
      const record = await getBookkeepingItem(client, 'invoice-template', body.templateId);
      if (!record) return json(404, { error: 'Invoice template not found' });
      const template = validateTemplate(record.template), values = validateValues(body);
      const pdf = await renderInvoice(template, values);
      return json(200, {
        filename: `invoice-${values.invoiceNumber.replace(/[^a-zA-Z0-9_-]/g, '_')}.pdf`,
        contentType: 'application/pdf', contentBase64: Buffer.from(pdf).toString('base64'),
        total: invoiceTotal(values), currency: template.currency,
      });
    }
    return json(404, { error: 'Not found' });
  } catch (error) {
    // Validation happens before storage/rendering. Operational errors retain their original failure.
    if (error instanceof Error && /^(Invalid |Expected |Use |Currency |Item amounts|.*contains characters)/.test(error.message)) return json(400, { error: error.message });
    throw error;
  }
}
