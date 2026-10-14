/**
 * One-off backfill: link existing newsletter Cards to their newsletter slots.
 *
 * Delete this script once it has been applied to production.
 *
 * Matching, per newsletter Card (projected the way the board shows it):
 *   1. an unlinked active slot whose campaignNumber equals the Card's
 *      issueNumber;
 *   2. otherwise the unlinked active slot with the nearest publicationDate
 *      within ±7 days of the Card's anchorDate.
 * Ties, slots claimed by more than one Card, and issue matches whose dates are
 * more than 7 days apart are reported and never linked.
 *
 * Dry run is the default. Inputs come either from a read-only snapshot
 * directory (`--from-snapshot <dir>` with cards.json, newsletter-slots.json
 * and templates.json) or from the API (DATAOPS_API, DATAOPS_TOKEN).
 * `--apply` writes the links through PUT /api/newsletter-slots/:id, which
 * re-validates every link, and requires DATAOPS_CONFIRM to equal DATAOPS_API.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { cardTemplateType, hydrateStructuredCardFields } from '../src/cards/cardTitleStructure';
import type { Card } from '../src/types';

type Slot = {
  id: string;
  version: number;
  publicationDate: string;
  campaignNumber?: number | null;
  campaignLabel?: string;
  status: string;
  cardId?: string | null;
};
type NewsletterCard = { id: string; title: string; anchorDate: string | null; issueNumber: string | null };
export type Link = { cardId: string; slotId: string; slotVersion: number; by: 'issue' | 'date'; days: number };
export type LinkPlan = {
  links: Link[];
  alreadyLinked: Array<{ cardId: string; slotId: string }>;
  unmatched: Array<{ cardId: string; title: string; anchorDate: string | null; issueNumber: string | null }>;
  duplicates: Array<{ slotId: string; cardIds: string[] }>;
  ambiguous: Array<{ cardId: string; slotIds: string[] }>;
  mismatches: Array<{ cardId: string; slotId: string; reason: string }>;
};

const NEWSLETTER_TYPES = new Set(['newsletter', 'newsletter-standalone']);
const WINDOW_DAYS = 7;

const dayDistance = (left: string, right: string) =>
  Math.round(Math.abs(Date.parse(`${left}T00:00:00Z`) - Date.parse(`${right}T00:00:00Z`)) / 86_400_000);

/** Newsletter Cards as the board projects them (title-derived fields hydrated). */
export function newsletterCards(cards: Card[], templateIdByType: Map<string, string>): NewsletterCard[] {
  return cards
    .filter((card) => card.status !== 'archived')
    .filter((card) => NEWSLETTER_TYPES.has(String(cardTemplateType(card, templateIdByType))))
    .map((card) => {
      const view = { ...card };
      hydrateStructuredCardFields(view, templateIdByType);
      return {
        id: card.id,
        title: String(card.title || ''),
        anchorDate: view.anchorDate || null,
        issueNumber: view.issueNumber ? String(view.issueNumber) : null,
      };
    });
}

export function planLinks(cards: NewsletterCard[], slots: Slot[]): LinkPlan {
  const plan: LinkPlan = { links: [], alreadyLinked: [], unmatched: [], duplicates: [], ambiguous: [], mismatches: [] };
  const linkedCardIds = new Set<string>();
  for (const slot of slots) {
    if (slot.cardId) {
      plan.alreadyLinked.push({ cardId: String(slot.cardId), slotId: slot.id });
      linkedCardIds.add(String(slot.cardId));
    }
  }
  const open = slots.filter((slot) => !slot.cardId && slot.status !== 'cancelled');
  const proposals: Link[] = [];
  for (const card of cards) {
    if (linkedCardIds.has(card.id)) continue;
    const byIssue = card.issueNumber
      ? open.filter((slot) => slot.campaignNumber != null && String(slot.campaignNumber) === card.issueNumber)
      : [];
    let candidates = byIssue;
    let by: Link['by'] = 'issue';
    if (byIssue.length === 0 && card.anchorDate) {
      by = 'date';
      const near = open
        .map((slot) => ({ slot, days: dayDistance(slot.publicationDate, card.anchorDate!) }))
        .filter(({ days }) => days <= WINDOW_DAYS);
      const best = Math.min(...near.map(({ days }) => days));
      candidates = near.filter(({ days }) => days === best).map(({ slot }) => slot);
    }
    if (candidates.length === 0) {
      plan.unmatched.push({ cardId: card.id, title: card.title, anchorDate: card.anchorDate, issueNumber: card.issueNumber });
      continue;
    }
    if (by === 'issue' && candidates.length > 1 && card.anchorDate) {
      const ranked = candidates
        .map((slot) => ({ slot, days: dayDistance(slot.publicationDate, card.anchorDate!) }))
        .sort((left, right) => left.days - right.days);
      candidates = ranked.filter(({ days }) => days === ranked[0].days).map(({ slot }) => slot);
    }
    if (candidates.length > 1) {
      plan.ambiguous.push({ cardId: card.id, slotIds: candidates.map((slot) => slot.id) });
      continue;
    }
    const slot = candidates[0];
    const days = card.anchorDate ? dayDistance(slot.publicationDate, card.anchorDate) : -1;
    if (by === 'issue' && (days < 0 || days > WINDOW_DAYS)) {
      plan.mismatches.push({
        cardId: card.id,
        slotId: slot.id,
        reason: `issue #${card.issueNumber} matches but Card date ${card.anchorDate} is ${days < 0 ? 'missing' : `${days} days`} from slot ${slot.publicationDate}`,
      });
      continue;
    }
    if (by === 'date' && card.issueNumber && slot.campaignNumber != null && String(slot.campaignNumber) !== card.issueNumber) {
      plan.mismatches.push({
        cardId: card.id,
        slotId: slot.id,
        reason: `date matches but Card issue #${card.issueNumber} differs from slot #${slot.campaignNumber}`,
      });
      continue;
    }
    proposals.push({ cardId: card.id, slotId: slot.id, slotVersion: slot.version, by, days });
  }
  const claims = new Map<string, Link[]>();
  for (const proposal of proposals) claims.set(proposal.slotId, [...(claims.get(proposal.slotId) || []), proposal]);
  for (const [slotId, claimed] of claims) {
    if (claimed.length > 1) plan.duplicates.push({ slotId, cardIds: claimed.map(({ cardId }) => cardId) });
    else plan.links.push(claimed[0]);
  }
  return plan;
}

function readSnapshot(dir: string) {
  const read = (name: string) => JSON.parse(readFileSync(path.join(dir, name), 'utf8')) as Array<Record<string, unknown>>;
  const templates = read('templates.json');
  const templateIdByType = new Map(templates.map((template) => [String(template.type), String(template.id)]));
  const cards = read('cards.json').filter((item) => String(item.PK || 'CARD#').startsWith('CARD#')) as unknown as Card[];
  const slots = read('newsletter-slots.json').filter((item) => String(item.PK || 'SLOT#').startsWith('SLOT#')) as unknown as Slot[];
  return { cards, slots, templateIdByType };
}

async function readApi(api: string, token: string) {
  const headers = { authorization: `Bearer ${token}` };
  const get = async (route: string) => {
    const response = await fetch(`${api}${route}`, { headers });
    if (!response.ok) throw new Error(`GET ${route.split('?')[0]} failed (${response.status})`);
    return response.json() as Promise<any>;
  };
  const cards: Card[] = [];
  let cursor = '';
  do {
    const page = await get(`/api/cards?limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
    cards.push(...page.cards.items);
    cursor = page.cards.nextCursor || '';
  } while (cursor);
  const templates = await get('/api/templates');
  const templateIdByType = new Map<string, string>(
    (templates.templates as any[]).map((template: any) => [template.type, template.id]),
  );
  const slots = (await get('/api/newsletter-slots?from=2000-01-01&to=9999-12-31')).items as Slot[];
  return { cards, slots, templateIdByType };
}

async function apply(api: string, token: string, links: Link[]) {
  const results: Array<{ slotId: string; cardId: string; status: number }> = [];
  for (const link of links) {
    const response = await fetch(`${api}/api/newsletter-slots/${link.slotId}`, {
      method: 'PUT',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ version: link.slotVersion, cardId: link.cardId }),
    });
    results.push({ slotId: link.slotId, cardId: link.cardId, status: response.status });
  }
  return results;
}

async function main() {
  const args = process.argv.slice(2);
  const snapshotIndex = args.indexOf('--from-snapshot');
  const snapshot = snapshotIndex >= 0 ? args[snapshotIndex + 1] : '';
  const write = args.includes('--apply');
  const api = (process.env.DATAOPS_API || '').replace(/\/$/, '');
  const token = process.env.DATAOPS_TOKEN || '';
  if (write && snapshot) throw new Error('--apply reads live state from the API; it cannot use --from-snapshot');
  if (!snapshot && (!api || !token)) throw new Error('Set DATAOPS_API and DATAOPS_TOKEN, or pass --from-snapshot <dir>');
  if (write && process.env.DATAOPS_CONFIRM !== api) throw new Error('--apply requires DATAOPS_CONFIRM to equal DATAOPS_API');
  const input = snapshot ? readSnapshot(snapshot) : await readApi(api, token);
  const cards = newsletterCards(input.cards, input.templateIdByType);
  const plan = planLinks(cards, input.slots);
  const report = {
    mode: write ? 'apply' : 'dry-run',
    source: snapshot ? `snapshot:${snapshot}` : api,
    newsletterCards: cards.length,
    slots: input.slots.length,
    ...plan,
  };
  if (!write) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }
  console.log(JSON.stringify({ ...report, applied: await apply(api, token, plan.links) }, null, 2));
}

if (require.main === module) {
  main().catch((error) => {
    console.error(JSON.stringify({ error: (error as Error).message }));
    process.exitCode = 1;
  });
}
