/**
 * Automatic pull of newsletter performance metrics from Mailchimp Marketing API v3.
 *
 * Reads the Mailchimp API key (`<key>-<dc>`) from the DataOps runtime secrets
 * store (`dataops-v1.mailchimp-token` or `course-management.mailchimp-token`),
 * matches the newsletter issue to its sent Mailchimp campaign, fetches
 * `/3.0/reports/{id}` and `/3.0/reports/{id}/click-details`, and computes
 * issue-level (`sent`, `opens`, `openRate`, `clicks`, `uniqueClicks`, `clickRate`)
 * and per-slot (`primary`, `secondary`) sponsor link clicks while preserving
 * any recorded LinkedIn / X metrics.
 */
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

import {
  type NewsletterIssue,
  type NewsletterIssueKind,
  type NewsletterIssueStats,
  type NewsletterSlot,
  type NewsletterSlotPosition,
  type NewsletterSlotStats,
} from '../db/newsletterIssues';
import { getSponsorDoc, listSponsorDocSummariesByCardId } from '../db/sponsorDocs';
import { getCrmRecord } from '../db/sponsorCrm';
import { readRuntimeSecret } from '../secrets/reader';
import { berlinDate } from '../sponsorFinance/core';
import { SLOT_POSITIONS } from './issueCard';
import { parseNewsletterIssueMarkdown } from './markdownPreview';

export const DEFAULT_MAILCHIMP_SECRET_NAMES = [
  'dataops-v1.mailchimp-token',
  'course-management.mailchimp-token',
] as const;

const INTERNAL_HOST_PATTERNS = [
  /(^|\.)datatalks\.club$/i,
  /^github\.com$/i,
  /(^|\.)campaign-archive\.com$/i,
  /(^|\.)list-manage\.com$/i,
  /(^|\.)mailchi\.mp$/i,
  /(^|\.)eepurl\.com$/i,
  /^lu\.ma$/i,
  /^luma\.com$/i,
  /^calendar\.google\.com$/i,
  /^airtable\.com$/i,
  /^(www\.)?twitter\.com$/i,
  /^(www\.)?x\.com$/i,
  /^(www\.)?linkedin\.com$/i,
  /^(www\.)?youtube\.com$/i,
  /^youtu\.be$/i,
  /(^|\.)aishippingblog\.com$/i,
  /(^|\.)substack\.com$/i,
];

export interface MailchimpCampaignSummary {
  id: string;
  web_id?: number;
  send_time?: string;
  archive_url?: string;
  long_archive_url?: string;
  emails_sent?: number;
  settings?: {
    title?: string;
    subject_line?: string;
  };
}

export interface MailchimpClickDetailEntry {
  url?: string;
  total_clicks?: number;
  unique_clicks?: number;
}

export interface MailchimpReportPayload {
  id?: string;
  campaign_title?: string;
  emails_sent?: number;
  send_time?: string;
  opens?: {
    opens_total?: number;
    unique_opens?: number;
    open_rate?: number;
  };
  clicks?: {
    clicks_total?: number;
    unique_clicks?: number;
    unique_subscriber_clicks?: number;
    click_rate?: number;
  };
}

export interface MailchimpMetricsDeps {
  fetchImpl?: typeof fetch;
  readSecret?: typeof readRuntimeSecret;
  apiKey?: string;
}

let deps: MailchimpMetricsDeps = {};

export function setMailchimpMetricsDepsForTests(next: MailchimpMetricsDeps): void {
  deps = next;
}

export class MailchimpMetricsError extends Error {
  statusCode: number;
  code: string;

  constructor(message: string, statusCode = 422, code = 'mailchimp_error') {
    super(message);
    this.name = 'MailchimpMetricsError';
    this.statusCode = statusCode;
    this.code = code;
  }
}

function parseApiKeyAndServer(raw: string): { apiKey: string; server: string } | null {
  const trimmed = String(raw || '').trim();
  if (!trimmed) return null;
  let candidate = trimmed;
  let explicitServer = '';
  if (trimmed.startsWith('{')) {
    try {
      const parsed = JSON.parse(trimmed) as Record<string, unknown>;
      candidate = String(parsed.apiKey || parsed.api_key || parsed.token || parsed.value || '').trim();
      explicitServer = String(parsed.server || parsed.dc || '').trim();
    } catch {
      return null;
    }
  }
  const server = explicitServer || (candidate.includes('-') ? candidate.split('-').pop() || '' : '');
  if (!candidate || !server || !/^[a-z]{2}\d+$/i.test(server)) return null;
  return { apiKey: candidate, server: server.toLowerCase() };
}

export async function resolveMailchimpCredentials(): Promise<{ apiKey: string; server: string }> {
  if (deps.apiKey) {
    const parsed = parseApiKeyAndServer(deps.apiKey);
    if (parsed) return parsed;
  }
  const envKey = process.env.MAILCHIMP_API_KEY || '';
  if (envKey) {
    const parsed = parseApiKeyAndServer(envKey);
    if (parsed) return parsed;
  }
  const secretReader = deps.readSecret || readRuntimeSecret;
  const envSecretName = (process.env.DATAOPS_MAILCHIMP_SECRET_NAME || '').trim();
  const names = [
    ...(envSecretName ? [envSecretName] : []),
    ...DEFAULT_MAILCHIMP_SECRET_NAMES,
  ];
  for (const name of names) {
    try {
      const value = await secretReader(name);
      const parsed = parseApiKeyAndServer(value);
      if (parsed) return parsed;
    } catch {
      // Try next candidate secret name.
    }
  }
  throw new MailchimpMetricsError(
    `No Mailchimp API key found in runtime secrets (${DEFAULT_MAILCHIMP_SECRET_NAMES.join(' or ')})`,
    503,
    'mailchimp_credentials_missing',
  );
}

async function mailchimpGet<T>(
  server: string,
  apiKey: string,
  path: string,
): Promise<T> {
  const fetchFn = deps.fetchImpl || fetch;
  const url = `https://${server}.api.mailchimp.com/3.0${path}`;
  const auth = `Basic ${Buffer.from(`anystring:${apiKey}`).toString('base64')}`;
  let response: Response;
  try {
    response = await fetchFn(url, {
      method: 'GET',
      headers: {
        authorization: auth,
        accept: 'application/json',
      },
    });
  } catch (err) {
    throw new MailchimpMetricsError(
      `Mailchimp API request failed: ${(err as Error)?.message || 'network error'}`,
      502,
      'mailchimp_unreachable',
    );
  }
  if (response.status === 404) {
    throw new MailchimpMetricsError('Mailchimp campaign or report not found', 404, 'mailchimp_not_found');
  }
  if (!response.ok) {
    throw new MailchimpMetricsError(
      `Mailchimp API returned HTTP ${response.status}`,
      502,
      'mailchimp_http_error',
    );
  }
  return (await response.json()) as T;
}

export function isInternalNewsletterUrl(rawUrl: string): boolean {
  try {
    const parsed = new URL(rawUrl);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return true;
    const host = parsed.hostname.toLowerCase();
    return INTERNAL_HOST_PATTERNS.some((pattern) => pattern.test(host));
  } catch {
    return true;
  }
}

function extractUrlsFromText(text: string): string[] {
  const urls: string[] = [];
  const markdownLinkRegex = /\[[^\]]*\]\((https?:\/\/[^\s)]+)\)/gi;
  let match: RegExpExecArray | null;
  while ((match = markdownLinkRegex.exec(text)) !== null) {
    urls.push(match[1].trim());
  }
  const bareUrlRegex = /(?<!\()(https?:\/\/[^\s)>\]"']+)/gi;
  while ((match = bareUrlRegex.exec(text)) !== null) {
    urls.push(match[1].replace(/[.,;:!?]+$/, '').trim());
  }
  return [...new Set(urls.filter((u) => !isInternalNewsletterUrl(u)))];
}

/**
 * Extract primary and secondary sponsor CTA URLs from the issue's stored
 * `issue.md` markdown package.
 */
export function extractSlotUrlsFromIssueMarkdown(
  markdown: string | undefined,
  kind: NewsletterIssueKind,
): Partial<Record<NewsletterSlotPosition, string[]>> {
  const raw = String(markdown || '').replace(/\r\n/g, '\n').trim();
  if (!raw) return {};
  const body = raw.replace(/^---\n[\s\S]*?\n---\n*/, '');
  if (kind === 'standalone') {
    const urls = extractUrlsFromText(body);
    return urls.length ? { primary: urls } : {};
  }

  const lines = body.split('\n');
  const firstHeadingIdx = lines.findIndex((line) => /^##\s+/.test(line.trim()));
  if (firstHeadingIdx < 0) return {};

  // Primary section: from the first `## ` heading until the next `## ` heading
  // or course banner separator.
  let primaryEndIdx = lines.length;
  for (let i = firstHeadingIdx + 1; i < lines.length; i += 1) {
    const trimmed = lines[i].trim();
    if (
      /^##\s+/.test(trimmed)
      || /^\[Banner:/i.test(trimmed)
      || /^https?:\/\/github\.com\/DataTalksClub\//i.test(trimmed)
    ) {
      primaryEndIdx = i;
      break;
    }
  }
  const primaryUrls = extractUrlsFromText(lines.slice(firstHeadingIdx, primaryEndIdx).join('\n'));

  // Secondary section: after the primary section, look for a `SPONSORED` marker
  // line and capture from there through the following `## ` block.
  let secondaryUrls: string[] = [];
  for (let i = primaryEndIdx; i < lines.length; i += 1) {
    const trimmed = lines[i].trim();
    if (/^(\[SPONSORED\]|SPONSORED\b)/i.test(trimmed)) {
      let secEnd = lines.length;
      let seenHeading = false;
      for (let j = i + 1; j < lines.length; j += 1) {
        const nextTrimmed = lines[j].trim();
        if (/^##\s+/.test(nextTrimmed)) {
          if (seenHeading) {
            secEnd = j;
            break;
          }
          seenHeading = true;
          continue;
        }
        if (seenHeading && /^(NEWS|EVENTS|RECORDINGS|READ|COURSES|COMMUNITY)\b/.test(nextTrimmed)) {
          secEnd = j;
          break;
        }
      }
      secondaryUrls = extractUrlsFromText(lines.slice(i + 1, secEnd).join('\n'));
      break;
    }
  }

  return {
    ...(primaryUrls.length ? { primary: primaryUrls } : {}),
    ...(secondaryUrls.length ? { secondary: secondaryUrls } : {}),
  };
}

export function normalizeComparableUrl(rawUrl: string): {
  originAndPath: string;
  hostname: string;
} | null {
  try {
    const parsed = new URL(rawUrl.trim());
    const hostname = parsed.hostname.toLowerCase().replace(/^www\./, '');
    const pathname = parsed.pathname.replace(/\/+$/, '');
    return {
      originAndPath: `https://${hostname}${pathname}`,
      hostname,
    };
  } catch {
    return null;
  }
}

export function matchClickDetailsForSlot(
  urlsClicked: MailchimpClickDetailEntry[],
  targetUrls: string[],
  sponsorName?: string,
): { clicks: number; uniqueClicks: number; matchedUrls: string[] } | null {
  const targets = targetUrls
    .map((u) => normalizeComparableUrl(u))
    .filter((u): u is NonNullable<typeof u> => Boolean(u));

  const matchedEntries: MailchimpClickDetailEntry[] = [];
  const matchedUrls = new Set<string>();

  if (targets.length > 0) {
    for (const entry of urlsClicked) {
      if (!entry.url) continue;
      const candidate = normalizeComparableUrl(entry.url);
      if (!candidate) continue;
      const matches = targets.some((target) => {
        if (target.originAndPath === candidate.originAndPath) return true;
        // If target has no path (root domain), match by hostname.
        if (target.originAndPath === `https://${target.hostname}` && target.hostname === candidate.hostname) {
          return true;
        }
        return false;
      });
      if (matches) {
        matchedEntries.push(entry);
        matchedUrls.add(candidate.originAndPath);
      }
    }
  }

  // Fallback by sponsor name token against non-internal clicked URLs when no explicit URL matched
  if (matchedEntries.length === 0 && sponsorName) {
    const slug = sponsorName
      .toLowerCase()
      .replace(/\b(ai|db|io|inc|llc|ltd|corp|data|cloud|tech|labs)\b/g, '')
      .replace(/[^a-z0-9]/g, '')
      .trim();
    const fullSlug = sponsorName.toLowerCase().replace(/[^a-z0-9]/g, '').trim();
    const tokens = [slug, fullSlug].filter((t) => t.length >= 4);
    if (tokens.length > 0) {
      // Pick the highest-click external URL group matching the sponsor token
      const groups = new Map<string, MailchimpClickDetailEntry[]>();
      for (const entry of urlsClicked) {
        if (!entry.url || isInternalNewsletterUrl(entry.url)) continue;
        const candidate = normalizeComparableUrl(entry.url);
        if (!candidate) continue;
        const hostClean = candidate.hostname.replace(/[^a-z0-9]/g, '');
        if (tokens.some((tok) => hostClean.includes(tok))) {
          const list = groups.get(candidate.originAndPath) || [];
          list.push(entry);
          groups.set(candidate.originAndPath, list);
        }
      }
      let bestKey = '';
      let bestTotal = -1;
      for (const [key, list] of groups.entries()) {
        const sum = list.reduce((acc, item) => acc + (item.total_clicks || 0), 0);
        if (sum > bestTotal) {
          bestTotal = sum;
          bestKey = key;
        }
      }
      if (bestKey) {
        for (const entry of groups.get(bestKey)!) {
          matchedEntries.push(entry);
          matchedUrls.add(bestKey);
        }
      }
    }
  }

  if (matchedEntries.length === 0) return null;

  const clicks = matchedEntries.reduce((sum, item) => sum + (Number(item.total_clicks) || 0), 0);
  const uniqueClicks = matchedEntries.reduce((sum, item) => sum + (Number(item.unique_clicks) || 0), 0);
  return {
    clicks,
    uniqueClicks,
    matchedUrls: [...matchedUrls],
  };
}

function candidateIssueUrls(issue: NewsletterIssue): string[] {
  const urls: string[] = [];
  if (issue.publicUrl) urls.push(issue.publicUrl);
  for (const link of issue.links || []) {
    if (link.url) urls.push(link.url);
  }
  if (issue.markdown?.issue) {
    const parsed = parseNewsletterIssueMarkdown(issue.markdown.issue);
    for (const key of ['archive_url', 'mailchimp_campaign', 'mailchimp_url', 'public_url']) {
      if (parsed.frontmatter[key]) urls.push(parsed.frontmatter[key]);
    }
  }
  return urls;
}

export function matchMailchimpCampaign(
  issue: NewsletterIssue,
  campaigns: MailchimpCampaignSummary[],
  requestedCampaignId?: string,
): MailchimpCampaignSummary | null {
  if (requestedCampaignId) {
    const req = requestedCampaignId.trim();
    const found = campaigns.find(
      (c) => c.id === req || (c.web_id !== undefined && String(c.web_id) === req),
    );
    if (found) return found;
  }

  const urls = candidateIssueUrls(issue);
  for (const rawUrl of urls) {
    const idParamMatch = /[?&]id=(\d+)\b/.exec(rawUrl);
    if (idParamMatch) {
      const webId = Number(idParamMatch[1]);
      const byWebId = campaigns.find((c) => c.web_id === webId);
      if (byWebId) return byWebId;
    }
    const norm = normalizeComparableUrl(rawUrl);
    if (norm) {
      const byArchive = campaigns.find((c) => {
        const a1 = c.archive_url ? normalizeComparableUrl(c.archive_url) : null;
        const a2 = c.long_archive_url ? normalizeComparableUrl(c.long_archive_url) : null;
        return (
          a1?.originAndPath === norm.originAndPath
          || a2?.originAndPath === norm.originAndPath
        );
      });
      if (byArchive) return byArchive;
    }
  }

  if (issue.kind === 'weekly' && issue.issueNumber !== undefined) {
    const numPattern = new RegExp(`(?:#|weekly[-\\s]+)${issue.issueNumber}\\b`, 'i');
    const byNumber = campaigns.filter(
      (c) =>
        numPattern.test(c.settings?.title || '')
        || numPattern.test(c.settings?.subject_line || '')
        || numPattern.test(c.long_archive_url || ''),
    );
    if (byNumber.length === 1) return byNumber[0];
    if (byNumber.length > 1) {
      const exactDate = byNumber.find((c) => campaignSendDate(c) === issue.publicationDate);
      return exactDate || byNumber[0];
    }
  }

  const sameDate = campaigns.filter((c) => campaignSendDate(c) === issue.publicationDate);
  if (issue.kind === 'standalone') {
    const sponsor = (issue.slots?.primary?.sponsor || '').toLowerCase().trim();
    const standaloneMatch = sameDate.find((c) => {
      const title = (c.settings?.title || '').toLowerCase();
      return (
        title.includes('stand-alone')
        || title.includes('standalone')
        || (sponsor && title.includes(sponsor))
      );
    });
    if (standaloneMatch) return standaloneMatch;
  } else {
    const weeklyMatch = sameDate.find((c) => {
      const title = (c.settings?.title || '').toLowerCase();
      return !title.includes('stand-alone') && !title.includes('standalone');
    });
    if (weeklyMatch) return weeklyMatch;
  }

  return null;
}

function campaignSendDate(campaign: MailchimpCampaignSummary): string {
  if (!campaign.send_time) return '';
  const parsed = new Date(campaign.send_time);
  if (Number.isNaN(parsed.getTime())) return String(campaign.send_time).slice(0, 10);
  return berlinDate(parsed);
}

function deriveRate(numerator: number | undefined, denominator: number | undefined): number | undefined {
  if (numerator === undefined || denominator === undefined || denominator <= 0) return undefined;
  const rate = Math.round((numerator / denominator) * 10000) / 100;
  return rate >= 0 && rate <= 100 ? rate : undefined;
}

async function resolveSlotTargetUrls(
  client: DynamoDBDocumentClient,
  issue: NewsletterIssue,
  slotUrlsOverride?: Partial<Record<NewsletterSlotPosition, string>>,
): Promise<Partial<Record<NewsletterSlotPosition, string[]>>> {
  const result: Partial<Record<NewsletterSlotPosition, string[]>> = {};
  const fromMarkdown = extractSlotUrlsFromIssueMarkdown(issue.markdown?.issue, issue.kind);
  const positions = SLOT_POSITIONS[issue.kind] as readonly NewsletterSlotPosition[];

  let cardDocs: Awaited<ReturnType<typeof listSponsorDocSummariesByCardId>> | null = null;

  for (const position of positions) {
    const explicit = slotUrlsOverride?.[position]?.trim();
    if (explicit) {
      result[position] = [explicit];
      continue;
    }
    if (fromMarkdown[position]?.length) {
      result[position] = fromMarkdown[position];
      continue;
    }
    if (issue.cardId) {
      if (cardDocs === null) {
        cardDocs = await listSponsorDocSummariesByCardId(client, issue.cardId).catch(() => []);
      }
      const targetTemplates = position === 'primary'
        ? ['newsletter-main', 'newsletter-standalone']
        : ['newsletter-secondary'];
      const matchingSummary = cardDocs.find((d) => targetTemplates.includes(d.template));
      if (matchingSummary) {
        const doc = await getSponsorDoc(client, matchingSummary.id).catch(() => null);
        const ctaUrl = doc?.content?.ctaUrl?.trim();
        if (ctaUrl && !isInternalNewsletterUrl(ctaUrl)) {
          result[position] = [ctaUrl];
          continue;
        }
      }
    }
    const orgId = issue.slots?.[position]?.organizationId;
    if (orgId) {
      const org = await getCrmRecord(client, 'organization', orgId).catch(() => null);
      const website = String(org?.website || org?.domain || '').trim();
      if (website) {
        const withProto = /^https?:\/\//i.test(website) ? website : `https://${website}`;
        result[position] = [withProto];
      }
    }
  }

  return result;
}

export interface PullMailchimpMetricsOptions {
  campaignId?: string;
  slotUrls?: Partial<Record<NewsletterSlotPosition, string>>;
}

export interface PulledMailchimpMetrics {
  campaign: {
    id: string;
    webId?: number;
    title: string | null;
    sendTime: string | null;
    archiveUrl: string | null;
  };
  stats: NewsletterIssueStats;
  slots: Partial<Record<NewsletterSlotPosition, NewsletterSlot>>;
  matchedSlotUrls: Partial<Record<NewsletterSlotPosition, string[]>>;
}

export async function pullIssueMailchimpMetrics(
  client: DynamoDBDocumentClient,
  issue: NewsletterIssue,
  options: PullMailchimpMetricsOptions = {},
): Promise<PulledMailchimpMetrics> {
  const { apiKey, server } = await resolveMailchimpCredentials();

  let campaign: MailchimpCampaignSummary | null = null;
  const requestedId = options.campaignId?.trim();

  if (requestedId && !/^\d+$/.test(requestedId)) {
    campaign = await mailchimpGet<MailchimpCampaignSummary>(
      server,
      apiKey,
      `/campaigns/${encodeURIComponent(requestedId)}`,
    );
  } else {
    const listResponse = await mailchimpGet<{ campaigns?: MailchimpCampaignSummary[] }>(
      server,
      apiKey,
      '/campaigns?status=sent&count=100&sort_field=send_time&sort_dir=DESC',
    );
    const campaigns = listResponse.campaigns || [];
    campaign = matchMailchimpCampaign(issue, campaigns, requestedId);
    if (!campaign) {
      throw new MailchimpMetricsError(
        requestedId
          ? `No sent Mailchimp campaign found matching "${requestedId}"`
          : `No sent Mailchimp campaign found for ${issue.kind === 'weekly' && issue.issueNumber ? `Weekly #${issue.issueNumber}` : issue.publicationDate} (${issue.publicationDate})`,
        404,
        'mailchimp_campaign_not_found',
      );
    }
  }

  const [report, clickDetails] = await Promise.all([
    mailchimpGet<MailchimpReportPayload>(server, apiKey, `/reports/${encodeURIComponent(campaign.id)}`),
    mailchimpGet<{ urls_clicked?: MailchimpClickDetailEntry[] }>(
      server,
      apiKey,
      `/reports/${encodeURIComponent(campaign.id)}/click-details?count=100`,
    ),
  ]);

  const sent = typeof report.emails_sent === 'number' && report.emails_sent >= 0
    ? Math.round(report.emails_sent)
    : typeof campaign.emails_sent === 'number' && campaign.emails_sent >= 0
      ? Math.round(campaign.emails_sent)
      : undefined;

  const opens = typeof report.opens?.unique_opens === 'number' && report.opens.unique_opens >= 0
    ? Math.round(report.opens.unique_opens)
    : undefined;

  const openRate = deriveRate(opens, sent)
    ?? (typeof report.opens?.open_rate === 'number'
      ? Math.round(report.opens.open_rate * 10000) / 100
      : undefined);

  const targetUrls = await resolveSlotTargetUrls(client, issue, options.slotUrls);
  const urlsClicked = clickDetails.urls_clicked || [];
  const positions = SLOT_POSITIONS[issue.kind] as readonly NewsletterSlotPosition[];
  const now = new Date().toISOString();

  const nextSlots: Partial<Record<NewsletterSlotPosition, NewsletterSlot>> = {};
  const matchedSlotUrls: Partial<Record<NewsletterSlotPosition, string[]>> = {};

  for (const position of positions) {
    const currentSlot = issue.slots?.[position] || {};
    const slotTargets = targetUrls[position] || [];
    const matched = matchClickDetailsForSlot(urlsClicked, slotTargets, currentSlot.sponsor);
    if (matched) {
      matchedSlotUrls[position] = matched.matchedUrls;
      const clickRate = deriveRate(matched.clicks, opens);
      const nextSlotStats: NewsletterSlotStats = {
        ...(currentSlot.stats || {}),
        clicks: matched.clicks,
        uniqueClicks: matched.uniqueClicks,
        ...(clickRate !== undefined ? { clickRate } : {}),
        recordedAt: now,
      };
      nextSlots[position] = {
        ...currentSlot,
        stats: nextSlotStats,
      };
    } else if (currentSlot.stats) {
      const updatedClickRate = currentSlot.stats.clicks !== undefined
        ? deriveRate(currentSlot.stats.clicks, opens)
        : undefined;
      nextSlots[position] = {
        ...currentSlot,
        stats: {
          ...currentSlot.stats,
          ...(updatedClickRate !== undefined ? { clickRate: updatedClickRate } : {}),
        },
      };
    } else {
      nextSlots[position] = { ...currentSlot };
    }
  }

  const primaryStats = nextSlots.primary?.stats;
  const issueClicks = primaryStats?.clicks ?? issue.stats?.clicks;
  const issueUniqueClicks = primaryStats?.uniqueClicks ?? issue.stats?.uniqueClicks;
  const issueClickRate = deriveRate(issueClicks, opens) ?? primaryStats?.clickRate ?? issue.stats?.clickRate;

  const nextIssueStats: NewsletterIssueStats = {
    ...(issue.stats || {}),
    ...(sent !== undefined ? { sent } : {}),
    ...(opens !== undefined ? { opens } : {}),
    ...(openRate !== undefined ? { openRate } : {}),
    ...(issueClicks !== undefined ? { clicks: issueClicks } : {}),
    ...(issueUniqueClicks !== undefined ? { uniqueClicks: issueUniqueClicks } : {}),
    ...(issueClickRate !== undefined ? { clickRate: issueClickRate } : {}),
    recordedAt: now,
  };

  return {
    campaign: {
      id: campaign.id,
      ...(campaign.web_id !== undefined ? { webId: campaign.web_id } : {}),
      title: campaign.settings?.title || report.campaign_title || null,
      sendTime: campaign.send_time || report.send_time || null,
      archiveUrl: campaign.long_archive_url || campaign.archive_url || null,
    },
    stats: nextIssueStats,
    slots: nextSlots,
    matchedSlotUrls,
  };
}
