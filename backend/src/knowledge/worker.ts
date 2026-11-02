/** Independent AWS knowledge backups; never called by HTTP reads.
 *
 * The daily GitHub mirror lives in the knowledge repository's own workflow
 * (dataops-knowledge/.github/workflows/validate.yml): it merges prod-ahead
 * edits into Git with the repository's history as the base, which this job
 * never saw. A server-side copy that overwrote Git's files byte for byte
 * fought the publish loop and delivered gate-breaking content.
 */
import {createHash,randomUUID} from 'node:crypto';
import {createReadStream} from 'node:fs';
import {mkdtemp,open,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {CopyObjectCommand,HeadObjectCommand,PutObjectCommand} from '@aws-sdk/client-s3';
import {KnowledgeStore,bounded,type Publication} from '../docs/knowledgeStore';
import {writeEmbeddedMetric} from '../embeddedMetrics';
import {withKnowledgeJobLease} from './lease';

export interface RecoverySnapshot {schemaVersion:1; revision:string; createdAt:string; publications:Publication[]; payloads:{sha:string;size:number;key:string}[];}
export class KnowledgeJobs {
  readonly maxUploads=400;
  constructor(readonly store=new KnowledgeStore(),readonly backupBucket=process.env.KNOWLEDGE_BACKUP_BUCKET||'',readonly fetchImpl:typeof fetch=fetch,readonly signal?:AbortSignal) {}
  async backup():Promise<{revision:string;key:string}> {
    if(!this.backupBucket) throw new Error('KNOWLEDGE_BACKUP_BUCKET is not configured');
    // Each publication repeats the full tree. Never retain the chain or serialize
    // its combined manifest in memory; disk and the S3 request provide backpressure.
    const directory=await mkdtemp(join(tmpdir(),'knowledge-backup-'));
    const path=join(directory,'snapshot.json');
    try {
      const head=await this.store.pin();const createdAt=new Date().toISOString();
      const file=await open(path,'wx');const hash=createHash('sha256');let size=0;
      const write=async(text:string)=>{this.signal?.throwIfAborted();const bytes=Buffer.from(text);await file.writeFile(bytes);hash.update(bytes);size+=bytes.length;};
      const payloads=new Map<string,RecoverySnapshot['payloads'][number]>();const seen=new Set<string>();
      try {
        await write(JSON.stringify({schemaVersion:1,revision:head.revision,createdAt}).slice(0,-1)+',"publications":[');
        let revision:string|null=head.revision;
        while(revision) {
          this.signal?.throwIfAborted();
          if(seen.has(revision)) throw new Error('Invalid knowledge publication chain');
          const publication:Publication=revision===head.revision?head:(await this.store.json<Publication>(`publications/${revision}.json`)).value;
          if(publication.revision!==revision) throw new Error('Invalid knowledge publication');
          await write((seen.size?',':'')+JSON.stringify(publication));seen.add(revision);
          await bounded(Object.values(publication.entries),async entry=>{
            this.signal?.throwIfAborted();
            if(payloads.has(entry.sha)) return;
            const payload={sha:entry.sha,size:entry.size,key:`objects/${entry.sha}`};payloads.set(entry.sha,payload);
            let exists=false;
            try {
              const old=await this.store.client.send(new HeadObjectCommand({Bucket:this.backupBucket,Key:payload.key}),{abortSignal:this.signal});
              if(old.ContentLength!==payload.size) throw new Error('Backup payload size mismatch');exists=true;
            } catch(err) {if(!['NotFound','NoSuchKey'].includes((err as {name?:string}).name||'')) throw err;}
            if(!exists) await this.store.client.send(new CopyObjectCommand({Bucket:this.backupBucket,Key:payload.key,CopySource:`${this.store.bucket}/${payload.key}`}),{abortSignal:this.signal});
          });
          revision=publication.parent;
        }
        await write('],"payloads":[');let first=true;
        for(const payload of payloads.values()) {await write((first?'':',')+JSON.stringify(payload));first=false;}
        await write(']}');
      } finally {await file.close();}
      this.signal?.throwIfAborted();
      const key=`snapshots/${createdAt.slice(0,10)}/${randomUUID()}.json`;
      const body=createReadStream(path);
      try {
        await this.store.client.send(new PutObjectCommand({Bucket:this.backupBucket,Key:key,Body:body,ContentLength:size,ContentType:'application/json',Metadata:{sha256:hash.digest('hex')},IfNoneMatch:'*'}),{abortSignal:this.signal});
      } finally {body.destroy();}
      return {revision:head.revision,key};
    } finally {await rm(directory,{recursive:true,force:true});}
  }
}
function metric(job:string,success:number):void {
  writeEmbeddedMetric({_aws:{Timestamp:Date.now(),CloudWatchMetrics:[{Namespace:'DataOps/Knowledge',Dimensions:[['Job']],Metrics:[{Name:'Success',Unit:'Count'},{Name:'Failure',Unit:'Count'}]}]},Job:job,Success:success,Failure:success?0:1});
}
export async function handler(event:{detail?:{dataopsAction?:string}}):Promise<unknown> {
  if(event.detail?.dataopsAction!=='knowledge-backup') throw new Error('Unknown knowledge job');
  const store=new KnowledgeStore();
  try {
    const result=await withKnowledgeJobLease(store,'knowledge-backup',async signal=>{
      const jobs=new KnowledgeJobs(store,undefined,undefined,signal);
      const result=await jobs.backup();
      signal.throwIfAborted();
      await store.client.send(new PutObjectCommand({Bucket:store.bucket,Key:`jobs/knowledge-backup/success.json`,Body:JSON.stringify({...result,at:new Date().toISOString()})}),{abortSignal:signal});
      return result;
    });
    metric('knowledge-backup',1);return result;
  } catch(err) {
    metric('knowledge-backup',0);throw err;
  }
}
