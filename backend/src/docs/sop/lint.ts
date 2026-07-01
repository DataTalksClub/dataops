/**
 * Validate a marked-up SOP markdown file against `docs/sop-format.md`.
 *
 * Faithful TypeScript port of
 * `lambda-functions/src/lambda_functions/sop_lint.py`. Violation strings are
 * byte-for-byte identical to the Python implementation (parity-tested), so the
 * Node CLI and the deployed engine enforce exactly the same rules.
 */

import {
  ParseError,
  REQUIRED_SECTIONS,
  parse,
  parseFrontmatter,
  splitFrontmatter,
} from './parse';
import type { Frontmatter, ProcedureSection, Step } from './types';

export const ALLOWED_ACTIONS = new Set([
  'navigate',
  'click',
  'type',
  'upload',
  'download',
  'copy',
  'paste',
  'submit',
  'verify',
  'wait',
  'other',
]);

// Sorted form, used in messages to match Python's `sorted(ALLOWED_ACTIONS)`.
const ALLOWED_ACTIONS_SORTED = [...ALLOWED_ACTIONS].sort();

type FmValue = string | string[] | null | undefined;
type PyValue = string | number | string[] | number[] | null | undefined;

/** Mirror Python's `repr()` for the value shapes that appear in lint messages. */
function pyRepr(value: PyValue): string {
  if (value === null || value === undefined) {
    return 'None';
  }
  if (typeof value === 'number') {
    return String(value);
  }
  if (Array.isArray(value)) {
    return `[${(value as (string | number)[]).map((v) => pyRepr(v)).join(', ')}]`;
  }
  // string -> Python single-quoted repr
  const escaped = value.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
  return `'${escaped}'`;
}

/** Mirror Python's `int(str)` for the strict integer subset used by SOPs. */
function pyInt(value: FmValue): number {
  if (typeof value !== 'string') {
    throw new Error('not an int');
  }
  const trimmed = value.trim();
  if (!/^[+-]?\d+$/.test(trimmed)) {
    throw new Error('not an int');
  }
  return parseInt(trimmed, 10);
}

function isFalsy(v: FmValue): boolean {
  if (v === undefined || v === null || v === '') return true;
  if (Array.isArray(v) && v.length === 0) return true;
  return false;
}

function asList(v: FmValue): string[] {
  if (v === undefined || v === null) return [];
  if (Array.isArray(v)) return v;
  return [v];
}

function getDocType(fm: Frontmatter): FmValue {
  return Object.prototype.hasOwnProperty.call(fm, 'doc_type')
    ? fm.doc_type
    : null;
}

/**
 * Return a list of violation strings for the given marked-up SOP text.
 * An empty list means the file is clean.
 */
export function lintText(text: string): string[] {
  const violations: string[] = [];
  const [rawFm] = splitFrontmatter(text);
  if (!rawFm) {
    violations.push('missing frontmatter');
    return violations;
  }
  const fm = parseFrontmatter(rawFm);
  const docType = getDocType(fm);
  if (!(typeof docType === 'string' && (docType === 'sop' || docType === 'checklist'))) {
    violations.push(
      `doc_type must be 'sop' or 'checklist' (got ${pyRepr(docType)})`,
    );
  }
  if (isFalsy(fm.title)) {
    violations.push('frontmatter is missing `title`');
  }
  if (fm.schema_version === undefined) {
    return violations;
  }
  let sv: number;
  try {
    sv = pyInt(fm.schema_version);
  } catch {
    violations.push(
      `schema_version must be an integer (got ${pyRepr(fm.schema_version)})`,
    );
    return violations;
  }
  if (sv !== 1) {
    violations.push(`unsupported schema_version: ${sv}`);
    return violations;
  }
  let result;
  try {
    result = parse(text);
  } catch (e) {
    if (e instanceof ParseError) {
      violations.push(`parse error: ${e.toString()}`);
      return violations;
    }
    throw e;
  }

  const sections = result.sections;
  for (const name of REQUIRED_SECTIONS) {
    if (!(name in sections)) {
      violations.push(`missing required section: ${name}`);
    }
  }

  if ('procedure' in sections && !sections.procedure.raw) {
    const proc = sections.procedure as ProcedureSection;
    const groups = proc.groups || [];
    const flat = proc.flat_steps || [];
    if (groups.length && flat.length) {
      violations.push('procedure mixes groups and flat steps — pick one shape');
    }
    const allSteps: Step[] = [];
    for (const g of groups) {
      allSteps.push(...g.steps);
    }
    allSteps.push(...flat);
    const ids = allSteps.map((s) => s.id);
    if (new Set(ids).size !== ids.length) {
      const dups = [...new Set(ids.filter((i) => ids.filter((x) => x === i).length > 1))].sort(
        (a, b) => a - b,
      );
      violations.push(`duplicate step ids: ${pyRepr(dups)}`);
    }
    const expected = Array.from({ length: ids.length }, (_, k) => k + 1);
    if (!arraysEqual(ids, expected)) {
      violations.push(
        `step ids are not sequential 1..N; got ${pyRepr(ids)}, expected ${pyRepr(expected)}`,
      );
    }
    const declaredSystems = new Set(asList(fm.systems));
    for (const s of allSteps) {
      const attrs = s.attrs || {};
      const action = attrs.action;
      if (action && !ALLOWED_ACTIONS.has(action)) {
        violations.push(
          `step id=${s.id}: action ${pyRepr(action)} not in ${pyRepr(ALLOWED_ACTIONS_SORTED)}`,
        );
      }
      const systems = attrs.systems || [];
      const unknown = systems.filter((x) => !declaredSystems.has(x));
      if (unknown.length && declaredSystems.size) {
        const sortedUnknown = [...new Set(unknown)].sort();
        violations.push(
          `step id=${s.id}: systems ${pyRepr(sortedUnknown)} not in frontmatter \`systems\``,
        );
      }
      for (const shot of s.screenshots || []) {
        if (!shot.src) {
          violations.push(
            `step id=${s.id}: <!-- sop-screenshot-start --> block has no image`,
          );
        }
      }
      if (s.rendered_number !== null && s.rendered_number !== s.id) {
        violations.push(
          `step id=${s.id}: rendered number ${s.rendered_number} does not match id`,
        );
      }
    }
  }

  return violations;
}

function arraysEqual(a: number[], b: number[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}
