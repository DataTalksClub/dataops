/** Private corpus runner. Never commit its input, cache or report. */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, dirname, join } from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { extractWithLlm, needsPdfInput, extractionModel, EXTRACTION_PROMPT, EXTRACTION_SCHEMA, type LlmExtraction } from '../src/invoices/llm';
import { extractFinanceText, regexFinanceFacts } from '../src/invoices/financeExtraction';

async function main() {
const args = process.argv.slice(2);
const arg = (name: string, fallback = '') => { const i = args.indexOf(`--${name}`); return i < 0 ? fallback : args[i + 1]; };
const root = resolve(arg('corpus'));
const mode = arg('mode', 'full');
if (!['full', 'openai', 'regex'].includes(mode) || !arg('corpus')) throw new Error('Use --corpus PRIVATE_DIR --mode full|openai|regex --model MODEL [--gold FILE] [--report FILE]');
const model = arg('model', extractionModel());
const cache = resolve(arg('cache', join(root, 'eval-cache')));
const documents: Array<{ id: string; file: string; kind: string }> = JSON.parse(await readFile(join(root, 'index.json'), 'utf8'));
const gold: Record<string, Partial<LlmExtraction>> = arg('gold') ? JSON.parse(await readFile(arg('gold'), 'utf8')) : {};
await mkdir(cache, { recursive: true, mode: 0o700 });
let key: string | undefined;
const keyReader = async () => key ||= execFileSync('dataops', ['secrets', 'get', process.env.DATAOPS_OPENAI_SECRET || 'openai-invoice-extraction', '--field', 'api_key'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const results: any[] = [];
let cursor = 0;
async function worker() {
  while (cursor < documents.length) {
    const document = documents[cursor++];
    const text = await readFile(join(root, 'text', `${document.id}.txt`), 'utf8');
    const pdf = needsPdfInput(text) ? await readFile(document.file) : undefined;
    const fingerprint = createHash('sha256').update(EXTRACTION_PROMPT + text + model).update(pdf || '').update(JSON.stringify(EXTRACTION_SCHEMA)).digest('hex');
    const path = join(cache, `${fingerprint}.json`);
    const started = performance.now();
    let usage = { inputTokens: 0, outputTokens: 0 };
    let latencyMs = 0;
    let route = 'openai';
    let fields: LlmExtraction | undefined;
    let issues: string[] = [];
    try {
      const read = async () => {
        let result;
        try { result = JSON.parse(await readFile(path, 'utf8')); }
        catch {
          if(args.includes('--offline')) throw new Error('recording-missing');
          result = await extractWithLlm({ text, ...(pdf ? {pdf,forcePdf:true} : {}) }, { model, apiKey: await keyReader(), timeoutMs: 55_000 });
          await writeFile(path, JSON.stringify(result), { mode: 0o600 });
        }
        usage = result.usage; latencyMs = result.latencyMs;
        return result;
      };
      if (mode === 'regex') {fields=regexFinanceFacts(text);route='regex';latencyMs=performance.now()-started;}
      else if (mode === 'openai') fields = (await read()).fields;
      else {
        const result = await extractFinanceText(text, { llm: read });
        fields = result.facts; issues = result.extraction.issues; route = result.extraction.method;
        if (!latencyMs) latencyMs = performance.now() - started;
      }
      results.push({ id: document.id, kind: document.kind, fields, route, issues, usage, latencyMs, ...(route==='regex-fallback'?{error:'reader-unavailable'}:{}) });
    } catch {
      results.push({ id: document.id, kind: document.kind, error: 'extraction-failed', route, latencyMs: performance.now() - started });
    }
    if (results.length % 25 === 0) console.log(`${mode} ${model}: ${results.length}/${documents.length}`);
  }
}
await Promise.all(Array.from({ length: Number(arg('concurrency', '6')) }, worker));
results.sort((a,b) => a.id.localeCompare(b.id));
const fields = ['net','vat','gross','vatRate','currency','date','counterparty','invoiceNumber','reverseCharge','direction','docType'] as const;
const accuracy: Record<string, { correct: number; total: number; accuracy: number | null }> = {};
const errors: any[] = [];
const normalized = (field: string, value: any) => value == null ? null : ['net','vat','gross','vatRate'].includes(field) ? Number(value) : field === 'counterparty' ? String(value).toLowerCase().replace(/[^\p{L}\p{N}]/gu, '') : field==='invoiceNumber' ? String(value).replace(/[\u0000\u2010-\u2014\u2212]/g,'-').replace(/\s*-\s*/g,'-') : value;
for (const field of fields) {
  let correct = 0, total = 0;
  for (const result of results) {
    if (!Object.hasOwn(gold[result.id] || {}, field) || gold[result.id]?.docType === 'other' && field !== 'docType') continue;
    total++;
    const expected = gold[result.id][field], actual = result.fields?.[field];
    if (normalized(field, actual) === normalized(field, expected)) correct++;
    else errors.push({ id: result.id, field, expected, actual: actual ?? null });
  }
  accuracy[field] = { correct, total, accuracy: total ? correct / total : null };
}
// Standard uncached USD per million tokens. Override pricing for other models.
const prices = model === 'gpt-5.4-mini' ? [0.75, 4.5] : model === 'gpt-5.4-nano' ? [0.2, 1.25] : model === 'gpt-6-luna' ? [0.1, 0.5] : [Number(arg('input-price', 'NaN')), Number(arg('output-price', 'NaN'))];
const totalCost = results.reduce((s, r) => s + ((r.usage?.inputTokens || 0) * prices[0] + (r.usage?.outputTokens || 0) * prices[1]) / 1e6, 0);
const report = { mode, model, generatedAt: new Date().toISOString(), documents: results.length, labeledDocuments: Object.keys(gold).length, failures: results.filter(r=>r.error).length, routes: results.reduce((a,r)=>(a[r.route]=(a[r.route]||0)+1,a),{} as Record<string,number>), accuracy, flaggedRate: results.filter(r=>r.issues?.length).length / results.length, discrepancyRate: results.filter(r=>r.issues?.some((i:string)=>i.startsWith('disagreement:'))).length / results.length, costPerDocumentUsd: totalCost / results.length, meanLatencyMs: results.reduce((s,r)=>s+r.latencyMs,0) / results.length, errors, results };
const destination = arg('report', join(root, `${mode}-${model}.json`));
await mkdir(dirname(destination), { recursive: true });
await writeFile(destination, JSON.stringify(report, null, 2), { mode: 0o600 });
if(args.includes('--check') && (report.failures || Object.values(accuracy).some((v,i)=>v.accuracy===null || v.accuracy < (i<3?0.98:0.95)))) { console.error('Accuracy check failed'); process.exitCode=1; }
console.log(JSON.stringify({ report: destination, documents: report.documents, failures: report.failures, labeledDocuments: report.labeledDocuments, costPerDocumentUsd: report.costPerDocumentUsd, meanLatencyMs: report.meanLatencyMs }));

}
main().catch(() => { console.error("Evaluation failed; check corpus paths and app-secret access"); process.exitCode = 1; });
