/**
 * LLM reading of an invoice, receipt or credit note through the OpenAI
 * Responses API with a strict JSON schema. The API key is the DataOps secret
 * named by DATAOPS_OPENAI_SECRET (default openai-invoice-extraction, field
 * api_key) and the model is DATAOPS_EXTRACTION_MODEL; neither is in code.
 * Only the document text (and, for a scanned PDF without text, the PDF
 * itself) is sent.
 */
import { createSecretReader } from '../secrets/reader';

export const DEFAULT_EXTRACTION_MODEL = 'gpt-5.4-mini';
export const OPENAI_RESPONSES_URL = 'https://api.openai.com/v1/responses';

export type LlmExtraction = {
  docType: 'invoice' | 'receipt' | 'credit_note' | 'other';
  direction: 'income' | 'expense';
  counterparty: string | null;
  invoiceNumber: string | null;
  date: string | null;
  currency: string | null;
  net: string | null;
  vat: string | null;
  gross: string | null;
  vatRate: string | null;
  reverseCharge: boolean;
  paymentChannel: 'card' | 'paypal' | 'bank-transfer' | 'direct-debit' | 'platform' | null;
  description: string | null;
  confidence: 'high' | 'medium' | 'low';
  uncertainFields: string[];
};
export type LlmResult = { fields: LlmExtraction; model: string; latencyMs: number; usage: { inputTokens: number; outputTokens: number } };
type Fetch = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; json(): Promise<any> }>;

const nullable = (type: string, extra: Record<string, unknown> = {}) => ({ type: [type, 'null'], ...extra });
const MONEY = { type: ['string', 'null'], pattern: '^\\d{1,10}\\.\\d{2}$' };
export const EXTRACTION_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['docType', 'direction', 'counterparty', 'invoiceNumber', 'date', 'currency', 'net', 'vat', 'gross', 'vatRate', 'reverseCharge', 'paymentChannel', 'description', 'confidence', 'uncertainFields'],
  properties: {
    docType: { type: 'string', enum: ['invoice', 'receipt', 'credit_note', 'other'] },
    direction: { type: 'string', enum: ['income', 'expense'] },
    counterparty: nullable('string'),
    invoiceNumber: nullable('string'),
    date: nullable('string', { pattern: '^\\d{4}-\\d{2}-\\d{2}$' }),
    currency: nullable('string', { pattern: '^[A-Z]{3}$' }),
    net: MONEY,
    vat: MONEY,
    gross: MONEY,
    vatRate: nullable('string', { pattern: '^\\d{1,2}(\\.\\d{1,2})?$' }),
    reverseCharge: { type: 'boolean' },
    paymentChannel: { type: ['string', 'null'], enum: ['card', 'paypal', 'bank-transfer', 'direct-debit', 'platform', null] },
    description: nullable('string'),
    confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
    uncertainFields: { type: 'array', items: { type: 'string' } },
  },
} as const;

export const EXTRACTION_PROMPT = `You read one bookkeeping document for DataTalks.Club (Alexey Grigorev, Berlin, VAT ID DE343190995) and return its facts.
Rules:
- direction: "income" when DataTalks.Club issued it to a customer, or when it is a refund or credit note from a supplier (money comes back). Otherwise "expense".
- docType: "credit_note" for a credit note, refund, Gutschrift or Stornorechnung; "receipt" for a payment receipt; "invoice" otherwise.
- gross is the total of the document. For a credit note or refund it is the refunded or credited amount, never an "adjusted invoice total", remaining balance or the original invoice total. Amounts are positive strings with two decimals ("1550.00").
- net and vat only when the document states them (or states a 0% rate); otherwise null. vatRate is the percentage as a number string ("19", "0"). reverseCharge is true when the document says reverse charge, "Steuerschuldnerschaft des Leistungsempfängers", §13b UStG or similar.
- invoiceNumber is the full document number with every suffix (for a credit note its own number, e.g. "A1B2C3D4-0059-CN-01"); hyphens may be missing or shown as spaces in the text: restore them.
- counterparty is the other party's legal name as printed (the issuer for expenses, the customer for DataTalks.Club's own invoices); never DataTalks.Club itself, never a payment processor unless it is the seller.
- date is the issue date (YYYY-MM-DD). description is a short phrase for what was bought or sold, taken from the line items, never from an email subject.
- paymentChannel only when the document shows how it was paid (card with digits -> "card").
- When a value is ambiguous (several candidate totals, unreadable text), return null for it, list the field in uncertainFields and lower confidence. Never guess.`;

let cachedKey: { value: string; at: number } | null = null;

/** The API key from the DataOps secret; cached briefly so rotation takes effect. */
export async function openAiKey(): Promise<string> {
  if (process.env.OPENAI_API_KEY) return process.env.OPENAI_API_KEY;
  if (cachedKey && Date.now() - cachedKey.at < 5 * 60_000) return cachedKey.value;
  const read = createSecretReader({ tableName: process.env.DATAOPS_SECRETS_TABLE || '', keyId: process.env.DATAOPS_SECRETS_KMS_KEY || '', region: process.env.AWS_REGION || '' });
  const fields = await read(process.env.DATAOPS_OPENAI_SECRET || 'openai-invoice-extraction');
  if (typeof fields.api_key !== 'string' || !fields.api_key) throw new Error('openai-key-missing');
  cachedKey = { value: fields.api_key, at: Date.now() };
  return cachedKey.value;
}

export function extractionModel() {
  return process.env.DATAOPS_EXTRACTION_MODEL || DEFAULT_EXTRACTION_MODEL;
}

export async function extractWithLlm(input: { text: string; pdf?: Buffer; hints?: { subject?: string } }, options: { model?: string; apiKey?: string; fetchImpl?: Fetch; timeoutMs?: number } = {}): Promise<LlmResult> {
  const model = options.model || extractionModel();
  const apiKey = options.apiKey || await openAiKey();
  const fetchImpl = options.fetchImpl || (globalThis.fetch as unknown as Fetch);
  const content: Array<Record<string, unknown>> = [];
  const text = input.text.slice(0, 60_000);
  if (text.replace(/\s/g, '').length >= 100 || !input.pdf) content.push({ type: 'input_text', text: `Document text:\n${text}` });
  else content.push({ type: 'input_file', filename: 'document.pdf', file_data: `data:application/pdf;base64,${input.pdf.toString('base64')}` });
  if (input.hints?.subject) content.push({ type: 'input_text', text: `Forwarding email subject (context only, not a description): ${input.hints.subject.slice(0, 200)}` });
  const started = Date.now();
  const response = await fetchImpl(OPENAI_RESPONSES_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      input: [{ role: 'system', content: EXTRACTION_PROMPT }, { role: 'user', content }],
      text: { format: { type: 'json_schema', name: 'bookkeeping_document', strict: true, schema: EXTRACTION_SCHEMA } },
    }),
    signal: AbortSignal.timeout(options.timeoutMs || 60_000),
  });
  const body = await response.json();
  // Error bodies can echo request details; keep only the code.
  if (!response.ok) throw new Error(`openai-${response.status}${body?.error?.code ? `-${body.error.code}` : ''}`);
  const output = body.output_text ?? body.output?.flatMap((item: any) => item.content || []).find((c: any) => c.type === 'output_text')?.text;
  if (typeof output !== 'string') throw new Error('openai-no-output');
  return {
    fields: JSON.parse(output) as LlmExtraction,
    model: body.model || model,
    latencyMs: Date.now() - started,
    usage: { inputTokens: body.usage?.input_tokens || 0, outputTokens: body.usage?.output_tokens || 0 },
  };
}
