/**
 * The read-only format audit: every live Card and Sponsor Document checked
 * against the three-event-formats policy. It reports; it never repairs —
 * existing data is cleaned up by hand, not migrated behind the scenes.
 *
 * Newsletter Cards and their documents are out of scope by design: the
 * newsletter is its own recurring publication and stays untouched.
 */
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import type { Card, Template } from '../types';
import { listAllCards } from '../db/cards';
import { listTemplates } from '../db/templates';
import { listAllSponsorDocSummaries } from '../db/sponsorDocs';
import {
  EVENT_CARD_FORMATS,
  EVENT_FORMAT_DOC_TEMPLATES,
  eventFormatOfType,
  eventFormatOfTag,
  eventFormatOfVariantType,
  claimsEventCardFormat,
  isSeparateBusinessEventType,
} from './eventFormats';
import { parseCardTitle } from './cardTitleStructure';

export interface FormatAuditFinding {
  kind: 'card' | 'doc' | 'template';
  id: string;
  cardId?: string;
  title: string;
  status: string;
  template: string;
  expected: string;
  reason: string;
}

export interface FormatAuditReport {
  generatedAt: string;
  cardsScanned: number;
  docsScanned: number;
  findings: FormatAuditFinding[];
}

/** The canonical event-format Template a card must be instantiated from, if the card claims a format at all. */
function claimedCardFormat(card: Card, templateById: Map<string, Template>): EventCardFormatOf | null {
  const template = card.templateId ? templateById.get(card.templateId) : undefined;
  if (isSeparateBusinessEventType(template?.type)) return null;
  const fromType = eventFormatOfType(template?.type) ?? eventFormatOfVariantType(template?.type);
  if (fromType) return fromType;
  const tag = parseCardTitle(String(card.title || '')).tag;
  return eventFormatOfTag(tag);
}

type EventCardFormatOf = (typeof EVENT_CARD_FORMATS)[number];

function cardFindings(card: Card, templateById: Map<string, Template>): FormatAuditFinding[] {
  const format = claimedCardFormat(card, templateById);
  if (!format) return [];
  const template = templateById.get(card.templateId);
  const templateType = String(template?.type || '(unknown)');
  const findings: FormatAuditFinding[] = [];
  if (template?.origin === 'git') {
    // Git-authored compound types (`lightning-lesson-podcast`) are distinct
    // authored products, not format deviations; a Git template serving a
    // *different* event format than the card claims is one.
    if (templateType === format || eventFormatOfType(templateType) === null) return [];
  }
  if (!template || template.origin !== 'git' || eventFormatOfType(templateType) !== null) {
    findings.push({
      kind: 'card',
      id: card.id,
      title: String(card.title || ''),
      status: card.status,
      template: templateType,
      expected: `canonical ${format} Template (origin git, type "${format}")`,
      reason: !template
        ? `Card claims the ${format} format but its Template is missing`
        : template.origin !== 'git'
          ? `Card is instantiated from a non-canonical ${format} Template ("${templateType}", origin ${template.origin}) — event formats have no custom or sponsored variants`
          : `Card claims the ${format} format but its Template serves ${templateType}`,
    });
  }
  return findings;
}

function docFindings(doc: { id: string; cardId: string; title: string; template: string; status: string }, cardById: Map<string, Card>, templateById: Map<string, Template>): FormatAuditFinding[] {
  const card = cardById.get(doc.cardId);
  if (!card) {
    return [{
      kind: 'doc',
      id: doc.id,
      cardId: doc.cardId,
      title: doc.title,
      status: doc.status,
      template: doc.template,
      expected: 'a Card that exists',
      reason: 'Document references a Card that does not exist',
    }];
  }
  const format = claimedCardFormat(card, templateById);
  if (!format) return [];
  const allowed = EVENT_FORMAT_DOC_TEMPLATES[format];
  if (allowed.includes(doc.template)) return [];
  return [{
    kind: 'doc',
    id: doc.id,
    cardId: doc.cardId,
    title: doc.title,
    status: doc.status,
    template: doc.template,
    expected: `one of the ${format} document templates (${allowed.join(', ')})`,
    reason: `Document template "${doc.template}" does not belong to the card's ${format} format`,
  }];
}

/** Template types whose slug claims a DTC event format without being one (`sponsored-webinar`). */
function templateVariantFindings(templates: Template[]): FormatAuditFinding[] {
  const findings: FormatAuditFinding[] = [];
  for (const template of templates) {
    if (template.origin === 'git') continue;
    if (!claimsEventCardFormat(template.type)) continue;
    const format = eventFormatOfType(template.type);
    findings.push({
      kind: 'template',
      id: template.id,
      title: `Template: ${template.name}`,
      status: String(template.status || 'active'),
      template: String(template.type || ''),
      expected: format ? `only the canonical "${format}" Template` : 'no custom Template claiming an event format',
      reason: format
        ? `A custom Template claims the ${format} format itself ("${template.type}") — the format's canonical Template is the only one`
        : `Custom Template type "${template.type}" claims an event-format variant`,
    });
  }
  return findings;
}

/** Scan every Card, Template and Sponsor Document and report policy mismatches. Read-only. */
export async function buildFormatAuditReport(client: DynamoDBDocumentClient): Promise<FormatAuditReport> {
  const [cards, templates, docs] = await Promise.all([
    listAllCards(client),
    listTemplates(client),
    listAllSponsorDocSummaries(client),
  ]);
  const templateById = new Map<string, Template>(templates.map((t) => [t.id, t]));
  const cardById = new Map<string, Card>(cards.map((c) => [c.id, c]));
  const findings: FormatAuditFinding[] = templateVariantFindings(templates);
  for (const card of cards) findings.push(...cardFindings(card, templateById));
  for (const doc of docs) findings.push(...docFindings(doc, cardById, templateById));
  return {
    generatedAt: new Date().toISOString(),
    cardsScanned: cards.length,
    docsScanned: docs.length,
    findings,
  };
}
