const { PDFDocument, StandardFonts } = require('pdf-lib');

// Invented statements with real text layers: exercise byte recognition rather
// than bypassing the supported bank layouts with a PDF-looking placeholder.
async function syntheticStatementPdf(bank) {
  const lines = bank === 'finom' ? [
    'Example Widgets GmbH   Statement of account',
    'Issue date:   04.09.2026',
    'From:   01.08.2026',
    'To:   31.08.2026',
    'Opening balance:   100,00 €',
    'Closing balance:   81,50 €',
    'IBAN: EX00 0000 0000 0000 0000 01',
    'Completed   Description   Pay in/out',
    '12.08.2026   Example Hosting',
    'Synthetic subscription',
    '- 18,50 €',
    'FINOM, a limited liability company registered in the Netherlands.',
  ] : bank === 'revolut' ? [
    'Account statement',
    'Generated on the September 4, 2026',
    'Account name   Euro',
    'Currency   EUR',
    'IBAN   EX00 0000 0000 0000 0000 02',
    'Balance summary',
    'Opening balance   €200.00',
    'Money in   €0.00',
    'Money out   - €27.00',
    'Closing balance   €173.00',
    'Transactions from August 1, 2026 to August 31, 2026',
    'Date (UTC)   Description   Money out   Money in   Balance',
    '15 Aug 2026   CAR   Example Tools   €27.00   €173.00',
    'Transaction types',
    '© 2026 Revolut Bank UAB',
  ] : null;
  if (!lines) throw new Error(`Unsupported synthetic statement bank: ${bank}`);
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Courier);
  const page = pdf.addPage([760, 800]);
  lines.forEach((line, index) => page.drawText(line, { x: 30, y: 760 - index * 24, size: 10, font }));
  return Buffer.from(await pdf.save());
}

module.exports = { syntheticStatementPdf };
