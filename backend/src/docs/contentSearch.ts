/**
 * `/search` endpoint of the docs content API: doc-source search over the
 * in-process search index, plus response formatting, source/filter
 * negotiation, and stable result ordering.
 *
 * Extracted verbatim from `contentApi.ts` when the docs content API was split.
 */

import type { LambdaEvent, LambdaResponse } from '../types';
import type { DocsRuntime } from './contentApi';
import { jsonResponse, queryParam } from './http';
import type { SearchResult } from './searchIndex';

const DEFAULT_SEARCH_LIMIT = 10;
const MAX_SEARCH_LIMIT = 50;

export async function search(rt: DocsRuntime, event: LambdaEvent): Promise<LambdaResponse> {
  const params = event.queryStringParameters || {};
  const query = (queryParam(event, 'q') || '').trim();
  if (!query) return jsonResponse(400, { error: 'Missing required query parameter: q' });

  const limit = Math.min(
    parseInt(params.limit || String(DEFAULT_SEARCH_LIMIT), 10) || DEFAULT_SEARCH_LIMIT,
    MAX_SEARCH_LIMIT,
  );
  const filters: Record<string, string> = {};
  for (const field of ['domain', 'doc_type']) {
    const value = (params[field] || '').trim();
    if (value) filters[field] = value;
  }

  const results: Record<string, unknown>[] = [];
  const sources: Record<string, unknown>[] = [];

  if (sourceEnabled(params, 'docs')) {
    await rt.ensureSearch();
    const matches = rt.index!.search(query, { filter: filters, numResults: limit });
    let docResults = matches.map((match) => formatDocResult(match, query));
    docResults = docResults.filter((result) => resultMatchesFilters(result, params));
    results.push(...docResults);
    sources.push({ source: 'docs', status: 'ok', count: docResults.length });
  }

  if (sourceEnabled(params, 'work')) {
    // Live work-source merge runs as a separate concern; not wired in this port.
    sources.push({
      source: 'work-engine',
      status: 'unavailable',
      error: 'Work search is not wired into the docs search endpoint yet',
    });
  }

  const sorted = sortResults(results).slice(0, limit);
  return jsonResponse(200, { query, results: sorted, sources });
}

function formatDocResult(match: SearchResult, query: string): Record<string, unknown> {
  const summary = String(match.summary || '');
  const description = String(match.description || summary);
  return {
    type: 'doc',
    score: typeof match._score === 'number' ? Number(match._score.toFixed(4)) : null,
    snippet: snippetFor(query, [match.body, match.headings, description, summary]),
    source: 'docs',
    source_label: `Process ${match.doc_type || 'doc'}`,
    action_label: 'Open process doc',
    path: match.path,
    id: match.id,
    title: match.title,
    domain: match.domain,
    doc_type: match.doc_type,
    summary,
    context: description || summary || match.path || '',
    description,
    purpose: match.purpose || '',
    tags: listValues(match.tags),
    systems: listValues(match.systems),
    route: { kind: 'doc', path: match.path, docId: match.id },
    fields: {
      doc_type: match.doc_type || '',
      domain: match.domain || '',
      tags: listValues(match.tags),
      systems: listValues(match.systems),
    },
  };
}

function sourceEnabled(params: Record<string, string>, source: 'docs' | 'work'): boolean {
  const requested = (params.source || params.sources || '').trim().toLowerCase();
  if (!requested) return true;
  const values = new Set(requested.replace(/,/g, ' ').split(/\s+/).filter(Boolean));
  if (source === 'docs') return ['docs', 'doc', 'process', 'process-docs'].some((v) => values.has(v));
  return ['work', 'work-engine', 'tasks', 'task', 'workflow', 'workflows', 'runtime'].some((v) => values.has(v));
}

function resultMatchesFilters(result: Record<string, unknown>, params: Record<string, string>): boolean {
  const requestedType = (params.type || params.result_type || '').trim().toLowerCase();
  if (
    requestedType &&
    ![String(result.type || '').toLowerCase(), String(result.doc_type || '').toLowerCase()].includes(requestedType)
  ) {
    return false;
  }
  const tag = (params.tag || '').trim().toLowerCase();
  if (tag && !metadataFilterMatches(result, 'tags', tag)) return false;
  const system = (params.system || '').trim().toLowerCase();
  if (system && !metadataFilterMatches(result, 'systems', system)) return false;
  return true;
}

function metadataFilterMatches(result: Record<string, unknown>, field: string, requested: string): boolean {
  const fields = (result.fields as Record<string, unknown>) || {};
  const values = new Set(listValues(result[field] ?? fields[field]).map((v) => v.toLowerCase()));
  return values.has(requested);
}

function sortResults(results: Record<string, unknown>[]): Record<string, unknown>[] {
  const order: Record<string, number> = {
    task: 0,
    workflow: 1,
    template: 2,
    doc: 3,
    artifact: 4,
    file: 5,
  };
  // Groups by result type; within a type the index's relevance order stands.
  // Array.prototype.sort is stable, so equal types keep their ranked order.
  return [...results].sort((a, b) => (order[String(a.type)] ?? 9) - (order[String(b.type)] ?? 9));
}

const SNIPPET_LENGTH = 220;
const SNIPPET_LEAD = 60;

/**
 * The passage of the first field that best covers the query terms, so a
 * reader (often an agent) can judge a hit without opening the document. The
 * window that contains the most distinct query terms wins; ties go to the
 * earliest. Falls back to the opening of the first non-empty field.
 */
export function snippetFor(query: string, fields: Array<string | undefined>): string {
  const terms = [...new Set(query.toLowerCase().match(/[\p{L}\p{N}]{2,}/gu) || [])];
  const texts = fields.map((field) => plainText(String(field || ''))).filter(Boolean);
  for (const text of texts) {
    const lower = text.toLowerCase();
    let best = -1;
    let bestHits = 0;
    for (const term of terms) {
      for (let at = lower.indexOf(term); at !== -1; at = lower.indexOf(term, at + term.length)) {
        const start = Math.max(0, at - SNIPPET_LEAD);
        const window = lower.slice(start, start + SNIPPET_LENGTH);
        const hits = terms.filter((candidate) => window.includes(candidate)).length;
        if (hits > bestHits || (hits === bestHits && start < best)) {
          best = start;
          bestHits = hits;
        }
      }
    }
    if (best >= 0) return excerpt(text, best);
  }
  return texts.length ? excerpt(texts[0], 0) : '';
}

/** Markdown reduced to the words a reader sees: no comments, markup, or URLs. */
function plainText(markdown: string): string {
  return markdown
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[#>*_`|]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function excerpt(text: string, start: number): string {
  let from = start;
  if (from > 0) {
    const space = text.indexOf(' ', from);
    from = space !== -1 && space - from < 20 ? space + 1 : from;
  }
  let to = Math.min(text.length, from + SNIPPET_LENGTH);
  if (to < text.length) {
    const space = text.lastIndexOf(' ', to);
    to = space > from ? space : to;
  }
  return `${from > 0 ? '…' : ''}${text.slice(from, to).trim()}${to < text.length ? '…' : ''}`;
}

function listValues(value: unknown): string[] {
  if (value === null || value === undefined) return [];
  if (Array.isArray(value)) return value.map((item) => String(item)).filter(Boolean);
  if (typeof value === 'string') {
    return value
      .replace(/,/g, ' ')
      .split(/\s+/)
      .map((part) => part.trim())
      .filter(Boolean);
  }
  return [String(value)];
}
