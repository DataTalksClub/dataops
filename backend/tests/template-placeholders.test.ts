import {test} from 'node:test';
import assert from 'node:assert/strict';
import {syntheticKnowledge} from './helpers/knowledge';
import {newDocContent} from '../src/docs/docScaffolds';
const valid='---\ndoc_type: template\n---\n## Template\n```text\nHello <NAME>\n```\n## Placeholders\n| Placeholder | What to put there | Example |\n| --- | --- | --- |\n| <NAME> | Recipient name | Alex |\n';
test('publication rejects malformed templates before any mutation and protects existing identity',async()=>{
 const {store,s3,publication}=syntheticKnowledge({'content/mail.md':valid,'content/sop.md':'old'});
 const before=[...s3.objects.keys()];
 await assert.rejects(()=>store.publish([{path:'content/sop.md',bytes:'changed'},{path:'content/mail.md',bytes:'## Template\n```\nHello <NAME>\n```'}],publication.revision,'actor','Edit'),/Missing explanation/);
 await assert.rejects(()=>store.publish([{path:'content/mail.md',bytes:'---\ntitle: Example\n---\ndoc_type: reference\n## Template\n```\nHello <NAME>\n```'}],publication.revision,'actor','Edit'),/Missing explanation/);
 assert.deepEqual([...s3.objects.keys()],before);
 assert.equal((await store.pin()).revision,publication.revision);
 const saved=await store.publish([{path:'content/mail.md',bytes:valid.replace('Hello','Welcome')}],publication.revision,'actor','Edit');
 assert.notEqual(saved.revision,publication.revision);
});
test('path identity validates new files and renames; ordinary SOP markdown remains valid',async()=>{
 const {store,publication}=syntheticKnowledge({'content/sop.md':'# SOP\nUse <NAME> as an example'});
 await assert.rejects(()=>store.publish([{path:'content/example/templates/mail.md',bytes:'# Missing template'}],publication.revision,'actor','Create'),/fenced body/);
 await assert.rejects(()=>store.publish([{path:'content/example/templates/mail.md',sourcePath:'content/sop.md'}],publication.revision,'actor','Rename'),/fenced body/);
 const saved=await store.publish([{path:'content/sop.md',bytes:'# SOP\nNo template table needed'}],publication.revision,'actor','Edit');
 assert.ok(saved.entries['content/sop.md']);
});
test('editor template scaffold satisfies the convention',async()=>{
 const {templateParser}=await import('../src/docs/templatePlaceholders');
 assert.deepEqual((await templateParser()).parseTemplatePlaceholders(newDocContent('Example','template','','full')).issues,[]);
});
test('API create validates explicit template type even when supplied content lacks frontmatter',async()=>{
 const {configureDocsRuntime,resetDocsRuntime,handleDocsRoutes}=await import('../src/docs/contentApi');
 const {store,publication}=syntheticKnowledge({});
 configureDocsRuntime(store);
 try {
  const response=await handleDocsRoutes({httpMethod:'POST',path:'/docs',headers:{},queryStringParameters:null,body:JSON.stringify({path:'content/example.md',doc_type:'template',content:'No template body',absent:true,expectedRevision:publication.revision})},'actor');
  assert.equal(response?.statusCode,400);
  assert.match(response?.body || '',/fenced body/);
  assert.equal((await store.pin()).revision,publication.revision);
 } finally {resetDocsRuntime();}
});
