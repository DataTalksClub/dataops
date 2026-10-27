import {it} from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {existsSync} from 'node:fs';
import {KnowledgeJobs} from '../src/knowledge/worker';
import {KNOWLEDGE_LEASE_MS,withKnowledgeJobLease} from '../src/knowledge/lease';
import {syntheticKnowledge} from './helpers/knowledge';
import {DynamoDBClient} from '@aws-sdk/client-dynamodb';
import {KMSClient} from '@aws-sdk/client-kms';

it('loads the mirror token through the context-bound reader and caches it per job',async t=>{
  const env={...process.env};t.after(()=>{process.env=env;});
  Object.assign(process.env,{DATAOPS_SECRETS_TABLE:'fixture-secrets',DATAOPS_SECRETS_KMS_KEY:'fixture-key',AWS_REGION:'eu-west-1',GITHUB_TOKEN_SECRET_NAME:'dataops-v1.knowledge.github-token'});
  let reads=0;
  t.mock.method(DynamoDBClient.prototype,'send',async(command:any)=>{
    reads++;assert.equal(command.input.Key.SK.S,'SECRET#dataops-v1.knowledge.github-token');
    return {Item:{data:{S:Buffer.from('ciphertext').toString('base64')}}};
  });
  t.mock.method(KMSClient.prototype,'send',async(command:any)=>{
    assert.deepEqual(command.input.EncryptionContext,{secret:'dataops-v1.knowledge.github-token'});
    return {Plaintext:Buffer.from(JSON.stringify({value:'fixture-mirror-token'}))};
  });
  const fetcher=(async(_url:any,options:any)=>{
    assert.equal(options.headers.authorization,'Bearer fixture-mirror-token');
    return new Response('{}',{status:200});
  }) as typeof fetch;
  const jobs=new KnowledgeJobs(syntheticKnowledge({}).store,'fixture-backups',fetcher);
  await jobs.github('GET','/git/ref/heads/main');
  await jobs.github('GET','/git/ref/heads/main');
  assert.equal(reads,1);
});

it('streams a large historical repository within a 256 MiB RSS bound',async()=>{
  // Linux carries the parent's peak RSS across exec. Fork Node from a small
  // shell so the oracle measures this workload, not the test runner's imports.
  const {stdout}=await promisify(execFile)('/bin/sh',['-c','"$@"; result=$?; exit "$result"','knowledge-memory',process.execPath,'--max-old-space-size=96','--import','tsx',require.resolve('./helpers/knowledge-backup-memory.ts')],{timeout:120_000});
  const measured=JSON.parse(stdout.trim());
  assert.ok(measured.uploaded>256*1024*1024);assert.ok(measured.maxRssBytes<256*1024*1024);
  console.log(`Backup memory regression: ${JSON.stringify(measured)}`);
});

it('removes the temporary snapshot after upload failure',async()=>{
  const {store,s3}=syntheticKnowledge({'content/synthetic.md':'synthetic'});const send=s3.send;let spool='';
  s3.send=async(command:any)=>{
    if(command.constructor.name==='PutObjectCommand' && command.input.Key.startsWith('snapshots/')) {
      spool=String(command.input.Body.path);assert.ok(existsSync(spool));throw new Error('Synthetic upload failure');
    }
    return send(command);
  };
  await assert.rejects(()=>new KnowledgeJobs(store,'protected').backup(),/Synthetic upload failure/);
  assert.ok(spool);assert.equal(existsSync(spool),false);
});

it('reclaims a dead worker lease after expiry, using the existing ETag',async t=>{
  const now=Date.now();t.mock.method(Date,'now',()=>now);
  const {store,s3}=syntheticKnowledge({});const key=`${store.bucket}/jobs/knowledge-backup/lease.json`;
  s3.objects.set(key,Buffer.from(JSON.stringify({owner:'dead-worker',expiresAt:now+KNOWLEDGE_LEASE_MS})));s3.etags.set(key,'"dead-worker"');
  let runs=0;
  await assert.rejects(()=>withKnowledgeJobLease(store,'knowledge-backup',async()=>{runs++;}),/already running/);
  t.mock.method(Date,'now',()=>now+60_000);
  await withKnowledgeJobLease(store,'knowledge-backup',async()=>{runs++;});
  assert.equal(runs,1);assert.equal(JSON.parse(s3.objects.get(key)!.toString()).expiresAt,0);
  const puts=s3.calls.filter(call=>call.name==='PutObjectCommand');assert.equal(puts[0].input.IfMatch,'"dead-worker"');
});

it('renews a live lease and releases it using the renewed ETag',async t=>{
  t.mock.timers.enable({apis:['setInterval','Date'],now:1_000_000});
  const {store,s3}=syntheticKnowledge({});const key=`${store.bucket}/jobs/knowledge-backup/lease.json`;
  await withKnowledgeJobLease(store,'knowledge-backup',async signal=>{
    const first=JSON.parse(s3.objects.get(key)!.toString());const firstEtag=s3.etags.get(key);
    t.mock.timers.tick(10_000);await new Promise(resolve=>setImmediate(resolve));
    assert.equal(JSON.parse(s3.objects.get(key)!.toString()).expiresAt,first.expiresAt+10_000);
    assert.notEqual(s3.etags.get(key),firstEtag);assert.equal(signal.aborted,false);
  });
  assert.equal(JSON.parse(s3.objects.get(key)!.toString()).expiresAt,0);
});

it('aborts on lease loss without releasing its successor',async t=>{
  t.mock.timers.enable({apis:['setInterval','Date'],now:1_000_000});
  const {store,s3}=syntheticKnowledge({});const key=`${store.bucket}/jobs/knowledge-backup/lease.json`;
  await assert.rejects(()=>withKnowledgeJobLease(store,'knowledge-backup',async signal=>{
    s3.objects.set(key,Buffer.from(JSON.stringify({owner:'successor',expiresAt:2_000_000})));s3.etags.set(key,'"successor"');
    t.mock.timers.tick(10_000);await new Promise(resolve=>setImmediate(resolve));
    assert.equal(signal.aborted,true);
  }),{name:'PreconditionFailed'});
  assert.equal(JSON.parse(s3.objects.get(key)!.toString()).owner,'successor');assert.equal(s3.etags.get(key),'"successor"');
});
