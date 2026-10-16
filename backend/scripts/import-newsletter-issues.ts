/**
 * Import newsletter issues from the schedule sheet's `Newsletter` tab.
 *
 * The sheet is the source of truth and keeps one row per sponsor placement:
 * a Primary Slot and an optional Secondary Slot per weekly issue, a
 * Stand-Alone Newsletter row per stand-alone send, and a Vacation row for a
 * cancelled week. Every row has a stable `ID` (`NL-306`, `NL-306-secondary`,
 * `NL-<date>-standalone`, `NL-<date>-vacation`). Rows are grouped into one
 * issue per email: `NL-306` and `NL-306-secondary` become weekly issue #306,
 * each slot keeping its row ID. A slot is booked when its row names a Sponsor
 * (`N/A` or blank means open).
 *
 * Writing creates each issue through the API. Issues already imported are
 * matched by source key and left alone.
 */
import ExcelJS from 'exceljs';
import { createHash } from 'crypto';

type ImportSlot = { sponsor?: string; sheetId?: string; documentUrl?: string };
export type ImportIssue = {
  kind: 'weekly' | 'standalone';
  publicationDate: string;
  issueNumber?: number;
  status: 'planned' | 'sent' | 'cancelled';
  slots: { primary?: ImportSlot; secondary?: ImportSlot };
  planningNote?: string;
  sourceType: 'xlsx-import';
  sourceKey: string;
};

/** A cell's plain value: formula results, hyperlink text and rich text unwrapped. */
const cellValue = (value: unknown): unknown => {
  if (value && typeof value === 'object' && !(value instanceof Date)) {
    const cell = value as Record<string, any>;
    if ('result' in cell) return cellValue(cell.result);
    if ('text' in cell) return cellValue(cell.text);
    if (Array.isArray(cell.richText)) return cell.richText.map((part: any) => part.text).join('');
  }
  return value;
};
const normalized = (value: unknown) =>
  String(cellValue(value) ?? '').trim().toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const text = (value: unknown) => String(cellValue(value) ?? '').trim();
const iso = (raw: unknown) => {
  const value = cellValue(raw);
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(String(value)) ? String(value) : '';
};
/** The link a cell holds: its hyperlink target, else an https text value. */
const link = (raw: unknown) => {
  if (raw && typeof raw === 'object' && typeof (raw as any).hyperlink === 'string') return (raw as any).hyperlink as string;
  const value = text(raw);
  return /^https:\/\//.test(value) ? value : '';
};

const HEADERS = {
  date: /^date$/,
  sponsor: /^sponsor$/,
  type: /^promo type$/,
  url: /^url$/,
  doc: /^doc$/,
  note: /^note$/,
  deliveries: /^newsletter deliveries$/,
  id: /^id$/,
};

type Row = {
  rowNumber: number;
  id: string;
  date: string;
  type: 'primary' | 'secondary' | 'standalone' | 'vacation';
  issueNumber?: number;
  sponsor: string;
  documentUrl: string;
  note: string;
  sent: boolean;
};

const ROW_TYPES: Record<string, Row['type']> = {
  'primary slot': 'primary',
  'secondary slot': 'secondary',
  'stand alone newsletter': 'standalone',
  vacation: 'vacation',
};

/** The issue a row belongs to: its ID without the `-secondary` suffix. */
export const issueSheetId = (rowId: string) => rowId.replace(/-secondary$/i, '');

export const issueSourceKey = (issueId: string) =>
  createHash('sha256').update(`Newsletter:id:${issueId}`).digest('hex');

export async function inspectNewsletterIssues(file: string, options: { today?: string } = {}) {
  const today = options.today || new Date().toISOString().slice(0, 10);
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(file);
  const sheet = workbook.getWorksheet('Newsletter');
  if (!sheet) throw new Error('Newsletter worksheet is required');
  const columns = new Map<keyof typeof HEADERS, number>();
  sheet.getRow(1).eachCell((cell, column) => {
    for (const [name, pattern] of Object.entries(HEADERS) as [keyof typeof HEADERS, RegExp][]) {
      if (!columns.has(name) && pattern.test(normalized(cell.value))) columns.set(name, column);
    }
  });
  for (const name of ['date', 'type', 'id'] as const) {
    if (!columns.has(name)) throw new Error(`Newsletter sheet has no ${name} column`);
  }
  const cell = (row: ExcelJS.Row, name: keyof typeof HEADERS) =>
    columns.has(name) ? row.getCell(columns.get(name)!).value : undefined;

  const reasons: Record<string, number> = {};
  const reject = (reason: string) => { reasons[reason] = (reasons[reason] || 0) + 1; };
  const rows: Row[] = [];
  const seen = new Set<string>();
  sheet.eachRow((row, rowNumber) => {
    if (rowNumber === 1) return;
    if (row.hidden) return reject('hidden-row');
    const id = text(cell(row, 'id'));
    const date = iso(cell(row, 'date'));
    const type = ROW_TYPES[normalized(cell(row, 'type'))];
    if (!id || id.length > 100) return reject('missing-or-invalid-id');
    if (seen.has(id)) return reject('duplicate-id');
    if (!date) return reject('missing-or-invalid-date');
    if (!type) return reject('unknown-promo-type');
    seen.add(id);
    const issueMatch = /weekly-(\d+)\b/.exec(link(cell(row, 'url')) || text(cell(row, 'url')));
    const sponsor = text(cell(row, 'sponsor')).slice(0, 200);
    rows.push({
      rowNumber,
      id,
      date,
      type,
      issueNumber: issueMatch ? Number(issueMatch[1]) : undefined,
      sponsor: /^n\/?a$/i.test(sponsor) ? '' : sponsor,
      documentUrl: link(cell(row, 'doc')),
      note: text(cell(row, 'note')).slice(0, 1000),
      sent: text(cell(row, 'deliveries')) !== '' || date < today,
    });
  });

  const groups = new Map<string, Row[]>();
  for (const row of rows) groups.set(issueSheetId(row.id), [...(groups.get(issueSheetId(row.id)) || []), row]);
  const issues: ImportIssue[] = [];
  for (const [issueId, group] of groups) {
    const primary = group.find((row) => row.type !== 'secondary');
    const secondary = group.find((row) => row.type === 'secondary');
    const head = primary || secondary!;
    if (secondary && primary && (primary.date !== secondary.date || primary.type !== 'primary')) {
      reject('secondary-without-matching-primary');
      continue;
    }
    const slot = (row: Row | undefined): ImportSlot | undefined => row && {
      sheetId: row.id,
      ...(row.sponsor ? { sponsor: row.sponsor } : {}),
      ...(row.documentUrl ? { documentUrl: row.documentUrl } : {}),
    };
    const kind = head.type === 'standalone' ? 'standalone' : 'weekly';
    const note = group.map((row) => row.note).find(Boolean);
    issues.push({
      kind,
      publicationDate: head.date,
      ...(kind === 'weekly' && head.issueNumber !== undefined ? { issueNumber: head.issueNumber } : {}),
      status: head.type === 'vacation' ? 'cancelled' : group.some((row) => row.sent) ? 'sent' : 'planned',
      slots: kind === 'standalone'
        ? { primary: slot(primary) }
        : head.type === 'vacation'
          ? { primary: { sheetId: head.id }, secondary: {} }
          : { primary: slot(primary) || {}, secondary: slot(secondary) || {} },
      ...(note ? { planningNote: note } : {}),
      sourceType: 'xlsx-import',
      sourceKey: issueSourceKey(issueId),
    });
  }
  issues.sort((left, right) => left.publicationDate.localeCompare(right.publicationDate));
  return {
    issues,
    report: {
      sheet: 'Newsletter',
      rows: rows.length,
      issues: issues.length,
      reasons,
    },
  };
}

export async function writeNewsletterIssues(
  issues: ImportIssue[],
  options: { api: string; token?: string; confirm: string },
) {
  if (options.confirm !== options.api) throw new Error('Explicit target confirmation must equal API URL');
  if (!options.token) throw new Error('Import requires a session token');
  const api = options.api.replace(/\/$/, '');
  const headers = { authorization: `Bearer ${options.token}` };
  let created = 0;
  let unchanged = 0;
  for (const issue of issues) {
    let response: Response | undefined;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        response = await fetch(`${api}/api/newsletter-issues`, {
          method: 'POST',
          headers: { ...headers, 'content-type': 'application/json', 'idempotency-key': issue.sourceKey },
          body: JSON.stringify(issue),
        });
      } catch {
        if (attempt === 2) throw new Error('Import network failure');
        continue;
      }
      if (response.status < 500) break;
    }
    if (!response?.ok) throw new Error(`Import rejected for ${issue.publicationDate} (${response?.status || 'network'})`);
    if (response.status === 201) created++;
    else unchanged++;
  }
  return { issues: issues.length, created, unchanged };
}

if (require.main === module) {
  const file = process.argv[2];
  const write = process.argv.includes('--write');
  inspectNewsletterIssues(file)
    .then(async ({ issues, report }) => {
      if (!write) {
        console.log(JSON.stringify({ mode: 'dry-run', ...report }));
        return;
      }
      console.log(JSON.stringify({
        mode: 'write',
        ...(await writeNewsletterIssues(issues, {
          api: process.env.NEWSLETTER_IMPORT_API || '',
          token: process.env.NEWSLETTER_IMPORT_TOKEN || '',
          confirm: process.env.NEWSLETTER_IMPORT_CONFIRM || '',
        })),
      }));
    })
    .catch((error) => {
      console.error(JSON.stringify({ error: error.message }));
      process.exitCode = 1;
    });
}
