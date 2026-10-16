import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { createNotification, dismissNotification, listAllNotifications } from '../db/notifications';
import { listCrmRecords } from '../db/sponsorCrm';
import { dealMoneyFacts } from '../sponsorFinance/ledger';
import { dayDiff, dealIsComplete } from './model';

type Rule = { code: string; dueDate: string; message: string; dealId: string; organizationId: string; deliverableId?: string };

function rulesForDeal(deal: Record<string, unknown>, today: string): Rule[] {
  const rules: Rule[] = [];
  if (deal.status === 'agreed' && !deal.primaryContactId) {
    rules.push({
      code: 'agreed-missing-primary-contact',
      dueDate: today,
      message: 'Agreed sponsor deal needs a primary contact',
      dealId: String(deal.id),
      organizationId: String(deal.organizationId || ''),
    });
  }
  return rules;
}

function rulesForDeliverable(deliverable: Record<string, unknown>, deal: Record<string, unknown>, today: string): Rule[] {
  const rules: Rule[] = [];
  const publication = String(deliverable.plannedPublicationDate || '');
  const deadline = String(deliverable.materialDeadline || '');
  const hasMaterials = Array.isArray(deliverable.artifactUrls) && deliverable.artifactUrls.length > 0;
  const published = String(deliverable.publishedAt || '').slice(0, 10);
  const base = {
    dealId: String(deal.id),
    organizationId: String(deal.organizationId || deliverable.organizationId || ''),
    deliverableId: String(deliverable.id),
  };
  if (deal.status === 'agreed' && publication && !hasMaterials && !published) {
    const days = dayDiff(today, publication);
    if ([14, 10, 3].includes(days)) {
      rules.push({ ...base, code: `materials-missing-${days}d`, dueDate: publication, message: `Sponsor deliverable materials are missing ${days} days before publication` });
    }
  }
  if (deadline && deadline < today && !hasMaterials) {
    rules.push({ ...base, code: 'materials-deadline-overdue', dueDate: deadline, message: 'Sponsor deliverable material deadline is overdue' });
  }
  if ((deliverable.scheduleEntryId || published) && (!deliverable.cardId || !deliverable.requiredLinkUrl)) {
    rules.push({ ...base, code: 'newsletter-workflow-incomplete', dueDate: publication || today, message: 'Sponsor deliverable is missing its newsletter workflow or required link' });
  }
  if (published && dayDiff(published, today) >= 7) {
    rules.push({ ...base, code: 'performance-follow-up-due', dueDate: published, message: 'Sponsor deliverable performance follow-up is due' });
  }
  return rules;
}

export async function evaluateSponsorBookingAlerts(client: DynamoDBDocumentClient, today = new Date().toISOString().slice(0, 10)) {
  const [organizations, deals, deliverables] = await Promise.all([
    listCrmRecords(client, 'organization'),
    listCrmRecords(client, 'deal'),
    listCrmRecords(client, 'deliverable'),
  ]);
  const facts = await dealMoneyFacts(client, today, { organizations, deals, deliverables });
  const deliverablesByDeal = new Map<string, typeof deliverables>();
  for (const deliverable of deliverables) {
    const dealId = String(deliverable.dealId);
    deliverablesByDeal.set(dealId, [...(deliverablesByDeal.get(dealId) || []), deliverable]);
  }
  const existing = await listAllNotifications(client);
  const active = new Set<string>();
  const created: string[] = [];
  const rules: Rule[] = [];
  // Only a live deal raises alerts: open or agreed, and not yet both paid and
  // delivered. A finished or lost deal's alerts resolve on the next run.
  for (const deal of deals) {
    const dealDeliverables = deliverablesByDeal.get(deal.id) || [];
    const live = (deal.status === 'open' || deal.status === 'agreed') && !dealIsComplete(deal, facts.get(deal.id), dealDeliverables);
    if (!live) continue;
    rules.push(...rulesForDeal(deal, today));
    for (const deliverable of dealDeliverables) rules.push(...rulesForDeliverable(deliverable, deal, today));
  }
  for (const rule of rules) {
    const fingerprint = `${rule.deliverableId || rule.dealId}#${rule.code}#${rule.dueDate}`;
    active.add(fingerprint);
    const found = existing.find((item) => !item.dismissed && (item.metadata as { sponsorAlertFingerprint?: string })?.sponsorAlertFingerprint === fingerprint);
    if (!found) {
      const notification = await createNotification(client, {
        type: 'follow-up-due',
        message: rule.message,
        dueAt: rule.dueDate,
        metadata: {
          sponsorDealId: rule.dealId,
          sponsorCompanyId: rule.organizationId,
          ...(rule.deliverableId ? { sponsorDeliverableId: rule.deliverableId } : {}),
          sponsorAlertRule: rule.code,
          sponsorAlertFingerprint: fingerprint,
          href: `/sponsors/deals/${encodeURIComponent(rule.dealId)}`,
        },
      });
      created.push(notification.id);
    }
  }
  let resolved = 0;
  for (const notification of existing) {
    const fingerprint = (notification.metadata as { sponsorAlertFingerprint?: string })?.sponsorAlertFingerprint;
    if (fingerprint && !notification.dismissed && !active.has(fingerprint)) {
      await dismissNotification(client, notification.id);
      resolved += 1;
    }
  }
  return { created, resolved };
}
