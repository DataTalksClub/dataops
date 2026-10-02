import {randomUUID} from 'node:crypto';
import {KnowledgeStore,checksum,type Publication} from '../../src/docs/knowledgeStore';
/** Faithful conditional-object semantics, injected at the SDK boundary; no GitHub calls. */
export class MemoryS3 {
  objects=new Map<string,Buffer>(); etags=new Map<string,string>();calls:{name:string;input:any}[]=[];
  failKey='';
  send=async(command:any):Promise<any>=>{
    const i=command.input;const key=`${i.Bucket}/${i.Key}`;const name=command.constructor.name;this.calls.push({name,input:i});
    if(i.Key===this.failKey) throw new Error('Injected storage failure');
    const old=this.objects.get(key);const etag=this.etags.get(key);
    if(name==='GetObjectCommand') {
      if(!old) throw Object.assign(new Error('Missing object'),{name:'NoSuchKey'});
      return {ETag:etag,Body:{transformToString:async()=>old.toString(),transformToByteArray:async()=>new Uint8Array(old)}};
    }
    if(name==='HeadObjectCommand') {if(!old) throw Object.assign(new Error('Missing object'),{name:'NotFound'});return{ETag:etag,ContentLength:old.length};}
    if(name==='PutObjectCommand' || name==='CopyObjectCommand') {
      if((i.IfNoneMatch==='*' && old) || (i.IfMatch && i.IfMatch!==etag)) throw Object.assign(new Error('Conditional conflict'),{name:'PreconditionFailed'});
      const bytes=name==='CopyObjectCommand'?this.objects.get(i.CopySource):Buffer.from(i.Body);
      if(!bytes) throw new Error('Missing copy source');this.objects.set(key,bytes);const next=`"${randomUUID()}"`;this.etags.set(key,next);return{ETag:next};
    }
    throw new Error(`Unexpected command ${name}`);
  };
  seed(files:Record<string,string|Uint8Array>,bucket='test-knowledge'):Publication {
    const entries:Publication['entries']={};
    for(const [path,body] of Object.entries(files)) {const bytes=Buffer.from(body);const sha=checksum(bytes);this.objects.set(`${bucket}/objects/${sha}`,bytes);entries[path]={path,sha,size:bytes.length,type:'blob'};}
    const p:Publication={schemaVersion:1,revision:randomUUID(),parent:null,actor:'migration-test',createdAt:new Date().toISOString(),message:'Import synthetic files',entries,changes:Object.keys(files).map(path=>({path,operation:'import'}))};
    this.objects.set(`${bucket}/publications/${p.revision}.json`,Buffer.from(JSON.stringify(p)));this.objects.set(`${bucket}/active.json`,Buffer.from(JSON.stringify({revision:p.revision})));this.etags.set(`${bucket}/active.json`,'"initial"');return p;
  }
}
export function syntheticKnowledge(files:Record<string,string|Uint8Array>,cacheDir?:string) {
  const s3=new MemoryS3();const publication=s3.seed(files);const store=new KnowledgeStore({bucket:'test-knowledge',client:s3 as any,cacheDir,offline:false});return{s3,store,publication};
}
