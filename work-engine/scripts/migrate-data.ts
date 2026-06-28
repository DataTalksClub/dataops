#!/usr/bin/env node

/**
 * Migration script: imports data from Trello board export and CSV spreadsheets
 * into the DataOps work-engine module (persistent LevelDB via dynalite).
 *
 * Prerequisites:
 *   Stop the dev server first (LevelDB only allows one process at a time).
 *
 * Usage:
 *   IS_LOCAL=true tsx scripts/migrate-data.ts [--dry-run] [--templates-only] [--csv-only] [--cards-only]
 *
 * Flags:
 *   --dry-run         Print what would be imported without writing to DB
 *   --templates-only  Only import Trello templates
 *   --csv-only        Only import CSV tasks
 *   --cards-only      Only import active Trello cards as bundles+tasks
 *   --include-done    Also import done CSV tasks (skipped by default)
 *   --source          Local Trello JSON export to import instead of bundled data
 *   --source-todo     Local TODO CSV export to import instead of bundled data
 *   --source-done     Local done CSV export to analyze instead of bundled data
 *
 * Data sources:
 *   data/qVB6fAUG - datatalksclub.json   Trello board export
 *   data/TODO list - todo.csv            Open tasks
 *   data/TODO list - done.csv            Completed tasks
 */

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { DynamoDBDocumentClient, ScanCommand } from '@aws-sdk/lib-dynamodb';

import { getClient, startLocal } from '../src/db/client';
import { createTables, TABLE_TASKS } from '../src/db/setup';
import { createTemplate, listTemplates } from '../src/db/templates';
import { createBundle, getBundle, updateBundle } from '../src/db/bundles';
import { createTask, getTask, updateTask } from '../src/db/tasks';
import { createArtifact, getArtifact, updateArtifact } from '../src/db/artifacts';
import { appendAssistantJobEvent } from '../src/db/assistantJobs';
import { createDueFollowUpNotifications } from '../src/db/notifications';
import { createRecurringConfig, listRecurringConfigs } from '../src/db/recurring';

// ---------------------------------------------------------------------------
// CLI flags
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const TEMPLATES_ONLY = args.includes('--templates-only');
const CSV_ONLY = args.includes('--csv-only');
const CARDS_ONLY = args.includes('--cards-only');
const INCLUDE_DONE = args.includes('--include-done');

// If no specific flag, import everything
const IMPORT_ALL = !TEMPLATES_ONLY && !CSV_ONLY && !CARDS_ONLY;

function readFlagValue(flag: string): string | null {
  const index = args.indexOf(flag);
  if (index === -1) return null;
  const value = args[index + 1];
  if (!value || value.startsWith('--')) {
    throw new Error(`${flag} requires a local file path`);
  }
  return path.resolve(process.cwd(), value);
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const DATA_DIR = path.join(__dirname, '..', 'data');
const TRELLO_FILE = path.join(DATA_DIR, 'qVB6fAUG - datatalksclub.json');
const CSV_TODO_FILE = path.join(DATA_DIR, 'TODO list - todo.csv');
const CSV_DONE_FILE = path.join(DATA_DIR, 'TODO list - done.csv');
const SOURCE_TRELLO_FILE = readFlagValue('--source') || TRELLO_FILE;
const SOURCE_TODO_FILE = readFlagValue('--source-todo') || CSV_TODO_FILE;
const SOURCE_DONE_FILE = readFlagValue('--source-done') || CSV_DONE_FILE;

// ---------------------------------------------------------------------------
// CSV parser (simple, handles quoted fields with newlines)
// ---------------------------------------------------------------------------

function parseCSVFile(filePath: string): string[][] {
  const text = fs.readFileSync(filePath, 'utf-8');
  const results: string[][] = [];
  let row: string[] = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"') {
      if (inQuotes && text[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === ',' && !inQuotes) {
      row.push(current);
      current = '';
    } else if (ch === '\n' && !inQuotes) {
      row.push(current);
      if (row.length > 0) results.push(row);
      row = [];
      current = '';
    } else if (ch === '\r' && !inQuotes) {
      // skip CR
    } else {
      current += ch;
    }
  }
  // last field
  if (current || row.length > 0) {
    row.push(current);
    results.push(row);
  }
  return results;
}

// ---------------------------------------------------------------------------
// Date parsing helpers
// ---------------------------------------------------------------------------

const MONTHS: Record<string, string> = {
  jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06',
  jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12',
};

/**
 * Try to parse various date formats into YYYY-MM-DD.
 */
function parseDate(raw: string | undefined): string | null {
  if (!raw || !raw.trim()) return null;
  const s = raw.trim();

  // YYYY-MM-DD or YYYY-MM-DD HH:MM:SS
  const isoMatch = s.match(/^(\d{4}-\d{2}-\d{2})/);
  if (isoMatch) return isValidDateOnly(isoMatch[1]) ? isoMatch[1] : null;

  // DD Mon YYYY or DD MMM YYYY
  const dmy = s.match(/^(\d{1,2})\s+([A-Za-z]{3})\s+(\d{4})/);
  if (dmy) {
    const mon = MONTHS[dmy[2].toLowerCase()];
    if (mon) {
      const date = `${dmy[3]}-${mon}-${dmy[1].padStart(2, '0')}`;
      return isValidDateOnly(date) ? date : null;
    }
  }

  // Mon DD YYYY / Month DD, YYYY
  const mdyText = s.match(/^([A-Za-z]{3,9})\s+(\d{1,2}),?\s+(\d{4})/);
  if (mdyText) {
    const mon = MONTHS[mdyText[1].slice(0, 3).toLowerCase()];
    if (mon) {
      const date = `${mdyText[3]}-${mon}-${mdyText[2].padStart(2, '0')}`;
      return isValidDateOnly(date) ? date : null;
    }
  }

  // DD.MM.YYYY, DD/MM/YYYY, or MM/DD/YYYY. Prefer DMY unless first part > 12.
  const numeric = s.match(/^(\d{1,2})[./](\d{1,2})[./](\d{4})$/);
  if (numeric) {
    const first = Number(numeric[1]);
    const second = Number(numeric[2]);
    const day = first > 12 ? first : second;
    const month = first > 12 ? second : first;
    const date = `${numeric[3]}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    return isValidDateOnly(date) ? date : null;
  }

  return null;
}

function isValidDateOnly(value: string): boolean {
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return (
    !Number.isNaN(date.getTime()) &&
    date.getUTCFullYear() === Number(match[1]) &&
    date.getUTCMonth() + 1 === Number(match[2]) &&
    date.getUTCDate() === Number(match[3])
  );
}

// ---------------------------------------------------------------------------
// Trello template -> App template mapping
// ---------------------------------------------------------------------------

interface TrelloCard {
  id: string;
  name: string;
  desc?: string;
  due?: string;
  closed: boolean;
  isTemplate: boolean;
  idList: string;
  idChecklists: string[];
  labels: { name: string }[];
  attachments: { id?: string; name?: string; url: string; mimeType?: string; date?: string }[];
  dateLastActivity?: string;
}

interface TrelloChecklist {
  id: string;
  name: string;
  pos: number;
  checkItems: TrelloCheckItem[];
}

interface TrelloCheckItem {
  id?: string;
  name: string;
  pos: number;
  state: string;
  due?: string;
}

interface TrelloList {
  id: string;
  name: string;
  closed: boolean;
  pos: number;
}

// ---------------------------------------------------------------------------
// Assignee hint mapping
// ---------------------------------------------------------------------------

const ASSIGNEE_HINTS: Record<string, string> = {
  'valeriia': 'valeriia',
  'grace': 'grace',
  'alexey': 'alexey',
};

/**
 * Extract assignee hint from task description text.
 * Patterns: "(assignee: Name)" or "-- Name" at end of text.
 */
function extractAssigneeHint(text: string): { description: string; assigneeId: string | null } {
  // Pattern: (assignee: Name)
  const assigneeMatch = text.match(/\s*\(assignee:\s*([^)]+)\)\s*/i);
  if (assigneeMatch) {
    const name = assigneeMatch[1].trim().toLowerCase();
    const assigneeId = ASSIGNEE_HINTS[name] || null;
    const cleaned = text.replace(assigneeMatch[0], ' ').replace(/\s+/g, ' ').trim();
    return { description: cleaned, assigneeId };
  }

  // Pattern: -- Name at end
  const dashMatch = text.match(/\s*--\s+([A-Za-z]+)\s*$/);
  if (dashMatch) {
    const name = dashMatch[1].trim().toLowerCase();
    const assigneeId = ASSIGNEE_HINTS[name] || null;
    if (assigneeId) {
      const cleaned = text.replace(dashMatch[0], '').trim();
      return { description: cleaned, assigneeId };
    }
  }

  return { description: text, assigneeId: null };
}

function mapTemplateType(cardName: string, labels: { name: string }[]): string {
  const name = cardName.toLowerCase();
  if (name.includes('[newsletter]')) return 'newsletter';
  if (name.includes('[podcast]')) return 'podcast';
  if (name.includes('[webinar]')) return 'webinar';
  if (name.includes('[workshop]')) return 'workshop';
  if (name.includes('[book of the week]')) return 'book-of-the-week';
  if (name.includes('[open-source spotlight]')) return 'oss';
  if (name.includes('[course]')) return 'course';
  if (name.includes('[social media]')) return 'social-media';
  if (name.includes('[maven ll]')) return 'maven-ll';
  if (name.includes('[office hours]')) return 'office-hours';
  if (name.includes('tax report')) return 'tax-report';
  if (name.includes('invoice')) return 'invoice';

  // Fallback: use first label
  if (labels && labels.length > 0) {
    return labels[0].name.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  }
  return 'other';
}

/**
 * Determine trigger type from template type.
 * Newsletter, Social Media Weekly, Tax Report -> "automatic"
 * All others -> "manual"
 */
function mapTriggerType(templateType: string): string {
  const autoTypes = ['newsletter', 'social-media', 'tax-report'];
  return autoTypes.includes(templateType) ? 'automatic' : 'manual';
}

/**
 * Extract leading emoji from a card name.
 * Returns the emoji string or null if no emoji prefix found.
 */
function extractEmoji(name: string): string | null {
  // Match leading emoji characters (including multi-codepoint emoji like flags, skin tones)
  const match = name.match(/^([\u{1F000}-\u{1FFFF}\u{2600}-\u{27BF}\u{FE00}-\u{FEFF}\u{200D}\u{20E3}\u{E0020}-\u{E007F}\u{FE0F}\u{1F3FB}-\u{1F3FF}]+)/u);
  if (match) return match[1];
  return null;
}

/**
 * Extract tags from Trello card labels.
 */
function extractTags(labels: { name: string }[]): string[] {
  if (!labels || labels.length === 0) return [];
  return labels.map((l) => l.name).filter((n) => n.length > 0);
}

/**
 * Map Trello list name to bundle stage.
 */
function mapStageFromList(listName: string): string {
  const lower = listName.toLowerCase();
  if (lower.includes('preparation')) return 'preparation';
  if (lower.includes('announced')) return 'announced';
  if (lower.includes('after event')) return 'after-event';
  if (lower.includes('done')) return 'done';
  return 'preparation';
}

/**
 * Extract markdown links from card description as references.
 */
function extractReferences(desc: string | undefined): { name: string; url: string }[] {
  if (!desc) return [];
  const references: { name: string; url: string }[] = [];
  const linkRegex = /\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g;
  let match;
  while ((match = linkRegex.exec(desc)) !== null) {
    references.push({ name: match[1], url: match[2] });
  }
  return references;
}

function extractMarkdownAndBareLinks(text: string | undefined): { name: string; url: string }[] {
  if (!text) return [];
  const links: { name: string; url: string }[] = [];
  const markdown = /\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g;
  let match;
  const seen = new Set<string>();
  while ((match = markdown.exec(text)) !== null) {
    if (!seen.has(match[2])) {
      links.push({ name: match[1], url: match[2] });
      seen.add(match[2]);
    }
  }
  for (const url of text.match(/https?:\/\/[^\s)>,"]+/g) || []) {
    if (!seen.has(url)) {
      links.push({ name: url, url });
      seen.add(url);
    }
  }
  return links;
}

function trelloTemplateToAppTemplate(card: TrelloCard, boardChecklists: TrelloChecklist[]) {
  const cardChecklists = (card.idChecklists || [])
    .map((clId) => boardChecklists.find((cl) => cl.id === clId))
    .filter((cl): cl is TrelloChecklist => Boolean(cl))
    .sort((a, b) => a.pos - b.pos);

  const taskDefinitions: { refId: string; description: string; offsetDays: number; instructionsUrl?: string }[] = [];
  let totalItems = 0;

  for (const cl of cardChecklists) {
    totalItems += (cl.checkItems || []).length;
  }

  let itemIndex = 0;
  for (const cl of cardChecklists) {
    const items = (cl.checkItems || []).sort((a, b) => a.pos - b.pos);
    for (const item of items) {
      const offsetDays = totalItems > 1
        ? Math.round(-totalItems + itemIndex * (totalItems + 5) / (totalItems - 1))
        : 0;

      const { description: cleanedName, instructionsUrl } = extractInstructionsUrl(item.name);
      const refId = slugify(`${cl.name}-${cleanedName}`.substring(0, 60));

      const td: { refId: string; description: string; offsetDays: number; instructionsUrl?: string } = {
        refId: `${refId}-${itemIndex}`,
        description: `[${cl.name}] ${cleanedName}`,
        offsetDays,
      };
      if (instructionsUrl) td.instructionsUrl = instructionsUrl;
      taskDefinitions.push(td);
      itemIndex++;
    }
  }

  const templateType = mapTemplateType(card.name, card.labels);

  const result: Record<string, unknown> = {
    name: cleanTemplateName(card.name),
    type: templateType,
    taskDefinitions,
    triggerType: mapTriggerType(templateType),
  };

  const emoji = extractEmoji(card.name);
  if (emoji) result.emoji = emoji;

  const tags = extractTags(card.labels);
  if (tags.length > 0) result.tags = tags;

  return result;
}

function cleanTemplateName(name: string): string {
  return name
    .replace(/^[\u{1F000}-\u{1FFFF}\u{2600}-\u{27BF}\u{FE00}-\u{FEFF}]+\s*/u, '')
    .replace(/\s*#XXX\b/, '')
    .replace(/\s*\(DD MMM \d{4}\)/, '')
    .replace(/\s*2026-MMM-DD\s*-\s*Topic\s*-\s*(?:Name|Speaker)/, '')
    .replace(/\s*2026-MM-DD\s*-\s*Topic\s*-\s*(?:Name|Speaker|Alexey Grigorev)/, '')
    .replace(/\s*YYYY-MM-DD\s*-\s*Book\s*-\s*Author\(s\)/, '')
    .replace(/\s*-\s*Tool\s*-\s*Name/, '')
    .replace(/\s*-\s*Title\s*-\s*Name/, '')
    .replace(/\s*Course-\s*YYYY/, 'Course')
    .replace(/\s*\[DD MMM YYYY\]/, '')
    .replace(/\s*\(MM\/YYYY\)/, '')
    .replace(/\s*Weekly posts\s*\(DD MMM 2024\)/, ' Weekly posts')
    .trim();
}

function extractInstructionsUrl(text: string): { description: string; instructionsUrl: string | null } {
  const match = text.match(/\s*\(\[([^\]]*)\]\((https?:\/\/[^)]+)\)\)\s*|\s*\[([^\]]*)\]\((https?:\/\/[^)]+)\)\s*/);
  if (!match) return { description: text, instructionsUrl: null };

  const url = match[2] || match[4];
  const cleaned = text.replace(match[0], ' ').replace(/\s+/g, ' ').trim();
  return { description: cleaned, instructionsUrl: url };
}

function extractBundleLinks(card: TrelloCard): { name: string; url: string }[] {
  const attachments = card.attachments || [];
  const candidates = [
    ...attachments.map((a) => ({ name: a.name || a.url, url: a.url })),
    ...extractMarkdownAndBareLinks(card.desc),
  ];
  const links: { name: string; url: string }[] = [];
  const seen = new Set<string>();
  for (const candidate of candidates) {
    if (!candidate.url || seen.has(candidate.url)) continue;
    if (!isSafeExternalUrl(candidate.url)) continue;
    links.push(candidate);
    seen.add(candidate.url);
  }
  return links;
}

function slugify(str: string): string {
  return str
    .toLowerCase()
    .replace(/\[.*?\]/g, '')
    .replace(/\(.*?\)/g, '')
    .replace(/https?:\/\/\S+/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .substring(0, 50);
}

function stableMigrationId(prefix: string, sourceId: string): string {
  const clean = sourceId.replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 72);
  if (clean.length > 0) return `${prefix}-${clean}`;
  const hash = crypto.createHash('sha256').update(sourceId).digest('hex').slice(0, 16);
  return `${prefix}-${hash}`;
}

function trelloCardSourceKey(card: TrelloCard): string {
  return `trello:card:${card.id}`;
}

function trelloCheckItemSourceKey(card: TrelloCard, checklist: TrelloChecklist, item: TrelloCheckItem, index: number): string {
  return `trello:card:${card.id}:checklist:${checklist.id}:item:${item.id || index}`;
}

function isTrelloInternalUrl(url: string): boolean {
  return /https?:\/\/(?:[^/]+\.)?trello\.com\/(?:1\/cards|c\/|b\/)/i.test(url);
}

function isSafeExternalUrl(url: string): boolean {
  if (!/^https?:\/\//i.test(url)) return false;
  if (isTrelloInternalUrl(url)) return false;
  return !/(X-Amz-Signature|X-Amz-Credential|X-Amz-Security-Token|access_token=|token=|sig=|signature=|api[_-]?key=|password=|secret=|cookie=|session=)/i.test(url);
}

function artifactTypeForUrl(name: string, url: string): string {
  const text = `${name} ${url}`.toLowerCase();
  if (/(invoice|receipt)/.test(text)) return 'invoice';
  if (/(podcast|google.*doc|docs\.google\.com\/document)/.test(text)) return 'podcast-doc';
  if (/(youtube|zoom|recording|video)/.test(text)) return 'recording';
  if (/(luma|lu\.ma|meetup|event|website|web page)/.test(text)) return 'event-page';
  if (/(report|spreadsheet|docs\.google\.com\/spreadsheets)/.test(text)) return 'report';
  return 'external-link';
}

function requiredLinkNameForText(text: string): string | null {
  const lower = text.toLowerCase();
  if (/\bluma\b|lu\.ma/.test(lower)) return 'Luma';
  if (/\bmeetup\b/.test(lower)) return 'Meetup';
  if (/\byoutube\b|youtu\.be/.test(lower)) return 'YouTube';
  if (/\blinkedin\b/.test(lower)) return 'LinkedIn';
  if (/\btwitter\b|\bx\b announcement/.test(lower)) return 'X announcement';
  if (/\bslack\b/.test(lower)) return 'Slack link';
  if (/\bairtable\b/.test(lower)) return 'Airtable record';
  if (/\bpodcast\b.*\bdoc|\bpodcast document\b/.test(lower)) return 'Podcast document';
  if (/\breport\b/.test(lower)) return 'Report';
  if (/\bspreadsheet\b|\bgoogle sheet\b/.test(lower)) return 'Spreadsheet';
  if (/\bwebsite\b|\bweb page\b|\bpage\b/.test(lower)) return 'Website page';
  if (/\blink\b|\burl\b/.test(lower)) return 'Completion proof';
  return null;
}

function inferTrelloProofRequirement(text: string, urls: string[]): Record<string, unknown> | null {
  const lower = text.toLowerCase();
  if (/(invoice|receipt)/.test(lower)) {
    return { proofRequirement: { type: 'file', label: 'Invoice or receipt', required: true }, requiresFile: true };
  }
  const requiredLinkName = requiredLinkNameForText(text);
  if (requiredLinkName) {
    return {
      proofRequirement: { type: 'url', label: requiredLinkName, required: true },
      requiredLinkName,
    };
  }
  if (/(airtable|scheduled|published|sent|submitted|external status|status)/.test(lower)) {
    return { proofRequirement: { type: 'external-status', label: 'External status confirmation', required: true } };
  }
  return inferProofRequirement(text, urls);
}

interface ProcessDocIndex {
  byId: Map<string, string>;
  byRelativePath: Map<string, string>;
  byBasename: Map<string, string>;
}

let cachedProcessDocIndex: ProcessDocIndex | null = null;

function walkMarkdownFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...walkMarkdownFiles(fullPath));
    } else if (entry.isFile() && /\.mdx?$/i.test(entry.name)) {
      files.push(fullPath);
    }
  }
  return files;
}

function getProcessDocIndex(): ProcessDocIndex {
  if (cachedProcessDocIndex) return cachedProcessDocIndex;
  const contentDir = path.resolve(__dirname, '..', '..', 'content');
  const index: ProcessDocIndex = {
    byId: new Map(),
    byRelativePath: new Map(),
    byBasename: new Map(),
  };
  for (const file of walkMarkdownFiles(contentDir)) {
    const body = fs.readFileSync(file, 'utf8');
    const id = body.match(/^id:\s*("?)([A-Za-z0-9._-]+)\1\s*$/m)?.[2];
    if (!id) continue;
    const relative = path.relative(contentDir, file).split(path.sep).join('/');
    index.byId.set(id, id);
    index.byRelativePath.set(relative, id);
    index.byRelativePath.set(`content/${relative}`, id);
    index.byBasename.set(path.basename(file), id);
  }
  cachedProcessDocIndex = index;
  return index;
}

function resolveInstructionDocFromUrl(url: string | null): { instructionDocId?: string; unresolvedUrl?: string } {
  if (!url) return {};
  const index = getProcessDocIndex();
  try {
    const parsed = new URL(url);
    const decodedPath = decodeURIComponent(parsed.pathname).replace(/^\/+/, '');
    const contentIndex = decodedPath.indexOf('content/');
    if (contentIndex >= 0) {
      const relative = decodedPath.slice(contentIndex);
      const docId = index.byRelativePath.get(relative);
      if (docId) return { instructionDocId: docId };
    }
    const basename = path.basename(decodedPath);
    const basenameDocId = index.byBasename.get(basename);
    if (basenameDocId) return { instructionDocId: basenameDocId };
  } catch {
    const normalized = url.replace(/^\/+/, '');
    const contentIndex = normalized.indexOf('content/');
    const relative = contentIndex >= 0 ? normalized.slice(contentIndex) : normalized;
    const docId = index.byRelativePath.get(relative) || index.byBasename.get(path.basename(relative));
    if (docId) return { instructionDocId: docId };
  }
  const explicitId = url.match(/\b(sop|template|reference|task-template)\.[A-Za-z0-9._-]+/);
  if (explicitId && index.byId.has(explicitId[0])) return { instructionDocId: explicitId[0] };
  return { unresolvedUrl: url };
}

// ---------------------------------------------------------------------------
// Trello card -> Bundle + Tasks mapping
// ---------------------------------------------------------------------------

function extractDateFromCardName(name: string): string | null {
  const iso = name.match(/(\d{4}-\d{2}-\d{2})/);
  if (iso) return iso[1];

  const mmmdd = name.match(/(\d{4})-([A-Za-z]{3})-(\d{2})/);
  if (mmmdd) {
    const mon = MONTHS[mmmdd[2].toLowerCase()];
    if (mon) return `${mmmdd[1]}-${mon}-${mmmdd[3]}`;
  }

  const dmy = name.match(/(\d{1,2})\s+([A-Za-z]{3})\s+(\d{4})/);
  if (dmy) {
    const mon = MONTHS[dmy[2].toLowerCase()];
    if (mon) return `${dmy[3]}-${mon}-${dmy[1].padStart(2, '0')}`;
  }

  return null;
}

function trelloCardToBundle(card: TrelloCard, listName: string) {
  const fallbackDate = card.dateLastActivity
    ? card.dateLastActivity.split('T')[0]
    : new Date().toISOString().split('T')[0];
  const anchorDate = card.due
    ? card.due.split('T')[0]
    : extractDateFromCardName(card.name) || fallbackDate;

  // Extract emoji from card name and strip it from title
  const emoji = extractEmoji(card.name);
  const title = emoji ? card.name.replace(/^[\u{1F000}-\u{1FFFF}\u{2600}-\u{27BF}\u{FE00}-\u{FEFF}\u{200D}\u{20E3}\u{E0020}-\u{E007F}\u{FE0F}\u{1F3FB}-\u{1F3FF}]+\s*/u, '').trim() : card.name;

  const bundle: Record<string, unknown> = {
    title,
    anchorDate,
    description: card.desc || null,
    status: card.closed ? 'archived' : 'active',
    stage: mapStageFromList(listName),
  };

  if (emoji) bundle.emoji = emoji;

  // Extract tags from labels
  const tags = extractTags(card.labels);
  if (tags.length > 0) bundle.tags = tags;

  // Extract references from description
  const references = extractReferences(card.desc);
  if (references.length > 0) bundle.references = references;

  // Extract bundle links from attachments (renamed from links)
  const bundleLinks = extractBundleLinks(card);
  if (bundleLinks.length > 0) bundle.bundleLinks = bundleLinks;

  return bundle;
}

function trelloChecklistItemsToTasks(card: TrelloCard, boardChecklists: TrelloChecklist[], bundleId: string | null) {
  const cardChecklists = (card.idChecklists || [])
    .map((clId) => boardChecklists.find((cl) => cl.id === clId))
    .filter((cl): cl is TrelloChecklist => Boolean(cl))
    .sort((a, b) => a.pos - b.pos);

  const tasks: Record<string, unknown>[] = [];
  const fallbackDate = card.dateLastActivity
    ? card.dateLastActivity.split('T')[0]
    : new Date().toISOString().split('T')[0];
  const anchorDate = card.due
    ? card.due.split('T')[0]
    : extractDateFromCardName(card.name) || fallbackDate;

  let itemIndex = 0;
  for (const cl of cardChecklists) {
    const items = (cl.checkItems || []).sort((a, b) => a.pos - b.pos);
    for (const item of items) {
      const { description: cleanedName, instructionsUrl } = extractInstructionsUrl(item.name);
      const { description: finalName, assigneeId } = extractAssigneeHint(cleanedName);

      const refId = slugify(`${cl.name}-${finalName}`.substring(0, 60));

      const taskData: Record<string, unknown> = {
        description: `[${cl.name}] ${finalName}`,
        date: item.due ? item.due.split('T')[0] : anchorDate,
        status: item.state === 'complete' ? 'done' : 'todo',
        source: 'template',
        templateTaskRef: `${refId}-${itemIndex}`,
      };
      if (instructionsUrl) taskData.instructionsUrl = instructionsUrl;
      if (assigneeId) taskData.assigneeId = assigneeId;
      if (bundleId) taskData.bundleId = bundleId;
      tasks.push(taskData);
      itemIndex++;
    }
  }

  return tasks;
}

// ---------------------------------------------------------------------------
// Trello active cards -> integrated work planning
// ---------------------------------------------------------------------------

const ACTIVE_TRELLO_LIST_NAMES = ['Preparation', 'Announced', 'After event'];

interface TrelloSkippedCard {
  sourceId: string;
  name: string;
  reason: 'template-card' | 'closed-card' | 'inactive-list' | 'closed-list' | 'missing-list';
  listName?: string;
}

interface TrelloArtifactPlan {
  sourceKey: string;
  artifact: Record<string, unknown>;
}

interface TrelloActiveCardPlan {
  sourceKey: string;
  listName: string;
  bundle: Record<string, unknown>;
  tasks: Record<string, unknown>[];
  artifacts: TrelloArtifactPlan[];
  warnings: string[];
}

interface TrelloActiveCardStats {
  cardsPlanned: number;
  cardsSkipped: number;
  bundlesCreated: number;
  bundlesUpdated: number;
  tasksPlanned: number;
  tasksCreated: number;
  tasksUpdated: number;
  artifactsPlanned: number;
  artifactsCreated: number;
  artifactsUpdated: number;
  bundleLinks: number;
  waitingTasks: number;
  proofRequirements: number;
  unresolvedProcessDocs: number;
  unresolvedWorkflowTypes: number;
  invalidDates: number;
  unknownAssignees: number;
  invalidUrls: number;
  unsafeArtifactUrls: number;
  unsupportedProofInferences: number;
  duplicateSourceIds: number;
  followUpNotificationsCreated: number;
}

interface TrelloActiveCardReport {
  stats: TrelloActiveCardStats;
  skippedRecords: TrelloSkippedCard[];
  unresolvedDocs: string[];
  unresolvedWorkflowTypes: string[];
  invalidDates: string[];
  unknownAssignees: string[];
  invalidUrls: string[];
  unsafeArtifactUrls: string[];
  unsupportedProofInferences: string[];
  duplicateSourceIds: string[];
  plans: TrelloActiveCardPlan[];
}

const DEFAULT_TRELLO_ACTIVE_STATS: TrelloActiveCardStats = {
  cardsPlanned: 0,
  cardsSkipped: 0,
  bundlesCreated: 0,
  bundlesUpdated: 0,
  tasksPlanned: 0,
  tasksCreated: 0,
  tasksUpdated: 0,
  artifactsPlanned: 0,
  artifactsCreated: 0,
  artifactsUpdated: 0,
  bundleLinks: 0,
  waitingTasks: 0,
  proofRequirements: 0,
  unresolvedProcessDocs: 0,
  unresolvedWorkflowTypes: 0,
  invalidDates: 0,
  unknownAssignees: 0,
  invalidUrls: 0,
  unsafeArtifactUrls: 0,
  unsupportedProofInferences: 0,
  duplicateSourceIds: 0,
  followUpNotificationsCreated: 0,
};

function emptyTrelloActiveCardReport(): TrelloActiveCardReport {
  return {
    stats: { ...DEFAULT_TRELLO_ACTIVE_STATS },
    skippedRecords: [],
    unresolvedDocs: [],
    unresolvedWorkflowTypes: [],
    invalidDates: [],
    unknownAssignees: [],
    invalidUrls: [],
    unsafeArtifactUrls: [],
    unsupportedProofInferences: [],
    duplicateSourceIds: [],
    plans: [],
  };
}

function isActiveTrelloListName(listName: string): boolean {
  const lower = listName.toLowerCase();
  return ACTIVE_TRELLO_LIST_NAMES.some((name) => lower === name.toLowerCase());
}

function selectActiveTrelloCards(
  cards: TrelloCard[],
  lists: TrelloList[]
): { activeCards: TrelloCard[]; skippedRecords: TrelloSkippedCard[]; listMap: Record<string, TrelloList> } {
  const listMap: Record<string, TrelloList> = {};
  for (const list of lists) listMap[list.id] = list;

  const activeCards: TrelloCard[] = [];
  const skippedRecords: TrelloSkippedCard[] = [];

  for (const card of cards) {
    const list = listMap[card.idList];
    const listName = list?.name;
    if (!list) {
      skippedRecords.push({ sourceId: card.id, name: card.name, reason: 'missing-list' });
      continue;
    }
    if (card.isTemplate) {
      skippedRecords.push({ sourceId: card.id, name: card.name, reason: 'template-card', listName });
      continue;
    }
    if (card.closed) {
      skippedRecords.push({ sourceId: card.id, name: card.name, reason: 'closed-card', listName });
      continue;
    }
    if (list.closed) {
      skippedRecords.push({ sourceId: card.id, name: card.name, reason: 'closed-list', listName });
      continue;
    }
    if (!isActiveTrelloListName(list.name)) {
      skippedRecords.push({ sourceId: card.id, name: card.name, reason: 'inactive-list', listName });
      continue;
    }
    activeCards.push(card);
  }

  return { activeCards, skippedRecords, listMap };
}

function appendMigrationProvenance(text: string | null | undefined, lines: string[]): string {
  const cleanText = text?.trim();
  const provenance = `Migration provenance: ${lines.join('; ')}`;
  return cleanText ? `${cleanText}\n\n${provenance}` : provenance;
}

function systemsForText(text: string): string[] {
  const systems = new Set<string>();
  const lower = text.toLowerCase();
  if (/(google doc|google drive|docs\.google\.com|spreadsheet|google sheet)/.test(lower)) systems.add('google-drive');
  if (/(mailchimp|newsletter)/.test(lower)) systems.add('mailchimp');
  if (/(luma|lu\.ma)/.test(lower)) systems.add('luma');
  if (/\bmeetup\b/.test(lower)) systems.add('meetup');
  if (/\byoutube\b|youtu\.be/.test(lower)) systems.add('youtube');
  if (/\bslack\b/.test(lower)) systems.add('slack');
  if (/\bairtable\b/.test(lower)) systems.add('airtable');
  if (/\blinkedin\b/.test(lower)) systems.add('linkedin');
  if (/\btwitter\b|\bx\b/.test(lower)) systems.add('x');
  if (/\bfinom\b|invoice|receipt/.test(lower)) systems.add('finom');
  return [...systems].sort();
}

function addReportWarning(report: TrelloActiveCardReport, warning: string, context: string): void {
  if (warning.startsWith('unresolved process doc:')) {
    report.stats.unresolvedProcessDocs++;
    report.unresolvedDocs.push(`${context} ${warning.replace('unresolved process doc: ', '')}`);
  } else if (warning.startsWith('unresolved workflow type:')) {
    report.stats.unresolvedWorkflowTypes++;
    report.unresolvedWorkflowTypes.push(`${context} ${warning.replace('unresolved workflow type: ', '')}`);
  } else if (warning.startsWith('invalid date:')) {
    report.stats.invalidDates++;
    report.invalidDates.push(`${context} ${warning.replace('invalid date: ', '')}`);
  } else if (warning.startsWith('unknown assignee:')) {
    report.stats.unknownAssignees++;
    report.unknownAssignees.push(`${context} ${warning.replace('unknown assignee: ', '')}`);
  } else if (warning.startsWith('invalid URL:')) {
    report.stats.invalidUrls++;
    report.invalidUrls.push(`${context} ${warning.replace('invalid URL: ', '')}`);
  } else if (warning.startsWith('unsafe artifact URL:')) {
    report.stats.unsafeArtifactUrls++;
    report.unsafeArtifactUrls.push(`${context} ${warning.replace('unsafe artifact URL: ', '')}`);
  } else if (warning.startsWith('unsupported proof inference:')) {
    report.stats.unsupportedProofInferences++;
    report.unsupportedProofInferences.push(`${context} ${warning.replace('unsupported proof inference: ', '')}`);
  } else if (warning.startsWith('duplicate source ID:')) {
    report.stats.duplicateSourceIds++;
    report.duplicateSourceIds.push(`${context} ${warning.replace('duplicate source ID: ', '')}`);
  }
}

function buildTrelloArtifactPlans(card: TrelloCard, bundleId: string, warnings: string[]): TrelloArtifactPlan[] {
  const candidates = [
    ...(card.attachments || []).map((a) => ({ sourceId: a.id || a.url, name: a.name || a.url, url: a.url, source: 'attachment' })),
    ...extractMarkdownAndBareLinks(card.desc).map((link) => ({ sourceId: link.url, name: link.name, url: link.url, source: 'description-link' })),
  ];
  const artifacts: TrelloArtifactPlan[] = [];
  const seen = new Set<string>();
  for (const candidate of candidates) {
    if (!candidate.url || seen.has(candidate.url)) continue;
    seen.add(candidate.url);
    if (!/^https?:\/\//i.test(candidate.url)) {
      warnings.push(`invalid URL: ${candidate.url}`);
      continue;
    }
    if (!isSafeExternalUrl(candidate.url)) {
      warnings.push(`unsafe artifact URL: ${candidate.url}`);
      continue;
    }
    const sourceKey = `trello:card:${card.id}:artifact:${candidate.sourceId}`;
    artifacts.push({
      sourceKey,
      artifact: {
        id: stableMigrationId('trello-artifact', `${card.id}-${candidate.sourceId}`),
        type: artifactTypeForUrl(candidate.name, candidate.url),
        title: candidate.name,
        description: `Imported from Trello ${candidate.source} on card "${card.name}".`,
        status: 'approved',
        storageProvider: 'external-url',
        storageUri: candidate.url,
        visibility: 'internal',
        dataClass: 'internal',
        bundleId,
        sourceType: 'migration',
        reviewedAt: card.dateLastActivity || new Date().toISOString(),
        tags: ['trello-import', candidate.source],
        metadata: {
          source: 'trello-active-card-migration',
          sourceCardId: card.id,
          sourceKey,
        },
      },
    });
  }
  return artifacts;
}

function planTrelloActiveCard(
  card: TrelloCard,
  listName: string,
  boardChecklists: TrelloChecklist[]
): TrelloActiveCardPlan {
  const sourceKey = trelloCardSourceKey(card);
  const bundleId = stableMigrationId('trello-card', card.id);
  const bundle = trelloCardToBundle(card, listName);
  const warnings: string[] = [];
  const templateType = mapTemplateType(card.name, card.labels);
  const bundleTags = new Set([...(Array.isArray(bundle.tags) ? bundle.tags as string[] : []), 'trello-import', templateType]);
  const bundleLinks = extractBundleLinks(card);

  Object.assign(bundle, {
    id: bundleId,
    status: 'active',
    tags: [...bundleTags].filter(Boolean),
    bundleLinks,
    description: appendMigrationProvenance(bundle.description as string | null | undefined, [
      `source=trello-active-card`,
      `source_card_id=${card.id}`,
      `source_list=${listName}`,
      `source_key=${sourceKey}`,
    ]),
  });

  const artifacts = buildTrelloArtifactPlans(card, bundleId, warnings);
  if (artifacts.length > 0) {
    bundle.artifactRefs = artifacts.map((artifactPlan) => ({
      artifactId: artifactPlan.artifact.id,
      type: artifactPlan.artifact.type,
      title: artifactPlan.artifact.title,
      storageUri: artifactPlan.artifact.storageUri,
      status: artifactPlan.artifact.status,
    }));
  }

  bundle.auditEventRefs = [{ auditEventId: stableMigrationId('trello-audit', sourceKey), action: 'created' }];

  const cardChecklists = (card.idChecklists || [])
    .map((clId) => boardChecklists.find((cl) => cl.id === clId))
    .filter((cl): cl is TrelloChecklist => Boolean(cl))
    .sort((a, b) => a.pos - b.pos);

  const tasks: Record<string, unknown>[] = [];
  const fallbackDate = card.dateLastActivity ? card.dateLastActivity.split('T')[0] : new Date().toISOString().split('T')[0];
  const anchorDate = String(bundle.anchorDate || fallbackDate);
  let itemIndex = 0;
  const sourceIds = new Set<string>([sourceKey]);

  for (const checklist of cardChecklists) {
    const phase = slugify(checklist.name) || mapStageFromList(listName);
    const items = (checklist.checkItems || []).sort((a, b) => a.pos - b.pos);
    for (const item of items) {
      const itemSourceKey = trelloCheckItemSourceKey(card, checklist, item, itemIndex);
      if (sourceIds.has(itemSourceKey)) warnings.push(`duplicate source ID: ${itemSourceKey}`);
      sourceIds.add(itemSourceKey);

      const rawDate = item.due || card.due || anchorDate;
      const date = parseDate(rawDate) || anchorDate;
      if (!parseDate(rawDate)) warnings.push(`invalid date: ${rawDate}`);

      const { description: cleanedName, instructionsUrl } = extractInstructionsUrl(item.name);
      const { description: finalName, assigneeId } = extractAssigneeHint(cleanedName);
      if (/\(assignee:\s*[^)]+\)/i.test(cleanedName) && !assigneeId) {
        warnings.push(`unknown assignee: ${cleanedName}`);
      }

      const contextText = `${finalName}\n${card.name}\n${card.desc || ''}`;
      const proofText = `${finalName}\n${instructionsUrl || ''}`;
      const { safeUrls } = extractSafeUrls(proofText);
      const proof = inferTrelloProofRequirement(proofText, safeUrls);
      const waiting = inferWaiting(contextText, date);
      if (!waiting && mentionsReviewerButNotWaiting(contextText)) {
        warnings.push(`unsupported proof inference: ambiguous waiting for ${finalName}`);
      }

      const docResolution = resolveInstructionDocFromUrl(instructionsUrl);
      if (docResolution.unresolvedUrl) warnings.push(`unresolved process doc: ${docResolution.unresolvedUrl}`);

      const taskId = stableMigrationId('trello-checkitem', `${card.id}-${checklist.id}-${item.id || itemIndex}`);
      const refId = slugify(`${checklist.name}-${finalName}`.substring(0, 60)) || `item-${itemIndex}`;
      let status = item.state === 'complete' ? 'done' : waiting ? 'waiting' : 'todo';
      const task: Record<string, unknown> = {
        id: taskId,
        description: `[${checklist.name}] ${finalName}`,
        date,
        status,
        source: 'import',
        bundleId,
        templateTaskRef: `${refId}-${item.id || itemIndex}`,
        phase,
        tags: ['trello-import', templateType],
        comment: appendMigrationProvenance(waiting?.note, [
          `source=trello-active-card`,
          `source_card_id=${card.id}`,
          `source_checklist_id=${checklist.id}`,
          `source_checkitem_id=${item.id || itemIndex}`,
          `source_list=${listName}`,
          `source_key=${itemSourceKey}`,
        ]),
        auditEventRefs: [{ auditEventId: stableMigrationId('trello-audit', sourceKey), action: 'created' }],
      };

      const systems = systemsForText(contextText);
      if (systems.length > 0) task.systems = systems;
      if (instructionsUrl) task.instructionsUrl = instructionsUrl;
      if (docResolution.instructionDocId) task.instructionDocId = docResolution.instructionDocId;
      if (assigneeId) task.assigneeId = assigneeId;
      if (safeUrls[0]) task.link = safeUrls[0];
      if (proof) Object.assign(task, proof);
      if (waiting && status === 'waiting') {
        task.waitingFor = waiting.waitingFor;
        task.followUpAt = waiting.followUpAt;
      }
      if (status === 'done') {
        if (task.requiresFile === true) {
          status = 'todo';
          task.status = status;
          warnings.push(`unsupported proof inference: completed file-proof item lacks migrated file for ${itemSourceKey}`);
        } else if ((task.proofRequirement as Record<string, unknown> | undefined)?.type === 'external-status') {
          task.externalStatus = 'trello-checkitem-complete';
          task.completedAt = `${date}T00:00:00.000Z`;
        } else if (!(task.proofRequirement as Record<string, unknown> | undefined)?.type || task.link || task.comment) {
          task.completedAt = `${date}T00:00:00.000Z`;
        }
      }

      tasks.push(task);
      itemIndex++;
    }
  }

  if (!templateType || templateType === 'other') {
    warnings.push(`unresolved workflow type: ${card.name}`);
  }

  return { sourceKey, listName, bundle, tasks, artifacts, warnings };
}

async function upsertTrelloActiveCardPlan(
  client: DynamoDBDocumentClient,
  plan: TrelloActiveCardPlan,
  report: TrelloActiveCardReport
): Promise<void> {
  const bundleId = String(plan.bundle.id);
  const existingBundle = await getBundle(client, bundleId);
  if (existingBundle) {
    await updateBundle(client, bundleId, plan.bundle);
    report.stats.bundlesUpdated++;
  } else {
    await createBundle(client, plan.bundle);
    report.stats.bundlesCreated++;
  }

  for (const task of plan.tasks) {
    const taskId = String(task.id);
    const existingTask = await getTask(client, taskId);
    if (existingTask) {
      await updateTask(client, taskId, task);
      report.stats.tasksUpdated++;
    } else {
      await createTask(client, task);
      report.stats.tasksCreated++;
    }
  }

  for (const artifactPlan of plan.artifacts) {
    const artifactId = String(artifactPlan.artifact.id);
    const existingArtifact = await getArtifact(client, artifactId);
    if (existingArtifact) {
      await updateArtifact(client, artifactId, artifactPlan.artifact);
      report.stats.artifactsUpdated++;
    } else {
      await createArtifact(client, artifactPlan.artifact);
      report.stats.artifactsCreated++;
    }
  }

  await appendAssistantJobEvent(client, {
    id: stableMigrationId('trello-audit', plan.sourceKey),
    action: 'created',
    summary: `Imported Trello active card "${plan.bundle.title}" as operations-manager work`,
    metadata: {
      source: 'trello-active-card-migration',
      sourceKey: plan.sourceKey,
      bundleId,
      taskIds: plan.tasks.map((task) => task.id),
      artifactIds: plan.artifacts.map((artifactPlan) => artifactPlan.artifact.id),
    },
  });
}

async function migrateTrelloActiveCards(
  client: DynamoDBDocumentClient | null,
  cards: TrelloCard[],
  boardChecklists: TrelloChecklist[],
  listMap: Record<string, TrelloList>,
  skippedRecords: TrelloSkippedCard[]
): Promise<TrelloActiveCardReport> {
  const report = emptyTrelloActiveCardReport();
  report.skippedRecords.push(...skippedRecords);
  report.stats.cardsSkipped = skippedRecords.length;

  const seenSourceKeys = new Set<string>();
  for (const card of cards) {
    const listName = listMap[card.idList]?.name || 'Unknown';
    const plan = planTrelloActiveCard(card, listName, boardChecklists);
    if (seenSourceKeys.has(plan.sourceKey)) {
      plan.warnings.push(`duplicate source ID: ${plan.sourceKey}`);
    }
    seenSourceKeys.add(plan.sourceKey);
    report.plans.push(plan);
    report.stats.cardsPlanned++;
    report.stats.tasksPlanned += plan.tasks.length;
    report.stats.artifactsPlanned += plan.artifacts.length;
    report.stats.bundleLinks += Array.isArray(plan.bundle.bundleLinks) ? plan.bundle.bundleLinks.length : 0;
    report.stats.waitingTasks += plan.tasks.filter((task) => task.status === 'waiting').length;
    report.stats.proofRequirements += plan.tasks.filter((task) => task.proofRequirement).length;
    for (const warning of plan.warnings) addReportWarning(report, warning, `${plan.sourceKey}`);

    if (client) await upsertTrelloActiveCardPlan(client, plan, report);
  }

  if (client) {
    const notifications = await createDueFollowUpNotifications(client);
    report.stats.followUpNotificationsCreated = notifications.length;
  }

  return report;
}

function printTrelloActiveCardReport(report: TrelloActiveCardReport): void {
  console.log('  Trello active-card dry-run/import report:');
  console.log(JSON.stringify({
    stats: report.stats,
    skippedRecords: report.skippedRecords,
    unresolvedDocs: report.unresolvedDocs,
    unresolvedWorkflowTypes: report.unresolvedWorkflowTypes,
    invalidDates: report.invalidDates,
    unknownAssignees: report.unknownAssignees,
    invalidUrls: report.invalidUrls,
    unsafeArtifactUrls: report.unsafeArtifactUrls,
    unsupportedProofInferences: report.unsupportedProofInferences,
    duplicateSourceIds: report.duplicateSourceIds,
  }, null, 2));
}

// ---------------------------------------------------------------------------
// CSV -> integrated work planning
// ---------------------------------------------------------------------------

type SpreadsheetRowStatus = 'open' | 'done' | 'blank' | 'unknown';
type CsvFileRole = 'todo' | 'done';

interface CsvRowContext {
  sourceFile: string;
  sourceLabel: string;
  fileRole: CsvFileRole;
  rowNumber: number;
  includeDone?: boolean;
}

interface CsvTaskPlan {
  kind: 'task';
  task: Record<string, unknown>;
  sourceKey: string;
  warnings: string[];
}

interface CsvRecurringPlan {
  kind: 'recurring';
  config: {
    description: string;
    cronExpression: string;
  };
  sourceKey: string;
  warnings: string[];
}

interface CsvSkipPlan {
  kind: 'skip';
  reason: 'blank' | 'completed-history' | 'invalid-date' | 'missing-description' | 'missing-proof';
  sourceKey?: string;
  warnings: string[];
}

type CsvMigrationPlan = CsvTaskPlan | CsvRecurringPlan | CsvSkipPlan;

interface CsvMigrationStats {
  importedTasks: number;
  recurringConfigsCreated: number;
  recurringSuggestions: number;
  workflowAttachmentCandidates: number;
  completedRowsSkipped: number;
  blankRowsSkipped: number;
  unsafeRows: number;
  unresolvedProcessDocs: number;
  unresolvedWorkflowMatches: number;
  proofRequirements: number;
  waitingFollowUps: number;
  validationErrors: number;
  duplicateTasksSkipped: number;
  duplicateRecurringSkipped: number;
  createdTasks: number;
  updatedTasks: number;
}

interface CsvMigrationReport {
  stats: CsvMigrationStats;
  unresolvedDocs: string[];
  unresolvedWorkflows: string[];
  unsafeFindings: string[];
  validationErrors: string[];
  recurringSuggestions: string[];
  plans: CsvMigrationPlan[];
}

const DEFAULT_CSV_STATS: CsvMigrationStats = {
  importedTasks: 0,
  recurringConfigsCreated: 0,
  recurringSuggestions: 0,
  workflowAttachmentCandidates: 0,
  completedRowsSkipped: 0,
  blankRowsSkipped: 0,
  unsafeRows: 0,
  unresolvedProcessDocs: 0,
  unresolvedWorkflowMatches: 0,
  proofRequirements: 0,
  waitingFollowUps: 0,
  validationErrors: 0,
  duplicateTasksSkipped: 0,
  duplicateRecurringSkipped: 0,
  createdTasks: 0,
  updatedTasks: 0,
};

const RECURRING_PATTERNS = [
  {
    pattern: /^Invite people to Slack from/i,
    config: {
      description: 'Invite people to Slack from Airtable',
      schedule: 'daily',
      cronExpression: '0 9 * * *',
    },
  },
  {
    pattern: /^Create new trello cards if necessary/i,
    config: {
      description: 'Create new Trello cards and review existing ones',
      schedule: 'daily',
      cronExpression: '0 9 * * *',
    },
  },
  {
    pattern: /^Make sure the newsletter for the next week is prepared/i,
    config: {
      description: 'Ensure newsletter for next week is prepared',
      schedule: 'weekly',
      dayOfWeek: 2,
      cronExpression: '0 9 * * 2',
    },
  },
  {
    pattern: /^Prepare (?:a )?newsletter for the week after next/i,
    config: {
      description: 'Prepare newsletter for the week after next',
      schedule: 'weekly',
      dayOfWeek: 3,
      cronExpression: '0 9 * * 3',
    },
  },
  {
    pattern: /^Backup the mailing list from mailchimp/i,
    config: {
      description: 'Backup MailChimp mailing list to Google Drive',
      schedule: 'weekly',
      dayOfWeek: 4,
      cronExpression: '0 9 * * 4',
    },
  },
  {
    pattern: /^Create a slack dump/i,
    config: {
      description: 'Create Slack dump',
      schedule: 'monthly',
      dayOfMonth: 1,
      cronExpression: '0 9 1 * *',
    },
  },
  {
    pattern: /(sponsor performance|follow.?up with sponsor)/i,
    config: {
      description: 'Review sponsor performance and follow up',
      schedule: 'monthly',
      dayOfMonth: 5,
      cronExpression: '0 9 5 * *',
    },
  },
  {
    pattern: /(invoice|receipt|bookkeeping).*check|check.*(invoice|receipt|bookkeeping)/i,
    config: {
      description: 'Check bookkeeping, invoices, and receipts',
      schedule: 'weekly',
      dayOfWeek: 1,
      cronExpression: '0 9 * * 1',
    },
  },
];

function isRecurringTask(description: string): boolean {
  return RECURRING_PATTERNS.some((p) => p.pattern.test(description));
}

function findRecurringPattern(description: string): typeof RECURRING_PATTERNS[number] | null {
  return RECURRING_PATTERNS.find((p) => p.pattern.test(description)) || null;
}

function normalizeSpreadsheetStatus(raw: string | undefined, fileRole: CsvFileRole, hasDescription: boolean): SpreadsheetRowStatus {
  const normalized = (raw || '').trim().toUpperCase().replace(/\s+/g, '');
  if (!hasDescription && !normalized) return 'blank';
  if (normalized === 'DONE' || normalized === 'DONEDONE') return 'done';
  if (normalized === 'NEW' || normalized === 'TODO' || normalized === 'OPEN' || normalized === '') {
    return fileRole === 'done' ? 'done' : 'open';
  }
  return 'unknown';
}

function compactText(value: string, maxLength = 240): string {
  return value.replace(/\s+/g, ' ').trim().slice(0, maxLength);
}

function sourceRowHash(row: string[]): string {
  return crypto
    .createHash('sha256')
    .update(row.map((cell) => compactText(cell || '', 500)).join('\u001f'))
    .digest('hex')
    .slice(0, 16);
}

function buildSourceKey(context: CsvRowContext, row: string[]): string {
  return `spreadsheet-todo:${path.basename(context.sourceFile)}:${sourceRowHash(row)}`;
}

function redactUnsafeText(text: string): { text: string; unsafe: boolean } {
  let unsafe = false;
  let redacted = text;
  const unsafeUrlPattern = /https?:\/\/\S*(?:X-Amz-Signature|X-Amz-Credential|X-Amz-Security-Token|access_token=|token=|sig=|signature=|api[_-]?key=|password=|secret=|cookie=)\S*/gi;
  redacted = redacted.replace(unsafeUrlPattern, () => {
    unsafe = true;
    return '[REDACTED_URL]';
  });

  const secretPattern = /\b(?:api[_-]?key|access[_-]?token|secret|password|cookie|authorization)\s*[:=]\s*\S+/gi;
  redacted = redacted.replace(secretPattern, () => {
    unsafe = true;
    return '[REDACTED_SECRET]';
  });

  return { text: redacted, unsafe };
}

function extractSafeUrls(text: string): { safeUrls: string[]; unsafeUrls: string[] } {
  const urls = text.match(/https?:\/\/[^\s)>,"]+/g) || [];
  const safeUrls: string[] = [];
  const unsafeUrls: string[] = [];
  for (const url of urls) {
    if (/(X-Amz-Signature|X-Amz-Credential|X-Amz-Security-Token|access_token=|token=|sig=|signature=|api[_-]?key=|password=|secret=|cookie=)/i.test(url)) {
      unsafeUrls.push(url);
    } else {
      safeUrls.push(url);
    }
  }
  return { safeUrls, unsafeUrls };
}

function inferProofRequirement(text: string, urls: string[]): Record<string, unknown> | null {
  const lower = text.toLowerCase();
  if (/(invoice|receipt)/.test(lower)) return { proofRequirement: { type: 'file', label: 'Invoice or receipt', required: true }, requiresFile: true };
  if (/(backup|dump|export file)/.test(lower)) return { proofRequirement: { type: 'file', label: 'Backup/export file', required: true }, requiresFile: true };
  if (/(google doc|document|report|spreadsheet|public link|link)/.test(lower)) {
    return {
      proofRequirement: { type: urls.length > 0 ? 'url' : 'comment', label: 'Completion proof', required: true },
      requiredLinkName: 'Completion proof',
    };
  }
  if (/(comment|status update|external status)/.test(lower)) {
    return { proofRequirement: { type: 'comment', label: 'Completion note', required: true } };
  }
  return null;
}

function inferWaiting(text: string, date: string): { waitingFor: string; followUpAt: string; note: string } | null {
  const lower = text.toLowerCase();
  if (!/(waiting|wait for|follow.?up|blocked|reply|response)/.test(lower)) return null;
  const person = text.match(/\b(guest|sponsor|author|speaker|publisher|freelancer|accountant|alexey|valeriia|valeria|grace)\b/i)?.[1];
  if (!person) return null;
  return {
    waitingFor: person[0].toUpperCase() + person.slice(1),
    followUpAt: date,
    note: `Waiting/follow-up inferred from spreadsheet row for ${person}.`,
  };
}

function mentionsReviewerButNotWaiting(text: string): boolean {
  return /\b(guest|sponsor|author|speaker|publisher|freelancer|accountant|alexey|valeriia|valeria|grace)\b/i.test(text) &&
    !/(waiting|wait for|follow.?up|blocked|reply|response)/i.test(text);
}

function inferWorkflowCandidate(text: string): string | null {
  if (/\b(newsletter|podcast|tax report|webinar|workshop|course|invoice)\b/i.test(text)) {
    return compactText(text, 120);
  }
  return null;
}

function resolveInstructionDoc(text: string): { instructionDocId?: string; instructionsUrl?: string; unresolvedUrl?: string } {
  const explicit = text.match(/\b(?:instructionDocId|instruction_doc_id|doc):\s*([a-z0-9._-]+)/i);
  if (explicit) return { instructionDocId: explicit[1] };
  const { safeUrls } = extractSafeUrls(text);
  const docUrl = safeUrls.find((url) => url.includes('docs.google.com') || url.includes('/content/'));
  if (docUrl) return { instructionsUrl: docUrl, unresolvedUrl: docUrl };
  return {};
}

function buildProvenanceComment(context: CsvRowContext, row: string[], sourceKey: string, notes: string, warnings: string[]): string {
  const [dateRaw, taskText, , statusRaw] = row;
  const provenance = [
    `Migration provenance: source_file=${path.basename(context.sourceFile)}`,
    `row=${context.rowNumber}`,
    `source_status=${compactText(statusRaw || 'blank', 40) || 'blank'}`,
    `source_date=${compactText(dateRaw || 'blank', 40) || 'blank'}`,
    `source_key=${sourceKey}`,
    `source_text="${compactText(taskText || '', 160)}"`,
  ].join('; ');
  const parts = [provenance];
  if (notes.trim()) parts.push(`Spreadsheet notes: ${compactText(notes, 500)}`);
  if (warnings.length > 0) parts.push(`Migration warnings: ${warnings.join('; ')}`);
  return parts.join('\n');
}

function csvRowToTask(row: string[], context?: Partial<CsvRowContext>): Record<string, unknown> | null {
  const effectiveContext: CsvRowContext = {
    sourceFile: context?.sourceFile || CSV_TODO_FILE,
    sourceLabel: context?.sourceLabel || 'TODO list - todo.csv',
    fileRole: context?.fileRole || 'todo',
    rowNumber: context?.rowNumber || 1,
    includeDone: context?.includeDone || false,
  };
  const plan = planCsvRow(row, effectiveContext);
  return plan.kind === 'task' ? plan.task : null;
}

function planCsvRow(row: string[], context: CsvRowContext): CsvMigrationPlan {
  const [dateRaw = '', taskRaw = '', notesRaw = '', statusRaw = ''] = row;
  const descriptionRaw = taskRaw.trim();
  const notesRawText = notesRaw.trim();
  const hasAnyContent = row.some((cell) => cell.trim().length > 0);
  const warnings: string[] = [];

  if (!hasAnyContent) return { kind: 'skip', reason: 'blank', warnings };

  const sourceKey = buildSourceKey(context, row);
  const status = normalizeSpreadsheetStatus(statusRaw, context.fileRole, descriptionRaw.length > 0);
  if (status === 'blank') return { kind: 'skip', reason: 'blank', sourceKey, warnings };
  if (!descriptionRaw) return { kind: 'skip', reason: 'missing-description', sourceKey, warnings: ['missing task text'] };

  const date = parseDate(dateRaw);
  if (!date) return { kind: 'skip', reason: 'invalid-date', sourceKey, warnings: [`invalid date: ${dateRaw || 'blank'}`] };

  const { text: description, unsafe: unsafeDescription } = redactUnsafeText(descriptionRaw);
  const { text: notes, unsafe: unsafeNotes } = redactUnsafeText(notesRawText);
  const combined = `${description}\n${notes}`;
  const { safeUrls, unsafeUrls } = extractSafeUrls(`${descriptionRaw}\n${notesRawText}`);
  if (unsafeDescription || unsafeNotes || unsafeUrls.length > 0) warnings.push('unsafe URL/secret redacted');

  const recurring = findRecurringPattern(description);
  if (recurring) {
    return {
      kind: 'recurring',
      sourceKey,
      config: {
        description: recurring.config.description,
        cronExpression: recurring.config.cronExpression,
      },
      warnings,
    };
  }

  if ((status === 'done' || context.fileRole === 'done') && !context.includeDone) {
    return { kind: 'skip', reason: 'completed-history', sourceKey, warnings };
  }

  const proof = inferProofRequirement(combined, safeUrls);
  const hasProofUrl = safeUrls.length > 0;
  if ((status === 'done' || context.fileRole === 'done') && proof && !hasProofUrl && !(proof.proofRequirement as Record<string, unknown>)?.type?.toString().includes('comment')) {
    return { kind: 'skip', reason: 'missing-proof', sourceKey, warnings: [...warnings, 'completed row requires proof but no safe proof was found'] };
  }

  const { description: noAssigneeDescription, assigneeId } = extractAssigneeHint(description);
  const doc = resolveInstructionDoc(combined);
  if (doc.unresolvedUrl) warnings.push(`unresolved process doc: ${doc.unresolvedUrl}`);
  const workflowCandidate = inferWorkflowCandidate(description);
  if (workflowCandidate) warnings.push(`unresolved workflow match: ${workflowCandidate}`);
  if (mentionsReviewerButNotWaiting(combined)) warnings.push('unresolved waiting inference');

  const waiting = inferWaiting(combined, date);
  const task: Record<string, unknown> = {
    description: noAssigneeDescription,
    date,
    status: waiting ? 'waiting' : status === 'done' ? 'done' : 'todo',
    source: 'import',
    comment: buildProvenanceComment(context, row, sourceKey, notes, waiting ? [...warnings, waiting.note] : warnings),
    tags: ['spreadsheet-import'],
  };
  if (assigneeId) task.assigneeId = assigneeId;
  if (safeUrls[0]) task.link = safeUrls[0];
  if (doc.instructionsUrl) task.instructionsUrl = doc.instructionsUrl;
  if (doc.instructionDocId) task.instructionDocId = doc.instructionDocId;
  if (proof) Object.assign(task, proof);
  if (waiting) {
    task.waitingFor = waiting.waitingFor;
    task.followUpAt = waiting.followUpAt;
  }
  if (status === 'done') {
    task.completedAt = `${date}T00:00:00.000Z`;
    task.externalStatus = 'spreadsheet-done';
  }
  return { kind: 'task', task, sourceKey, warnings };
}

function emptyCsvMigrationReport(): CsvMigrationReport {
  return {
    stats: { ...DEFAULT_CSV_STATS },
    unresolvedDocs: [],
    unresolvedWorkflows: [],
    unsafeFindings: [],
    validationErrors: [],
    recurringSuggestions: [],
    plans: [],
  };
}

function collectPlanStats(report: CsvMigrationReport, plan: CsvMigrationPlan, context: CsvRowContext): void {
  report.plans.push(plan);
  const rowLabel = `${path.basename(context.sourceFile)}:${context.rowNumber}`;
  const warningText = plan.warnings.join('\n');
  if (warningText.includes('unsafe URL/secret redacted')) {
    report.stats.unsafeRows++;
    report.unsafeFindings.push(rowLabel);
  }
  for (const warning of plan.warnings) {
    if (warning.startsWith('unresolved process doc:')) {
      report.stats.unresolvedProcessDocs++;
      report.unresolvedDocs.push(`${rowLabel} ${warning.replace('unresolved process doc: ', '')}`);
    }
    if (warning.startsWith('unresolved workflow match:')) {
      report.stats.workflowAttachmentCandidates++;
      report.stats.unresolvedWorkflowMatches++;
      report.unresolvedWorkflows.push(`${rowLabel} ${warning.replace('unresolved workflow match: ', '')}`);
    }
    if (warning === 'unresolved waiting inference') {
      report.validationErrors.push(`${rowLabel} unresolved waiting inference`);
    }
  }

  if (plan.kind === 'skip') {
    if (plan.reason === 'blank') report.stats.blankRowsSkipped++;
    if (plan.reason === 'completed-history') report.stats.completedRowsSkipped++;
    if (plan.reason === 'invalid-date' || plan.reason === 'missing-description' || plan.reason === 'missing-proof') {
      report.stats.validationErrors++;
      report.validationErrors.push(`${rowLabel} ${plan.reason}: ${plan.warnings.join('; ')}`);
    }
    return;
  }

  if (plan.kind === 'recurring') {
    report.stats.recurringSuggestions++;
    report.recurringSuggestions.push(`${plan.config.description} (${plan.config.cronExpression})`);
    return;
  }

  report.stats.importedTasks++;
  if (plan.task.proofRequirement) report.stats.proofRequirements++;
  if (plan.task.status === 'waiting') report.stats.waitingFollowUps++;
}

async function taskExistsForSourceKey(client: DynamoDBDocumentClient, sourceKey: string): Promise<boolean> {
  const result = await client.send(
    new ScanCommand({
      TableName: TABLE_TASKS,
      Select: 'COUNT',
      FilterExpression: 'begins_with(PK, :prefix) AND #source = :source AND contains(#comment, :sourceKey)',
      ExpressionAttributeNames: {
        '#source': 'source',
        '#comment': 'comment',
      },
      ExpressionAttributeValues: {
        ':prefix': 'TASK#',
        ':source': 'import',
        ':sourceKey': sourceKey,
      },
    })
  );
  return (result.Count || 0) > 0;
}

async function migrateCsvFile(
  client: DynamoDBDocumentClient | null,
  filePath: string,
  fileRole: CsvFileRole,
  report: CsvMigrationReport
): Promise<void> {
  const rows = parseCSVFile(filePath);
  const dataRows = rows.slice(1);
  let existingRecurring = new Set<string>();
  if (client) {
    const configs = await listRecurringConfigs(client);
    existingRecurring = new Set(configs.map((config) => `${config.description}\u001f${config.cronExpression}`));
  }

  for (let index = 0; index < dataRows.length; index++) {
    const row = dataRows[index];
    const context: CsvRowContext = {
      sourceFile: filePath,
      sourceLabel: path.basename(filePath),
      fileRole,
      rowNumber: index + 2,
      includeDone: INCLUDE_DONE,
    };
    const plan = planCsvRow(row, context);
    collectPlanStats(report, plan, context);

    if (!client) continue;

    if (plan.kind === 'task') {
      if (await taskExistsForSourceKey(client, plan.sourceKey)) {
        report.stats.duplicateTasksSkipped++;
        continue;
      }
      await createTask(client, plan.task);
      report.stats.createdTasks++;
      continue;
    }

    if (plan.kind === 'recurring') {
      const recurringKey = `${plan.config.description}\u001f${plan.config.cronExpression}`;
      if (existingRecurring.has(recurringKey)) {
        report.stats.duplicateRecurringSkipped++;
        continue;
      }
      await createRecurringConfig(client, {
        description: plan.config.description,
        cronExpression: plan.config.cronExpression,
      });
      existingRecurring.add(recurringKey);
      report.stats.recurringConfigsCreated++;
    }
  }
}

function printCsvReport(report: CsvMigrationReport): void {
  console.log('  CSV dry-run/import report:');
  console.log(`    Imported task plans:              ${report.stats.importedTasks}`);
  console.log(`    Created tasks:                    ${report.stats.createdTasks}`);
  console.log(`    Duplicate tasks skipped:          ${report.stats.duplicateTasksSkipped}`);
  console.log(`    Recurring configs created:        ${report.stats.recurringConfigsCreated}`);
  console.log(`    Recurring suggestions:            ${report.stats.recurringSuggestions}`);
  console.log(`    Duplicate recurring skipped:      ${report.stats.duplicateRecurringSkipped}`);
  console.log(`    Workflow candidates:              ${report.stats.workflowAttachmentCandidates}`);
  console.log(`    Completed rows skipped:           ${report.stats.completedRowsSkipped}`);
  console.log(`    Blank rows skipped:               ${report.stats.blankRowsSkipped}`);
  console.log(`    Unsafe rows redacted:             ${report.stats.unsafeRows}`);
  console.log(`    Unresolved process docs:          ${report.stats.unresolvedProcessDocs}`);
  console.log(`    Unresolved workflow matches:      ${report.stats.unresolvedWorkflowMatches}`);
  console.log(`    Proof requirements:               ${report.stats.proofRequirements}`);
  console.log(`    Waiting/follow-up tasks:          ${report.stats.waitingFollowUps}`);
  console.log(`    Validation errors:                ${report.stats.validationErrors}`);
  if (report.recurringSuggestions.length > 0) {
    console.log('  Recurring suggestions/configs:');
    for (const suggestion of [...new Set(report.recurringSuggestions)]) {
      console.log(`    - ${suggestion}`);
    }
  }
  if (report.unresolvedDocs.length > 0) {
    console.log('  Unresolved process docs:');
    for (const item of report.unresolvedDocs.slice(0, 20)) console.log(`    - ${item}`);
  }
  if (report.unresolvedWorkflows.length > 0) {
    console.log('  Unresolved workflow matches:');
    for (const item of report.unresolvedWorkflows.slice(0, 20)) console.log(`    - ${item}`);
  }
}

// ---------------------------------------------------------------------------
// Main migration
// ---------------------------------------------------------------------------

async function main() {
  console.log('=== DataOps Work-Engine Migration Script ===');
  if (DRY_RUN) console.log('** DRY RUN - no data will be written **\n');

  const needsTrello = IMPORT_ALL || TEMPLATES_ONLY || CARDS_ONLY;
  let allCards: TrelloCard[] = [];
  let allChecklists: TrelloChecklist[] = [];
  let allLists: TrelloList[] = [];
  let templateCards: TrelloCard[] = [];
  let activeCards: TrelloCard[] = [];
  const listMap: Record<string, TrelloList> = {};

  if (needsTrello) {
    console.log('Loading Trello board export...');
    if (!fs.existsSync(SOURCE_TRELLO_FILE)) {
      throw new Error(`--source file does not exist: ${SOURCE_TRELLO_FILE}`);
    }
    console.log(`  Source: ${SOURCE_TRELLO_FILE}`);
    const trello = JSON.parse(fs.readFileSync(SOURCE_TRELLO_FILE, 'utf-8'));
    allCards = trello.cards || [];
    allChecklists = trello.checklists || [];
    allLists = trello.lists || [];

    console.log(`  Cards: ${allCards.length}`);
    console.log(`  Checklists: ${allChecklists.length}`);
    console.log(`  Lists: ${allLists.length}`);

    // Separate template cards from regular cards
    templateCards = allCards.filter((c) => c.isTemplate);
    const selection = selectActiveTrelloCards(allCards, allLists);
    Object.assign(listMap, selection.listMap);
    activeCards = selection.activeCards;

    console.log(`  Template cards: ${templateCards.length}`);
    console.log(`  Active cards (Preparation/Announced/After event): ${activeCards.length}`);
    console.log(`  Active-card path skipped records: ${selection.skippedRecords.length}`);
  }

  // Connect to DB (persistent LevelDB in .data/)
  let client: DynamoDBDocumentClient | null = null;
  if (!DRY_RUN) {
    console.log('\nStarting local DynamoDB (persistent)...');
    const port = await startLocal();
    client = await getClient(port);
    await createTables(client);
    console.log('  DB ready.');
  }

  const stats = {
    templates: 0,
    bundles: 0,
    tasks: 0,
    recurringConfigs: 0,
    skippedDuplicateTemplates: 0,
    skippedRecurringTasks: 0,
    skippedBlankRows: 0,
  };

  // -----------------------------------------------------------------------
  // 1. Import Trello templates
  // -----------------------------------------------------------------------

  if (IMPORT_ALL || TEMPLATES_ONLY) {
    console.log('\n--- Importing Trello Templates ---');

    const SKIP_LEGACY = ['62df9cbc51d95e6fa50c8f56'];

    let existingNames = new Set<string>();
    if (!DRY_RUN) {
      const existing = await listTemplates(client!);
      existingNames = new Set(existing.map((t) => t.name));
    }

    for (const card of templateCards) {
      if (SKIP_LEGACY.includes(card.id)) {
        console.log(`  SKIP (legacy): ${card.name}`);
        continue;
      }

      const template = trelloTemplateToAppTemplate(card, allChecklists);

      if ((template.taskDefinitions as unknown[]).length === 0) {
        console.log(`  SKIP (no tasks): ${card.name}`);
        continue;
      }

      if (existingNames.has(template.name as string)) {
        console.log(`  SKIP (exists): ${template.name}`);
        stats.skippedDuplicateTemplates++;
        continue;
      }

      const emoji = template.emoji ? `${template.emoji} ` : '';
      const tags = template.tags ? ` tags=${JSON.stringify(template.tags)}` : '';
      console.log(`  Template: ${emoji}${template.name} (${template.type}) - ${(template.taskDefinitions as unknown[]).length} task definitions${tags} trigger=${template.triggerType}`);

      if (DRY_RUN) {
        for (const td of (template.taskDefinitions as { offsetDays: number; description: string; instructionsUrl?: string }[])) {
          console.log(`    [offset ${td.offsetDays >= 0 ? '+' : ''}${td.offsetDays}] ${td.description.substring(0, 80)}`);
        }
      } else {
        await createTemplate(client!, template as Record<string, unknown>);
        existingNames.add(template.name as string);
      }

      stats.templates++;
    }
  }

  // -----------------------------------------------------------------------
  // 2. Import active Trello cards as bundles + tasks
  // -----------------------------------------------------------------------

  if (IMPORT_ALL || CARDS_ONLY) {
    console.log('\n--- Importing Active Trello Cards as Bundles ---');

    const selection = selectActiveTrelloCards(allCards, allLists);
    const trelloReport = await migrateTrelloActiveCards(
      client,
      selection.activeCards,
      allChecklists,
      selection.listMap,
      selection.skippedRecords
    );
    for (const plan of trelloReport.plans) {
      const emoji = plan.bundle.emoji ? `${plan.bundle.emoji} ` : '';
      const tags = plan.bundle.tags ? ` tags=${JSON.stringify(plan.bundle.tags)}` : '';
      const stage = plan.bundle.stage ? ` stage=${plan.bundle.stage}` : '';
      console.log(`  Bundle: ${emoji}${String(plan.bundle.title).substring(0, 70)} [${plan.listName}]${stage}${tags} tasks=${plan.tasks.length} artifacts=${plan.artifacts.length}`);
      if (DRY_RUN) {
        for (const task of plan.tasks) {
          const instr = task.instructionDocId ? ` [doc: ${task.instructionDocId}]` : task.instructionsUrl ? ` [instructions: ${task.instructionsUrl}]` : '';
          const waiting = task.status === 'waiting' ? ` [waiting: ${task.waitingFor} ${task.followUpAt}]` : '';
          const proof = task.proofRequirement ? ` [proof: ${JSON.stringify(task.proofRequirement)}]` : '';
          console.log(`    [${task.status}] ${String(task.description).substring(0, 70)}${instr}${waiting}${proof}`);
        }
      }
    }
    printTrelloActiveCardReport(trelloReport);
    stats.bundles += trelloReport.stats.bundlesCreated + (DRY_RUN ? trelloReport.stats.cardsPlanned : 0);
    stats.tasks += DRY_RUN ? trelloReport.stats.tasksPlanned : trelloReport.stats.tasksCreated;
  }

  // -----------------------------------------------------------------------
  // 3. Import CSV tasks
  // -----------------------------------------------------------------------

  if (IMPORT_ALL || CSV_ONLY) {
    console.log('\n--- Importing CSV Tasks ---');

    const csvReport = emptyCsvMigrationReport();
    console.log(`  Processing todo CSV: ${SOURCE_TODO_FILE}`);
    await migrateCsvFile(client, SOURCE_TODO_FILE, 'todo', csvReport);

    if (fs.existsSync(SOURCE_DONE_FILE)) {
      console.log(`  Processing done CSV for history analysis: ${SOURCE_DONE_FILE}`);
      await migrateCsvFile(client, SOURCE_DONE_FILE, 'done', csvReport);
    } else if (readFlagValue('--source-done')) {
      throw new Error(`--source-done file does not exist: ${SOURCE_DONE_FILE}`);
    } else {
      console.log('  No done.csv found; history analysis skipped');
    }

    printCsvReport(csvReport);
    stats.tasks += csvReport.stats.createdTasks || (DRY_RUN ? csvReport.stats.importedTasks : 0);
    stats.recurringConfigs += csvReport.stats.recurringConfigsCreated;
    stats.skippedRecurringTasks += csvReport.stats.recurringSuggestions;
    stats.skippedBlankRows += csvReport.stats.blankRowsSkipped;
  }

  // -----------------------------------------------------------------------
  // Summary
  // -----------------------------------------------------------------------

  console.log('\n=== Migration Summary ===');
  console.log(`  Templates created:           ${stats.templates}`);
  console.log(`  Bundles created:             ${stats.bundles}`);
  console.log(`  ${DRY_RUN ? 'Tasks planned' : 'Tasks created'}:               ${stats.tasks}`);
  console.log(`  Skipped duplicate templates: ${stats.skippedDuplicateTemplates}`);
  console.log(`  Skipped recurring tasks:     ${stats.skippedRecurringTasks}`);
  console.log(`  Skipped blank rows:          ${stats.skippedBlankRows}`);

  if (DRY_RUN) {
    console.log('\n** This was a dry run. Re-run without --dry-run to write data. **');
  }

  console.log('\nNote: Recurring task patterns detected in CSV data should be');
  console.log('configured as recurring configs via the app UI or API:');
  for (const rp of RECURRING_PATTERNS) {
    console.log(`  - ${rp.config.description} (${rp.config.schedule})`);
  }
}

// ---------------------------------------------------------------------------
// Exports for testing
// ---------------------------------------------------------------------------

export {
  extractEmoji,
  extractTags,
  mapStageFromList,
  extractReferences,
  extractBundleLinks,
  extractInstructionsUrl,
  extractAssigneeHint,
  trelloCardToBundle,
  trelloChecklistItemsToTasks,
  selectActiveTrelloCards,
  planTrelloActiveCard,
  migrateTrelloActiveCards,
  emptyTrelloActiveCardReport,
  trelloTemplateToAppTemplate,
  mapTriggerType,
  cleanTemplateName,
  slugify,
  mapTemplateType,
  parseCSVFile,
  parseDate,
  extractDateFromCardName,
  csvRowToTask,
  planCsvRow,
  migrateCsvFile,
  emptyCsvMigrationReport,
  normalizeSpreadsheetStatus,
  redactUnsafeText,
  extractSafeUrls,
  isRecurringTask,
  findRecurringPattern,
  // Types
  type TrelloCard,
  type TrelloChecklist,
  type TrelloCheckItem,
  type TrelloList,
  type CsvMigrationPlan,
};

// Only run main() when executed directly (not when imported for testing)
const isDirectExecution = process.argv[1]?.endsWith('migrate-data.ts') || process.argv[1]?.endsWith('migrate-data.js');
if (isDirectExecution) {
  main()
    .then(() => process.exit(0))
    .catch((err: unknown) => {
      console.error('Migration failed:', err);
      process.exit(1);
    });
}
