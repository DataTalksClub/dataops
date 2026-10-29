import { readFile, writeFile } from 'node:fs/promises';
import { apiFor } from './session.mjs';

const base = '/api/bookkeeping/invoice-generation';
export const summary = 'Contractor invoice templates and PDF generation';
export const help = `dataops invoice-pdfs

  templates
  create-template --file template.json
  render --template-id ID --file invoice.json --output invoice.pdf

Template JSON: name, issuer, recipient, paymentDetails, taxNote, currency (EUR/USD/GBP).
Use multiline strings for names, addresses and tax identifiers. Supply approved tax text.
Invoice JSON: invoiceNumber, issueDate (YYYY-MM-DD), servicePeriod,
items: [{description, amount: "100.00"}]. Amounts include the approved tax treatment.
Templates are private and immutable; create a new named template when details change.
Rendering downloads a PDF; it does not send it or update the ledger.
`;
async function input(args) {
  if (typeof args.file !== 'string') throw new Error('--file is required');
  const value = JSON.parse(await readFile(args.file, 'utf8'));
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('JSON must be an object');
  return value;
}
export const commands = {
  templates: async (args, io) => {
    const result = await apiFor(args).get(`${base}/templates`);
    if (!args.json) for (const item of result.items) io.print(`${item.id}  ${item.name}`);
    return result;
  },
  'create-template': async (args, io) => {
    const result = await apiFor(args).post(`${base}/templates`, await input(args));
    if (!args.json) io.print(`Created template ${result.id}`);
    return result;
  },
  render: async (args, io) => {
    if (typeof args.templateId !== 'string' || typeof args.output !== 'string') throw new Error('--template-id and --output are required');
    const result = await apiFor(args).post(`${base}/render`, { ...await input(args), templateId: args.templateId });
    const bytes = Buffer.from(result.contentBase64 || '', 'base64');
    if (result.contentType !== 'application/pdf' || bytes.subarray(0, 5).toString() !== '%PDF-') throw new Error('Server did not return a PDF');
    await writeFile(args.output, bytes, { mode: 0o600, flag: 'wx' });
    const metadata = { output: args.output, total: result.total, currency: result.currency };
    if (!args.json) io.print(`Saved ${args.output} (${result.total} ${result.currency})`);
    return metadata;
  },
};
