import type { Task } from '../types';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { listCrmRecords, type CrmRecord } from '../db/sponsorCrm';
import { listOpenDealTasks } from '../db/taskSubjects';
import { financeEnabled } from '../sponsorFinance/repository';
import { dealMoneyFacts } from '../sponsorFinance/ledger';
import { deriveFulfillment, deriveMoney } from './model';

export const PIPELINE_STAGES = ['open', 'agreed', 'invoiced', 'running', 'closed', 'lost'] as const;
export type PipelineStage = typeof PIPELINE_STAGES[number];
const latest = (...values: unknown[]) => values.filter((value): value is string => typeof value === 'string' && Boolean(value)).sort().at(-1) || null;

export function pipelineTaskDate(task: Task): string {
  return String(task.status === 'waiting' || task.waitingFor || task.followUpAt ? task.followUpAt || '' : task.date || '').slice(0, 10);
}

export function pipelineTaskDeferred(task: Task, today: string, now = Date.now()): boolean {
  return String(task.snoozedUntil || '').slice(0, 10) > today
    || Boolean(task.notBeforeAt && Date.parse(task.notBeforeAt) > now)
    || Boolean((task.status === 'waiting' || task.waitingFor || task.followUpAt) && pipelineTaskDate(task) > today);
}

export function pipelineStage(deal: CrmRecord, money: string, fulfillment: string): PipelineStage {
  if (deal.status === 'lost') return 'lost';
  if (fulfillment === 'delivered' && (money === 'paid' || money === 'none')) return 'closed';
  if (['invoiced', 'partial', 'paid', 'overdue'].includes(money)) return 'invoiced';
  if (fulfillment === 'in-delivery') return 'running';
  return deal.status === 'agreed' ? 'agreed' : 'open';
}

/** One request-wide CRM snapshot, one open-task read; return only visible row fields. */
export async function sponsorPipeline(client: DynamoDBDocumentClient, query: Record<string, string | undefined>, today: string) {
  const [organizations, contacts, deals, deliverables, tasks] = await Promise.all([
    listCrmRecords(client, 'organization'), listCrmRecords(client, 'contact'),
    listCrmRecords(client, 'deal'), listCrmRecords(client, 'deliverable'), listOpenDealTasks(client),
  ]);
  const facts = await dealMoneyFacts(client, today, { organizations, deals, deliverables });
  const orgs = new Map(organizations.map((item) => [item.id, item]));
  const people = new Map(contacts.filter((item) => !item.archivedAt).map((item) => [item.id, item]));
  const primary = new Map(contacts.filter((item) => item.primary && !item.archivedAt).map((item) => [String(item.organizationId), item]));
  const kids = new Map<string, CrmRecord[]>();
  for (const item of deliverables.filter((item) => !item.archivedAt)) {
    const id = String(item.dealId); kids.set(id, [...(kids.get(id) || []), item]);
  }
  const week = new Date(`${today}T12:00:00Z`); week.setUTCDate(week.getUTCDate() + 7);
  const through = week.toISOString().slice(0, 10);
  const rows = deals.filter((deal) => !deal.archivedAt && !orgs.get(String(deal.organizationId))?.archivedAt).map((deal) => {
    const organization = orgs.get(String(deal.organizationId));
    const named = people.get(String(deal.primaryContactId));
    const contact = named?.organizationId === deal.organizationId ? named : primary.get(String(deal.organizationId));
    const money = deriveMoney(facts.get(deal.id));
    const fulfillment = deriveFulfillment(kids.get(deal.id) || []);
    const stage = pipelineStage(deal, money, fulfillment);
    const allTasks = (tasks.get(deal.id) || []).slice().sort((a, b) =>
      (pipelineTaskDate(a) || '9999').localeCompare(pipelineTaskDate(b) || '9999') || a.id.localeCompare(b.id));
    const eligible = allTasks.filter((item) => !pipelineTaskDeferred(item, today));
    const task = eligible[0] || allTasks[0];
    const attentionDate = task ? pipelineTaskDate(task) : '';
    const deferred = Boolean(task && pipelineTaskDeferred(task, today));
    const lastContacted = latest(organization?.lastInboundAt, organization?.lastOutboundAt, contact?.lastInboundAt, contact?.lastOutboundAt, contact?.lastContactedAt);
    const replyNeeded = Boolean(organization?.lastInboundAt && String(organization.lastInboundAt) > String(organization.lastOutboundAt || ''));
    return {
      id: deal.id, organizationId: deal.organizationId, organizationName: organization?.displayName || 'Unknown company',
      title: deal.title, status: deal.status, stage, money, fulfillment, amountEur: deal.amountEur,
      updatedAt: deal.updatedAt, lastContacted, replyNeeded,
      primaryContact: contact ? { id: contact.id, name: contact.name, email: Array.isArray(contact.emails) ? contact.emails[0] : undefined, role: contact.role } : null,
      nextTask: task ? { id: task.id, description: task.description, date: attentionDate || null, deferred, assigneeId: task.assigneeId, status: task.status } : null,
      unscheduled: !task || !attentionDate,
      actionable: !['closed', 'lost'].includes(stage) && (replyNeeded || Boolean(task && !deferred && attentionDate && attentionDate <= through)),
    };
  });
  const search = String(query.search || '').trim().toLowerCase();
  const searched = rows.filter((row) => (!query.organizationId || row.organizationId === query.organizationId)
    && (!search || [row.organizationName, row.title, row.primaryContact?.name, row.primaryContact?.email, row.nextTask?.description].some((value) => String(value || '').toLowerCase().includes(search))));
  const counts = Object.fromEntries(PIPELINE_STAGES.map((stage) => [stage, searched.filter((row) => row.stage === stage).length]));
  const view = query.view || 'actionable';
  const filtered = searched.filter((row) => (!query.stage || row.stage === query.stage)
    && (view === 'all' || (view === 'actionable' ? row.actionable : view === 'active' ? !['closed', 'lost'].includes(row.stage) : view === 'unscheduled' ? row.unscheduled && !['closed', 'lost'].includes(row.stage) : ['closed', 'lost'].includes(row.stage)))
    && (!query.owner || row.nextTask?.assigneeId === query.owner));
  filtered.sort((a, b) => query.sort === 'recent'
    ? String(b.updatedAt).localeCompare(String(a.updatedAt)) || a.id.localeCompare(b.id)
    : Number(['open', 'closed', 'lost'].includes(a.stage)) - Number(['open', 'closed', 'lost'].includes(b.stage))
      || String(a.nextTask?.date || '9999').localeCompare(String(b.nextTask?.date || '9999')) || String(b.updatedAt).localeCompare(String(a.updatedAt)) || a.id.localeCompare(b.id));
  const offset = Number(query.cursor || 0), limit = Number(query.limit || 30);
  return { today, through, view, financeEnabled: financeEnabled(), counts, actionableCount: searched.filter((row) => row.actionable).length,
    total: filtered.length, items: filtered.slice(offset, offset + limit),
    nextCursor: offset + limit < filtered.length ? String(offset + limit) : null };
}
