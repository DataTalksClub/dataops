/**
 * One-off backfill: move structure out of legacy Card titles.
 *
 * Trello-imported Cards carry a `[Tag]` prefix (the source Template), an
 * event/issue date inside the title, a trailing person segment on event
 * Cards (`- Tony Zeljkovic`), a trailing sponsor segment on newsletter
 * Cards (`- Astronomer`), and a sometimes-stale `anchorDate`.
 * For each Card this script:
 * - assigns `templateId` from the `[Tag]` when the Card has none,
 * - corrects `anchorDate` from the date embedded in the title,
 * - moves the person segment to `people` and the sponsor segment to
 *   `sponsor`,
 * - rewrites `title` to the remainder (tag, date, and person/sponsor
 *   segments removed).
 *
 * Usage against local dynalite (dev server stopped first):
 *   tsx scripts/backfill-card-structure.ts [--dry-run] [--apply]
 *
 * Against production (AWS credentials, explicit table names):
 *   DATAOPS_CARDS_TABLE=dataops-v1-cards DATAOPS_TEMPLATES_TABLE=dataops-v1-templates \
 *     tsx scripts/backfill-card-structure.ts --apply
 *
 * Default is `--dry-run`: print planned changes without writing.
 */
import { getClient } from '../src/db/client';
import { listCards, updateCard } from '../src/db/cards';
import { listTemplates } from '../src/db/templates';
import { planCardStructureUpdate } from '../src/cards/cardTitleStructure';

const args = new Set(process.argv.slice(2));
const APPLY = args.has('--apply');

interface PlannedChange {
  id: string;
  title?: { from: string; to: string };
  anchorDate?: { from: string; to: string };
  templateId?: { from: string | null; to: string };
  people?: { from: string[]; to: string[] };
  sponsor?: { from: string | null; to: string };
}

async function main(): Promise<void> {
  const client = await getClient();
  const [cards, templates] = await Promise.all([listCards(client), listTemplates(client)]);

  const templateIdByType = new Map<string, string>();
  for (const template of templates) {
    const type = String(template.type || '').trim();
    if (type && !templateIdByType.has(type)) templateIdByType.set(type, template.id);
  }

  const planned: PlannedChange[] = [];
  for (const card of cards) {
    const patch = planCardStructureUpdate(card, templateIdByType);
    if (!patch) continue;
    const change: PlannedChange = { id: card.id };
    if (patch.templateId) change.templateId = { from: card.templateId ?? null, to: patch.templateId };
    if (patch.anchorDate) change.anchorDate = { from: String(card.anchorDate || ''), to: patch.anchorDate };
    if (patch.title) change.title = { from: String(card.title || ''), to: patch.title };
    if (patch.people) change.people = { from: card.people || [], to: patch.people };
    if (patch.sponsor) change.sponsor = { from: card.sponsor ?? null, to: patch.sponsor };
    planned.push(change);
  }

  for (const change of planned) console.log(JSON.stringify(change));

  const summary = {
    scanned: cards.length,
    planned: planned.length,
    titles: planned.filter((change) => change.title).length,
    anchorDates: planned.filter((change) => change.anchorDate).length,
    templateIds: planned.filter((change) => change.templateId).length,
    people: planned.filter((change) => change.people).length,
    sponsors: planned.filter((change) => change.sponsor).length,
    applied: false,
  };

  if (!APPLY) {
    console.log(JSON.stringify({ ...summary, mode: 'dry-run' }));
    return;
  }

  let applied = 0;
  for (const change of planned) {
    const card = cards.find((candidate) => candidate.id === change.id);
    if (!card) continue;
    const patch: Record<string, unknown> = {};
    if (change.templateId) patch.templateId = change.templateId.to;
    if (change.anchorDate) patch.anchorDate = change.anchorDate.to;
    if (change.title) patch.title = change.title.to;
    if (change.people) patch.people = change.people.to;
    if (change.sponsor) patch.sponsor = change.sponsor.to;
    await updateCard(client, card.id, { expectedVersion: card.version, patch });
    applied += 1;
  }
  console.log(JSON.stringify({ ...summary, applied, mode: 'applied' }));
}

main().catch((error: unknown) => {
  console.error('Card structure backfill failed:', (error as Error).message);
  process.exit(1);
});
