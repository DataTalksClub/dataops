import {it} from 'node:test';
import assert from 'node:assert/strict';

import {evaluateRepoBackupFreshness, recordRepoBackupFreshness, runRepoBackupFreshnessCheck, FRESH_BACKUP_MAX_AGE_MS, MIRROR_LAST_REPORT_KEY, REPO_BACKUP_JOB} from '../src/knowledge/repoBackupFreshness';
import {syntheticKnowledge} from './helpers/knowledge';
import type {RepoBackupManifest} from '../src/knowledge/repoBackupFreshness';

const NOW = new Date('2026-11-18T05:30:00Z');
const day = (days: number) => new Date(NOW.getTime() - days * 24 * 60 * 60 * 1000);

/** Capture the raw stdout lines the embedded metric is written to. */
function captureStdout(action: () => void): string[] {
  const originalWrite = process.stdout.write;
  const lines: string[] = [];
  process.stdout.write = ((chunk: unknown) => { lines.push(String(chunk)); return true; }) as typeof process.stdout.write;
  try { action(); } finally { process.stdout.write = originalWrite; }
  return lines;
}

function backup(commit: string | null, lastModified: Date | null): RepoBackupManifest {
  return { commit, lastModified };
}

it('counts a backup as fresh while it contains the mirrored HEAD, however old the upload is', () => {
  // A quiet repository keeps HEAD stable for weeks; the backup of that HEAD
  // never changes and must not page.
  const freshness = evaluateRepoBackupFreshness({ backup: backup('a'.repeat(40), day(40)), mirrorCommit: 'a'.repeat(40), now: NOW });
  assert.equal(freshness.fresh, true);
  assert.equal(freshness.reason, 'commit-match');
});

it('counts a recent upload as fresh even when the mirror already moved on', () => {
  // The mirror reports the new HEAD at 04:00; the next backup lands at 03:17
  // the following day, so a one-day-old manifest of an older commit is normal.
  const freshness = evaluateRepoBackupFreshness({ backup: backup('b'.repeat(40), day(1)), mirrorCommit: 'c'.repeat(40), now: NOW });
  assert.equal(freshness.fresh, true);
  assert.equal(freshness.reason, 'recent-upload');
});

it('counts exactly-two-day-old uploads as fresh on the boundary', () => {
  const freshness = evaluateRepoBackupFreshness({ backup: backup('b'.repeat(40), new Date(NOW.getTime() - FRESH_BACKUP_MAX_AGE_MS)), mirrorCommit: 'c'.repeat(40), now: NOW });
  assert.equal(freshness.fresh, true);
});

it('pages only when an unbacked commit is older than the freshness window', () => {
  // The incident shape: the backup workflow stopped scheduling while the
  // repository kept receiving commits - nothing alerted for 44 days.
  const freshness = evaluateRepoBackupFreshness({ backup: backup('b'.repeat(40), day(44)), mirrorCommit: 'c'.repeat(40), now: NOW });
  assert.equal(freshness.fresh, false);
  assert.equal(freshness.reason, 'divergent-commit');
});

it('pages when the backup manifest is missing', () => {
  const freshness = evaluateRepoBackupFreshness({ backup: backup(null, null), mirrorCommit: 'c'.repeat(40), now: NOW });
  assert.equal(freshness.fresh, false);
  assert.equal(freshness.reason, 'missing-manifest');
});

it('judges by upload age when the mirror has never reported', () => {
  const freshness = evaluateRepoBackupFreshness({ backup: backup('b'.repeat(40), day(44)), mirrorCommit: '', now: NOW });
  assert.equal(freshness.fresh, false);
  assert.equal(freshness.reason, 'divergent-commit');
  const oldUnidentified = evaluateRepoBackupFreshness({ backup: backup(null, day(44)), mirrorCommit: '', now: NOW });
  assert.equal(oldUnidentified.fresh, false);
  assert.equal(oldUnidentified.reason, 'manifest-incomplete');
});

it('writes the freshness metric as a bare stdout EMF record', () => {
  const lines = captureStdout(() => recordRepoBackupFreshness({
    fresh: false, reason: 'divergent-commit',
    backup: { commit: 'b'.repeat(40), lastModified: day(44) },
    mirrorCommit: 'c'.repeat(40),
  }));
  assert.equal(lines.length, 1);
  assert.ok(lines[0].endsWith('\n'));
  const record = JSON.parse(lines[0]);
  assert.equal(record._aws.CloudWatchMetrics[0].Namespace, 'DataOps/Knowledge');
  assert.equal(record.Job, REPO_BACKUP_JOB);
  assert.equal(record.Success, 0);
  assert.equal(record.reason, 'divergent-commit');
  assert.equal(record.mirror_commit, 'c'.repeat(40));
});

it('reads the backup manifest and mirror report from S3 and emits the stale verdict', async () => {
  const { store, s3 } = syntheticKnowledge({});
  const backupBucket = 'dataops-knowledge-backups-1-eu-west-1';
  s3.objects.set(`${backupBucket}/dataops-knowledge/latest/manifest.json`, Buffer.from(JSON.stringify({ commit_sha: 'b'.repeat(40) })));
  s3.modified.set(`${backupBucket}/dataops-knowledge/latest/manifest.json`, day(44));
  s3.objects.set(`${store.bucket}/${MIRROR_LAST_REPORT_KEY}`, Buffer.from(JSON.stringify({ outcome: 'success', revision: 'rev1', commit: 'c'.repeat(40), at: NOW.toISOString() })));

  let stdout: string[] = [];
  const originalWrite = process.stdout.write;
  process.stdout.write = ((chunk: unknown) => { stdout.push(String(chunk)); return true; }) as typeof process.stdout.write;
  let freshness;
  try {
    freshness = await runRepoBackupFreshnessCheck({ store, backupBucket, backupPrefix: 'dataops-knowledge', now: NOW });
  } finally {
    process.stdout.write = originalWrite;
  }
  assert.equal(freshness.fresh, false);
  assert.equal(freshness.reason, 'divergent-commit');
  assert.equal(freshness.backup.commit, 'b'.repeat(40));
  assert.equal(freshness.backup.lastModified!.toISOString(), day(44).toISOString());
  assert.equal(freshness.mirrorCommit, 'c'.repeat(40));
  assert.equal(stdout.length, 1);
  assert.equal(JSON.parse(stdout[0]).Success, 0);
});

it('reports fresh for a matching mirror commit even after a 44-day upload gap', async () => {
  const { store, s3 } = syntheticKnowledge({});
  const backupBucket = 'dataops-knowledge-backups-2-eu-west-1';
  s3.objects.set(`${backupBucket}/dataops-knowledge/latest/manifest.json`, Buffer.from(JSON.stringify({ commit_sha: 'q'.repeat(40) })));
  s3.modified.set(`${backupBucket}/dataops-knowledge/latest/manifest.json`, day(44));
  s3.objects.set(`${store.bucket}/${MIRROR_LAST_REPORT_KEY}`, Buffer.from(JSON.stringify({ outcome: 'success', revision: 'rev2', commit: 'q'.repeat(40), at: NOW.toISOString() })));
  const freshness = await runRepoBackupFreshnessCheck({ store, backupBucket, backupPrefix: 'dataops-knowledge/', now: NOW });
  assert.equal(freshness.fresh, true);
  assert.equal(freshness.reason, 'commit-match');
});

it('reports fresh for a day-old upload of a not-yet-backed-up HEAD', async () => {
  const { store, s3 } = syntheticKnowledge({});
  const backupBucket = 'dataops-knowledge-backups-3-eu-west-1';
  s3.objects.set(`${backupBucket}/dataops-knowledge/latest/manifest.json`, Buffer.from(JSON.stringify({ commit_sha: 'q'.repeat(40) })));
  s3.modified.set(`${backupBucket}/dataops-knowledge/latest/manifest.json`, day(1));
  const freshness = await runRepoBackupFreshnessCheck({ store, backupBucket, backupPrefix: 'dataops-knowledge', now: NOW });
  assert.equal(freshness.fresh, true);
  assert.equal(freshness.reason, 'recent-upload');
});

it('fails loudly when the backup bucket is not configured', async () => {
  const { store } = syntheticKnowledge({});
  await assert.rejects(() => runRepoBackupFreshnessCheck({ store, backupBucket: '', backupPrefix: 'dataops-knowledge', now: NOW }), /KNOWLEDGE_REPO_BACKUP_BUCKET is not configured/);
});
