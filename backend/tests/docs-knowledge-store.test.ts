import {describe,it} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {resolve} from 'node:path';
import {KnowledgeStore,RevisionConflict,KnowledgeError,normalizeRepoPath,bounded} from '../src/docs/knowledgeStore';
import {KnowledgeJobs} from '../src/knowledge/worker';
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
   const regenerated=await store.publish([{path:'content/derived.md',sourcePath:'content/b.md',bytes:'generated view',absent:true}],restored.revision,'actor','Rename and regenerate');
   assert.equal(regenerated.entries['content/b.md'],undefined);assert.equal(await store.readFile('content/derived.md'),'generated view');
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

describe('knowledge history pagination',()=>{
 it('paginates a deep chain without re-walking it from the head on every page',async()=>{
  const {store,s3,publication}=syntheticKnowledge({'content/quiet.md':'quiet','content/other.md':'v0'});
  let revision=publication.revision;
  for(let i=1;i<=250;i++) revision=(await store.publish([{path:'content/other.md',bytes:`v${i}`}],revision,'actor',`change ${i}`)).revision;
  const pages:{versions:Record<string,unknown>[];cursor:string|null}[]=[];
  let cursor:string|undefined;
  while(true) {
   const page=await store.history('content/quiet.md',cursor);
   pages.push(page);
   if(!page.cursor) break;
   cursor=page.cursor;
  }
  const ops=pages.flatMap(page=>page.versions.map(v=>v.operation));
  assert.deepEqual(ops,['import']);
  const getPubs=()=>s3.calls.filter(c=>c.name==='GetObjectCommand'&&String(c.input.Key).includes('/publications/')).length;
  const before=getPubs();
  const continued=await store.history('content/quiet.md',pages[0].cursor!);
  const reads=getPubs()-before;
  assert.ok(continued.versions.length===0&&continued.cursor, 'the second page continues the chain');
  assert.ok(reads<=110,`a cursor page must cost O(page), not O(depth): ${reads} publication reads`);
 });
 it('rejects cursors that name no publication',async()=>{
  const {store}=syntheticKnowledge({'content/a.md':'a'});
  await assert.rejects(()=>store.history('content/a.md','00000000-0000-4000-8000-000000000000'),KnowledgeError);
  await assert.rejects(()=>store.history('content/a.md','not-a-cursor'),/Invalid history cursor/);
 });
});

describe('bounded concurrent reads',()=>{
 it('settles started work and stops dequeuing before releasing a failed pool',async()=>{
  let active=0;let started=0;
  await assert.rejects(()=>bounded(Array.from({length:100},(_,i)=>i),async value=>{active++;started++;try{if(value===0)throw new Error('failed');await new Promise(resolve=>setTimeout(resolve,5));}finally{active--; }},8));
  assert.equal(active,0);assert.ok(started<=8);
 });
});
