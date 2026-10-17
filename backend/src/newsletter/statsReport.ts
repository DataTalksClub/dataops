import type {
  NewsletterIssue,
  NewsletterIssueKind,
  NewsletterSlotPosition,
} from '../db/newsletterIssues';
import { issueLabel, SLOT_POSITIONS } from './issueCard';

export interface SponsorStatsReport {
  issueId: string;
  label: string;
  kind: NewsletterIssueKind;
  issueNumber?: number;
  publicationDate: string;
  publicUrl?: string;
  slot: NewsletterSlotPosition;
  sponsor: string | null;
  organizationId?: string;
  recordedAt: string | null;
  newsletter: {
    deliveries?: number;
    views?: number;
    clicks?: number;
    uniqueClicks?: number;
    openRate?: number;
    clickRate?: number;
  };
  linkedin: {
    views?: number;
    clicks?: number;
    ctr?: number;
    postUrl?: string;
  };
  x: {
    views?: number;
    clicks?: number;
    ctr?: number;
    postUrl?: string;
  };
  totals: {
    views: number;
    clicks: number;
  };
  message: string;
}

const fmtInt = (value: number) => new Intl.NumberFormat('en-US').format(value);

function channelBullet(label: string, views?: number, clicks?: number): string | null {
  if (views === undefined && clicks === undefined) return null;
  const viewPart = `${fmtInt(views ?? 0)} views`;
  const clickPart = clicks && clicks > 0 ? ` / ${fmtInt(clicks)} clicks` : '';
  return `- ${viewPart}${clickPart} in ${label}`;
}

/**
 * Format the sponsor newsletter performance report following
 * `template.newsletter.newsletter-performance` (`system.partnerships-and-revenue.report-sponsor-results`).
 * Zero clicks on a channel are omitted per the template note.
 */
export function formatSponsorStatsMessage(
  newsletter: { views?: number; clicks?: number },
  linkedin: { views?: number; clicks?: number },
  x: { views?: number; clicks?: number },
  totals: { views: number; clicks: number },
  options: { contactName?: string } = {},
): string {
  const greeting = `Hi ${options.contactName?.trim() || '<NAME>'}`;
  const bullets = [
    channelBullet('the newsletter', newsletter.views, newsletter.clicks),
    channelBullet('LinkedIn', linkedin.views, linkedin.clicks),
    channelBullet('Twitter', x.views, x.clicks),
  ].filter((line): line is string => Boolean(line));
  const totalClicks = totals.clicks > 0 ? ` and ${fmtInt(totals.clicks)} clicks` : '';
  const summaryLine = `So ${fmtInt(totals.views)} views${totalClicks} in total`;
  return [
    greeting,
    '',
    'We just wanted to share how the newsletter performed last week',
    ...(bullets.length ? ['', ...bullets.flatMap((line) => [line, ''])] : ['']),
    summaryLine,
    '',
    "We hope you're satisfied with the results. Thanks for supporting us!",
  ].join('\n');
}

export function buildSponsorStatsReport(
  issue: NewsletterIssue,
  position: NewsletterSlotPosition = 'primary',
  options: { contactName?: string } = {},
): SponsorStatsReport {
  const slot = issue.slots?.[position] || {};
  const issueStats = issue.stats;
  const slotStats = slot.stats;
  const newsletter = {
    ...(issueStats?.deliveries !== undefined ? { deliveries: issueStats.deliveries } : {}),
    ...(issueStats?.opens !== undefined ? { views: issueStats.opens } : {}),
    ...((slotStats?.clicks ?? issueStats?.clicks) !== undefined
      ? { clicks: slotStats?.clicks ?? issueStats?.clicks }
      : {}),
    ...((slotStats?.uniqueClicks ?? issueStats?.uniqueClicks) !== undefined
      ? { uniqueClicks: slotStats?.uniqueClicks ?? issueStats?.uniqueClicks }
      : {}),
    ...(issueStats?.openRate !== undefined ? { openRate: issueStats.openRate } : {}),
    ...((slotStats?.clickRate ?? issueStats?.clickRate) !== undefined
      ? { clickRate: slotStats?.clickRate ?? issueStats?.clickRate }
      : {}),
  };
  const linkedin = {
    ...(slotStats?.linkedinImpressions !== undefined ? { views: slotStats.linkedinImpressions } : {}),
    ...(slotStats?.linkedinClicks !== undefined ? { clicks: slotStats.linkedinClicks } : {}),
    ...(slotStats?.linkedinCtr !== undefined ? { ctr: slotStats.linkedinCtr } : {}),
    ...(slotStats?.linkedinPostUrl ? { postUrl: slotStats.linkedinPostUrl } : {}),
  };
  const x = {
    ...(slotStats?.xImpressions !== undefined ? { views: slotStats.xImpressions } : {}),
    ...(slotStats?.xClicks !== undefined ? { clicks: slotStats.xClicks } : {}),
    ...(slotStats?.xCtr !== undefined ? { ctr: slotStats.xCtr } : {}),
    ...(slotStats?.xPostUrl ? { postUrl: slotStats.xPostUrl } : {}),
  };
  const totals = {
    views: (newsletter.views || 0) + (linkedin.views || 0) + (x.views || 0),
    clicks: (newsletter.clicks || 0) + (linkedin.clicks || 0) + (x.clicks || 0),
  };
  const recordedAt = [slotStats?.recordedAt, issueStats?.recordedAt].filter(Boolean).sort().at(-1) || null;
  return {
    issueId: issue.id,
    label: issueLabel(issue),
    kind: issue.kind,
    ...(issue.issueNumber !== undefined ? { issueNumber: issue.issueNumber } : {}),
    publicationDate: issue.publicationDate,
    ...(issue.publicUrl ? { publicUrl: issue.publicUrl } : {}),
    slot: position,
    sponsor: slot.sponsor || null,
    ...(slot.organizationId ? { organizationId: slot.organizationId } : {}),
    recordedAt,
    newsletter,
    linkedin,
    x,
    totals,
    message: formatSponsorStatsMessage(newsletter, linkedin, x, totals, options),
  };
}

export function buildIssueStatsReports(
  issue: NewsletterIssue,
  options: { slot?: NewsletterSlotPosition; contactName?: string } = {},
): SponsorStatsReport[] {
  if (options.slot) return [buildSponsorStatsReport(issue, options.slot, options)];
  const positions = SLOT_POSITIONS[issue.kind] as readonly NewsletterSlotPosition[];
  const active = positions.filter((pos) => issue.slots?.[pos]?.sponsor || issue.slots?.[pos]?.stats);
  const target = active.length ? active : (['primary'] as const);
  return target.map((pos) => buildSponsorStatsReport(issue, pos, options));
}

export function filterSponsorStatsReports(
  issues: NewsletterIssue[],
  filter: { sponsor?: string; organizationId?: string; slot?: NewsletterSlotPosition; contactName?: string } = {},
): SponsorStatsReport[] {
  const needle = filter.sponsor?.trim().toLowerCase() || '';
  const orgId = filter.organizationId?.trim() || '';
  const out: SponsorStatsReport[] = [];
  for (const issue of issues) {
    if (issue.status === 'cancelled') continue;
    const positions = filter.slot
      ? ([filter.slot] as const)
      : (SLOT_POSITIONS[issue.kind] as readonly NewsletterSlotPosition[]);
    for (const position of positions) {
      if (!(SLOT_POSITIONS[issue.kind] as readonly string[]).includes(position)) continue;
      const slot = issue.slots?.[position];
      const hasStats = Boolean(issue.stats || slot?.stats);
      const hasSponsor = Boolean(slot?.sponsor);
      if (!hasStats && !hasSponsor) continue;
      if (orgId && slot?.organizationId !== orgId) continue;
      if (needle) {
        const sponsorText = (slot?.sponsor || '').toLowerCase();
        const orgMatch = slot?.organizationId?.toLowerCase() === needle;
        if (!orgMatch && !sponsorText.includes(needle)) continue;
      }
      out.push(buildSponsorStatsReport(issue, position, { contactName: filter.contactName }));
    }
  }
  return out;
}
