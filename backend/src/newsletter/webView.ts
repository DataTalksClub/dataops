/**
 * "View this email in your browser": the public page every newsletter links to.
 *
 * `GET /api/newsletter-view/<token>` serves the frozen payload Relay was asked
 * to send, and only once it was scheduled (the token points at nothing before
 * that, and again after a cancelled schedule). The token is an unguessable
 * per-draft id. The page is the email HTML with the per-recipient preferences
 * and unsubscribe links disabled, served without scripts.
 */
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import type { LambdaResponse } from '../types';
import { getFrozenPayload, getWebView } from './blocksStore';
import { disableAccountLinks } from './emailRender';

const VIEW_PATH = /^\/api\/newsletter-view\/([A-Za-z0-9_-]{16,64})\/?$/;

export function isAnonymousNewsletterViewRequest(method: string, path: string): boolean {
  return method.toUpperCase() === 'GET' && VIEW_PATH.test(path);
}

const HEADERS: Record<string, string> = {
  'content-type': 'text/html; charset=utf-8',
  'cache-control': 'no-store',
  'x-robots-tag': 'noindex',
  'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff',
  'content-security-policy': "default-src 'none'; img-src https: data:; style-src 'unsafe-inline'; font-src https:; base-uri 'none'; form-action 'none'",
};

function notFound(): LambdaResponse {
  return {
    statusCode: 404,
    headers: HEADERS,
    body: '<!DOCTYPE html><html><head><meta charset="utf-8"><title>Not found</title></head><body><p>This newsletter is not available.</p></body></html>',
  };
}

export async function handleNewsletterView(path: string, client: DynamoDBDocumentClient): Promise<LambdaResponse> {
  const match = VIEW_PATH.exec(path);
  if (!match) return notFound();
  const view = await getWebView(client, match[1]);
  if (!view) return notFound();
  const payload = await getFrozenPayload(client, view.issueId, view.payloadHash);
  if (!payload || payload.webViewToken !== match[1]) return notFound();
  return { statusCode: 200, headers: HEADERS, body: disableAccountLinks(payload.html) };
}
