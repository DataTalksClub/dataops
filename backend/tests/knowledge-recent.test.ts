import {describe,it,beforeEach,afterEach} from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync,mkdtempSync,rmSync} from 'node:fs';
import {resolve} from 'node:path';
import {handleDocsRoutes,configureDocsRuntime,resetDocsRuntime,publicationActorName} from '../src/docs/contentApi';
import {syntheticKnowledge} from './helpers/knowledge';
import type {LambdaEvent} from '../src/types';

function ev(query:Record<string,string>={}):LambdaEvent {
  return {httpMethod:'GET',path:'/knowledge/recent',headers:{},queryStringParameters:query,body:null};
}
async function recent(query:Record<string,string>={},names:Record<string,string>={}) {
  const response=await handleDocsRoutes(ev(query),'reader',undefined,async(ids)=>Object.fromEntries(ids.filter(id=>names[id]).map(id=>[id,names[id]])));
  assert.ok(response);
  return {status:response.statusCode,body:JSON.parse(response.body)};
}

describe('GET /knowledge/recent',()=>{
  let dir:string;
  beforeEach(()=>{mkdirSync(resolve('../.tmp'),{recursive:true});dir=mkdtempSync(resolve('../.tmp/knowledge-recent-'));});
  afterEach(()=>{resetDocsRuntime();rmSync(dir,{recursive:true,force:true});});

  it('lists changed docs newest first, collapses repeat edits, follows renames and skips non-docs',async()=>{
    const fixture=syntheticKnowledge({'content/a.md':'a','content/b.md':'b','content/images/x.png':'png','workflow-templates/t.yaml':'t: 1'},dir);
    const {store}=fixture;
    configureDocsRuntime(store);
    let rev=fixture.publication.revision;
    rev=(await store.publish([{path:'content/a.md',bytes:'a2'}],rev,'user-1','Update content/a.md')).revision;
    rev=(await store.publish([{path:'content/b.md',bytes:'b2'}],rev,'user-2','Update content/b.md')).revision;
    rev=(await store.publish([{path:'content/images/x.png',bytes:'png2'},{path:'workflow-templates/t.yaml',bytes:'t: 2'}],rev,'user-2','Assets')).revision;
    rev=(await store.publish([{path:'content/c.md',sourcePath:'content/b.md',absent:true}],rev,'user-1','Rename')).revision;
    rev=(await store.publish([{path:'content/a.md',bytes:'a3'}],rev,'git:DataTalksClub/dataops-knowledge@0123456789ab','Publish dataops-knowledge 0123456789ab')).revision;

    const {status,body}=await recent({},{'user-1':'Grace Hopper'});
    assert.equal(status,200);
    assert.equal(body.revision,rev);
    assert.deepEqual(body.changes.map((c:any)=>[c.path,c.operation,c.changes,c.actorName,c.deleted]),[
      ['content/a.md','edit',3,'Git 0123456',false],
      ['content/c.md','rename',3,'Grace Hopper',false],
    ]);
    assert.equal(body.complete,true);
  });

  it('marks deleted docs, honours the limit, and stops reading once the limit is met',async()=>{
    const fixture=syntheticKnowledge({'content/a.md':'a','content/b.md':'b'},dir);
    const {store,s3}=fixture;
    configureDocsRuntime(store);
    let rev=fixture.publication.revision;
    rev=(await store.publish([{path:'content/a.md',bytes:'a2'}],rev,'user-1','a')).revision;
    rev=(await store.publish([{path:'content/b.md'}],rev,'user-2','delete b')).revision;
    const one=await recent({limit:'1'});
    assert.deepEqual(one.body.changes.map((c:any)=>[c.path,c.operation,c.deleted,c.actorName]),[['content/b.md','delete',true,'user-2']]);
    assert.equal(one.body.complete,false);
    assert.equal(one.body.scanned,1);
    const publicationReads=()=>s3.calls.filter(c=>c.name==='GetObjectCommand'&&String(c.input.Key).startsWith('publications/')).length;
    const before=publicationReads();
    const two=await recent({limit:'2'});
    assert.deepEqual(two.body.changes.map((c:any)=>c.path),['content/b.md','content/a.md']);
    assert.ok(publicationReads()>before);
    const cached=publicationReads();
    await recent({limit:'2'});
    // The same publication answers from the per-revision cache.
    assert.equal(publicationReads(),cached);
  });

  it('rejects an invalid limit',async()=>{
    const fixture=syntheticKnowledge({'content/a.md':'a'},dir);
    configureDocsRuntime(fixture.store);
    for(const limit of ['0','101','x']) assert.equal((await recent({limit})).status,400);
  });
});

describe('publicationActorName',()=>{
  it('names git publications by short sha and users by display name',()=>{
    assert.equal(publicationActorName('git:DataTalksClub/dataops-knowledge@8bd4542aa1b2'),'Git 8bd4542');
    assert.equal(publicationActorName('user-1',{'user-1':'Orin Vale'}),'Orin Vale');
    assert.equal(publicationActorName('local-operator'),'local-operator');
  });
});
