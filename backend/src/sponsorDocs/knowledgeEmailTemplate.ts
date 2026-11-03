import { buildRegistry } from '../docs/docRegistry';
import {
  createKnowledgeStore,
  knowledgeStoreConfigFromEnv,
  type KnowledgeStore,
} from '../docs/knowledgeStore';
import { parseFrontmatter, splitFrontmatter } from '../docs/sop';

export const NEWSLETTER_SPONSOR_EMAIL_TEMPLATE_ID =
  'template.newsletter.send-sponsorship-document-2-weeks-before';
export const NEWSLETTER_SPONSOR_EMAIL_SECTION =
  'Template 2: Initial Introduction to Sponsor (Scheduled Newsletter Date)';

export interface KnowledgeEmailTemplate {
  id: string;
  revision: string;
  markdown: string;
}

export interface RenderKnowledgeEmailOptions {
  sectionHeading: string;
  subjectVariant?: string;
  values: Record<string, string>;
}

export interface RenderedKnowledgeEmail {
  subject: string;
  body: string;
}

export class KnowledgeEmailTemplateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'KnowledgeEmailTemplateError';
  }
}

type TemplateLoader = (templateId: string) => Promise<KnowledgeEmailTemplate>;

let knowledgeStore: KnowledgeStore | null = null;
let cachedRegistry: { revision: string; byId: Map<string, { path: string; doc_type: string }> } | null = null;
let testLoader: TemplateLoader | null = null;

export function setKnowledgeEmailTemplateLoaderForTests(loader: TemplateLoader | null): void {
  testLoader = loader;
  knowledgeStore = null;
  cachedRegistry = null;
}

async function defaultTemplateLoader(templateId: string): Promise<KnowledgeEmailTemplate> {
  knowledgeStore ||= createKnowledgeStore(knowledgeStoreConfigFromEnv());
  await knowledgeStore.sync();
  const revision = knowledgeStore.revision;
  if (!cachedRegistry || cachedRegistry.revision !== revision) {
    const registry = buildRegistry(knowledgeStore.contentRoot);
    cachedRegistry = {
      revision,
      byId: new Map(registry.documents.map((document) => [document.id, {
        path: document.path,
        doc_type: document.doc_type,
      }])),
    };
  }

  const document = cachedRegistry.byId.get(templateId);
  if (!document || document.doc_type !== 'template') {
    throw new KnowledgeEmailTemplateError(`Knowledge template not found: ${templateId}`);
  }
  const markdown = await knowledgeStore.readFile(document.path);
  const [rawFrontmatter] = splitFrontmatter(markdown);
  const metadata = rawFrontmatter ? parseFrontmatter(rawFrontmatter) : {};
  if (metadata.id !== templateId || metadata.doc_type !== 'template') {
    throw new KnowledgeEmailTemplateError(`Knowledge template identity changed: ${templateId}`);
  }
  return { id: templateId, revision, markdown };
}

export async function loadKnowledgeEmailTemplate(templateId: string): Promise<KnowledgeEmailTemplate> {
  return (testLoader || defaultTemplateLoader)(templateId);
}

function normalizeHeading(value: string): string {
  return value.trim().replace(/^#{2,6}\s+/, '');
}

function extractSection(markdown: string, sectionHeading: string): string {
  const lines = markdown.split(/\r?\n/);
  const target = normalizeHeading(sectionHeading);
  const start = lines.findIndex((line) => {
    const heading = line.match(/^(#{2,6})\s+(.+?)\s*#*\s*$/);
    return heading?.[2] === target;
  });
  if (start < 0) throw new KnowledgeEmailTemplateError(`Template section not found: ${target}`);
  const startLevel = /^#+/.exec(lines[start])?.[0].length || 3;
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    const level = /^#+(?=\s)/.exec(lines[index])?.[0].length;
    if (level && level <= startLevel) {
      end = index;
      break;
    }
  }
  const section = lines.slice(start + 1, end).join('\n');
  const codeBlock = section.match(/```(?:text|txt)?\s*\r?\n([\s\S]*?)\r?\n```/i);
  if (!codeBlock) throw new KnowledgeEmailTemplateError(`Template section has no text body: ${target}`);
  return codeBlock[1].trim();
}

function subjectForVariant(markdown: string, section: string, variant?: string): string {
  const explicit = section.match(/^\s*Subject:\s*(.+?)\s*$/im)?.[1];
  if (explicit) return explicit;
  if (!variant) throw new KnowledgeEmailTemplateError('The template requires a subject variant');

  const instruction = /^Use the appropriate subject title[^\n]*\n([\s\S]*?)(?=^#{2,6}\s+Template\b)/im.exec(markdown);
  if (!instruction) throw new KnowledgeEmailTemplateError(`Subject variant not found: ${variant}`);
  const lines = instruction[1].split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const item = lines[index].match(/^\s*\d+\.\s+(.+?)\s*$/);
    if (!item || item[1].toLowerCase() !== variant.trim().toLowerCase()) continue;
    for (let next = index + 1; next < lines.length; next += 1) {
      const candidate = lines[next].trim();
      if (!candidate) continue;
      return candidate.replace(/^Subject:\s*/i, '');
    }
  }
  throw new KnowledgeEmailTemplateError(`Subject variant not found: ${variant}`);
}

function interpolate(value: string, values: Record<string, string>): string {
  const rendered = value
    .replace(/<([A-Z][A-Z0-9_]*)>|\{\{([A-Z][A-Z0-9_]*)\}\}/g, (_match, angleName: string, braceName: string) => {
      const name = angleName || braceName;
      if (!(name in values)) throw new KnowledgeEmailTemplateError(`Missing email template value: ${name}`);
      return values[name];
    })
    .replace(/\bMM-DD-YYYY\b/g, values['MM-DD-YYYY'] || 'MM-DD-YYYY');
  if (/<[A-Z][A-Z0-9_]*>|\{\{[A-Z][A-Z0-9_]*\}\}|\bMM-DD-YYYY\b/.test(rendered)) {
    throw new KnowledgeEmailTemplateError('Email template contains unresolved placeholders');
  }
  return rendered;
}

export function renderKnowledgeEmailTemplate(
  template: Pick<KnowledgeEmailTemplate, 'markdown'>,
  options: RenderKnowledgeEmailOptions,
): RenderedKnowledgeEmail {
  const sectionHeading = normalizeHeading(options.sectionHeading);
  const sectionBody = extractSection(template.markdown, sectionHeading);
  const subject = interpolate(subjectForVariant(template.markdown, sectionBody, options.subjectVariant), options.values);
  const body = interpolate(sectionBody, options.values)
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '$2')
    .replace(/\r\n?/g, '\n');
  return { subject, body };
}

function dateWithMonthName(value: string | null | undefined): string {
  const raw = String(value || '').trim();
  const date = new Date(`${raw}T00:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw) || Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== raw) {
    throw new KnowledgeEmailTemplateError('Newsletter date must be a valid YYYY-MM-DD date');
  }
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'UTC', month: 'long', day: 'numeric', year: 'numeric',
  }).format(date);
}

function newsletterSubjectDate(value: string): string {
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) throw new KnowledgeEmailTemplateError('Newsletter date must be a valid YYYY-MM-DD date');
  return `${match[2]}-${match[3]}-${match[1]}`;
}

function copyDeadline(publicationDate: string): string {
  const date = new Date(`${publicationDate}T00:00:00Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== publicationDate) {
    throw new KnowledgeEmailTemplateError('Newsletter date must be a valid YYYY-MM-DD date');
  }
  return new Date(date.getTime() - 10 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

const SUBJECT_VARIANT_BY_DOC_TEMPLATE: Record<string, string> = {
  'newsletter-main': 'Main Slot',
  'newsletter-secondary': 'Secondary Slot',
  'newsletter-standalone': 'Stand-alone Newsletter',
};

export async function renderNewsletterSponsorEmail(options: {
  template: string;
  sponsorName?: string | null;
  publicationDate?: string | null;
  shareUrl: string;
  accessCode: string;
  recipientName?: string | null;
}): Promise<KnowledgeEmailTemplate & RenderedKnowledgeEmail> {
  const subjectVariant = SUBJECT_VARIANT_BY_DOC_TEMPLATE[options.template];
  if (!subjectVariant) throw new KnowledgeEmailTemplateError(`Unsupported newsletter email variant: ${options.template}`);
  const publicationDate = String(options.publicationDate || '').trim();
  const company = String(options.sponsorName || '').trim();
  const recipientName = String(options.recipientName || '').trim() || 'there';
  if (!company) throw new KnowledgeEmailTemplateError('A company name is required to render this email');

  const template = await loadKnowledgeEmailTemplate(NEWSLETTER_SPONSOR_EMAIL_TEMPLATE_ID);
  const rendered = renderKnowledgeEmailTemplate(template, {
    sectionHeading: NEWSLETTER_SPONSOR_EMAIL_SECTION,
    subjectVariant,
    values: {
      COMPANY: company,
      COMPANY_NAME: company,
      RECIPIENT_NAME: recipientName,
      SENDER_NAME: 'Orin',
      NEWSLETTER_DATE: dateWithMonthName(publicationDate),
      COPY_DOCUMENT_URL: options.shareUrl,
      ACCESS_CODE: options.accessCode,
      COPY_DEADLINE: copyDeadline(publicationDate),
      'MM-DD-YYYY': newsletterSubjectDate(publicationDate),
    },
  });
  return { ...template, ...rendered };
}
