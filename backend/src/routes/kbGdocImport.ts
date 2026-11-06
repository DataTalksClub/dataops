/**
 * `POST /api/kb/import-gdoc`: fetch a Google Docs document through the Dapier
 * broker and hand its plain-text export to the caller for KB import.
 *
 * The backend only fetches; converting to a KB document and saving it stays
 * with the CLI (`dataops kb import-gdoc`), which reuses the existing
 * `kb import` conversion and publication flow. Guarded behind work-admin
 * auth because it performs an external fetch on the operator's behalf.
 */

import { fetchGdocExport, gdocSourceUrl, isGdocId } from '../knowledgeGdoc';
import { resolveInteractiveActor, workAdminForbidden } from '../identity/actor';
import { json, parseJsonObjectEventOrEmpty } from '../http';
import { recordRequestError } from '../requestErrorLog';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import type { LambdaEvent, LambdaResponse } from '../types';

const PATH = '/api/kb/import-gdoc';

/** Accepts a bare document id or a docs.google.com document URL. */
function parseDocId(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const value = raw.trim();
  if (!value) return null;
  const urlMatch = value.match(/^https:\/\/docs\.google\.com\/document\/d\/([A-Za-z0-9_-]+)(?:\/|$)/);
  const docId = urlMatch ? urlMatch[1] : value;
  return isGdocId(docId) ? docId : null;
}

export async function handleKbGdocImportRoutes(
  path: string,
  method: string,
  event: LambdaEvent,
  client: DynamoDBDocumentClient,
): Promise<LambdaResponse | null> {
  if (path !== PATH) return null;
  if (method !== 'POST') return json(405, { error: 'Method not allowed' });

  const resolution = await resolveInteractiveActor(client, event, 'work-write');
  if (!resolution.ok) return resolution.response;
  if (!resolution.actor.isAdmin) return workAdminForbidden('Importing a Google Docs document requires an admin');

  try {
    const body = parseJsonObjectEventOrEmpty(event) ?? {};
    const docId = parseDocId(body.docId ?? body.source);
    if (!docId) return json(400, { error: 'docId must be a Google Docs document id or https://docs.google.com/document/d/<id> URL' });
    if (body.connectionId !== undefined && (typeof body.connectionId !== 'string' || body.connectionId.length > 200)) {
      return json(400, { error: 'connectionId must be a short string naming a Dapier Google connection' });
    }

    const result = await fetchGdocExport(
      { connectionId: typeof body.connectionId === 'string' ? body.connectionId : undefined },
      docId,
    );
    if (result.problem) return json(502, { error: result.problem, code: 'gdoc-fetch-failed', docId });
    return json(200, {
      docId,
      source: gdocSourceUrl(docId),
      content: result.content,
      sha256: result.sha256,
      sizeBytes: result.sizeBytes,
    });
  } catch (error: unknown) {
    recordRequestError(error);
    return json(500, { error: 'Internal server error' });
  }
}
