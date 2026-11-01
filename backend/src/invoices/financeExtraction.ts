import { BlankConversionError, extractInvoiceText, normalizePdfText, pdfText, type InvoiceHints } from './extract';
import { extractWithLlm, needsPdfInput, type LlmExtraction, type LlmResult } from './llm';
import { date, validCurrency, type Invoice, type InvoiceFields } from './model';
import { loadEcbRates } from '../finance/rates';

type Facts = LlmExtraction;
const decimal = '(\\d[\\d.,]*[.,]\\d{2})';
function amount(raw?: string): string | null {
  if (!raw) return null;
  const comma = raw.lastIndexOf(','), dot = raw.lastIndexOf('.');
  const cleaned = comma > dot ? raw.replace(/\./g, '').replace(',', '.') : raw.replace(/,/g, '');
  return /^\d+\.\d{2}$/.test(cleaned) ? Number(cleaned).toFixed(2) : null;
}
const pick = (text: string, pattern: string) => amount(new RegExp(pattern, 'im').exec(text)?.[1]);
function blank(): Facts { return { docType:'invoice', direction:'expense', counterparty:null, invoiceNumber:null, date:null, currency:null, net:null, vat:null, gross:null, vatRate:null, reverseCharge:false, paymentChannel:null, description:null, confidence:'low', uncertainFields:[] }; }

/** Explicit labeled totals for an independent cross-check; never sums line VAT. */
export function regexFinanceFacts(raw: string): Facts {
  const text = normalizePdfText(raw);
  const old = extractInvoiceText(raw).fields;
  const f = Object.assign(blank(), { counterparty: old.counterparty || null, invoiceNumber:old.invoiceNumber || null, date:old.transactionDate || null, currency:old.currency || null, gross:old.amount || null, description:old.description || null });
  f.reverseCharge = /reverse[ -]charge|§\s*13b|Steuerschuldnerschaft.*Leistungsempfängers/i.test(text);
  f.net = pick(text, `(?:^|\\n)\\s*(?:Net Charges \\(After Credits/Discounts, excl\\. Tax\\)|Gesamt netto|Subtotal(?: \\(excl\\. VAT\\))?|Net(?: amount)?|Total excl\\. VAT)\\s*[:]?\\s*(?:USD|EUR|€|\\$)?\\s*${decimal}`);
  f.vat = pick(text, `(?:^|\\n)\\s*(?:TOTAL VAT|VAT(?: amount)?|Umsatzsteuer|Tax)\\s*[:]?\\s*(?:USD|EUR|€|\\$)?\\s*${decimal}`);
  const rate = /(?:VAT\s*[-:]?\s*|Tax rate\s*|^\s*)(\d{1,2}(?:[.,]\d{1,2})?)\s*%/im.exec(text);
  if (rate) f.vatRate = rate[1].replace(',', '.');
  const taxAtRate = new RegExp(`(?:VAT|Tax|Umsatzsteuer)\\s*\\(?\\d{1,2}(?:[.,]\\d{1,2})?\\s*%\\)?\\s*(?:USD|EUR|€|\\$)?\\s*${decimal}`, 'i').exec(text);
  if (taxAtRate) f.vat = amount(taxAtRate[1]);
  if (f.reverseCharge && f.net && f.gross === f.net) { f.vat = '0.00'; f.vatRate = '0'; }
  if (/(?:^|\n)\s*(?:credit note|refund|Gutschrift|Stornorechnung)\b/i.test(text)) {
    f.docType='credit_note'; f.direction='income';
    // Original invoice totals are not the tax base of a partial refund.
    f.net=pick(text,`(?:Credited subtotal|Refunded net|Net credit)\\s*[:]?\\s*[-−]?\\s*(?:USD|EUR|€|\\$)?\\s*${decimal}`);
    f.vat=pick(text,`(?:Credited tax|Refunded VAT|VAT credit)\\s*[:]?\\s*[-−]?\\s*(?:USD|EUR|€|\\$)?\\s*${decimal}`);
  }
  else if (/\bReceipt\b/.test(text)) f.docType='receipt';
  return f;
}

type Template = { name: string; match: (text:string)=>boolean; parse: (text:string, base:Facts)=>Facts };
/** Layout identity and required labels, rather than a sender email, select templates. */
export const FINANCE_TEMPLATES: Template[] = [
  { name:'aws', match:t=>/Amazon Web Services/.test(t)&&/VAT Invoice Number:/.test(t), parse:(t,f)=>({...f,counterparty:/Amazon Web Services EMEA SARL/.test(t)?'Amazon Web Services EMEA SARL':'Amazon Web Services',vatRate:/VAT\s*-\s*19%/.test(t)?'19':f.vatRate}) },
  { name:'hetzner', match:t=>/Hetzner Online GmbH/.test(t)&&/Tax code\s+Tax rate/.test(t), parse:(t,f)=>{
    const row = new RegExp(`(?:^|\\n)Total\\s+€\\s*${decimal}\\s+€\\s*${decimal}\\s+€\\s*${decimal}`,'m').exec(t);
    const d=/Invoice date:\s*(\d{2})\/(\d{2})\/(\d{4})/.exec(t);
    return {...f,counterparty:'Hetzner Online GmbH',currency:'EUR',net:amount(row?.[1]),vat:amount(row?.[2]),gross:amount(row?.[3]),vatRate:/19\s*%/.test(t)?'19':null,date:d?`${d[3]}-${d[2]}-${d[1]}`:null};
  } },
  { name:'finom', match:t=>/Created with\s+Finom\.co/.test(t)&&/Total taxable/.test(t), parse:(t,f)=>{
    const total = new RegExp(`Total taxable\\s+${decimal}\\s*€\\s+${decimal}\\s*€`).exec(t);
    const lines=t.split('\n').map(l=>l.trim()).filter(Boolean);
    const headerEnd=lines.findIndex(l=>/^Invoice No\./.test(l));
    const first=lines.slice(0,headerEnd).map((l,i)=>/^DataTalks\.?Club\b/i.test(l)?i:-1).filter(i=>i>=0).pop() ?? -1;
    // Issuer blocks may repeat before the recipient. Use the final issuer
    // header and the end of its address, never a footer's bank details.
    const addressEnd=first<0?-1:lines.findIndex((l,i)=>i>=first&&i<=first+3&&/\b\d{5}\s+Berlin\b/i.test(l));
    const recipient=addressEnd>=0&&addressEnd+1<headerEnd?lines[addressEnd+1]:null;
    const allZero=/VAT \(%\)/.test(t)&&/\s0\s+[\d.,]+\s*€/.test(t)&&total?.[1]===total?.[2];
    return {...f,counterparty:recipient,direction:'income',currency:'EUR',net:amount(total?.[1]),gross:amount(total?.[2]),vat:allZero?'0.00':null,vatRate:allZero?'0':null};
  } },
  { name:'google-workspace', match:t=>/Google Cloud EMEA Limited/.test(t)&&/Google Workspace/.test(t)&&/Subtotal in EUR\s+VAT \(0%\)\s+Total in EUR/.test(t), parse:(t,f)=>{
    const row=new RegExp(`€\\s*${decimal}\\s+€\\s*${decimal}\\s+€\\s*${decimal}\\s+(?:Summary|Subtotal)`).exec(t);
    const printed=/\.{4,}\s+([A-Za-z]+ \d{1,2}, \d{4})/.exec(t)?.[1];
    const parsed=printed?new Date(`${printed} UTC`):null;
    return {...f,counterparty:'Google Cloud EMEA Limited',currency:'EUR',net:amount(row?.[1]),vat:amount(row?.[2]),gross:amount(row?.[3]),vatRate:'0',reverseCharge:true,date:parsed&&Number.isFinite(parsed.getTime())?parsed.toISOString().slice(0,10):null};
  } },
  { name:'mailchimp', match:t=>/Mailchimp\s+Receipt/.test(t)&&/Tax was not applied to this purchase\. The reverse charge mechanism applies/.test(t), parse:(t,f)=>{
    const total=new RegExp(`(?:Premium plan|Email|contacts)[\\s\\S]*?(€|\\$)\\s*${decimal}`).exec(t);
    const printed=/Date Paid:\s*([A-Za-z]+ \d{1,2}, \d{4})/.exec(t)?.[1];
    const parsed=printed?new Date(`${printed} UTC`):null;
    const gross=amount(total?.[2]);
    return {...f,docType:'receipt',direction:'expense',counterparty:/The Rocket Science Group, LLC/.test(t)?'The Rocket Science Group, LLC':null,invoiceNumber:/Receipt\s+(MC\d+)/.exec(t)?.[1]||null,currency:total?.[1]==='€'?'EUR':total?.[1]==='$'?'USD':null,net:gross,vat:'0.00',gross,vatRate:'0',reverseCharge:true,date:parsed&&Number.isFinite(parsed.getTime())?parsed.toISOString().slice(0,10):null};
  } },
  { name:'revolut', match:t=>/Revolut Bank UAB/.test(t)&&/Total \(exc VAT\)/.test(t)&&/Total \(inc VAT\)/.test(t), parse:(t,f)=>{
    const value=(label:string)=> {const m=new RegExp(label+'\\s*€\\s*(\\d+(?:[.,]\\d{2})?)(?![\\d.,])').exec(t);return m?Number(m[1].replace(',','.')).toFixed(2):null;};
    const printed=/Issue date:\s*([A-Za-z]+ \d{1,2}, \d{4})/.exec(t)?.[1];const parsed=printed?new Date(`${printed} UTC`):null;
    return {...f,docType:'invoice',counterparty:'Revolut Bank UAB',currency:'EUR',invoiceNumber:/Invoice #([A-Z0-9-]+)/.exec(t)?.[1]||null,net:value('Total \\(exc VAT\\)'),vat:value('(?:^|\\n)VAT'),gross:value('Total \\(inc VAT\\)'),vatRate:/\b0%/.test(t)?'0':null,reverseCharge:/Customer to account for any VAT/.test(t),date:parsed&&Number.isFinite(parsed.getTime())?parsed.toISOString().slice(0,10):null};
  } },
  { name:'stripe', match:t=>/(?:OpenAI|Anthropic|Cloudflare|OpenRouter|Pro Sulum|Cursor|Anysphere|Zoom Video)/i.test(t)&&/Invoice number/.test(t)&&/Subtotal/.test(t)&&/Amount (?:paid|due)/.test(t), parse:(t,f)=>{
    const issuerSection=t.split(/Bill to/i)[0];
    const issuer=/^\s*((?:OpenAI(?: OpCo)?[,]? LLC|OpenAI, Inc\.|Anthropic, PBC|Cloudflare, Inc\.|OpenRouter, Inc\.?|Pro Sulum, LLC|Anysphere, Inc\.))(?=\s*(?:@[^\n]+)?(?:\n|$))/im.exec(issuerSection)?.[1]?.trim();
    f={...f,counterparty:issuer||null};
    // A missing tax line is not evidence of a 0% tax rate.
    const rates=[...t.matchAll(/\b(\d{1,2}(?:\.\d+)?)\s*%/g)].map(m=>Number(m[1]));
    if (rates.length && rates.every(r=>r===0)&&f.net===f.gross) return {...f,vat:'0.00',vatRate:'0'};
    return f;
  } },
];

export function validateFinanceFacts(f: Facts, expectedPeriod?: string): string[] {
  const issues:string[]=[];
  for (const key of ['counterparty','invoiceNumber','date','currency','net','vat','gross','vatRate'] as const) if (!f[key]) issues.push(`missing:${key}`);
  if (f.date && !date(f.date)) issues.push('invalid:date');
  if (f.date && expectedPeriod && !f.date.startsWith(expectedPeriod)) issues.push('unexpected:period');
  if (f.currency && !validCurrency(f.currency)) issues.push('invalid:currency');
  for (const key of ['net','vat','gross'] as const) if(f[key]!==null && !/^\d{1,10}\.\d{2}$/.test(f[key]!)) issues.push(`invalid:${key}`);
  if(f.net!==null && f.vat!==null && f.gross!==null && Math.abs(Math.round(Number(f.net)*100)+Math.round(Number(f.vat)*100)-Math.round(Number(f.gross)*100))>1) issues.push('inconsistent:net+vat=gross');
  if(f.vatRate!==null && (!/^\d{1,2}(\.\d{1,2})?$/.test(f.vatRate)||Number(f.vatRate)>50)) issues.push('invalid:vatRate');
  if(f.net && f.vat && f.vatRate && Math.abs(Number(f.net)*Number(f.vatRate)-Number(f.vat)*100)>110) issues.push('inconsistent:vatRate');
  if(f.docType==='other') issues.push('unsupported:document-type');
  if(f.confidence!=='high') issues.push(`confidence:${f.confidence}`);
  for(const key of f.uncertainFields) issues.push(`uncertain:${key}`);
  return issues;
}
export type FinanceExtraction = { fields:InvoiceFields; extraction:Invoice['extraction']; facts:Facts; usage?:LlmResult['usage']; model?:string };
export async function extractFinanceText(raw:string, options:{pdf?:Buffer; hints?:InvoiceHints; expectedPeriod?:string; llm?:(input:{text:string;pdf?:Buffer;forcePdf?:boolean;hints?:InvoiceHints})=>Promise<LlmResult>} = {}):Promise<FinanceExtraction> {
  const text=normalizePdfText(raw);
  const base=extractInvoiceText(raw,options.hints);
  const regex=regexFinanceFacts(raw);
  let facts:Facts|undefined;
  let method='openai';
  let result:LlmResult|undefined;
  const issues:string[]=[];
  for(const template of FINANCE_TEMPLATES) {
    if(!template.match(text)) continue;
    const candidate=template.parse(text,regex);candidate.confidence='high';
    if(candidate.net!==null && candidate.vat!==null && candidate.vatRate!==null && !validateFinanceFacts(candidate,options.expectedPeriod).length) {
      facts=candidate;method=`template:${template.name}`;break;
    }
  }
  if(!facts) {
    try {
      result=await (options.llm||((input)=>extractWithLlm(input,{timeoutMs:15_000})))({text:raw,pdf:options.pdf,forcePdf:needsPdfInput(raw),hints:options.hints});
      facts=result.fields;
      for(const key of ['net','vat','gross','vatRate','currency','date','invoiceNumber'] as const) {
        const left=regex[key],right=facts[key];
        const same=['net','vat','gross','vatRate'].includes(key)?Number(left)===Number(right):left===right;
        if(left!==null && right!==null && !same) issues.push(`disagreement:${key}`);
      }
    } catch {
      facts=regex;method='regex-fallback';issues.push('reader-unavailable:retry-extraction');
    }
  }
  // Keep high-signal values found by the local labeled parser when a reader
  // omits them. In particular, forwarded PDFs often put a printed total or
  // paid date behind dot leaders that a remote reader may skip.
  if(facts.counterparty===null && regex.counterparty!==null) facts.counterparty=regex.counterparty;
  if(facts.invoiceNumber===null && regex.invoiceNumber!==null) facts.invoiceNumber=regex.invoiceNumber;
  if(facts.date===null && regex.date!==null) facts.date=regex.date;
  if(facts.currency===null && regex.currency!==null) facts.currency=regex.currency;
  if(facts.gross===null && regex.gross!==null) facts.gross=regex.gross;
  if(facts.docType!=='credit_note' && /\b(?:Bill to|Billed to|To)\s*:?\s*DataTalks\.?Club\b/i.test(text) && facts.direction==='income') {
    facts.direction='expense';issues.push('disagreement:direction');
  }
  // Fill uniquely determined amounts from explicit labels, not an assumed tax rate.
  if(facts.docType!=='other' && !/Total excluding tax|VAT[^\n]*incl\./i.test(text)) {
    if(facts.net===null && regex.net!==null) facts.net=regex.net;
    if(facts.vat===null && facts.net!==null && facts.gross!==null && Number(facts.gross)>=Number(facts.net)) facts.vat=(Number(facts.gross)-Number(facts.net)).toFixed(2);
    if(facts.net===null && facts.vat!==null && facts.gross!==null && Number(facts.gross)>=Number(facts.vat)) facts.net=(Number(facts.gross)-Number(facts.vat)).toFixed(2);
  }
  issues.push(...validateFinanceFacts(facts,options.expectedPeriod));
  if(facts.invoiceNumber) facts.invoiceNumber=facts.invoiceNumber.replace(/[\u0000\u2010-\u2014\u2212]/g,'-').replace(/\s*-\s*/g,'-');
  const fields:InvoiceFields={...base.fields};
  const mapping={counterparty:'counterparty',invoiceNumber:'invoiceNumber',date:'transactionDate',currency:'currency',net:'netAmount',vat:'vatAmount',gross:'amount',vatRate:'vatRate',description:'description'} as const;
  // Unknown facts clear earlier heuristic guesses rather than laundering them.
  for(const [from,to] of Object.entries(mapping) as Array<[keyof typeof mapping,typeof mapping[keyof typeof mapping]]>) {
    delete fields[to];if(facts[from]!==null) fields[to]=facts[from]!;
  }
  fields.reverseCharge=facts.reverseCharge;
  if(facts.vat!==null && facts.currency) fields.vatCurrency=facts.currency;
  if(facts.docType==='credit_note') fields.subtype='Refund';
  return {fields,facts,extraction:{method,evidence:[...base.extraction.evidence,`finance:${method}`],issues:[...new Set(issues)],documentType:facts.docType,direction:facts.direction,needsReview:issues.length>0,...(facts.paymentChannel?{paymentChannel:facts.paymentChannel}:{})},...(result?{usage:result.usage,model:result.model}:{})};
}
/** Indicative conversion is separate from the actual EUR bank payment. */
export async function convertExtractedFinance(result:FinanceExtraction):Promise<FinanceExtraction> {
  const f=result.fields;
  if(!f.currency || !f.transactionDate || !f.amount) return result;
  const rate=f.currency==='EUR'?{rate:1,date:f.transactionDate}: (await loadEcbRates([{currency:f.currency,date:f.transactionDate}])).lookup(f.currency,f.transactionDate);
  if(!rate) {result.extraction.issues.push('conversion-unavailable:retry-extraction');result.extraction.needsReview=true;return result;}
  f.exchangeRate=String(rate.rate);f.exchangeRateDate=rate.date;f.exchangeRateSource=f.currency==='EUR'?'eur':'ecb';
  f.grossAmountEur=(Number(f.amount)/rate.rate).toFixed(2);
  if(f.netAmount!==undefined) f.netAmountEur=(Number(f.netAmount)/rate.rate).toFixed(2);
  if(f.vatAmount!==undefined) f.vatAmountEur=(Number(f.vatAmount)/rate.rate).toFixed(2);
  return result;
}

/** OCR failure must still allow the document reader to inspect a scanned PDF. */
export async function extractFinancePdf(bytes:Buffer,options:{hints?:InvoiceHints;textReader?:typeof pdfText;llm?:(input:{text:string;pdf?:Buffer;forcePdf?:boolean;hints?:InvoiceHints})=>Promise<LlmResult>}={}):Promise<FinanceExtraction> {
  if(bytes.length>25*1024*1024 || !/^%PDF-[12]\.[0-9]/.test(bytes.subarray(0,8).toString())) throw new Error('invalid-pdf');
  let text='';
  let textReaderError: string | undefined;
  try {text=await (options.textReader||pdfText)(bytes);} catch(error) {
    if(error instanceof BlankConversionError) throw error;
    // The reader accepts PDF images when OCR is unavailable.
    textReaderError = error instanceof Error ? error.message : String(error);
  }
  const result=await extractFinanceText(text,{pdf:bytes,hints:options.hints,llm:options.llm});
  if(textReaderError) {
    result.extraction.issues.push(`PDF text extraction failed: ${textReaderError.slice(0,500)}`);
    result.extraction.needsReview=true;
  }
  return convertExtractedFinance(result);
}
