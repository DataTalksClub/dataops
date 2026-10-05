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
    let docResults = matches.map(formatDocResult);
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

function formatDocResult(match: SearchResult): Record<string, unknown> {
  const summary = String(match.summary || '');
  const description = String(match.description || summary);
  return {
    type: 'doc',
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
    'assistant-job': 6,
  };
  return [...results].sort((a, b) => {
    const oa = order[String(a.type)] ?? 9;
    const ob = order[String(b.type)] ?? 9;
    if (oa !== ob) return oa - ob;
    return String(a.title || '').toLowerCase().localeCompare(String(b.title || '').toLowerCase());
  });
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
