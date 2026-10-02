import { createHash } from 'crypto';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import type { Invoice, InvoiceFields } from './model';
export interface PublicationConfig {
  brokerUrl: string; brokerCredential: string; agent: string;
  googleConnection: string; googleAccountId: string; dropboxConnection: string; dropboxAccountId: string;
  spreadsheetId: string; sheetTab: string; dropboxRoot: string; monthFolderPrefix: string;
}
export interface Providers {
  bindingKey?: string;
  readiness(): Promise<Array<{name:string;ready:boolean;message:string}>>;
  sheetLayout(): Promise<{headers:string[]; rows:string[][]; destinationKey:string}>;
  readRow(row:number): Promise<string[]>;
  writeRow(row:number, values:string[]): Promise<void>;
  findRow(marker:string): Promise<{row:number;values:string[]} | null>;
  readDropbox(path:string): Promise<{bytes:Buffer;reference:string} | null>;
  writeDropbox(path:string,bytes:Buffer): Promise<void>;
  dropboxPath(invoice:Invoice): string;
}
let secretClient = new SecretsManagerClient({});
let fetcher: typeof fetch = fetch;
export function setInvoiceProviderClientsForTests(value: {secrets?: SecretsManagerClient; fetch?:typeof fetch}) { if(value.secrets) secretClient=value.secrets; fetcher=value.fetch || fetch; }
export async function publicationConfig(): Promise<PublicationConfig | null> {
  const inline = process.env.NODE_ENV === 'test' ? process.env.INVOICE_PUBLICATION_CONFIG : undefined;
  const name = process.env.INVOICE_PUBLICATION_SECRET_NAME;
  if (!inline && !name) return null;
  const raw = inline || (await secretClient.send(new GetSecretValueCommand({SecretId:name}))).SecretString;
  if (!raw) throw new Error('publication-config-unavailable');
  const config = JSON.parse(raw.trim().startsWith('{') ? raw : Buffer.from(raw,'base64').toString('utf8')) as PublicationConfig;
  for (const key of ['brokerUrl','brokerCredential','agent','googleConnection','googleAccountId','dropboxConnection','dropboxAccountId','spreadsheetId','sheetTab','dropboxRoot','monthFolderPrefix'] as const)
    if (typeof config[key] !== 'string' || !config[key] || config[key].length>2000) throw new Error(`missing-${key}`);
  if (!/^https:\/\/[^/?#]+(?:\/[^?#]*)?$/.test(config.brokerUrl) || !config.dropboxRoot.startsWith('/') || /[\x00-\x1f]/.test(config.sheetTab) || /[\/\x00-\x1f]/.test(config.monthFolderPrefix)) throw new Error('invalid-publication-config');
  return config;
}
const requiredHeaders = ['Date sent','Date paid','Provider','What','Price, $','Price, EUR','Statement','Count','Entry Type','Type','Period','Category'];
export function validateHeaders(headers:string[]) {
  if (headers.length > 64 || requiredHeaders.some(h => headers.filter(x=>x===h).length !== 1)) throw new Error('incompatible-sheet-headers');
}
export const marker = (invoice:Invoice) => `[dataops:${invoice.id}]`;
export function sheetValues(invoice:Invoice,headers:string[]): string[] {
  validateHeaders(headers);
  const f:InvoiceFields = invoice.fields;
  const cells:Record<string,string> = {'Date sent':f.transactionDate!, 'Date paid':f.paidDate!, Provider:f.counterparty!, What:f.description!, 'Price, $': f.currency==='USD' ? `-${f.amount}`:'', 'Price, EUR':`-${f.amountEur}`, Statement:`${f.statementRef || ''} ${marker(invoice)} document:${invoice.source.artifactId}`.trim(), Count:String(f.quantity || 1), Comment:[f.comment,f.paymentEvidence].filter(Boolean).join('; '), 'Entry Type':'expense', Type:f.subtype || '', Period:f.period || '', Category:f.category || ''};
  return headers.map(h=>cells[h] || '');
}
function column(index:number) { let result=''; for(let n=index;n>0;n=Math.floor((n-1)/26)) result=String.fromCharCode(65+(n-1)%26)+result; return result; }
export async function officialProviders(config:PublicationConfig): Promise<Providers> {
  const tokens = new Map<string,string>();
  async function request(url:string, init:RequestInit) {
    let response:Response;
    try { response = await fetcher(url,{...init, signal:AbortSignal.timeout(15000)}); }
    catch { throw new Error('provider-response-unknown'); }
    return response;
  }
  async function token(kind:'google'|'dropbox') {
    if(tokens.has(kind)) return tokens.get(kind)!;
    const result = await request(`${config.brokerUrl.replace(/\/$/,'')}/api/agent/token`,{method:'POST',headers:{Authorization:`Bearer ${config.brokerCredential}`,'Content-Type':'application/json'},body:JSON.stringify({connection_id:kind==='google'?config.googleConnection:config.dropboxConnection,agent:config.agent})});
    if(!result.ok) throw new Error(`broker-${kind}-${result.status===403?'grant-denied':result.status===401?'authentication-failed':'unavailable'}`);
    const value=await result.json() as {access_token:string;scope:string|string[];provider_account_id:string};
    if(value.provider_account_id !== (kind==='google'?config.googleAccountId:config.dropboxAccountId)) throw new Error(`${kind}-account-mismatch`);
    const scopes = Array.isArray(value.scope) ? value.scope : String(value.scope).split(/[ ,]+/);
    const required=kind==='google'?['https://www.googleapis.com/auth/spreadsheets']:['files.content.write','files.content.read','files.metadata.read'];
    if(required.some(s=>!scopes.includes(s))) throw new Error(`${kind}-scope-missing`);
    if(typeof value.access_token!=='string' || !value.access_token) throw new Error('broker-token-unavailable');
    tokens.set(kind,value.access_token); return value.access_token;
  }
  const tab=`'${config.sheetTab.replace(/'/g,"''")}'`;
  async function google(range:string,method='GET',body?:unknown):Promise<{values?:string[][]}> {
    const url=`https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(config.spreadsheetId)}/values/${encodeURIComponent(range)}${method==='PUT'?'?valueInputOption=RAW':'?valueRenderOption=UNFORMATTED_VALUE'}`;
    const response=await request(url,{method,headers:{Authorization:`Bearer ${await token('google')}`,'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});
    if(!response.ok) throw new Error(`sheets-${response.status===403?'access-denied':response.status===404?'destination-missing':'unavailable'}`);
    return await response.json() as {values?:string[][]};
  }
  let headers:string[]=[];
  return {
    bindingKey:createHash('sha256').update(JSON.stringify({googleAccountId:config.googleAccountId,dropboxAccountId:config.dropboxAccountId,spreadsheetId:config.spreadsheetId,sheetTab:config.sheetTab,dropboxRoot:config.dropboxRoot,monthFolderPrefix:config.monthFolderPrefix})).digest('hex'),
    async readiness() {
      const checks=[];
      for(const kind of ['google','dropbox'] as const) { try { await token(kind); checks.push({name:`${kind}-broker-account-scopes`,ready:true,message:'Verified scoped broker token for configured account'}); } catch(e) {checks.push({name:`${kind}-broker-account-scopes`,ready:false,message:(e as Error).message});} }
      try { const rows=(await google(`${tab}!A1:BL1`)).values || []; validateHeaders(rows[0] || []); checks.push({name:'sheet-headers',ready:true,message:'Configured tab headers verified'}); } catch(e) {checks.push({name:'sheet-headers',ready:false,message:(e as Error).message});}
      try {const r=await request('https://api.dropboxapi.com/2/files/get_metadata',{method:'POST',headers:{Authorization:`Bearer ${await token('dropbox')}`,'Content-Type':'application/json'},body:JSON.stringify({path:config.dropboxRoot})}); if(!r.ok || (await r.json() as {'.tag':string})['.tag']!=='folder') throw new Error('dropbox-destination-missing');checks.push({name:'dropbox-folder',ready:true,message:'Configured archive folder verified'});}catch(e){checks.push({name:'dropbox-folder',ready:false,message:(e as Error).message});}
      return checks;
    },
    async sheetLayout() { const rows=(await google(`${tab}!A:BL`)).values || []; headers=(rows[0] || []).map(String); validateHeaders(headers); return {headers,rows:rows.map(row=>row.map(String)),destinationKey:createHash('sha256').update(`${config.spreadsheetId}\n${config.sheetTab}`).digest('hex')}; },
    async readRow(row) {return ((await google(`${tab}!A${row}:${column(headers.length)}${row}`)).values?.[0] || []).map(String);},
    async writeRow(row,values) {await google(`${tab}!A${row}:${column(values.length)}${row}`,'PUT',{values:[values.map((v,i)=>['Price, $','Price, EUR','Count'].includes(headers[i]) && v ? Number(v) : v)]});},
    async findRow(id) {const rows=(await google(`${tab}!A:BL`)).values || [];const matches=rows.map((values,i)=>({row:i+1,values:values.map(String)})).filter(r=>r.values.some(c=>c.includes(id))); if(matches.length>1) throw new Error('sheet-duplicate-operation'); return matches[0] || null;},
    async readDropbox(path) { const r=await request('https://content.dropboxapi.com/2/files/download',{method:'POST',headers:{Authorization:`Bearer ${await token('dropbox')}`,'Dropbox-API-Arg':JSON.stringify({path})}}); if(r.status===409) { const error=await r.json() as {error_summary?:string}; if(error.error_summary?.startsWith('path/not_found')) return null; throw new Error('dropbox-read-failed'); } if(!r.ok) throw new Error('dropbox-read-failed'); const meta=JSON.parse(r.headers.get('Dropbox-API-Result') || '{}') as {id?:string};return {bytes:Buffer.from(await r.arrayBuffer()),reference:meta.id || path}; },
    async writeDropbox(path,bytes) {
      const relative=path.slice(config.dropboxRoot.replace(/\/$/,'').length+1).split('/').slice(0,-1);
      let parent=config.dropboxRoot.replace(/\/$/,'');
      for(const segment of relative) {
        parent+=`/${segment}`;
        const directory=await request('https://api.dropboxapi.com/2/files/create_folder_v2',{method:'POST',headers:{Authorization:`Bearer ${await token('dropbox')}`,'Content-Type':'application/json'},body:JSON.stringify({path:parent,autorename:false})});
        if(!directory.ok) {
          const metadata=await request('https://api.dropboxapi.com/2/files/get_metadata',{method:'POST',headers:{Authorization:`Bearer ${await token('dropbox')}`,'Content-Type':'application/json'},body:JSON.stringify({path:parent})});
          if(!metadata.ok || (await metadata.json() as {'.tag':string})['.tag']!=='folder') throw new Error('dropbox-archive-folder-unavailable');
        }
      }
      const r=await request('https://content.dropboxapi.com/2/files/upload',{method:'POST',headers:{Authorization:`Bearer ${await token('dropbox')}`,'Content-Type':'application/octet-stream','Dropbox-API-Arg':JSON.stringify({path,mode:'add',autorename:false,mute:true,strict_conflict:true})},body:new Uint8Array(bytes)}); if(!r.ok) throw new Error('dropbox-write-outcome-requires-reconciliation');},
    dropboxPath(invoice) {const vendor=(invoice.fields.counterparty || 'invoice').replace(/[^a-zA-Z0-9_-]/g,'_').slice(0,70);const date=invoice.fields.transactionDate!;return `${config.dropboxRoot.replace(/\/$/,'')}/${date.slice(0,4)}/${config.monthFolderPrefix}${date.slice(0,7)}/${date}-${vendor}-${invoice.id}.pdf`;},
  };
}
