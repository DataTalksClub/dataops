import { open, readFile, unlink, writeFile } from 'node:fs/promises';
import { apiFor } from './session.mjs';

const base = '/api/bookkeeping/invoice-generation';
export const summary = 'Contractor invoice templates and PDF generation';
export const help = `dataops invoice-pdfs

  templates
  create-template --file template.json
  render --template-id ID --file invoice.json --output invoice.pdf
  reissue --template-id ID --file corrected-invoice.json --output reissue.pdf --reason "..."

Template JSON: name, issuer, recipient, paymentDetails, taxNote, currency (EUR/USD/GBP).
Use multiline strings for names, addresses and tax identifiers. Supply approved tax text.
Invoice JSON: invoiceNumber, issueDate (YYYY-MM-DD), servicePeriod,
items: [{description, amount: "100.00"}]. Amounts include the approved tax treatment.
Templates are private and immutable; create a new named template when details change.
Rendering downloads a PDF; it does not send it or update the ledger. For a correction,
copy the issued invoice's verified fields into corrected-invoice.json, fix the item line,
and use reissue to create a separate PDF. The original file is never overwritten. Reissue
also writes <output>.reissue.json with the reason and generation metadata; both files
are created exclusively with owner-only permissions.
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
  reissue: async (args, io) => {
    if (typeof args.templateId !== 'string' || typeof args.output !== 'string') throw new Error('--template-id and --output are required');
    if (typeof args.reason !== 'string' || !args.reason.trim()) throw new Error('--reason is required');
    const invoice = await input(args);
    if (typeof invoice.invoiceNumber !== 'string' || !invoice.invoiceNumber.trim()) throw new Error('Invoice JSON must include invoiceNumber');
    const result = await apiFor(args).post(`${base}/render`, { ...invoice, templateId: args.templateId });
    const bytes = Buffer.from(result.contentBase64 || '', 'base64');
    if (result.contentType !== 'application/pdf' || bytes.subarray(0, 5).toString() !== '%PDF-') throw new Error('Server did not return a PDF');
    const metadata = {
      output: args.output,
      invoiceNumber: invoice.invoiceNumber,
      templateId: args.templateId,
      reason: args.reason.trim(),
      total: result.total,
      currency: result.currency,
    };
    const sidecar = `${args.output}.reissue.json`;
    let pdfHandle;
    let metadataHandle;
    try {
      pdfHandle = await open(args.output, 'wx', 0o600);
      metadataHandle = await open(sidecar, 'wx', 0o600);
      await pdfHandle.writeFile(bytes);
      await metadataHandle.writeFile(`${JSON.stringify({ ...metadata, recordedAt: new Date().toISOString() }, null, 2)}\n`);
      await pdfHandle.close();
      await metadataHandle.close();
    } catch (error) {
      await pdfHandle?.close().catch(() => {});
      await metadataHandle?.close().catch(() => {});
      if (pdfHandle) await unlink(args.output).catch(() => {});
      if (metadataHandle) await unlink(sidecar).catch(() => {});
      throw error;
    }
    metadata.auditFile = sidecar;
    if (!args.json) io.print(`Prepared reissue ${args.output} and recorded its reason in ${sidecar}; Finom was not changed`);
    return metadata;
  },
};
