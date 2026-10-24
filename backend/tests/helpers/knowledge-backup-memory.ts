/** Large history generated on demand: the fixture itself never retains the chain. */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {ReadStream,existsSync} from 'node:fs';
import {KnowledgeStore,type Publication} from '../../src/docs/knowledgeStore';
import {KnowledgeJobs} from '../../src/knowledge/worker';

async function main() {
  const revisions=400;const entries=2500;let read=0;let heads=0;let uploaded=0;let spool='';
  const publication=(n:number):Publication=>({schemaVersion:1,revision:String(n),parent:n?String(n-1):null,createdAt:'2026-10-24T00:00:00Z',actor:'synthetic',message:'Synthetic history',changes:[],entries:Object.fromEntries(Array.from({length:entries},(_,i)=>{
    const path=`content/${'synthetic-'.repeat(8)}${i}.md`;
    return [path,{path,sha:i.toString(16).padStart(64,'0'),size:1,type:'blob' as const}];
  }))});
  const client={send:async(command:any)=>{
    const i=command.input;
    if(command.constructor.name==='GetObjectCommand') {
      if(i.Key==='active.json')return {Body:{transformToString:async()=>JSON.stringify({revision:String(revisions-1)})}};
      read++;return {Body:{transformToString:async()=>JSON.stringify(publication(Number(i.Key.split('/')[1].split('.')[0])))}};
    }
    if(command.constructor.name==='HeadObjectCommand') {heads++;return {ContentLength:1};}
    assert.equal(command.constructor.name,'PutObjectCommand');
    assert.ok(i.Body instanceof ReadStream,'snapshot must be uploaded as a disk stream');spool=String(i.Body.path);
    const hash=createHash('sha256');
    for await(const chunk of i.Body) {uploaded+=chunk.length;hash.update(chunk);}
    assert.equal(uploaded,i.ContentLength);assert.equal(hash.digest('hex'),i.Metadata.sha256);
    return {};
  }};
  const job=new KnowledgeJobs(new KnowledgeStore({bucket:'synthetic',client:client as any}),'synthetic-backup');
  job.chain=async()=>{throw new Error('Backup must not retain the publication chain');};
  await job.backup();
  assert.equal(read,revisions);assert.equal(heads,entries);assert.equal(existsSync(spool),false);
  assert.ok(uploaded>256*1024*1024,'fixture must exceed the memory budget');
  const maxRssBytes=process.resourceUsage().maxRSS*1024;
  assert.ok(maxRssBytes<256*1024*1024,`peak RSS ${maxRssBytes} must remain below 256 MiB`);
  console.log(JSON.stringify({revisions,entries,uploaded,maxRssBytes}));
}
main().catch(error=>{console.error(error);process.exitCode=1;});
