/**
 * Google Docs export fetch for KB imports (`dataops kb import-gdoc`).
 *
 * Product path is **through Dapier**, the same broker every other Google leg
 * uses (calendar/Gmail/sheets):
 *
 *   1. A Dapier connection that holds a Google account with Drive read access
 *      is selected by connection id (request body override, else the
 *      `DATAOPS_GDOCS_CONNECTION_ID` environment setting).
 *   2. The machine credential from the team store secret
 *      (`personal-scheduler.dapier-api-token`, shared with the calendar
 *      broker) mints a short-lived access token at
 *      `POST https://dapier.dtcdev.click/api/agent/token`.
 *   3. The token fetches a plain-text export via
 *      `https://www.googleapis.com/drive/v3/files/<docId>/export?mimeType=text/plain`.
 *
 * Google refresh tokens stay in Dapier; nothing here stores credentials.
 */
import { createHash } from 'node:crypto';

import { DAPIER_AGENT, DAPIER_BASE_URL, readDapierCredential } from './calendar/dapierBroker';

/** Agent and machine credential are shared with the calendar broker leg. */
export const GDOC_CONNECTION_ENV = 'DATAOPS_GDOCS_CONNECTION_ID';
const DRIVE_API_BASE = 'https://www.googleapis.com/drive/v3/files';
const MAX_EXPORT_BYTES = 2_000_000;
/** Google Drive file ids are unreserved base64url characters, ~20-60 long. */
const DOC_ID_PATTERN = /^[A-Za-z0-9_-]{10,120}$/;
/** files.export needs drive or drive.readonly; drive.file cannot see shared docs. */
const REQUIRED_SCOPES = [
  'https://www.googleapis.com/auth/drive.readonly',
  'https://www.googleapis.com/auth/drive',
];

export function isGdocId(docId: string): boolean {
  return DOC_ID_PATTERN.test(docId) && docId !== 'e';
}

/** Google Docs edit URL recorded as provenance in imported KB documents. */
export function gdocSourceUrl(docId: string): string {
  return `https://docs.google.com/document/d/${docId}/edit`;
}

export interface GdocFetchDeps {
  fetchImpl?: typeof fetch;
  brokerUrl?: string;
  /** When set (via tests), skips Secrets Manager lookup. */
  credential?: string;
  agent?: string;
  connectionId?: string;
}

export type GdocFetchResult =
  | { content: string; sha256: string; sizeBytes: number; problem?: undefined }
  | { content?: undefined; sha256?: undefined; sizeBytes?: undefined; problem: string };

let fetcher: typeof fetch = fetch;

export function setKbGdocFetchForTests(value: typeof fetch | undefined): void {
  fetcher = value || fetch;
}

export function resolveGdocConnectionId(explicit?: string): string {
  const trimmed = typeof explicit === 'string' ? explicit.trim() : '';
  if (trimmed) return trimmed;
  return (process.env[GDOC_CONNECTION_ENV] || '').trim();
}

async function mintToken(deps: GdocFetchDeps, connectionId: string): Promise<{ token: string } | { problem: string }> {
  const run = deps.fetchImpl || fetcher;
  const agent = deps.agent || DAPIER_AGENT;
  const brokerUrl = (deps.brokerUrl || DAPIER_BASE_URL).replace(/\/$/, '');
  let credential: string;
  if (deps.credential) {
    credential = deps.credential;
  } else {
    const resolved = await readDapierCredential(undefined);
    if (!resolved.credential) return { problem: resolved.problem || 'No Dapier broker credential in this environment.' };
    credential = resolved.credential;
  }
  let tokenRes: Response;
  try {
    tokenRes = await run(`${brokerUrl}/api/agent/token`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${credential}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ connection_id: connectionId, agent }),
      signal: AbortSignal.timeout(10000),
    });
  } catch {
    return { problem: 'The Dapier broker could not be reached.' };
  }
  if (!tokenRes.ok) {
    const why = tokenRes.status === 403
      ? `Dapier denied access to connection "${connectionId}". A Dapier operator must grant agent "${agent}" the \`use\` operation on it.`
      : tokenRes.status === 404
        ? `The Dapier connection "${connectionId}" no longer exists; pick another Google connection.`
        : tokenRes.status === 409 || tokenRes.status === 502
          ? `Dapier cannot obtain a Google token for connection "${connectionId}"; reconnect it in Dapier.`
          : `The Dapier broker refused the token request (HTTP ${tokenRes.status}).`;
    return { problem: why };
  }
  let data: { access_token?: string; scope?: string | string[] };
  try { data = await tokenRes.json() as typeof data; }
  catch { return { problem: 'The Dapier broker returned an invalid token response.' }; }
  if (!data.access_token) return { problem: 'The Dapier broker returned no access token.' };
  const scopes = Array.isArray(data.scope) ? data.scope : String(data.scope || '').split(/[ ,]+/);
  if (scopes.length && !scopes.some((scope) => REQUIRED_SCOPES.includes(scope))) {
    return {
      problem: `Connection "${connectionId}" has no Google Drive read scope, so its documents cannot be exported. ` +
        'Reconnect it in Dapier with the Drive readonly scope granted.',
    };
  }
  return { token: data.access_token };
}

/**
 * Fetch a plain-text export of one Google Docs document. Never echoes the
 * token; problems name the broker or HTTP status only.
 */
export async function fetchGdocExport(deps: GdocFetchDeps, rawDocId: string): Promise<GdocFetchResult> {
  const docId = rawDocId.trim();
  if (!isGdocId(docId)) return { problem: 'docId must be a Google Docs document id (letters, digits, "-", "_")' };
  const connectionId = resolveGdocConnectionId(deps.connectionId);
  if (!connectionId) {
    return {
      problem: `No Dapier Google connection configured. Pass --connection-id or set ${GDOC_CONNECTION_ENV} ` +
        'to a Google connection whose account can read the document.',
    };
  }
  const minted = await mintToken(deps, connectionId);
  if ('problem' in minted) return minted;

  const run = deps.fetchImpl || fetcher;
  const url = `${DRIVE_API_BASE}/${encodeURIComponent(docId)}/export?mimeType=text/plain`;
  let res: Response;
  try {
    res = await run(url, {
      headers: { Authorization: `Bearer ${minted.token}` },
      signal: AbortSignal.timeout(20000),
    });
  } catch {
    return { problem: 'The Google Docs export could not be fetched.' };
  }
  if (!res.ok) {
    return {
      problem: res.status === 404
        ? `Google Drive has no document "${docId}" visible to the connection's account (HTTP 404).`
        : res.status === 403
          ? 'The connection\'s Google account may not read this document (HTTP 403); share it with that account.'
          : `The Google Docs export failed (HTTP ${res.status}).`,
    };
  }
  let bytes: Uint8Array;
  try { bytes = new Uint8Array(await res.arrayBuffer()); }
  catch { return { problem: 'The Google Docs export response could not be read.' }; }
  if (bytes.byteLength > MAX_EXPORT_BYTES) {
    return { problem: `The exported document is larger than ${MAX_EXPORT_BYTES} bytes; import a trimmed copy manually.` };
  }
  let content: string;
  try { content = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { return { problem: 'The exported document is not valid UTF-8 text.' }; }
  if (!content.trim()) return { problem: 'The exported document is empty.' };
  return { content, sha256: createHash('sha256').update(bytes).digest('hex'), sizeBytes: bytes.byteLength };
}
