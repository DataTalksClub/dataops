import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { getDocument } from '../db/documents';
import { DOCX_CONTENT_TYPE, markdownToDocx } from '../docs/docxExport';
import type { LambdaEvent, LambdaResponse } from '../types';

/** Called by the documents router after its work-read authorization check. */
export async function handleDocumentExportRoutes(event: LambdaEvent, client: DynamoDBDocumentClient): Promise<LambdaResponse | null> {
  const match = /^\/api\/documents\/([^/]+)\/export\/?$/.exec(event.path || '');
  if (!match) return null;
  const json = (statusCode: number, error: string): LambdaResponse => ({ statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ error }) });
  if ((event.httpMethod || 'GET') !== 'GET') return json(405, 'Method not allowed');
  const format = event.queryStringParameters?.format || 'md';
  if (!['md', 'txt', 'docx'].includes(format)) return json(400, 'format must be md, docx, or txt');
  const document = await getDocument(client, decodeURIComponent(match[1]));
  if (!document) return json(404, 'Document not found');
  const body = format === 'docx' ? (await markdownToDocx(document.content)).toString('base64') : document.content;
  return {
    statusCode: 200,
    headers: {
      'Content-Type': format === 'docx' ? DOCX_CONTENT_TYPE : format === 'txt' ? 'text/plain; charset=utf-8' : 'text/markdown; charset=utf-8',
      'Content-Disposition': `attachment; filename="document.${format}"`,
      'Cache-Control': 'no-store',
    },
    body,
    ...(format === 'docx' ? { isBase64Encoded: true } : {}),
  };
}
