/** Independent AWS knowledge backups and one daily GitHub mirror; never called by HTTP reads. */
import {createHash,randomUUID} from 'node:crypto';
import {createReadStream} from 'node:fs';
import {mkdtemp,open,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {CopyObjectCommand,HeadObjectCommand,PutObjectCommand} from '@aws-sdk/client-s3';
import {KnowledgeStore,bounded,checksum,isManagedKnowledgePath,type Publication} from '../docs/knowledgeStore';
import {writeEmbeddedMetric} from '../embeddedMetrics';
import {withKnowledgeJobLease} from './lease';

export interface RecoverySnapshot {schemaVersion:1; revision:string; createdAt:string; publications:Publication[]; payloads:{sha:string;size:number;key:string}[];}
export class GitHubMirrorError extends Error {constructor(readonly status:number,message:string){super(message);}}
export class KnowledgeJobs {
  private token:string|undefined;
  private writeQueue:Promise<void>=Promise.resolve();
  private lastWrite=0;
  private uploads=0;
  private blocked:Error|null=null;
  private primaryRemaining:number|undefined;
  private readonly deadline=Date.now()+14*60_000;
  readonly maxUploads=400;
  pause:(ms:number)=>Promise<void>=ms=>new Promise(resolve=>setTimeout(resolve,ms));
  private async pacedWrite():Promise<void> {
    const queued=this.writeQueue.then(async()=>{const delay=Math.max(0,1000-(Date.now()-this.lastWrite));if(delay)await this.pause(delay);this.lastWrite=Date.now();});
    this.writeQueue=queued;await queued;
  }
  constructor(readonly store=new KnowledgeStore(),readonly backupBucket=process.env.KNOWLEDGE_BACKUP_BUCKET||'',readonly fetchImpl:typeof fetch=fetch,readonly signal?:AbortSignal) {}
  async chain(published?:Publication):Promise<Publication[]> {
    const publications:Publication[]=[];let p=published||await this.store.pin();const seen=new Set<string>();
    while(p) {
      if(seen.has(p.revision)) throw new Error('Invalid knowledge publication chain');seen.add(p.revision);publications.push(p);
      if(!p.parent) break;
      p=(await this.store.json<Publication>(`publications/${p.parent}.json`)).value;
    }
    return publications;
  }
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

  async github(method:string,path:string,body?:unknown):Promise<any> {
    this.signal?.throwIfAborted();
    if(this.blocked)throw this.blocked;
    if(Date.now()>this.deadline)throw new Error('Mirror deferred: invocation budget exhausted');
    if(method!=='GET')await this.pacedWrite();
    this.signal?.throwIfAborted();
    if(this.blocked)throw this.blocked;
    if(Date.now()>this.deadline)throw new Error('Mirror deferred: invocation budget exhausted');
    if(this.primaryRemaining!==undefined) {
      if(this.primaryRemaining<=0)throw new Error('Mirror deferred: primary quota exhausted');
      this.primaryRemaining--;
    }
    if(!this.token) {
      const {readRuntimeSecret}=await import('../secrets/reader');
      this.token=await readRuntimeSecret(process.env.GITHUB_TOKEN_SECRET_NAME||'');
    }
    const token=this.token;if(!token) throw new Error('Mirror credential missing');
    const response=await this.fetchImpl(`https://api.github.com/repos/${process.env.GITHUB_OWNER||'DataTalksClub'}/${process.env.GITHUB_REPO||'dataops-knowledge'}${path}`,{method,signal:AbortSignal.timeout(60_000),headers:{authorization:`Bearer ${token}`,accept:'application/vnd.github+json','content-type':'application/json','x-github-api-version':'2022-11-28'},body:body?JSON.stringify(body):undefined});
    const remaining=response.headers.get('x-ratelimit-remaining');
    if(remaining!==null && Number.isFinite(Number(remaining)))this.primaryRemaining=Math.min(this.primaryRemaining??Infinity,Number(remaining));
    if(!response.ok) {
      const retryAfter=response.headers.get('retry-after');const reset=response.headers.get('x-ratelimit-reset');
      const failure=new GitHubMirrorError(response.status,`GitHub mirror deferred HTTP ${response.status}${retryAfter?`; retry after ${retryAfter} seconds`:''}${reset?`; quota reset ${new Date(Number(reset)*1000).toISOString()}`:''}`);
      if(response.status===403||response.status===429)this.blocked=failure;
      throw failure;
    }
    return response.json();
  }
  async mirror():Promise<{revision:string;commit:string;unchanged:boolean}> {
    this.signal?.throwIfAborted();
    const p=await this.store.pin();const branch=encodeURIComponent(process.env.GITHUB_BRANCH||'main');
    const ref=await this.github('GET',`/git/ref/heads/${branch}`);
    const head=ref.object.sha;
    const commit=await this.github('GET',`/git/commits/${head}`);
    const tree=await this.github('GET',`/git/trees/${commit.tree.sha}?recursive=1`);
    if(tree.truncated) throw new Error('GitHub mirror tree truncated');
    const old=new Map<string,string>(tree.tree.filter((e:any)=>e.type==='blob').map((e:any)=>[e.path,e.sha]));
    // The dataset ownership inventory survives deletions and never adopts direct GitHub edits.
    const chain=await this.chain(p);const owned=new Set(chain.flatMap(item=>Object.keys(item.entries).filter(isManagedKnowledgePath)));
    const changes:any[]=[];
    const cachedKeys=new Set<string>();
    for(const path of owned) if(!p.entries[path] && old.has(path)) changes.push({path,mode:'100644',type:'blob',sha:null});
    await bounded(Object.values(p.entries).filter(entry=>isManagedKnowledgePath(entry.path)),async entry=>{
      this.signal?.throwIfAborted();
      const bytes=await this.store.blobBytes(entry.sha);
      const gitSha=createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
      if(old.get(entry.path)===gitSha) return;
      // Git Trees can batch text bodies; binaries need a blob upload only when bytes change.
      const text=bytes.toString('utf8');
      if(Buffer.from(text).equals(bytes)) changes.push({path:entry.path,mode:'100644',type:'blob',content:text});
      else {
        const scope=checksum(`${process.env.GITHUB_OWNER||'DataTalksClub'}/${process.env.GITHUB_REPO||'dataops-knowledge'}/${process.env.GITHUB_BRANCH||'main'}`);
        const cacheKey=`jobs/knowledge-mirror/blobs/${scope}/${entry.sha}.json`;
        let blobSha:string|undefined;
        try {
          const progress=(await this.store.json<{sha:string;at:string;invalid?:boolean}>(cacheKey)).value;
          if(!progress.invalid && Date.now()-Date.parse(progress.at)<14*86400_000 && progress.sha===gitSha) {blobSha=progress.sha;cachedKeys.add(cacheKey);}
        } catch(error) {if(!['NoSuchKey','NotFound'].includes((error as Error).name))throw error;}
        if(!blobSha) {
          if(this.uploads>=this.maxUploads)throw new Error('Mirror deferred: daily binary upload budget reached; progress retained');
          this.uploads++;
          const blob=await this.github('POST','/git/blobs',{encoding:'base64',content:bytes.toString('base64')});
          if(blob.sha!==gitSha)throw new Error('Mirror blob checksum mismatch');
          blobSha=blob.sha;
          await this.store.client.send(new PutObjectCommand({Bucket:this.store.bucket,Key:cacheKey,Body:JSON.stringify({sha:blobSha,at:new Date().toISOString()})}));
          cachedKeys.add(cacheKey);
        }
        changes.push({path:entry.path,mode:'100644',type:'blob',sha:blobSha});
      }
    },8);
    if(!changes.length) return {revision:p.revision,commit:head,unchanged:true};
    let nextTree;
    try {nextTree=await this.github('POST','/git/trees',{base_tree:commit.tree.sha,tree:changes.sort((a,b)=>a.path.localeCompare(b.path))});}
    catch(error) {
      if(error instanceof GitHubMirrorError && error.status===422) {
        await bounded([...cachedKeys],async key=>{await this.store.client.send(new PutObjectCommand({Bucket:this.store.bucket,Key:key,Body:JSON.stringify({invalid:true,at:new Date().toISOString()})}));});
      }
      throw error;
    }
    const next=await this.github('POST','/git/commits',{message:`Daily knowledge snapshot ${p.revision}`,tree:nextTree.sha,parents:[head]});
    // Non-forced advancement rejects external updates; never force-push or merge GitHub edits into S3.
    await this.github('PATCH',`/git/refs/heads/${branch}`,{sha:next.sha,force:false});
    return {revision:p.revision,commit:next.sha,unchanged:false};
  }
}
function metric(job:string,success:number):void {
  writeEmbeddedMetric({_aws:{Timestamp:Date.now(),CloudWatchMetrics:[{Namespace:'DataOps/Knowledge',Dimensions:[['Job']],Metrics:[{Name:'Success',Unit:'Count'},{Name:'Failure',Unit:'Count'}]}]},Job:job,Success:success,Failure:success?0:1});
}
export async function handler(event:{detail?:{dataopsAction?:string}}):Promise<unknown> {
  const job=event.detail?.dataopsAction;
  if(job!=='knowledge-backup' && job!=='knowledge-mirror') throw new Error('Unknown knowledge job');
  const store=new KnowledgeStore();
  try {
    const result=await withKnowledgeJobLease(store,job,async signal=>{
      const jobs=new KnowledgeJobs(store,undefined,undefined,signal);
      const result=job==='knowledge-backup'?await jobs.backup():await jobs.mirror();
      signal.throwIfAborted();
      await store.client.send(new PutObjectCommand({Bucket:store.bucket,Key:`jobs/${job}/success.json`,Body:JSON.stringify({...result,at:new Date().toISOString()})}),{abortSignal:signal});
      return result;
    });
    metric(job,1);return result;
  } catch(err) {
    metric(job,0);throw err;
  }
}
