import {randomUUID} from 'node:crypto';
import {PutObjectCommand} from '@aws-sdk/client-s3';
import {KnowledgeStore} from '../docs/knowledgeStore';

// Lambda's first asynchronous retry waits one minute. A killed worker stops
// renewing, so its lease expires before that retry, rather than lasting 16 min.
export const KNOWLEDGE_LEASE_MS=45_000;
const RENEW_MS=10_000;
export async function withKnowledgeJobLease<T>(store:KnowledgeStore,job:string,run:(signal:AbortSignal)=>Promise<T>):Promise<T> {
  const key=`jobs/${job}/lease.json`;const owner=randomUUID();let etag:string|undefined;
  try {
    const lock=await store.json<{expiresAt:number}>(key);
    if(lock.value.expiresAt>Date.now()) throw new Error('Knowledge job already running');
    etag=lock.etag;
    if(!etag) throw new Error('Knowledge lease has no concurrency token');
  } catch(err) {if(!['NoSuchKey','NotFound'].includes((err as Error).name)) throw err;}
  const put=(condition:{IfMatch:string}|{IfNoneMatch:string},expiresAt:number)=>store.client.send(new PutObjectCommand({Bucket:store.bucket,Key:key,Body:JSON.stringify({owner,expiresAt}),...condition}));
  const lease=await put(etag?{IfMatch:etag}:{IfNoneMatch:'*'},Date.now()+KNOWLEDGE_LEASE_MS);
  etag=lease.ETag;
  if(!etag) throw new Error('Knowledge lease has no concurrency token');
  const controller=new AbortController();let renewing:Promise<void>|undefined;
  const timer=setInterval(()=>{
    if(renewing || controller.signal.aborted) return;
    renewing=put({IfMatch:etag!},Date.now()+KNOWLEDGE_LEASE_MS)
      .then(next=>{if(!next.ETag)throw new Error('Knowledge lease has no concurrency token');etag=next.ETag;})
      .catch(error=>{controller.abort(error);})
      .finally(()=>{renewing=undefined;});
  },RENEW_MS);
  timer.unref();
  try {
    const result=await run(controller.signal);controller.signal.throwIfAborted();return result;
  } finally {
    clearInterval(timer);await renewing;
    // An uncertain renewal or a successor's ETag must never be overwritten.
    if(!controller.signal.aborted) await put({IfMatch:etag!},0);
    controller.signal.throwIfAborted();
  }
}
