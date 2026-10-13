/**
 * Structured parsing for legacy Card titles.
 *
 * Trello-imported Cards carry structure inside a free-text title:
 * a `[Tag]` prefix naming the source Template, an event date
 * (`2026-AUG-17`) or a newsletter issue date (`(12OCT 2026)`), an issue
 * number (`#298`), a trailing person segment on event Cards (`- Tony Zeljkovic`),
 * a trailing sponsor segment on newsletter Cards (`- Astronomer`), and the
 * remaining human title.
 *
 * The board renders the Template as a badge, the issue number and date as chips,
 * and person/sponsor in the subtitle/byline, so the stored/projected title
 * keeps only the clean remainder.
 */

import type { Card } from '../types';

export interface ParsedCardTitle {
  /** Raw `[Tag]` text, e.g. "Newsletter". Absent when the title has no tag. */
  tag: string | null;
  /** Template `type` for a recognized tag, e.g. "newsletter". */
  templateType: string | null;
  /** ISO date parsed from the title, e.g. "2026-10-12". */
  date: string | null;
  /** Issue number for recurring publications, e.g. "298". */
  issueNumber: string | null;
  /** People named by the Card (speakers/guests on events). */
  people: string[];
  /** Primary sponsor for newsletters. */
  sponsor: string | null;
  /** Secondary sponsors for newsletters. */
  secondarySponsors?: string[];
  /** Title with tag, date, issue number, people, and sponsors removed and tidied. */
  cleanTitle: string;
}

const TAG_PATTERN = /^(?:[\p{Extended_Pictographic}\u2699\u26a1\ufe0f\u200d]+\s*)?\[([^\]]+)\]\s*/u;

/** Newsletter issue dates: `(12OCT 2026)`, `(14 SEP 2026)`, `(24  AUG 2026)`. */
const PAREN_DATE_PATTERN = /\(\s*(\d{1,2})\s*([A-Za-z]{3,9}|\d{1,2})\s*(20\d{2})\s*\)/;

/** Event dates: `2026-AUG-17`, `2026-SEPT-07`, `2026-08-17`. */
const PREFIX_DATE_PATTERN = /\b(20\d{2})-([A-Za-z]{3,9}|\d{1,2})-(\d{1,2})\b/;

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
  let monthDigits: string | null = null;
  if (/^\d{1,2}$/.test(month)) {
    const num = Number(month);
    if (num >= 1 && num <= 12) monthDigits = String(num).padStart(2, '0');
  } else {
    monthDigits = monthNumber(month);
  }
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
  // `Pre-Course` (no spaces at all) are left for the glued person split.
  return value
    .replace(/(\S)\s+-\s*(\S)/g, '$1 - $2')
    .replace(/(\S)\s*-\s+(\S)/g, '$1 - $2');
}

/** Template types whose trailing `- Person` segment names people. */
const PERSON_TEMPLATE_TYPES = new Set([
  'podcast',
  'webinar',
  'workshop',
  'maven-ll',
  'office-hours',
  'oss',
  'book-of-the-week',
]);

/** Trello template placeholders carry no real person. */
const PLACEHOLDER_PEOPLE = new Set([
  'name', 'names', 'speaker', 'speakers', 'author', 'authors',
  'guest', 'guests', 'host', 'hosts', 'topic',
]);

function tidyName(value: string): string {
  return value
    .replace(/\s{2,}/g, ' ')
    .replace(/\(\s+/g, '(')
    .replace(/\s+\)/g, ')')
    .trim();
}

/** Split `Topic - Person` off the last spaced separator. */
function splitSpacedTrailer(value: string): { head: string; tail: string } | null {
  const index = value.lastIndexOf(' - ');
  if (index <= 0) return null;
  const head = value.slice(0, index).trim();
  const tail = value.slice(index + 3).trim();
  if (!head || !tail) return null;
  return { head, tail };
}

/**
 * Split `Products-Radovan Bacovic`: a glued dash whose tail is two or more
 * capitalized words reads as a person, while hyphenated words (`Pre-Course`)
 * never match and stay intact.
 */
function splitGluedTrailer(value: string): { head: string; tail: string } | null {
  const match = value.match(/^(.*)-([A-ZÀ-Þ][^-]* [^-]*)$/u);
  if (!match) return null;
  const head = match[1].trim();
  const tail = tidyName(match[2]);
  if (!head || !tail) return null;
  return { head, tail };
}

function splitTrailer(value: string): { head: string; tail: string } | null {
  return splitSpacedTrailer(value) || splitGluedTrailer(value);
}

function splitPeople(tail: string): string[] {
  return tail
    .split(/\s*(?:&|,|\band\b)\s*/i)
    .map(tidyName)
    .filter((name) => name.length > 0 && !PLACEHOLDER_PEOPLE.has(name.toLowerCase()));
}

function splitSponsors(tail: string): { sponsor: string | null; secondarySponsors: string[] } {
  const parts = tail
    .split(/\s*(?:&|,|\band\b)\s*/i)
    .map(tidyName)
    .filter((s) => s.length > 0 && !PLACEHOLDER_PEOPLE.has(s.toLowerCase()));
  if (parts.length === 0) return { sponsor: null, secondarySponsors: [] };
  return {
    sponsor: parts[0],
    secondarySponsors: parts.slice(1),
  };
}

export interface CardStructurePatch {
  templateId?: string;
  anchorDate?: string;
  title?: string;
  issueNumber?: string;
  people?: string[];
  sponsor?: string;
  secondarySponsors?: string[];
}

export interface StructuredCardShape {
  templateId?: string | null;
  anchorDate?: string;
  title?: string | null;
  issueNumber?: string | null;
  people?: string[];
  sponsor?: string | null;
  secondarySponsors?: string[];
}

function sameList(left: string[] | undefined, right: string[] | undefined): boolean {
  return JSON.stringify(left || []) === JSON.stringify(right || []);
}

/**
 * Decide the backfill patch for one Card. Returns null when nothing should
 * change. Existing `templateId`, `people`, `sponsor`, and `issueNumber` values
 * are never overwritten unless stale, and titles are only rewritten when the tag
 * names a known Template (so unknown tags keep their full title instead of losing parts).
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
  if (parsed.issueNumber && card.issueNumber !== parsed.issueNumber) {
    patch.issueNumber = parsed.issueNumber;
  }
  if (parsed.people.length > 0 && !sameList(card.people, parsed.people)) {
    patch.people = parsed.people;
  }
  if (parsed.sponsor !== null && (card.sponsor || null) !== parsed.sponsor) {
    patch.sponsor = parsed.sponsor;
  }
  if (parsed.secondarySponsors && parsed.secondarySponsors.length > 0 && !sameList(card.secondarySponsors, parsed.secondarySponsors)) {
    patch.secondarySponsors = parsed.secondarySponsors;
  }
  return Object.keys(patch).length > 0 ? patch : null;
}

export interface ParseCardTitleOptions {
  templateType?: string | null;
}

export function parseCardTitle(title: string, options?: ParseCardTitleOptions): ParsedCardTitle {
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

  const templateType = tag ? templateTypeForTag(tag) : (options?.templateType ?? null);
  let people: string[] = [];
  let sponsor: string | null = null;
  let secondarySponsors: string[] = [];
  let issueNumber: string | null = null;
  let topic = clean;

  if (templateType) {
    const trailer = splitTrailer(clean);
    if (trailer) {
      if (templateType === 'newsletter') {
        const sp = splitSponsors(trailer.tail);
        if (sp.sponsor) {
          sponsor = sp.sponsor;
          secondarySponsors = sp.secondarySponsors;
          topic = trailer.head;
        }
      } else if (PERSON_TEMPLATE_TYPES.has(templateType)) {
        const names = splitPeople(trailer.tail);
        if (names.length > 0) {
          people = names;
          topic = trailer.head;
        }
      }
    }

    // Extract issue number: `#298`, `# 298`
    const issueMatch = topic.match(/#\s*(\d+)\b/);
    if (issueMatch) {
      issueNumber = issueMatch[1];
      const stripped = topic.slice(0, issueMatch.index) + topic.slice(issueMatch.index! + issueMatch[0].length);
      const cleaned = stripped.replace(/\s{2,}/g, ' ').replace(/^[-–:;\s]+|[-–:;\s]+$/g, '').trim();
      if (cleaned.length > 0) {
        topic = tidySeparators(cleaned);
      }
    }
  }

  // Untagged titles with no known template are left untouched
  const cleanTitle = (tag || templateType)
    ? (topic || (issueNumber ? `#${issueNumber}` : clean))
    : (input.trim() || 'Untitled card');

  return {
    tag,
    templateType,
    date,
    issueNumber,
    people,
    sponsor,
    secondarySponsors,
    cleanTitle,
  };
}

export function findTemplateTypeById(
  templateId: string,
  templateIdByType?: Map<string, string> | Record<string, string>,
): string | null {
  if (!templateId || !templateIdByType) return null;
  if (templateIdByType instanceof Map) {
    for (const [type, id] of templateIdByType.entries()) {
      if (id === templateId) return type;
    }
  } else {
    for (const [type, id] of Object.entries(templateIdByType)) {
      if (id === templateId) return type;
    }
  }
  return null;
}

/**
 * Derive structured fields from a Card's raw title on read when they are not
 * stored yet. Modifies the Card in-place with non-destructive, safe defaults.
 */
export function hydrateStructuredCardFields(
  card: Card,
  templateIdByType?: Map<string, string> | Record<string, string>,
): void {
  if (!card || !card.title) return;
  const knownTemplateType = card.templateId
    ? findTemplateTypeById(card.templateId, templateIdByType)
    : null;
  const parsed = parseCardTitle(card.title, { templateType: knownTemplateType });

  if (parsed.tag || parsed.date || (knownTemplateType && (parsed.people.length > 0 || parsed.sponsor || parsed.issueNumber))) {
    if (!card.templateId && parsed.templateType && templateIdByType) {
      const lookup =
        templateIdByType instanceof Map
          ? templateIdByType.get(parsed.templateType)
          : (templateIdByType as Record<string, string>)[parsed.templateType];
      if (lookup) card.templateId = lookup;
    }
    if (parsed.date) {
      card.anchorDate = parsed.date;
    }
    if ((card.issueNumber === undefined || card.issueNumber === null) && parsed.issueNumber) {
      card.issueNumber = parsed.issueNumber;
    }
    if ((!card.people || card.people.length === 0) && parsed.people.length > 0) {
      card.people = parsed.people;
    }
    if ((card.sponsor === undefined || card.sponsor === null) && parsed.sponsor) {
      card.sponsor = parsed.sponsor;
    }
    if ((!card.secondarySponsors || card.secondarySponsors.length === 0) && parsed.secondarySponsors && parsed.secondarySponsors.length > 0) {
      card.secondarySponsors = parsed.secondarySponsors;
    }
    if (parsed.cleanTitle && parsed.cleanTitle !== card.title) {
      card.title = parsed.cleanTitle;
    }
  }
}
