import { PDFDocument, StandardFonts } from 'pdf-lib';
import { createHash } from 'crypto';
import { vatRuleFor, type ContractSigner, type ContractTerms } from './types';

export interface AuditEvent {
  action: string;
  at: string;
  role?: string;
  detail?: string;
  ip?: string;
  userAgent?: string;
}

export interface RenderContext {
  contractId: string;
  signers: ContractSigner[];
  auditEvents?: AuditEvent[];
}

/** The standard PDF fonts cover latin-1 plus a few typographic characters;
 * anything outside that range would render as noise. */
function text(value: unknown, max: number): string {
  const clean = String(value ?? '').replace(/[\x00-\x08\x0b-\x1f\x7f]/g, ' ').trim();
  if (!clean) return '';
  return clean.length > max ? clean.slice(0, max) : clean;
}

function money(value: number, currency: string): string {
  return value.toFixed(2) + ' ' + currency;
}

function wrap(draw: (row: string) => void, value: string, face: any, size: number, maxWidth: number): void {
  let row = '';
  for (const char of value) {
    if (face.widthOfTextAtSize(row + char, size) > maxWidth) { draw(row); row = ''; }
    row += char;
  }
  draw(row);
}

/** Renders the sponsor contract. Without signedAt dates the signature blocks
 * render as blank signing lines (draft/send state). With signatures filled
 * and an audit trail the same layout becomes the final signed PDF; pdf-lib
 * output has no form fields, so the result is flat by construction. */
export async function renderContractPdf(terms: ContractTerms, context: RenderContext): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  const font = pdf.embedStandardFont(StandardFonts.Helvetica);
  const bold = pdf.embedStandardFont(StandardFonts.HelveticaBold);
  let page = pdf.addPage([595.28, 841.89]);
  let y = 790;
  pdf.setTitle('Sponsorship Agreement ' + context.contractId);
  pdf.setSubject('DataTalks.Club sponsorship agreement (electronic signature)');
  function ensureSpace(height: number): void {
    if (y - height < 60) { page = pdf.addPage([595.28, 841.89]); y = 790; }
  }
  function line(value: string, heading = false): void {
    const face = heading ? bold : font, size = heading ? 13 : 10.5;
    for (const paragraph of text(value, 4000).split(String.fromCharCode(10))) {
      ensureSpace(17);
      wrap((row) => { ensureSpace(17); page.drawText(row, { x: 50, y, font: face, size }); y -= 16; }, paragraph, face, size, 495);
    }
    y -= 4;
  }
  const vat = vatRuleFor(terms.payerCountry);
  line('SPONSORSHIP AGREEMENT', true);
  line('Contract: ' + context.contractId);
  line('Parties', true);
  line('Provider: DataTalks.Club (DataTalks UG, Hamburg, Germany)');
  line('Sponsor: ' + terms.company);
  line('Legal payer: ' + terms.legalPayer + ' (' + terms.payerCountry + ')');
  line('Scope', true);
  line(terms.scope);
  line('Dates', true);
  line('Contract period: ' + terms.startDate + ' to ' + terms.endDate);
  line('The first deliverable starts at least one month after signing.');
  line('Fee and VAT', true);
  line('Agreed fee: ' + money(terms.priceEur, terms.currency));
  if (vat.apply) {
    line('VAT: German VAT of ' + vat.rate + ' percent applies on top of the fee.');
  } else if (vat.reverseCharge) {
    line('VAT: Reverse charge applies (EU B2B). The legal payer accounts for VAT in its member state.');
  } else {
    line('VAT: Not applicable (customer outside the EU).');
  }
  line('Cancellation', true);
  line('After signing, cancelling the sponsorship incurs a cancellation fee of 50 percent of the agreed fee.');
  line('Electronic signature', true);
  line('The parties sign this agreement electronically. Under EU regulation 910/2014 (eIDAS) this');
  line('constitutes a Simple Electronic Signature (SES). Each signature event (time, IP address,');
  line('browser) is recorded on the audit page of the signed document.');
  line('Signatures', true);
  for (const signer of context.signers) {
    ensureSpace(70);
    const label = signer.role === 'counter' ? 'For DataTalks.Club' : 'For the sponsor';
    line(label + ': ' + signer.name + ' (' + signer.email + ')');
    if (signer.signedAt) {
      line('Signed electronically at ' + signer.signedAt + (signer.ip ? ' from IP ' + signer.ip : ''));
    } else {
      line('Signature: ____________________________');
    }
  }
  const events = context.auditEvents || [];
  if (events.length > 0) {
    page = pdf.addPage([595.28, 841.89]);
    y = 790;
    line('AUDIT TRAIL', true);
    line('Contract ' + context.contractId + ' - electronic signing events (UTC):');
    for (const event of events) {
      line('- ' + event.at + '  ' + event.action + (event.role ? ' (' + event.role + ')' : '') + (event.detail ? ' - ' + event.detail : ''));
      if (event.ip) line('  IP: ' + event.ip + (event.userAgent ? '  User-Agent: ' + text(event.userAgent, 200) : ''));
    }
    line('This page is part of the signed document. The document SHA-256 hash is stored with the');
    line('contract record; a stored hash mismatch means the document was altered after signing.');
  }
  const bytes = await pdf.save();
  return bytes;
}

export function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(Buffer.from(bytes)).digest('hex');
}
