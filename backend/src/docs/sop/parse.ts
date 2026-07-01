/**
 * Parse a marked-up SOP markdown file into a structured object.
 *
 * Faithful TypeScript port of
 * `lambda-functions/src/lambda_functions/sop_parse.py`. The marker convention
 * is defined in `docs/sop-format.md`. Pure stdlib — no third-party deps.
 *
 * Parity with the Python implementation is enforced by `tests/sop.test.ts`.
 */

import type {
  Frontmatter,
  Group,
  ParsedSop,
  ProseBlock,
  Screenshot,
  Section,
  Step,
  StepAttrs,
} from './types';

// ---------- marker regexes (mirror sop_parse.py exactly) ----------

const SECTION_OPEN_RE =
  /<!--\s*sop-section-start:\s*([a-z_]+)((?:\s+\w+(?:=\S+)?)*)\s*-->/;
const SECTION_CLOSE_RE = /<!--\s*sop-section-end\s*-->/;
const GROUP_OPEN_RE = /<!--\s*sop-group-start:\s*"([^"]*)"\s*-->/;
const GROUP_CLOSE_RE = /<!--\s*sop-group-end\s*-->/;
const STEP_OPEN_RE = /<!--\s*sop-step-start(\s+[^-][^>]*?)\s*-->/;
const STEP_CLOSE_RE = /<!--\s*sop-step-end\s*-->/;
const SCREENSHOT_OPEN_RE = /<!--\s*sop-screenshot-start\s*-->/;
const SCREENSHOT_CLOSE_RE = /<!--\s*sop-screenshot-end\s*-->/;
const CAPTION_OPEN_RE = /<!--\s*sop-caption-start\s*-->/;
const CAPTION_CLOSE_RE = /<!--\s*sop-caption-end\s*-->/;
const PROSE_OPEN_RE = /<!--\s*sop-prose-start\s*-->/;
const PROSE_CLOSE_RE = /<!--\s*sop-prose-end\s*-->/;
const TODO_RE = /<!--\s*sop-todo:\s*"([^"]*)"\s*-->/;

// Global form for finditer-style iteration.
const ATTR_RE_G = /(\w+)\s*=\s*(?:"([^"]*)"|(\S+))/g;
const IMAGE_RE = /!\[([^\]]*)\]\(([^)]+)\)/;
const RENDERED_NUM_RE = /^\s*(\d+)\.\s/;

export const REQUIRED_SECTIONS = [
  'summary',
  'prerequisites',
  'procedure',
  'validation',
  'troubleshooting',
  'references',
] as const;

export class ParseError extends Error {
  readonly line: number;

  constructor(message: string, line: number) {
    super(message);
    this.name = 'ParseError';
    this.line = line;
  }

  toString(): string {
    return `line ${this.line}: ${this.message}`;
  }
}

// ---------- stdlib-equivalent helpers (match Python semantics) ----------

/**
 * Mirror Python's `str.splitlines()` for the line boundaries that occur in
 * markdown content (\n, \r, \r\n): a trailing line boundary does NOT produce a
 * final empty element, and an empty string yields `[]`.
 */
export function splitlines(s: string): string[] {
  if (s === '') return [];
  const parts = s.split(/\r\n|\r|\n/);
  if (parts.length > 0 && parts[parts.length - 1] === '') {
    parts.pop();
  }
  return parts;
}

/** Mirror Python's `str.strip("\n")` — trims only newline characters. */
function stripNewlines(s: string): string {
  let a = 0;
  let b = s.length;
  while (a < b && s[a] === '\n') a += 1;
  while (b > a && s[b - 1] === '\n') b -= 1;
  return s.slice(a, b);
}

/** Mirror Python's `str.strip()` — trims surrounding whitespace. */
function strip(s: string): string {
  return s.replace(/^\s+/, '').replace(/\s+$/, '');
}

/** Mirror Python's `str.lstrip()` — trims leading whitespace. */
function lstrip(s: string): string {
  return s.replace(/^\s+/, '');
}

/** Mirror Python's `str.strip(char)` for a single character. */
function stripChar(s: string, ch: string): string {
  let a = 0;
  let b = s.length;
  while (a < b && s[a] === ch) a += 1;
  while (b > a && s[b - 1] === ch) b -= 1;
  return s.slice(a, b);
}

// ---------- frontmatter ----------

export function splitFrontmatter(text: string): [string, string] {
  if (!text.startsWith('---\n')) {
    return ['', text];
  }
  const end = text.indexOf('\n---\n', 4);
  if (end === -1) {
    return ['', text];
  }
  return [text.slice(4, end), text.slice(end + 5)];
}

/** Minimal YAML subset: scalars, inline lists, and `key:` + `  - item` lists. */
export function parseFrontmatter(raw: string): Frontmatter {
  const data: Frontmatter = {};
  const lines = splitlines(raw);
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!strip(line) || lstrip(line).startsWith('#')) {
      i += 1;
      continue;
    }
    if (line.startsWith(' ')) {
      // continuation handled when we collect lists below
      i += 1;
      continue;
    }
    if (!line.includes(':')) {
      i += 1;
      continue;
    }
    const idx = line.indexOf(':');
    const key = strip(line.slice(0, idx));
    const value = strip(line.slice(idx + 1));
    if (value === '') {
      // Look ahead for `  - item` list
      const items: string[] = [];
      let j = i + 1;
      while (j < lines.length && lines[j].startsWith('  -')) {
        items.push(stripChar(strip(lstrip(lines[j]).slice(1)), '"'));
        j += 1;
      }
      data[key] = items;
      i = j;
    } else if (value.startsWith('[') && value.endsWith(']')) {
      const inner = strip(value.slice(1, -1));
      if (!inner) {
        data[key] = [];
      } else {
        data[key] = inner.split(',').map((v) => stripChar(strip(v), '"'));
      }
      i += 1;
    } else {
      data[key] = stripChar(value, '"');
      i += 1;
    }
  }
  return data;
}

// ---------- body parser ----------

interface MutStep {
  id: number;
  rendered_number: number | null;
  attrs: StepAttrs;
  body_lines: string[];
  screenshots: Screenshot[];
}

interface MutGroup {
  title: string;
  steps: Step[];
}

interface MutProcedure {
  raw: boolean;
  raw_body: string;
  groups: MutGroup[];
  flat_steps: Step[];
  prose: ProseBlock[];
  todos: string[];
}

function parseStepAttrs(s: string): StepAttrs {
  const attrs: StepAttrs = {};
  for (const m of s.matchAll(ATTR_RE_G)) {
    const key = m[1];
    const val = m[2] !== undefined ? m[2] : m[3];
    if (key === 'id') {
      attrs[key] = String(parseInt(val, 10));
    } else if (key === 'systems') {
      attrs[key] = val
        .split(',')
        .map((v) => strip(v))
        .filter((v) => v);
    } else {
      attrs[key] = val;
    }
  }
  return attrs;
}

function stripRenderedNumber(
  bodyLines: string[],
): [number | null, string[]] {
  const out = [...bodyLines];
  for (let i = 0; i < out.length; i += 1) {
    const line = out[i];
    if (!strip(line)) {
      continue;
    }
    const m = RENDERED_NUM_RE.exec(line);
    if (m) {
      const n = parseInt(m[1], 10);
      out[i] = line.slice(m[0].length);
      return [n, out];
    }
    return [null, out];
  }
  return [null, out];
}

function parseScreenshotBlock(lines: string[]): Screenshot {
  let src = '';
  let alt = '';
  let caption = '';
  let inCaption = false;
  const captionLines: string[] = [];
  for (const line of lines) {
    if (CAPTION_OPEN_RE.test(line)) {
      inCaption = true;
      continue;
    }
    if (CAPTION_CLOSE_RE.test(line)) {
      inCaption = false;
      caption = strip(captionLines.join('\n'));
      continue;
    }
    if (inCaption) {
      captionLines.push(line);
      continue;
    }
    const m = IMAGE_RE.exec(line);
    if (m && !src) {
      alt = m[1];
      src = m[2];
    }
  }
  if (inCaption) {
    caption = strip(captionLines.join('\n'));
  }
  return { alt, src, caption };
}

function parseScreenshots(bodyLines: string[]): [string[], Screenshot[]] {
  const screenshots: Screenshot[] = [];
  const out: string[] = [];
  let i = 0;
  while (i < bodyLines.length) {
    const line = bodyLines[i];
    if (SCREENSHOT_OPEN_RE.test(line)) {
      let j = i + 1;
      const inner: string[] = [];
      while (j < bodyLines.length && !SCREENSHOT_CLOSE_RE.test(bodyLines[j])) {
        inner.push(bodyLines[j]);
        j += 1;
      }
      if (j >= bodyLines.length) {
        throw new ParseError('unclosed <!-- sop-screenshot-start -->', i);
      }
      screenshots.push(parseScreenshotBlock(inner));
      i = j + 1;
    } else {
      out.push(line);
      i += 1;
    }
  }
  return [out, screenshots];
}

function finalizeStep(step: MutStep): Step {
  let [bodyLines, screenshots] = parseScreenshots(step.body_lines);
  const [rendered, strippedLines] = stripRenderedNumber(bodyLines);
  bodyLines = strippedLines;
  let renderedNumber = step.rendered_number;
  if (renderedNumber === null) {
    renderedNumber = rendered;
  }
  const body = stripNewlines(bodyLines.join('\n'));
  return {
    id: step.id,
    rendered_number: renderedNumber,
    attrs: step.attrs,
    body_md: body,
    screenshots,
  };
}

function parseProcedureBody(body: string): MutProcedure {
  const proc: MutProcedure = {
    raw: false,
    raw_body: '',
    groups: [],
    flat_steps: [],
    prose: [],
    todos: [],
  };
  const lines = splitlines(body);
  const n = lines.length;
  let i = 0;
  let currentGroup: MutGroup | null = null;
  let currentStep: MutStep | null = null;
  let inProse = false;
  let proseLines: string[] = [];
  let lastStepId: number | null = null;

  while (i < n) {
    const line = lines[i];

    // TODO marker (self-closing)
    const todo = TODO_RE.exec(line);
    if (todo && !currentStep) {
      proc.todos.push(todo[1]);
      i += 1;
      continue;
    }

    // group open
    const groupOpen = GROUP_OPEN_RE.exec(line);
    if (groupOpen) {
      if (currentGroup !== null) {
        throw new ParseError('nested <!-- group --> not allowed', i);
      }
      currentGroup = { title: groupOpen[1], steps: [] };
      i += 1;
      continue;
    }

    // group close
    if (GROUP_CLOSE_RE.test(line)) {
      if (currentGroup === null) {
        throw new ParseError('<!-- sop-group-end --> with no open group', i);
      }
      proc.groups.push(currentGroup);
      currentGroup = null;
      i += 1;
      continue;
    }

    // step open
    const stepOpen = STEP_OPEN_RE.exec(line);
    if (stepOpen) {
      if (currentStep !== null) {
        throw new ParseError('nested <!-- sop-step-start --> not allowed', i);
      }
      const attrs = parseStepAttrs(stepOpen[1]);
      if (!('id' in attrs)) {
        throw new ParseError('step missing required `id` attribute', i);
      }
      const sid = parseInt(attrs.id as string, 10);
      delete attrs.id;
      currentStep = {
        id: sid,
        rendered_number: null,
        attrs,
        body_lines: [],
        screenshots: [],
      };
      i += 1;
      continue;
    }

    // step close
    if (STEP_CLOSE_RE.test(line)) {
      if (currentStep === null) {
        throw new ParseError('<!-- sop-step-end --> with no open step', i);
      }
      const finalized = finalizeStep(currentStep);
      lastStepId = finalized.id;
      if (currentGroup !== null) {
        currentGroup.steps.push(finalized);
      } else {
        proc.flat_steps.push(finalized);
      }
      currentStep = null;
      i += 1;
      continue;
    }

    // prose open
    if (PROSE_OPEN_RE.test(line) && currentStep === null) {
      inProse = true;
      proseLines = [];
      i += 1;
      continue;
    }

    // prose close
    if (PROSE_CLOSE_RE.test(line) && inProse) {
      inProse = false;
      proc.prose.push({
        after_step_id: lastStepId,
        body_md: stripNewlines(proseLines.join('\n')),
      });
      i += 1;
      continue;
    }

    // body accumulation
    if (currentStep !== null) {
      currentStep.body_lines.push(line);
    } else if (inProse) {
      proseLines.push(line);
    }
    // else: ignore lines between procedure markers (heading line, blanks)
    i += 1;
  }

  if (currentStep !== null) {
    throw new ParseError('unclosed <!-- sop-step-start -->', n);
  }
  if (currentGroup !== null) {
    throw new ParseError('unclosed <!-- group -->', n);
  }
  if (inProse) {
    throw new ParseError('unclosed <!-- sop-prose-start -->', n);
  }
  return proc;
}

function extractSections(body: string): Record<string, { raw: boolean; body_md: string }> {
  const sections: Record<string, { raw: boolean; body_md: string }> = {};
  const lines = splitlines(body);
  const n = lines.length;
  let i = 0;
  while (i < n) {
    const line = lines[i];
    const m = SECTION_OPEN_RE.exec(line);
    if (!m) {
      i += 1;
      continue;
    }
    const name = m[1];
    const flags = m[2] || '';
    const isRaw = flags.split(/\s+/).filter((f) => f).includes('raw');
    // collect until matching section-end
    let j = i + 1;
    let depth = 1;
    const inner: string[] = [];
    while (j < n) {
      if (SECTION_OPEN_RE.test(lines[j])) {
        depth += 1;
      } else if (SECTION_CLOSE_RE.test(lines[j])) {
        depth -= 1;
        if (depth === 0) {
          break;
        }
      }
      inner.push(lines[j]);
      j += 1;
    }
    if (depth !== 0) {
      throw new ParseError(`unclosed <!-- sop-section-start: ${name} -->`, i);
    }
    sections[name] = { raw: isRaw, body_md: stripNewlines(inner.join('\n')) };
    i = j + 1;
  }
  return sections;
}

export function parse(text: string): ParsedSop {
  const [rawFm, body] = splitFrontmatter(text);
  const frontmatter = rawFm ? parseFrontmatter(rawFm) : {};
  const sectionsRaw = extractSections(body);
  const sections: Record<string, Section> = {};
  for (const [name, sec] of Object.entries(sectionsRaw)) {
    if (name === 'procedure' && !sec.raw) {
      const proc = parseProcedureBody(sec.body_md);
      const groups: Group[] = proc.groups.map((g) => ({
        title: g.title,
        steps: g.steps,
      }));
      sections.procedure = {
        raw: false,
        groups,
        flat_steps: proc.flat_steps,
        prose: proc.prose,
        todos: proc.todos,
      };
    } else {
      sections[name] = sec;
    }
  }
  // Mirror Python's `frontmatter.get("schema_version")`: the value when the key
  // is present (string or list), otherwise null.
  const schemaVersion =
    'schema_version' in frontmatter ? frontmatter.schema_version : null;
  return {
    schema_version: schemaVersion,
    frontmatter,
    sections,
  };
}
