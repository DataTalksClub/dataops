/**
 * A Task's supporting links (a message template, the website repo, a how-to
 * video) are stored as `materials`, never pasted into its title.
 *
 * The Trello import left them inside titles as Markdown, e.g.
 * "Announce in Slack ( , [template](https://docs.google.com/...))". Titles are
 * cleaned on every create and update: each Markdown or bare http(s) link moves
 * into `materials` as `{ label?, url }` with the URL stored clean, and the
 * empty brackets and separators it leaves behind are tidied away.
 */
import { externalLinkKey, normalizeExternalUrl, parseLinkText } from './artifactLinks';
import type { TaskMaterial } from './types';

const MARKDOWN_LINK = /\[([^\]]+)\]\(([^)\s\]]+)\]?\)?/g;
const BARE_URL = /https?:\/\/[^\s)]+/g;
const MAX_MATERIALS = 20;
const MAX_LABEL_LENGTH = 200;

function tidy(text: string): string {
  return text
    .replace(/\(\s*[,;]?\s*\)/g, '')
    .replace(/\(\s*,\s*/g, '(')
    .replace(/\s+([,.;:])/g, '$1')
    .replace(/\s{2,}/g, ' ')
    .replace(/[\s\-–—,:(]+$/, '')
    .trim();
}

/**
 * Split a title into its text and the links pasted into it. A link whose
 * target is not an http(s) URL stays in the text. When nothing but links
 * remains, the title is returned unchanged with no materials.
 */
export function extractTitleLinks(title: string): { title: string; materials: TaskMaterial[] } {
  const materials: TaskMaterial[] = [];
  let rest = title.replace(MARKDOWN_LINK, (match, label: string, target: string) => {
    const url = normalizeExternalUrl(target);
    if (!url) return match;
    const clean = parseLinkText(`[${label}](${url})`).label;
    materials.push(clean ? { url, label: clean } : { url });
    return '';
  });
  rest = rest.replace(BARE_URL, (match) => {
    const url = normalizeExternalUrl(match);
    if (!url) return match;
    materials.push({ url });
    return '';
  });
  if (materials.length === 0) return { title, materials };
  const clean = tidy(rest);
  return clean ? { title: clean, materials } : { title, materials: [] };
}

/** Append materials, one per destination; the first label for a page wins. */
export function mergeMaterials(...lists: TaskMaterial[][]): TaskMaterial[] {
  const seen = new Set<string>();
  const result: TaskMaterial[] = [];
  for (const material of lists.flat()) {
    const key = externalLinkKey(material.url);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(material);
  }
  return result;
}

/**
 * Validate caller-supplied materials and return them stored clean, or an
 * error message.
 */
export function normalizeTaskMaterials(value: unknown): { materials: TaskMaterial[] } | { error: string } {
  if (!Array.isArray(value)) return { error: 'materials must be an array' };
  if (value.length > MAX_MATERIALS) return { error: `materials must have ${MAX_MATERIALS} or fewer entries` };
  const materials: TaskMaterial[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      return { error: 'materials entries must be objects with a url' };
    }
    const { url, label } = entry as Record<string, unknown>;
    const clean = typeof url === 'string' ? normalizeExternalUrl(url) : null;
    if (!clean) return { error: 'materials url must be an http(s) URL' };
    if (label !== undefined && typeof label !== 'string') return { error: 'materials label must be a string' };
    const text = typeof label === 'string' ? label.trim() : '';
    if (text.length > MAX_LABEL_LENGTH) {
      return { error: `materials label must be ${MAX_LABEL_LENGTH} characters or fewer` };
    }
    materials.push(text ? { url: clean, label: text } : { url: clean });
  }
  return { materials: mergeMaterials(materials) };
}
