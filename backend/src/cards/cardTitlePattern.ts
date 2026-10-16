/**
 * Card titles composed from the planning record a Card executes.
 *
 * A Template may author `card_title`, a pattern such as
 * `{date} · #{issue} · {sponsor} · {variant}`. When a Card is created from a
 * newsletter issue or podcast episode, and whenever that record's facts change,
 * the Card's stored title is re-rendered from the pattern, so every surface
 * (Queue, Cards, calendar, hover card, CLI) shows the same distinguishing name.
 *
 * Parts are separated by `separator`; a part whose tokens all render empty is
 * dropped together with its separator, so `#{issue}` disappears for a
 * stand-alone send. The token vocabulary lives in `cardTitleTokens.json` so the
 * private knowledge repository's template validator reads the same names.
 */
import vocabulary from './cardTitleTokens.json';

export type TitleRecordType = 'newsletter-issue' | 'podcast-episode';
export type CardTitleValues = Record<string, string | null | undefined>;

const SEPARATOR = vocabulary.separator;
const TOKEN = /\{([^{}]*)\}/g;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function record(type: TitleRecordType) {
  const found = vocabulary.records.find((entry) => entry.id === type);
  if (!found) throw new Error(`Unknown card title record type ${type}`);
  return found;
}

/** Template types whose Cards a record of `type` links. */
export function recordTemplateTypes(type: TitleRecordType): string[] {
  return [...record(type).templateTypes];
}

/**
 * Problems with a Template's `card_title`, naming each unknown token. A
 * pattern is only meaningful on a Template whose Cards a record links.
 */
export function cardTitlePatternIssues(templateType: string, pattern: unknown): string[] {
  if (typeof pattern !== 'string' || !pattern.trim()) return ['card_title must be a non-empty string'];
  const owner = vocabulary.records.find((entry) => entry.templateTypes.includes(templateType));
  if (!owner) {
    const linked = vocabulary.records.flatMap((entry) => entry.templateTypes).join(', ');
    return [`card_title is only supported on templates linked from a planning record (${linked})`];
  }
  const issues: string[] = [];
  const known = Object.keys(owner.tokens);
  for (const [, name] of pattern.matchAll(TOKEN)) {
    if (!known.includes(name)) issues.push(`card_title token {${name}} is unknown; use ${known.map((token) => `{${token}}`).join(', ')}`);
  }
  if (/[{}]/.test(pattern.replace(TOKEN, ''))) issues.push('card_title has an unbalanced brace');
  return issues;
}

/** Render a pattern; parts whose tokens are all empty drop out with their separator. */
export function renderCardTitle(pattern: string, values: CardTitleValues): string {
  const parts: string[] = [];
  for (const part of pattern.split(SEPARATOR)) {
    const tokens = [...part.matchAll(TOKEN)].map(([, name]) => String(values[name] ?? '').trim());
    if (tokens.length > 0 && tokens.every((value) => !value)) continue;
    const rendered = part.replace(TOKEN, (_, name: string) => String(values[name] ?? '').trim()).trim();
    if (rendered) parts.push(rendered);
  }
  return parts.join(SEPARATOR);
}

/** `2026-10-19` -> `19 Oct`. The year is left out: the Card's date carries it. */
export function shortDate(isoDate: string | null | undefined): string {
  const match = String(isoDate || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!match) return '';
  return `${Number(match[3])} ${MONTHS[Number(match[2]) - 1]}`;
}

/** A newsletter issue's title values. */
export function newsletterIssueTitleValues(issue: {
  kind: string;
  publicationDate: string;
  issueNumber?: number | null;
  slots: Partial<Record<'primary' | 'secondary', { ticked: boolean; sponsor?: string } | undefined>>;
}): CardTitleValues {
  const booked = (['primary', 'secondary'] as const)
    .map((position) => issue.slots[position])
    .filter((slot) => slot?.ticked && slot.sponsor)
    .map((slot) => String(slot!.sponsor));
  return {
    date: shortDate(issue.publicationDate),
    issue: issue.issueNumber == null ? '' : String(issue.issueNumber),
    sponsor: issue.slots.primary?.ticked ? issue.slots.primary.sponsor || '' : '',
    sponsors: booked.join(' + '),
    variant: issue.kind === 'standalone' ? 'stand-alone' : '',
  };
}

/**
 * Title values for a Card created directly from a Template with a
 * `card_title`, before any planning record links it: the Card's own date,
 * issue number and sponsors fill the tokens they share with the record.
 */
export function cardFieldTitleValues(templateType: string, fields: {
  anchorDate?: unknown;
  issueNumber?: unknown;
  sponsor?: unknown;
  secondarySponsors?: unknown;
}): CardTitleValues {
  const text = (value: unknown) => (typeof value === 'string' || typeof value === 'number' ? String(value).trim() : '');
  const sponsor = text(fields.sponsor);
  const secondary = Array.isArray(fields.secondarySponsors) ? fields.secondarySponsors.map(text).filter(Boolean) : [];
  return {
    date: shortDate(text(fields.anchorDate)),
    issue: text(fields.issueNumber),
    sponsor,
    sponsors: [sponsor, ...secondary].filter(Boolean).join(' + '),
    variant: templateType === 'newsletter-standalone' ? 'stand-alone' : '',
  };
}

export function podcastEpisodeTitleValues(episode: {
  season?: number | null;
  episode?: number | null;
  title?: string | null;
  guests: { name: string }[];
  recordingDate?: string | null;
}): CardTitleValues {
  return {
    date: shortDate(episode.recordingDate),
    code: episode.season != null && episode.episode != null ? `S${episode.season}E${episode.episode}` : '',
    guests: episode.guests.map((guest) => guest.name).join(' & '),
    title: episode.title || '',
  };
}
