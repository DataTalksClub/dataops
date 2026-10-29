import { ZipFile } from 'yazl';

export const DOCX_CONTENT_TYPE = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

function xml(value: string): string {
  return value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

function run(text: string, properties = ''): string {
  return `<w:r>${properties ? `<w:rPr>${properties}</w:rPr>` : ''}<w:t xml:space="preserve">${xml(text)}</w:t></w:r>`;
}

/** Keep link destinations visible so exported documents remain useful offline. */
function inline(text: string): string {
  const pattern = /\[([^\]]+)\]\(([^)]+)\)|\*\*([^*]+)\*\*|`([^`]+)`|\*([^*]+)\*/g;
  let result = '';
  let end = 0;
  for (const match of text.matchAll(pattern)) {
    result += run(text.slice(end, match.index));
    if (match[1] !== undefined) result += run(`${match[1]} (${match[2]})`);
    else if (match[3] !== undefined) result += run(match[3], '<w:b/>');
    else if (match[4] !== undefined) result += run(match[4], '<w:rFonts w:ascii="Courier New" w:hAnsi="Courier New"/>');
    else result += run(match[5], '<w:i/>');
    end = match.index! + match[0].length;
  }
  return result + run(text.slice(end));
}

/** Portable Word export with headings, inline formatting, and literal fenced code. */
export async function markdownToDocx(markdown: string): Promise<Buffer> {
  let fence: string | null = null;
  const paragraphs = markdown.replace(/\r\n/g, '\n').split('\n').map((line) => {
    const marker = /^\s*(`{3,}|~{3,})/.exec(line);
    if (marker && (!fence || marker[1][0] === fence[0] && marker[1].length >= fence.length)) {
      fence = fence ? null : marker[1];
      return '';
    }
    if (fence) return `<w:p>${run(line, '<w:rFonts w:ascii="Courier New" w:hAnsi="Courier New"/>')}</w:p>`;
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    const properties = heading ? `<w:pPr><w:pStyle w:val="Heading${heading[1].length}"/></w:pPr>` : '';
    const text = heading ? heading[2] : line;
    return `<w:p>${properties}${inline(text)}</w:p>`;
  }).join('');
  const zip = new ZipFile();
  const result = new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    zip.outputStream.on('data', (chunk: Buffer) => chunks.push(chunk));
    zip.outputStream.on('end', () => resolve(Buffer.concat(chunks)));
    zip.outputStream.on('error', reject);
  });
  zip.addBuffer(Buffer.from('<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/></Types>'), '[Content_Types].xml');
  zip.addBuffer(Buffer.from('<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>'), '_rels/.rels');
  zip.addBuffer(Buffer.from('<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>'), 'word/_rels/document.xml.rels');
  const styles = Array.from({ length: 6 }, (_, i) => `<w:style w:type="paragraph" w:styleId="Heading${i + 1}"><w:name w:val="heading ${i + 1}"/><w:pPr><w:outlineLvl w:val="${i}"/></w:pPr><w:rPr><w:b/><w:sz w:val="${32 - i * 2}"/></w:rPr></w:style>`).join('');
  zip.addBuffer(Buffer.from(`<?xml version="1.0" encoding="UTF-8"?><w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">${styles}</w:styles>`), 'word/styles.xml');
  zip.addBuffer(Buffer.from(`<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${paragraphs}<w:sectPr/></w:body></w:document>`), 'word/document.xml');
  zip.end();
  return result;
}
