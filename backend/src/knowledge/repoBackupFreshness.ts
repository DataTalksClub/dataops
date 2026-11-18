/**
 * Dead-man check for the daily dataops-knowledge repository backup.
 *
 * The backup runs in the knowledge repository's GitHub Actions workflow
 * (backup-to-s3.yml) and uploads straight to the private backups bucket, so
 * nothing on the AWS side sees the workflow run — and the workflow's own
 * success also covers skip runs that upload nothing because HEAD did not
 * change. The truthful signal is the backup's `{prefix}/latest/manifest.json`:
 * it is re-uploaded whenever the workflow finds a commit it has not backed up
 * yet, and its `commit_sha` names the newest backed-up repository commit.
 *
 * The scheduled check turns that object into the `DataOps/Knowledge`
 * Job=knowledge-repo-backup Success metric that the KnowledgeRepoBackupStaleAlarm
 * in the infra template pages the operator topic from. A backup is fresh when
 * its commit matches the last mirror-reported repository HEAD
 * (jobs/knowledge-mirror/last-report.json, written by the heartbeat route) or
 * when it landed within the last two days. A quiet repository therefore stays
 * green indefinitely, while a workflow that silently stops scheduling pages as
 * soon as a real commit goes unbacked — the 2026-10-02 -> 2026-11-15 outage
 * ran 44 days without any alert.
 */
import {GetObjectCommand} from '@aws-sdk/client-s3';
import type {KnowledgeStore} from '../docs/knowledgeStore';
import {writeEmbeddedMetric} from '../embeddedMetrics';

export const REPO_BACKUP_JOB='knowledge-repo-backup';
/** Backups are daily; two days of silence means the latest upload is behind. */
export const FRESH_BACKUP_MAX_AGE_MS=48*60*60*1000;
/** Where recordMirrorHeartbeat persists the last reported mirror commit. */
export const MIRROR_LAST_REPORT_KEY='jobs/knowledge-mirror/last-report.json';

export interface RepoBackupManifest {commit:string|null; lastModified:Date|null}
export interface RepoBackupFreshness {fresh:boolean; reason:string; backup:RepoBackupManifest; mirrorCommit:string|null}

/** Fresh when the backup contains the newest mirror-reported HEAD, or a backup landed recently. */
export function evaluateRepoBackupFreshness(input:{backup:RepoBackupManifest; mirrorCommit:string|null; now:Date}):RepoBackupFreshness {
  const {backup,mirrorCommit,now}=input;
  if(!backup.lastModified) return {fresh:false,reason:'missing-manifest',backup,mirrorCommit};
  const age=now.getTime()-backup.lastModified.getTime();
  if(mirrorCommit && backup.commit && backup.commit===mirrorCommit) return {fresh:true,reason:'commit-match',backup,mirrorCommit};
  if(age<=FRESH_BACKUP_MAX_AGE_MS) return {fresh:true,reason:'recent-upload',backup,mirrorCommit};
  return {fresh:false,reason:backup.commit?'divergent-commit':'manifest-incomplete',backup,mirrorCommit};
}

/** One Success datapoint per day keeps the stale alarm green; 0 starts the dead-man count. */
export function recordRepoBackupFreshness(freshness:RepoBackupFreshness):void {
  writeEmbeddedMetric({
    _aws:{
      Timestamp:Date.now(),
      CloudWatchMetrics:[{Namespace:'DataOps/Knowledge',Dimensions:[['Job']],Metrics:[{Name:'Success',Unit:'Count'}]}],
    },
    Job:REPO_BACKUP_JOB,
    Success:freshness.fresh?1:0,
    reason:freshness.reason,
    backup_commit:freshness.backup.commit||'',
    backup_last_modified:freshness.backup.lastModified?.toISOString()||'',
    mirror_commit:freshness.mirrorCommit||'',
  });
}

async function readJsonObject(client:{send(command:unknown):Promise<any>},bucket:string,key:string):Promise<{value:any;lastModified:Date|null}|null> {
  let response:any;
  try {
    response=await client.send(new GetObjectCommand({Bucket:bucket,Key:key}));
  } catch(err) {
    if(['NotFound','NoSuchKey','NoSuchBucket'].includes((err as {name?:string}).name||'')) return null;
    throw err;
  }
  const text=await response.Body.transformToString();
  return {value:JSON.parse(text),lastModified:response.LastModified instanceof Date?response.LastModified:null};
}

export interface RepoBackupCheckDeps {store:KnowledgeStore; backupBucket:string; backupPrefix:string; now?:Date}

export async function runRepoBackupFreshnessCheck(deps:RepoBackupCheckDeps):Promise<RepoBackupFreshness> {
  if(!deps.backupBucket) throw new Error('KNOWLEDGE_REPO_BACKUP_BUCKET is not configured');
  const prefix=deps.backupPrefix.replace(/^\/+|\/+$/g,'');
  const manifestKey=`${prefix}/latest/manifest.json`;
  const manifest=await readJsonObject(deps.store.client,deps.backupBucket,manifestKey);
  const backup:RepoBackupManifest=manifest?{commit:typeof manifest.value.commit_sha==='string'?manifest.value.commit_sha:null,lastModified:manifest.lastModified}:{commit:null,lastModified:null};
  const report=await readJsonObject(deps.store.client,deps.store.bucket,MIRROR_LAST_REPORT_KEY);
  const mirrorCommit=report&&typeof report.value.commit==='string'?report.value.commit:null;
  const freshness=evaluateRepoBackupFreshness({backup,mirrorCommit,now:deps.now||new Date()});
  recordRepoBackupFreshness(freshness);
  return freshness;
}
