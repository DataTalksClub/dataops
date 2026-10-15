import {describe,it,beforeEach,afterEach} from 'node:test';
import assert from 'node:assert/strict';
import {existsSync,mkdirSync,mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {dirname,join,resolve} from 'node:path';
import {KnowledgeStore} from '../src/docs/knowledgeStore';
import {handleDocsRoutes,configureDocsRuntime,resetDocsRuntime} from '../src/docs/contentApi';
import {syntheticKnowledge} from './helpers/knowledge';
import type {LambdaEvent} from '../src/types';
const SOP = [
  '---',
  'title: Reset a password',
  'summary: How to reset a user password',
  'doc_type: sop',
  'schema_version: 1',
  'tags: [accounts, security]',
  '---',
  '',
  '# Reset a password',
  '',
  '<!-- sop-section-start: procedure -->',
  '## Procedure',
  '<!-- sop-step-start id=1 -->',
  '1. Open the admin console and reset the password.',
  '<!-- sop-step-end -->',
  '<!-- sop-section-end -->',
].join('\n');

const REF = [
  '---',
  'id: ref.newsletter',
  'title: Newsletter reference',
  'summary: Newsletter sponsorship reference',
  'doc_type: reference',
  '---',
  '',
  '# Newsletter reference',
  '',
  'Details about newsletter sponsorship and billing.',
].join('\n');


function ev(httpMethod:string,path:string,opts:{query?:Record<string,string>;body?:unknown}={}):LambdaEvent {
 return {httpMethod,path,headers:{},queryStringParameters:opts.query||null,body:opts.body===undefined?null:JSON.stringify(opts.body)};
}
async function call(event:LambdaEvent):Promise<{status:number;body:any}> {
 const response=await handleDocsRoutes(event,'authenticated-test-user');assert.ok(response);
 return {status:response.statusCode,body:JSON.parse(response.body)};
}
describe('S3 authenticated knowledge content routes',()=>{
 let dir:string;let revision:string;
 beforeEach(()=>{mkdirSync(resolve('../.tmp'),{recursive:true});dir=mkdtempSync(resolve('../.tmp/content-api-'));
  const fixture=syntheticKnowledge({'content/accounts/sops/reset-password.md':SOP,'content/newsletter/reference.md':REF},dir);
  configureDocsRuntime(fixture.store);revision=fixture.publication.revision;
 });
 afterEach(()=>{resetDocsRuntime();rmSync(dir,{recursive:true,force:true});});
 it('loads docs, registry, parsed content, search, quality and health without GitHub',async()=>{
  for(const route of ['/docs','/docs/registry','/docs/process-quality','/health','/lint']) assert.equal((await call(ev('GET',route))).status,200);
  const doc=await call(ev('GET','/docs',{query:{path:'content/accounts/sops/reset-password.md'}}));assert.equal(doc.body.revision,revision);assert.equal(doc.body.content,SOP);
  const search=await call(ev('GET','/search',{query:{q:'password'}}));assert.ok(search.body.results.length);
  assert.equal((await call(ev('GET','/docs/resolve',{query:{ref:'ref.newsletter'}}))).status,200);
 });
 it('saves with revision, conflicts stale attempts, requires expected revision and records actor',async()=>{
  const path='content/accounts/sops/reset-password.md';
  assert.equal((await call(ev('PUT','/docs',{query:{path},body:{content:'draft'}}))).status,400);
  const save=await call(ev('PUT','/docs',{query:{path},body:{content:SOP.replace('reset the password.','reset the password and New token.'),expectedRevision:revision}}));assert.equal(save.status,200);assert.notEqual(save.body.revision,revision);
  assert.equal((await call(ev('PUT','/docs',{query:{path},body:{content:'stale',expectedRevision:revision}}))).status,409);
  const history=await call(ev('GET','/knowledge/history',{query:{path}}));assert.equal(history.body.versions[0].actor,'authenticated-test-user');
  const search=await call(ev('GET','/search',{query:{q:'New token'}}));assert.ok(search.body.results.length);
 });
 it('creates with absent precondition and restores a deleted document as a new revision',async()=>{
  const path='content/test/new.md';
  assert.equal((await call(ev('POST','/docs',{body:{path,expectedRevision:revision}}))).status,400);
  const create=await call(ev('POST','/docs',{body:{path,expectedRevision:revision,absent:true}}));assert.equal(create.status,201);
  const deleted=await call(ev('DELETE','/docs',{query:{path},body:{expectedRevision:create.body.revision}}));assert.equal(deleted.status,200);
  assert.equal((await call(ev('GET','/docs',{query:{path}}))).status,404);
  const unavailable=await handleDocsRoutes(ev('GET','/knowledge/version',{query:{path,revision:deleted.body.revision}}),'actor');assert.equal(unavailable?.statusCode,404);
  const restore=await call(ev('POST','/knowledge/restore',{query:{path},body:{expectedRevision:deleted.body.revision,version:create.body.revision}}));assert.equal(restore.status,200);
  assert.equal((await call(ev('GET','/docs',{query:{path}}))).status,200);
 });
 it('rejects repository tooling paths for every knowledge mutation and historical read',async()=>{
  for(const route of ['/knowledge/history','/knowledge/version','/knowledge/download']) {
   assert.equal((await call(ev('GET',route,{query:{path:'.github/workflows/a.yaml',revision}}))).status,400);
  }
  for(const mutation of [{path:'.github/workflows/a.yaml',content:'code'},{path:'content/new.md',sourcePath:'scripts/a.py',absent:true}]) {
   assert.equal((await call(ev('POST','/knowledge/publish',{body:{expectedRevision:revision,mutations:[mutation]}}))).status,400);
  }
  assert.equal((await call(ev('POST','/knowledge/restore',{query:{path:'README.md'},body:{expectedRevision:revision,version:revision}}))).status,400);
  for(const [old_path,new_path] of [['scripts/a.py','content/a.md'],['content/newsletter/reference.md','schemas/a.json']]) {
   assert.equal((await call(ev('POST','/docs/rename',{body:{old_path,new_path,expectedRevision:revision}}))).status,400);
  }
  assert.equal((await call(ev('GET','/knowledge/version',{query:{path:'content/newsletter/reference.md',revision:'unpublished'}}))).status,404);
  assert.equal((await call(ev('GET','/knowledge/history',{query:{path:'content/newsletter/reference.md',cursor:'unpublished'}}))).status,400);
 });
 it('lists the managed manifest by sha256 and records a one-line publication message',async()=>{
  const fixture=syntheticKnowledge({'content/a.md':'alpha','_docs/model.csv':'a,b\n','scripts/tool.py':'print()'},dir);
  configureDocsRuntime(fixture.store);
  const {createHash}=await import('node:crypto');
  const manifest=await call(ev('GET','/knowledge/manifest'));assert.equal(manifest.status,200);
  assert.equal(manifest.body.revision,fixture.publication.revision);
  assert.deepEqual(manifest.body.roots,['content','_docs','workflow-templates','document-templates']);
  assert.deepEqual(manifest.body.entries,{
   '_docs/model.csv':{sha256:createHash('sha256').update('a,b\n').digest('hex'),size:4},
   'content/a.md':{sha256:createHash('sha256').update('alpha').digest('hex'),size:5},
  });
  const published=await call(ev('POST','/knowledge/publish',{body:{expectedRevision:fixture.publication.revision,message:'Publish dataops-knowledge abc123',mutations:[{path:'content/a.md',base64:Buffer.from('beta').toString('base64')}]}}));
  assert.equal(published.status,200);
  const history=await call(ev('GET','/knowledge/history',{query:{path:'content/a.md'}}));
  assert.equal(history.body.versions[0].message,'Publish dataops-knowledge abc123');
  const forced=await handleDocsRoutes(ev('POST','/knowledge/publish',{body:{expectedRevision:published.body.revision,message:'client says',mutations:[{path:'content/a.md',content:'gamma'}]}}),'service','Publish dataops-knowledge def456');
  assert.equal(forced?.statusCode,200);
  assert.equal((await call(ev('GET','/knowledge/history',{query:{path:'content/a.md'}}))).body.versions[0].message,'Publish dataops-knowledge def456');
  for(const message of ['two\nlines','x'.repeat(201),'   ',42]) {
   const rejected=await call(ev('POST','/knowledge/publish',{body:{expectedRevision:JSON.parse(forced!.body).revision,message,mutations:[{path:'content/a.md',content:'delta'}]}}));
   assert.equal(rejected.status,400);
  }
 });
 it('renames atomically and rejects unsafe paths/stateless invalid parse',async()=>{
  const rename=await call(ev('POST','/docs/rename',{body:{old_path:'content/newsletter/reference.md',new_path:'content/newsletter/renamed.md',expectedRevision:revision}}));assert.equal(rename.status,200);
  assert.equal((await call(ev('GET','/docs',{query:{path:'content/newsletter/reference.md'}}))).status,404);
  assert.equal((await call(ev('GET','/docs',{query:{path:'content/newsletter/renamed.md'}}))).status,200);
  assert.equal((await call(ev('GET','/docs',{query:{path:'../secret.md'}}))).status,400);
  assert.equal((await call(ev('POST','/parse',{body:{}}))).status,400);
 });
 it('creates document with parent frontmatter', async () => {
  const path = 'content/test/child.md';
  const res = await call(
   ev('POST', '/docs', {
    body: {
     path,
     title: 'Child Doc',
     doc_type: 'doc',
     parent: 'ref.newsletter',
     absent: true,
     expectedRevision: revision,
    },
   }),
  );
  assert.equal(res.status, 201);
  assert.ok(res.body.content.includes('parent: "ref.newsletter"'));

  const getRes = await call(ev('GET', '/docs', { query: { path } }));
  assert.equal(getRes.status, 200);
  assert.ok(getRes.body.content.includes('parent: "ref.newsletter"'));

  const reg = await call(ev('GET', '/docs/registry'));
  const docInReg = reg.body.documents.find((d: any) => d.path === path);
  assert.ok(docInReg);
  assert.equal(docInReg.parent, 'ref.newsletter');
  assert.equal(docInReg.parent_id, 'ref.newsletter');
 });
 it('moves document to set parent', async () => {
  const path = 'content/accounts/sops/reset-password.md';
  const moveRes = await call(
   ev('POST', '/docs/move', {
    body: {
     path,
     new_parent: 'ref.newsletter',
     expectedRevision: revision,
    },
   }),
  );
  assert.equal(moveRes.status, 200);
  assert.equal(moveRes.body.path, path);
  assert.equal(moveRes.body.parent, 'ref.newsletter');
  assert.notEqual(moveRes.body.revision, revision);

  const getRes = await call(ev('GET', '/docs', { query: { path } }));
  assert.equal(getRes.status, 200);
  assert.ok(getRes.body.content.includes('parent: "ref.newsletter"'));

  const reg = await call(ev('GET', '/docs/registry'));
  const docInReg = reg.body.documents.find((d: any) => d.path === path);
  assert.ok(docInReg);
  assert.equal(docInReg.parent, 'ref.newsletter');
  assert.equal(docInReg.parent_id, 'ref.newsletter');
 });
 it('moves document to clear parent to root', async () => {
  const path = 'content/accounts/sops/reset-password.md';
  const setRes = await call(
   ev('POST', '/docs/move', {
    body: {
     path,
     new_parent: 'ref.newsletter',
     expectedRevision: revision,
    },
   }),
  );
  assert.equal(setRes.status, 200);

  const clearRes = await call(
   ev('POST', '/docs/move', {
    body: {
     path,
     new_parent: null,
     expectedRevision: setRes.body.revision,
    },
   }),
  );
  assert.equal(clearRes.status, 200);
  assert.equal(clearRes.body.parent, null);

  const getRes = await call(ev('GET', '/docs', { query: { path } }));
  assert.equal(getRes.status, 200);
  assert.ok(!getRes.body.content.includes('parent:'));

  const resetRes = await call(
   ev('POST', '/docs/move', {
    body: {
     path,
     new_parent: 'ref.newsletter',
     expectedRevision: clearRes.body.revision,
    },
   }),
  );
  assert.equal(resetRes.status, 200);
  const clearEmpty = await call(
   ev('POST', '/docs/move', {
    body: {
     path,
     new_parent: '',
     expectedRevision: resetRes.body.revision,
    },
   }),
  );
  assert.equal(clearEmpty.status, 200);
  assert.equal(clearEmpty.body.parent, null);
 });
 it('prevents cycles and rejects move under itself or descendant', async () => {
  const selfRes = await call(
   ev('POST', '/docs/move', {
    body: {
     path: 'content/newsletter/reference.md',
     new_parent: 'ref.newsletter',
     expectedRevision: revision,
    },
   }),
  );
  assert.equal(selfRes.status, 400);

  const notFoundParent = await call(
   ev('POST', '/docs/move', {
    body: {
     path: 'content/newsletter/reference.md',
     new_parent: 'nonexistent.doc',
     expectedRevision: revision,
    },
   }),
  );
  assert.equal(notFoundParent.status, 400);

  const m1 = await call(
   ev('POST', '/docs/move', {
    body: {
     path: 'content/accounts/sops/reset-password.md',
     new_parent: 'ref.newsletter',
     expectedRevision: revision,
    },
   }),
  );
  assert.equal(m1.status, 200);

  const cycleRes = await call(
   ev('POST', '/docs/move', {
    body: {
     path: 'content/newsletter/reference.md',
     new_parent: 'sop.accounts.reset-password',
     expectedRevision: m1.body.revision,
    },
   }),
  );
  assert.equal(cycleRes.status, 400);

  const missingDoc = await call(
   ev('POST', '/docs/move', {
    body: {
     path: 'content/missing.md',
     new_parent: 'ref.newsletter',
    },
   }),
  );
  assert.equal(missingDoc.status, 404);
 });
});
describe('contentApi - docs listing content-root contract (offline)', () => {
  const SCRATCH = resolve(__dirname, '..', '..', '.tmp', 'docs-content-api-tests');
  let scratch: string;
  let offlineBefore: string | undefined;

  const COLLECTION_ROUTES = ['/docs', '/docs/registry', '/docs/process-quality'];

  function runtimeFor(cacheDir: string): void {
    configureDocsRuntime(
      new KnowledgeStore({cacheDir}),
    );
  }

  function populatedRoot(name: string): string {
    const cacheDir = join(scratch, name);
    const file = join(cacheDir, 'content', 'accounts', 'sops', 'reset-password.md');
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, SOP);
    return cacheDir;
  }

  beforeEach(() => {
    mkdirSync(SCRATCH, { recursive: true });
    scratch = mkdtempSync(join(SCRATCH, 'root-'));
    offlineBefore = process.env.DTC_OFFLINE;
    process.env.DTC_OFFLINE = '1';
  });

  afterEach(() => {
    resetDocsRuntime();
    if (offlineBefore === undefined) delete process.env.DTC_OFFLINE;
    else process.env.DTC_OFFLINE = offlineBefore;
    rmSync(scratch, { recursive: true, force: true });
  });

  it('lists the documents under a populated content root', async () => {
    runtimeFor(populatedRoot('populated'));
    const { status, body } = await call(ev('GET', '/docs'));
    assert.strictEqual(status, 200);
    assert.deepStrictEqual(
      body.documents.map((doc: any) => doc.path),
      ['content/accounts/sops/reset-password.md'],
    );
  });

  it('returns an empty list for a present but empty content root', async () => {
    const cacheDir = join(scratch, 'empty');
    mkdirSync(join(cacheDir, 'content'), { recursive: true });
    runtimeFor(cacheDir);

    const { status, body } = await call(ev('GET', '/docs'));
    assert.strictEqual(status, 200);
    assert.deepStrictEqual(body, { documents: [] });
  });

  it('fails loudly and names the path when the content root is missing', async () => {
    const cacheDir = join(scratch, 'missing');
    const contentRoot = join(cacheDir, 'content');
    runtimeFor(cacheDir);

    for (const path of [...COLLECTION_ROUTES, '/knowledge/status', '/knowledge/publication']) {
      const { status, body } = await call(ev('GET', path));
      assert.ok(status >= 500 && status < 600, `${path}: expected a 5xx, got ${status}`);
      assert.notStrictEqual(status, 404, `${path}: a missing content root is not a missing document`);
      assert.ok(
        String(body.error).includes(contentRoot),
        `${path}: error must name the configured content root, got ${body.error}`,
      );
    }
    assert.strictEqual(existsSync(contentRoot), false, 'the content root must not be created as a side effect');
  });

  it('still returns 404 for a missing document under a populated content root', async () => {
    runtimeFor(populatedRoot('populated-404'));
    const { status, body } = await call(ev('GET', '/docs', { query: { path: 'does-not-exist.md' } }));
    assert.strictEqual(status, 404);
    assert.strictEqual(body.error, 'Document not found');
  });
});

describe('docs search ranking, snippets and the per-publication index',()=>{
 let dir:string;
 const files={
  'content/a/sops/title-match.md':['---','title: Sponsor invoice checklist','summary: Send the sponsor invoice','doc_type: sop','---','','# Steps','','Prepare the sponsor invoice and email it.'].join('\n'),
  'content/a/reference/body-match.md':['---','title: Alpha reference','summary: Unrelated summary','doc_type: reference','---','','# Notes','','<!-- note -->Some text. Later the [sponsor](https://example.test) pays the invoice in full.'].join('\n'),
  'content/a/reference/no-match.md':['---','title: Zebra','summary: Nothing relevant','doc_type: reference','---','','Plain body.'].join('\n'),
 };
 beforeEach(()=>{mkdirSync(resolve('../.tmp'),{recursive:true});dir=mkdtempSync(resolve('../.tmp/search-rank-'));});
 afterEach(()=>{resetDocsRuntime();rmSync(dir,{recursive:true,force:true});});
 it('keeps relevance order with scores and returns a query snippet without markup',async()=>{
  configureDocsRuntime(syntheticKnowledge(files,dir).store);
  const search=await call(ev('GET','/search',{query:{q:'sponsor invoice'}}));
  const paths=search.body.results.map((r:any)=>r.path);
  assert.deepEqual(paths,['content/a/sops/title-match.md','content/a/reference/body-match.md']);
  assert.ok(search.body.results[0].score>search.body.results[1].score);
  const snippet=search.body.results[1].snippet;
  assert.match(snippet,/sponsor pays the invoice/);
  assert.doesNotMatch(snippet,/<!--|\]\(|https:/);
 });
 it('filters by doc_type inside the index so the limit counts matching documents',async()=>{
  configureDocsRuntime(syntheticKnowledge(files,dir).store);
  const search=await call(ev('GET','/search',{query:{q:'sponsor invoice',doc_type:'reference',limit:'1'}}));
  assert.deepEqual(search.body.results.map((r:any)=>r.path),['content/a/reference/body-match.md']);
 });
 it('reuses one index across requests for a publication and rebuilds after a new one',async()=>{
  const fixture=syntheticKnowledge(files,dir);
  const freshStore=()=>new KnowledgeStore({bucket:'test-knowledge',client:fixture.s3 as any,cacheDir:dir,offline:false});
  configureDocsRuntime(freshStore());
  assert.equal((await call(ev('GET','/search',{query:{q:'sponsor'}}))).body.results.length,2);
  // A second request (new runtime, new store) on the same publication must not re-read the corpus.
  const rt=configureDocsRuntime(freshStore());
  let rebuilt=0;const rebuild=rt.rebuildSearch.bind(rt);rt.rebuildSearch=()=>{rebuilt+=1;rebuild();};
  assert.equal((await call(ev('GET','/search',{query:{q:'sponsor'}}))).body.results.length,2);
  assert.equal(rebuilt,0);
  // Publishing from elsewhere moves the active pointer; the next request rebuilds.
  const writer=freshStore();const head=await writer.pin();
  await writer.publish([{path:'content/a/reference/no-match.md',bytes:['---','title: Zebra sponsor','doc_type: reference','---','','Now about sponsors.'].join('\n')}],head.revision,'test','edit');
  const next=configureDocsRuntime(freshStore());
  let rebuiltAfter=0;const rebuildNext=next.rebuildSearch.bind(next);next.rebuildSearch=()=>{rebuiltAfter+=1;rebuildNext();};
  assert.equal((await call(ev('GET','/search',{query:{q:'sponsor'}}))).body.results.length,3);
  assert.equal(rebuiltAfter,1);
 });
});
