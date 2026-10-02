import {describe,it} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {resolve} from 'node:path';
import {KnowledgeStore,RevisionConflict,normalizeRepoPath,bounded} from '../src/docs/knowledgeStore';
import {KnowledgeJobs,GitHubMirrorError} from '../src/knowledge/worker';
import {syntheticKnowledge} from './helpers/knowledge';

describe('immutable S3 knowledge publications',()=>{
 it('pins coherent reads, rejects competing edits, publishes rename atomically and recovers deletion',async()=>{
  const dir=mkdtempSync(resolve('../.tmp/knowledge-test-'));
  try {
   const {store,s3,publication}=syntheticKnowledge({'content/a.md':'old','definitions/model.csv':'a,b\n1,2'},dir);
   const second=new KnowledgeStore({bucket:store.bucket,client:s3 as any,cacheDir:dir});await second.pin();
   const saved=await store.publish([{path:'content/a.md',bytes:'new'}],publication.revision,'authenticated-actor','Edit');
   await assert.rejects(()=>second.publish([{path:'content/a.md',bytes:'stale'}],publication.revision,'other','Edit'),RevisionConflict);
   assert.equal(await second.readFile('content/a.md'),'old');assert.equal(await store.readFile('content/a.md'),'new');
   const renamed=await store.publish([{path:'content/b.md',sourcePath:'content/a.md',absent:true}],saved.revision,'actor','Rename');
   assert.equal(renamed.entries['content/a.md'],undefined);assert.ok(renamed.entries['content/b.md']);
   const deleted=await store.publish([{path:'content/b.md'}],renamed.revision,'actor','Delete');
   assert.equal(deleted.entries['content/b.md'],undefined);
   const history=await store.history('content/b.md');assert.deepEqual(history.versions.map(v=>v.operation),['delete','rename']);
   const restored=await store.publish([{path:'content/b.md',restoreRevision:renamed.revision}],deleted.revision,'actor','Restore');
   assert.equal(await store.readFile('content/b.md'),'new');assert.equal(restored.actor,'actor');
  } finally{rmSync(dir,{recursive:true,force:true});}
 });
 it('failed pointer publication exposes no partial multi-file write and rejects unpublished restore',async()=>{
  const {store,s3,publication}=syntheticKnowledge({'content/a.md':'a'});
  await store.pin();s3.failKey='active.json';await assert.rejects(()=>store.publish([{path:'content/a.md',bytes:'b'},{path:'new.bin',bytes:new Uint8Array([0,255])}],publication.revision,'actor','Multiple'));
  s3.failKey='';const reader=new KnowledgeStore({bucket:store.bucket,client:s3 as any});assert.deepEqual(Object.keys(await reader.tree()),['content/a.md']);
  const orphan=[...s3.objects.keys()].filter(k=>k.includes('/publications/')).find(k=>!k.includes(publication.revision))!;
  const revision=JSON.parse(s3.objects.get(orphan)!.toString()).revision;
  await assert.rejects(()=>reader.publish([{path:'content/a.md',restoreRevision:revision}],publication.revision,'actor','Restore'));
 });
 it('backs up published history and deleted bytes independently of GitHub',async()=>{
  const {store,s3,publication}=syntheticKnowledge({'content/a.md':'old'});
  await store.publish([{path:'content/a.md'}],publication.revision,'actor','Delete');
  const job=new KnowledgeJobs(store,'protected',async()=>{throw new Error('GitHub unavailable');});
  const result=await job.backup();const snapshot=JSON.parse(s3.objects.get(`protected/${result.key}`)!.toString());
  assert.equal(snapshot.publications.length,2);assert.equal(snapshot.payloads.length,1);assert.equal(s3.objects.get(`protected/${snapshot.payloads[0].key}`)!.toString(),'old');
  assert.equal(snapshot.publications[0].actor,'actor');
 });
 it('rejects unsafe paths',()=>{for(const path of ['/absolute','../escape','a//b','.git/config','a\\b']) assert.throws(()=>normalizeRepoPath(path));});
});

describe('daily Git mirror publication',()=>{
 it('batches changed text, adds only changed binary blobs, removes owned paths and preserves unrelated files',async()=>{
  const {store,publication}=syntheticKnowledge({'content/a.md':'old','content/deleted.md':'gone','content/image.png':new Uint8Array([0,255])});
  await store.publish([{path:'content/a.md',bytes:'changed'},{path:'content/deleted.md'}],publication.revision,'actor','Edit/delete');
  const requests:{method:string;path:string;body:any}[]=[];
  const job=new KnowledgeJobs(store,'protected');
  job.github=async(method,path,body)=>{
   requests.push({method,path,body});
   if(path.startsWith('/git/ref/heads/'))return{object:{sha:'old-head'}};
   if(path==='/git/commits/old-head')return{tree:{sha:'old-tree'}};
   if(path.startsWith('/git/trees/old-tree'))return{tree:[{path:'content/a.md',sha:'old-sha',type:'blob'},{path:'content/deleted.md',sha:'gone-sha',type:'blob'},{path:'unrelated.txt',sha:'keep-sha',type:'blob'}]};
   if(path==='/git/blobs') {const {createHash}=await import('node:crypto');const bytes=Buffer.from(body.content,'base64');return {sha:createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex')};}
   if(path==='/git/trees')return{sha:'new-tree'};
   if(path==='/git/commits')return{sha:'new-commit'};
   if(path.startsWith('/git/refs/heads/'))return{};
   throw new Error('Unexpected Git request');
  };
  const result=await job.mirror();assert.equal(result.commit,'new-commit');
  const tree=requests.find(r=>r.path==='/git/trees')!.body;assert.equal(tree.base_tree,'old-tree');
  assert.equal(tree.tree.length,3);assert.ok(tree.tree.some((e:any)=>e.path==='content/deleted.md'&&e.sha===null));
  assert.ok(!tree.tree.some((e:any)=>e.path==='unrelated.txt'));assert.equal(requests.filter(r=>r.path==='/git/blobs').length,1);
  assert.equal(requests.at(-1)!.body.force,false);assert.deepEqual(requests.find(r=>r.path==='/git/commits')!.body.parents,['old-head']);
 });
 it('unchanged export does not commit and failed GitHub writes leave knowledge unchanged',async()=>{
  const {store,publication}=syntheticKnowledge({'content/a.md':'unchanged'});
  const {createHash}=await import('node:crypto');const bytes=Buffer.from('unchanged');const sha=createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
  const job=new KnowledgeJobs(store,'protected');const writes:string[]=[];
  job.github=async(method,path)=>{if(method!=='GET')writes.push(path);if(path.startsWith('/git/ref/'))return{object:{sha:'head'}};if(path==='/git/commits/head')return{tree:{sha:'tree'}};return{tree:[{type:'blob',path:'content/a.md',sha}]};};
  assert.equal((await job.mirror()).unchanged,true);assert.equal(writes.length,0);
  job.github=async()=>{throw new Error('GitHub unavailable');};await assert.rejects(()=>job.mirror());assert.equal((await store.pin()).revision,publication.revision);
 });
});

describe('bounded daily mirror backfill and recovery',()=>{
 it('resumes 1700 new binary uploads over daily runs without partial refs or repeated completed uploads',async()=>{
  const files=Object.fromEntries(Array.from({length:1700},(_,index)=>[`content/images/${index}.png`,new Uint8Array([0,255,index&255,index>>8])]));
  const {store,s3}=syntheticKnowledge(files);const uploaded=new Set<string>();let refWrites=0;const daily:number[]=[];
  for(let day=0;day<5;day++) {
   const job=new KnowledgeJobs(new KnowledgeStore({bucket:store.bucket,client:s3 as any}),'protected');let count=0;
   job.github=async(method,path,body)=>{
    if(path.startsWith('/git/ref/heads/'))return{object:{sha:'head'}};
    if(path==='/git/commits/head')return{tree:{sha:'tree'}};
    if(path.startsWith('/git/trees/tree'))return{tree:[]};
    if(path==='/git/blobs') {const {createHash}=await import('node:crypto');const bytes=Buffer.from(body.content,'base64');const sha=createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');assert.ok(!uploaded.has(sha));uploaded.add(sha);count++;return{sha};}
    if(path==='/git/trees')return{sha:'complete-tree'};
    if(path==='/git/commits')return{sha:'commit'};
    if(path.startsWith('/git/refs/heads/')){refWrites++;return{};}
    throw new Error('Unexpected request');
   };
   if(day<4) {await assert.rejects(()=>job.mirror(),/budget reached/);assert.equal(refWrites,0);}else assert.equal((await job.mirror()).commit,'commit');
   daily.push(count);
  }
  assert.deepEqual(daily,[400,400,400,400,100]);assert.equal(uploaded.size,1700);assert.equal(refWrites,1);
 });
 it('settles started work and stops dequeuing before releasing a failed pool',async()=>{
  let active=0;let started=0;
  await assert.rejects(()=>bounded(Array.from({length:100},(_,i)=>i),async value=>{active++;started++;try{if(value===0)throw new Error('failed');await new Promise(resolve=>setTimeout(resolve,5));}finally{active--; }},8));
  assert.equal(active,0);assert.ok(started<=8);
 });
 it('paces writes and stops queued requests after rate limit refusal',async()=>{
  const {store}=syntheticKnowledge({'content/a.md':'text'});let requests=0;const sleeps:number[]=[];
  const job=new KnowledgeJobs(store,'protected',async()=>{requests++;return new Response('{}',{status:429,headers:{'retry-after':'60'}});});
  (job as any).token='synthetic-token';job.pause=async ms=>{sleeps.push(ms);};
  const out=await Promise.allSettled([job.github('POST','/git/blobs',{}),job.github('POST','/git/blobs',{})]);
  assert.ok(out.every(result=>result.status==='rejected'));assert.equal(requests,1);assert.ok(sleeps.every(ms=>ms<=1000));
 });
});


describe('mirror publication boundary and quota recovery',()=>{
 it('preserves migrated repository tooling and pins ownership across a concurrent publication',async()=>{
  const metadata=['.github/workflows/a.yaml','scripts/a.py','README.md','schemas/a.json'];
  const {store,publication}=syntheticKnowledge(Object.fromEntries([['content/a.md','old'],...metadata.map(path=>[path,'source-old'])]));
  const changes:any[]=[];const job=new KnowledgeJobs(store,'protected');
  job.github=async(method,path,body)=>{
   if(path.startsWith('/git/ref/heads/')) {await store.publish([{path:'content/new.md',bytes:'new',absent:true}],publication.revision,'actor','Concurrent');return {object:{sha:'head'}};}
   if(path==='/git/commits/head')return {tree:{sha:'tree'}};
   if(path.startsWith('/git/trees/tree'))return {tree:[...metadata,'content/new.md'].map(path=>({path,type:'blob',sha:'remote-changed'}))};
   if(path==='/git/trees'){changes.push(...body.tree);return {sha:'next-tree'};}
   if(path==='/git/commits')return {sha:'next'};
   return {};
  };
  const result=await job.mirror();assert.equal(result.revision,publication.revision);
  assert.deepEqual(changes.map(e=>e.path),['content/a.md']);
 });
 it('invalidates unavailable cached Git blobs on tree422 and reuploads next run',async()=>{
  const {store}=syntheticKnowledge({'content/image.png':new Uint8Array([0,255])});let uploads=0;let rejectTree=true;
  for(let run=0;run<2;run++) {
   const job=new KnowledgeJobs(store,'protected');job.github=async(method,path,body)=>{
    if(path.startsWith('/git/ref/heads/'))return {object:{sha:'head'}};
    if(path==='/git/commits/head')return {tree:{sha:'tree'}};
    if(path.startsWith('/git/trees/tree'))return {tree:[]};
    if(path==='/git/blobs'){uploads++;const {createHash}=await import('node:crypto');const bytes=Buffer.from(body.content,'base64');return {sha:createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex')};}
    if(path==='/git/trees'){if(rejectTree)throw new GitHubMirrorError(422,'missing cached blob');return {sha:'next-tree'};}
    if(path==='/git/commits')return {sha:'next'};return {};
   };
   if(run===0)await assert.rejects(()=>job.mirror(),GitHubMirrorError);else await job.mirror();rejectTree=false;
  }
  assert.equal(uploads,2);
 });
 it('reserves remaining primary requests and rechecks its deadline after pacing',async()=>{
  const {store}=syntheticKnowledge({'content/a.md':'text'});let requests=0;
  const job=new KnowledgeJobs(store,'protected',async()=>{requests++;return new Response('{}',{headers:{'x-ratelimit-remaining':'0'}});});
  (job as any).token='synthetic';await job.github('GET','/git/ref/heads/main');
  await assert.rejects(()=>job.github('GET','/git/commits/head'),/primary quota/);assert.equal(requests,1);
  const timed=new KnowledgeJobs(store,'protected',async()=>{requests++;return new Response('{}');});
  (timed as any).token='synthetic';(timed as any).lastWrite=Date.now();
  timed.pause=async()=>{(timed as any).deadline=Date.now()-1;};
  await assert.rejects(()=>timed.github('POST','/git/trees',{}),/invocation budget/);assert.equal(requests,1);
 });
});
