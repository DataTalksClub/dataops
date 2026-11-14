import { listAcademyLeads, scanAcademySignups } from './service';

export interface AcademyPageviewRow {
  date: string;
  page: string;
  track: string;
  utm_source: string;
  utm_medium: string;
  utm_campaign: string;
  utm_content: string;
  count: number;
  is_test: boolean;
}

export interface AcademyTrackConversion {
  visits: number;
  signups: number;
  conversion: number | null;
}

export interface AcademyPageviewsResponse {
  rows: AcademyPageviewRow[];
  summary: {
    visits: number;
    testVisits: number;
    byTrack: Record<string, AcademyTrackConversion>;
    byDay: Record<string, number>;
  };
}

type RawItem = Record<string, unknown>;

export const ACADEMY_TRACKS = ['agentic-engineering', 'ai-engineering'];

/** Test traffic = any utm_source/medium/campaign/content equal to or starting with "test" (e.g. ?utm_source=test). */
export function isTestPageview(row: Pick<AcademyPageviewRow, 'utm_source' | 'utm_medium' | 'utm_campaign' | 'utm_content'>): boolean {
  return [row.utm_source, row.utm_medium, row.utm_campaign, row.utm_content].some((v) => /^test([-_]|$)/i.test(v));
}

export function trackForPage(page: string): string {
  for (const t of ACADEMY_TRACKS) if (page.includes(t)) return t;
  return '';
}

/** Parses a PV# item: sk = page|utm_source|utm_medium|utm_campaign|utm_content (legacy: 4 parts, no medium). */
export function normalizePageview(item: RawItem): AcademyPageviewRow | null {
  const pk = typeof item.pk === 'string' ? item.pk : '';
  const sk = typeof item.sk === 'string' ? item.sk : '';
  if (!pk.startsWith('PV#')) return null;
  const raw = sk.split('|');
  let page: string, source: string, medium: string, campaign: string, content: string;
  if (raw.length === 4) {
    [page, source, campaign, content] = raw;
    medium = '-';
  } else {
    [page, source, medium, campaign, content] = [...raw, '-', '-', '-', '-'].slice(0, 5);
  }
  const base = {
    date: pk.slice(3),
    page,
    track: trackForPage(page),
    utm_source: source,
    utm_medium: medium,
    utm_campaign: campaign,
    utm_content: content,
    count: Number(item.count) || 0,
  };
  return { ...base, is_test: isTestPageview(base) };
}

export function summarizePageviews(
  rows: AcademyPageviewRow[],
  testVisits: number,
  signupsByTrack: Record<string, number>,
): AcademyPageviewsResponse['summary'] {
  const byTrack: Record<string, AcademyTrackConversion> = {};
  for (const t of ACADEMY_TRACKS) byTrack[t] = { visits: 0, signups: signupsByTrack[t] || 0, conversion: null };
  const byDay: Record<string, number> = {};
  let visits = 0;
  for (const r of rows) {
    visits += r.count;
    byDay[r.date] = (byDay[r.date] || 0) + r.count;
    if (r.track) {
      byTrack[r.track] ||= { visits: 0, signups: signupsByTrack[r.track] || 0, conversion: null };
      byTrack[r.track].visits += r.count;
    }
  }
  for (const t of Object.values(byTrack)) {
    t.conversion = t.visits > 0 ? Math.round((t.signups / t.visits) * 10000) / 10000 : null;
  }
  return { visits, testVisits, byTrack, byDay };
}

export async function listAcademyPageviews(options?: {
  includeTests?: boolean;
  from?: string;
  to?: string;
  scanPageviews?: () => Promise<RawItem[]>;
  scanSignups?: () => Promise<RawItem[]>;
}): Promise<AcademyPageviewsResponse> {
  const [pv, signups] = await Promise.all([
    options?.scanPageviews ? options.scanPageviews() : scanAcademySignups({ prefix: 'PV#' }),
    listAcademyLeads({ includeTests: false, scanItems: options?.scanSignups }),
  ]);
  const all = pv.map(normalizePageview).filter((r): r is AcademyPageviewRow => r !== null);
  const inRange = all.filter((r) => (!options?.from || r.date >= options.from) && (!options?.to || r.date <= options.to));
  const testVisits = inRange.filter((r) => r.is_test).reduce((n, r) => n + r.count, 0);
  const rows = inRange
    .filter((r) => options?.includeTests === true || !r.is_test)
    .sort((a, b) => b.date.localeCompare(a.date) || a.page.localeCompare(b.page) || b.count - a.count);
  const signupsByTrack = signups.summary.byTrack;
  return { rows, summary: summarizePageviews(rows, testVisits, signupsByTrack) };
}
