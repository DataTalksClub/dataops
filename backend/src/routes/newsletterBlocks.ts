/**
 * /api/newsletter-issues/:id/blocks — an issue's editable content blocks.
 *
 *   GET  /blocks                    the block set (404 blocks_not_imported before import)
 *   POST /blocks/import             {target, issueKey}: copy a Relay issue's blocks in
 *   PUT  /blocks/:blockId           {data, version}: edit one block (records a revision)
 *   POST /blocks/sync               {dryRun}: three-way sync with Relay (409 on conflict)
 *   GET  /blocks/revisions          every revision, oldest first (?block=<id> filters)
 *
 * See ../newsletter/blocksSync.ts for why the sync is two-way.
 */
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import type { LambdaEvent, LambdaResponse } from '../types';
import { json, parseJsonObjectEventOrEmpty } from '../http';
import { resolveNewsletterIssue } from '../db/newsletterIssues';
import { resolveInteractiveActor, type VerifiedActor } from '../identity/actor';
import {
  BLOCK_TYPES,
  BlockValidationError,
  FIELD_KINDS,
  FIELD_LABELS,
  RELAY_TARGETS,
  blockHash,
  blockLabel,
  changedFields,
  type IssueBlockSet,
  type RelayTarget,
} from '../newsletter/blocks';
import { BlockSetVersionConflict, listBlockRevisions } from '../newsletter/blocksStore';
import { RelayError } from '../newsletter/blocksRelay';
import { BlocksError, editBlock, importBlocks, requireBlockSet, syncBlocks, type BlockActor } from '../newsletter/blocksSync';

const blockActor = (actor: VerifiedActor): BlockActor => ({ id: actor.id, name: actor.user?.name || actor.user?.email || null });

/** The set as the API returns it: labels, field specs and pending-change flags added. */
export function blockSetView(set: IssueBlockSet) {
  return {
    ...set,
    blocks: set.blocks.map((block) => {
      const spec = BLOCK_TYPES[block.type];
      return {
        ...block,
        label: blockLabel(block.type),
        fields: (spec?.fields || Object.keys(block.data)).map((name) => ({
          name,
          label: FIELD_LABELS[name] || name,
          kind: FIELD_KINDS[name] || 'text',
          required: Boolean(spec?.required.includes(name)),
          default: spec?.defaults[name] || '',
        })),
        changedSinceSync: blockHash(block.type, block.data) !== block.base.hash,
      };
    }),
  };
}

function failure(error: unknown): LambdaResponse {
  if (error instanceof BlocksError) return json(error.status, { error: error.message, code: error.code, ...error.detail });
  if (error instanceof RelayError) return json(error.status, { error: error.message, code: error.code });
  if (error instanceof BlockValidationError) {
    return json(400, { error: error.message, code: 'block_invalid', fields: error.errors });
  }
  if (error instanceof BlockSetVersionConflict) return json(409, { error: error.message, code: 'blocks_version_conflict' });
  throw error;
}

export async function handleNewsletterBlockRoutes(
  issueRef: string,
  rest: string,
  method: string,
  event: LambdaEvent,
  client: DynamoDBDocumentClient,
): Promise<LambdaResponse> {
  const readOnly = method === 'GET';
  const resolved = await resolveInteractiveActor(client, event, readOnly ? 'work-read' : 'work-write');
  if (!resolved.ok) return resolved.response;
  const issue = await resolveNewsletterIssue(client, issueRef);
  if (!issue) return json(404, { error: 'Newsletter issue not found', code: 'issue_not_found' });
  const actor = blockActor(resolved.actor);
  const body = readOnly ? {} : parseJsonObjectEventOrEmpty(event);
  if (!body) return json(400, { error: 'Invalid JSON' });

  try {
    if (rest === '' || rest === '/') {
      if (method !== 'GET') return json(405, { error: 'Method not allowed' });
      return json(200, { issueId: issue.id, blocks: blockSetView(await requireBlockSet(client, issue.id)) });
    }
    if (rest === '/import') {
      if (method !== 'POST') return json(405, { error: 'Method not allowed' });
      const target = String(body.target || 'production') as RelayTarget;
      if (!RELAY_TARGETS.includes(target)) return json(400, { error: `target must be one of ${RELAY_TARGETS.join(', ')}` });
      const issueKey = String(body.issueKey || '').trim();
      if (!/^[a-z0-9][a-z0-9-]{0,119}$/.test(issueKey)) return json(400, { error: 'issueKey must be a Relay issue key like weekly-304' });
      const set = await importBlocks(client, issue.id, { target, issueKey }, actor);
      return json(201, { issueId: issue.id, blocks: blockSetView(set) });
    }
    if (rest === '/sync') {
      if (method !== 'POST') return json(405, { error: 'Method not allowed' });
      const result = await syncBlocks(client, issue.id, { dryRun: body.dryRun === true }, actor);
      return json(200, { issueId: issue.id, ...result, set: undefined, blocks: blockSetView(result.set) });
    }
    if (rest === '/revisions') {
      if (method !== 'GET') return json(405, { error: 'Method not allowed' });
      const set = await requireBlockSet(client, issue.id);
      const filter = event.queryStringParameters?.block || '';
      const revisions = (await listBlockRevisions(client, issue.id))
        .filter((revision) => !filter || revision.blockId === filter || String(revision.relayBlockId) === filter)
        .map((revision) => ({ ...revision, label: blockLabel(revision.blockType), changes: changedFields(revision.before, revision.after) }));
      return json(200, { issueId: issue.id, relay: set.relay, revisions });
    }
    const blockMatch = rest.match(/^\/([^/]+)$/);
    if (blockMatch) {
      if (method !== 'PUT') return json(405, { error: 'Method not allowed' });
      const blockId = decodeURIComponent(blockMatch[1]);
      const result = await editBlock(client, issue.id, blockId, { data: body.data, expectedVersion: body.version }, actor);
      return json(200, { issueId: issue.id, changed: result.changed, blocks: blockSetView(result.set) });
    }
    return json(404, { error: 'Not found' });
  } catch (error) {
    return failure(error);
  }
}
