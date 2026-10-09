/**
 * Structured parsing for legacy Card titles.
 *
 * Trello-imported Cards carry structure inside a free-text title:
 * a `[Tag]` prefix naming the source Template, an event date
 * (`2026-AUG-17`) or a newsletter issue date (`(12OCT 2026)`), and the
 * remaining human title. The board renders the Template as a badge and the
 * date as the anchor chip, so the stored title keeps only the remainder.
 * Person/sponsor extraction is a later slice; this module only strips the
 * tag and the date and reports what it found.
 */

export interface ParsedCardTitle {
  /** Raw `[Tag]` text, e.g. "Newsletter". Absent when the title has no tag. */
  tag: string | null;
  /** Template `type` for a recognized tag, e.g. "newsletter". */
  templateType: string | null;
  /** ISO date parsed from the title, e.g. "2026-10-12". */
  date: string | null;
  /** Title with the tag prefix and the date token removed and tidied. */
  cleanTitle: string;
}

const TAG_PATTERN = /^(?:[\p{Extended_Pictographic}\u2699\u26a1\ufe0f\u200d]+\s*)?\[([^\]]+)\]\s*/u;

/** Newsletter issue dates: `(12OCT 2026)`, `(14 SEP 2026)`, `(24  AUG 2026)`. */
const PAREN_DATE_PATTERN = /\(\s*(\d{1,2})\s*([A-Za-z]{3,9})\s*(20\d{2})\s*\)/;

/** Event dates: `2026-AUG-17`, `2026-SEPT-07`. */
const PREFIX_DATE_PATTERN = /\b(20\d{2})-([A-Za-z]{3,9})-(\d{1,2})\b/;

const MONTH_BY_NAME: Record<string, string> = {
  JAN: '01',
  FEB: '02',
  MAR: '03',
  APR: '04',
  MAY: '05',
  JUN: '06',
  JUL: '07',
  JULY: '07',
  AUG: '08',
  SEP: '09',
  SEPT: '09',
  OCT: '10',
  NOV: '11',
  DEC: '12',
};

/** Placeholder dates from Trello card templates carry no real date. */
const PLACEHOLDER_MONTHS = new Set(['MMM', 'MM', 'DD']);

function monthNumber(raw: string): string | null {
  const key = raw.toUpperCase();
  if (PLACEHOLDER_MONTHS.has(key)) return null;
  return MONTH_BY_NAME[key] ?? null;
}

function toIsoDate(year: string, month: string, day: string): string | null {
  const monthDigits = monthNumber(month);
  if (!monthDigits) return null;
  const dayNumber = Number(day);
  if (!Number.isInteger(dayNumber) || dayNumber < 1 || dayNumber > 31) return null;
  return `${year}-${monthDigits}-${String(dayNumber).padStart(2, '0')}`;
}

/**
 * Map a free-text `[Tag]` to a runtime Template `type`. Returns null for
 * tags with no Template counterpart; the caller keeps the title untouched.
 */
export function templateTypeForTag(tag: string): string | null {
  const normalized = tag.trim().toLowerCase().replace(/\s+/g, ' ');
  switch (normalized) {
    case 'newsletter':
      return 'newsletter';
    case 'podcast':
      return 'podcast';
    case 'webinar':
      return 'webinar';
    case 'workshop':
      return 'workshop';
    case 'book of the week':
      return 'book-of-the-week';
    case 'open-source spotlight':
    case 'open source spotlight':
      return 'oss';
    case 'social media':
      return 'social-media';
    case 'course':
      return 'course';
    case 'maven ll':
    case 'maven lightning lesson':
      return 'maven-ll';
    case 'office hours':
      return 'office-hours';
    case 'tax report':
      return 'tax-report';
    default:
      return null;
  }
}

function tidySeparators(value: string): string {
  // `Launch- Alexey` and `Q&A- Ivan` read as ` - `; hyphenated words such as
  // `Pre-Course` (no spaces at all) are left alone for the person-extraction
  // slice to handle.
  return value
    .replace(/(\S)\s+-\s*(\S)/g, '$1 - $2')
    .replace(/(\S)\s*-\s+(\S)/g, '$1 - $2');
}

export interface CardStructurePatch {
  templateId?: string;
  anchorDate?: string;
  title?: string;
}

export interface StructuredCardShape {
  templateId?: string | null;
  anchorDate?: string;
  title?: string | null;
}

/**
 * Decide the backfill patch for one Card. Returns null when nothing should
 * change. An existing `templateId` is never overwritten, and titles are only
 * rewritten when the tag names a known Template (so unknown tags keep their
 * full title instead of losing the prefix).
 */
export function planCardStructureUpdate(
  card: StructuredCardShape,
  templateIdByType: Map<string, string> | Record<string, string>,
): CardStructurePatch | null {
  const parsed = parseCardTitle(card.title || '');
  if (!parsed.tag && !parsed.date) return null;
  const lookup =
    templateIdByType instanceof Map
      ? (type: string) => templateIdByType.get(type)
      : (type: string) => (templateIdByType as Record<string, string>)[type];

  const patch: CardStructurePatch = {};
  if (!card.templateId && parsed.templateType) {
    const templateId = lookup(parsed.templateType);
    if (templateId) patch.templateId = templateId;
  }
  if (parsed.date && parsed.date !== String(card.anchorDate || '').slice(0, 10)) {
    patch.anchorDate = parsed.date;
  }
  if (parsed.tag && parsed.templateType && parsed.cleanTitle !== String(card.title || '')) {
    patch.title = parsed.cleanTitle;
  }
  return Object.keys(patch).length > 0 ? patch : null;
}

export function parseCardTitle(title: string): ParsedCardTitle {
  const input = String(title ?? '');
  const tagMatch = input.match(TAG_PATTERN);
  const tag = tagMatch ? tagMatch[1].trim() : null;
  const rest = tagMatch ? input.slice(tagMatch[0].length) : input;

  let date: string | null = null;
  let dateStart = -1;
  let dateEnd = -1;

  const parenMatch = rest.match(PAREN_DATE_PATTERN);
  if (parenMatch) {
    const iso = toIsoDate(parenMatch[3], parenMatch[2], parenMatch[1]);
    if (iso) {
      date = iso;
      dateStart = parenMatch.index ?? -1;
      dateEnd = dateStart + parenMatch[0].length;
    }
  }
  if (!date) {
    const prefixMatch = rest.match(PREFIX_DATE_PATTERN);
    if (prefixMatch) {
      const iso = toIsoDate(prefixMatch[1], prefixMatch[2], prefixMatch[3]);
      if (iso) {
        date = iso;
        dateStart = prefixMatch.index ?? -1;
        dateEnd = dateStart + prefixMatch[0].length;
      }
    }
  }

  let clean = dateStart >= 0 ? rest.slice(0, dateStart) + rest.slice(dateEnd) : rest;
  clean = clean.replace(/\s{2,}/g, ' ').trim();
  clean = clean.replace(/^[-–:;\s]+/, '').trim();
  clean = tidySeparators(clean);
  clean = clean.replace(/\(\s*\)/g, '').replace(/\s{2,}/g, ' ').trim();
  if (!clean) clean = rest.trim();

  return {
    tag,
    templateType: tag ? templateTypeForTag(tag) : null,
    date,
    cleanTitle: clean,
  };
}
