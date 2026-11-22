/** Full repository gates run on an immutable, private candidate before activation.
 * The ordinary save fails visibly while validation is pending; retrying the same
 * save consumes the receipt. Only the verified main-branch publisher can write
 * receipts or bypass validation (its own publication already passed the gates).
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import { PutObjectCommand } from '@aws-sdk/client-s3';
import { readRuntimeSecret } from '../secrets/reader';
import type { KnowledgeStore, Mutation, Publication } from './knowledgeStore';

const publisher = new AsyncLocalStorage<boolean>();
export const withValidatedKnowledgePublisher = <T>(action: () => Promise<T>): Promise<T> => publisher.run(true, action);
const hash = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
const prefix = (id: string) => {
  if (!/^[a-f0-9]{64}$/.test(id)) throw new Error('Invalid knowledge validation id');
  return `jobs/knowledge-validation/${id}`;
};
export interface Candidate {
  id: string; baseRevision: string; actor: string;
  entries: Publication['entries'];
  mutations: { path: string; base64?: string }[];
}
export interface ValidationReceipt { status: 'passed' | 'failed'; runUrl: string; }
export class KnowledgeValidationError extends Error {
  constructor(readonly id: string, readonly status: 'pending' | 'failed' | 'unavailable', readonly runUrl: string) {
    super(status === 'unavailable' ? `Could not start full knowledge validation. The active document is unchanged and your draft is preserved. Retry later; validation service: ${runUrl}.` : status === 'pending'
      ? `Knowledge edit is pending the full authored-content gates and has not been saved. Validation: ${runUrl}. Retry the same save after validation finishes.`
      : `Knowledge edit rejected: the full authored-content gates failed. The active document is unchanged. Fix the findings at ${runUrl} and save again.`);
  }
}
async function optionalJson<T>(store: KnowledgeStore, key: string): Promise<T | undefined> {
  try { return (await store.json<T>(key)).value; }
  catch (error) { if (['NoSuchKey', 'NotFound'].includes((error as Error).name)) return undefined; throw error; }
}
export async function validationCandidate(store: KnowledgeStore, id: string): Promise<Candidate> {
  return (await store.json<Candidate>(`${prefix(id)}/request.json`)).value;
}
/** Called only by the verified GitHub OIDC publisher, never from docs dispatch. */
export async function recordValidation(store: KnowledgeStore, id: string, receipt: ValidationReceipt): Promise<void> {
  await validationCandidate(store, id);
  const repository = process.env.KNOWLEDGE_PUBLISHER_REPOSITORY || 'DataTalksClub/dataops-knowledge';
  if (!['passed', 'failed'].includes(receipt.status) || !receipt.runUrl.startsWith(`https://github.com/${repository}/actions/runs/`) || !/\/runs\/[0-9]+$/.test(receipt.runUrl)) {
    throw new Error('Invalid validation receipt');
  }
  await store.client.send(new PutObjectCommand({ Bucket: store.bucket, Key: `${prefix(id)}/result.json`, Body: JSON.stringify(receipt), ContentType: 'application/json' }));
}
export async function dispatchValidation(id: string): Promise<void> {
  const token = await readRuntimeSecret('dataops-v1.knowledge.github-token');
  const response = await fetch('https://api.github.com/repos/DataTalksClub/dataops-knowledge/actions/workflows/validate-candidate.yml/dispatches', {
    method: 'POST', headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'content-type': 'application/json' },
    body: JSON.stringify({ ref: 'main', inputs: { candidate: id } }), signal: AbortSignal.timeout(10_000),
  });
  // Never echo provider bodies: they can contain request data or credentials.
  if (!response.ok) throw new Error(`Knowledge validation workflow dispatch failed (HTTP ${response.status}); the active knowledge is unchanged`);
}
export async function requireKnowledgeValidation(
  store: KnowledgeStore, previous: Publication, mutations: Mutation[], actor: string,
  dispatch: (id: string) => Promise<void> = dispatchValidation,
): Promise<void> {
  if (publisher.getStore()) return;
  const resolved: Candidate['mutations'] = [];
  for (const mutation of mutations) {
    let bytes: string | Uint8Array | undefined = mutation.bytes;
    if (bytes === undefined && mutation.sourcePath) bytes = await store.blobBytes(previous.entries[mutation.sourcePath]?.sha || '');
    if (bytes === undefined && mutation.restoreRevision) bytes = await store.versionBytes(mutation.path, mutation.restoreRevision);
    resolved.push({ path: mutation.path, ...(bytes !== undefined ? { base64: Buffer.from(bytes).toString('base64') } : {}) });
    if (mutation.sourcePath) resolved.push({ path: mutation.sourcePath });
  }
  // Include operation order: a batch may write a path more than once.
  const payload = { baseRevision: previous.revision, actor, entries: previous.entries, mutations: resolved };
  const id = hash(JSON.stringify(payload));
  const receipt = await optionalJson<ValidationReceipt>(store, `${prefix(id)}/result.json`);
  if (receipt?.status === 'passed') return;
  if (receipt?.status === 'failed') throw new KnowledgeValidationError(id, 'failed', receipt.runUrl);
  const runUrl = `https://github.com/DataTalksClub/dataops-knowledge/actions?query=${encodeURIComponent(id)}`;
  const queued = await optionalJson<{ dispatched: boolean }>(store, `${prefix(id)}/dispatch.json`);
  if (!queued?.dispatched) {
    await store.client.send(new PutObjectCommand({ Bucket: store.bucket, Key: `${prefix(id)}/request.json`, Body: JSON.stringify({ id, ...payload }), ContentType: 'application/json' }));
    try { await dispatch(id); }
    catch (error) {
      console.error('Knowledge validation dispatch failed', error instanceof Error ? error.message : 'Unknown provider failure');
      throw new KnowledgeValidationError(id, 'unavailable', runUrl);
    }
    await store.client.send(new PutObjectCommand({ Bucket: store.bucket, Key: `${prefix(id)}/dispatch.json`, Body: JSON.stringify({ dispatched: true }), ContentType: 'application/json' }));
  }
  throw new KnowledgeValidationError(id, 'pending', runUrl);
}
