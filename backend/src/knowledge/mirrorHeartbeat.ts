/**
 * Heartbeat of the daily DataOps -> Git knowledge mirror.
 *
 * The mirror runs in the knowledge repository's GitHub Actions workflow, so
 * nothing on the AWS side can see it run, fail, or silently stop being
 * scheduled. The workflow therefore reports each run's outcome here (as the
 * verified OIDC publisher) and this emits CloudWatch embedded metrics
 * `DataOps/Knowledge` Job=knowledge-mirror: Failure=1 on a failed run, and
 * Success=1 on a run that left Git matching the active DataOps revision. Two
 * alarms in the infra template page the shared operator topic (dev@) on any
 * Failure, and on any UTC day without a Success (the dead-man check: the
 * schedule stopped, the workflow was disabled, or it never reached the
 * report step), and send the recovery notice when the next success lands.
 *
 * The report also persists the mirrored Git HEAD to
 * jobs/knowledge-mirror/last-report.json: the repo-backup freshness check
 * compares it against the S3 backup manifest's commit to tell a quiet
 * repository (backed up, nothing new) from one whose backups stopped.
 */
import {PutObjectCommand} from '@aws-sdk/client-s3';
import type {KnowledgeStore} from '../docs/knowledgeStore';
import { writeEmbeddedMetric } from '../embeddedMetrics';
import { MIRROR_LAST_REPORT_KEY } from './repoBackupFreshness';

export const MIRROR_JOB = 'knowledge-mirror';

export interface MirrorHeartbeat { outcome: 'success' | 'failure'; revision: string; commit: string; }

export function parseMirrorHeartbeat(body: string | null | undefined): MirrorHeartbeat | null {
  let parsed: unknown;
  try { parsed = JSON.parse(body || ''); } catch { return null; }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const { outcome, revision, commit } = parsed as Record<string, unknown>;
  if (outcome !== 'success' && outcome !== 'failure') return null;
  const text = (value: unknown) => (typeof value === 'string' && /^[0-9A-Za-z._-]{0,80}$/.test(value) ? value : '');
  return { outcome, revision: text(revision), commit: text(commit) };
}

export async function recordMirrorHeartbeat(store: Pick<KnowledgeStore, 'bucket' | 'client'>, heartbeat: MirrorHeartbeat): Promise<void> {
  const success = heartbeat.outcome === 'success';
  writeEmbeddedMetric({
    _aws: {
      Timestamp: Date.now(),
      CloudWatchMetrics: [{ Namespace: 'DataOps/Knowledge', Dimensions: [['Job']], Metrics: [{ Name: 'Success', Unit: 'Count' }, { Name: 'Failure', Unit: 'Count' }] }],
    },
    Job: MIRROR_JOB,
    Success: success ? 1 : 0,
    Failure: success ? 0 : 1,
    revision: heartbeat.revision,
    commit: heartbeat.commit,
  });
  // The freshness check only reads the commit; keep the whole report for
  // operators inspecting the object.
  await store.client.send(new PutObjectCommand({
    Bucket: store.bucket,
    Key: MIRROR_LAST_REPORT_KEY,
    Body: JSON.stringify({ ...heartbeat, at: new Date().toISOString() }),
    ContentType: 'application/json',
  }));
}
