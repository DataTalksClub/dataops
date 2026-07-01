/**
 * SOP engine seam — TYPE SIGNATURES ONLY.
 *
 * Declares the TypeScript interface and result types for the SOP parser/linter
 * ported from `lambda-functions/src/lambda_functions/sop_parse.py` and
 * `sop_lint.py`. There is intentionally NO implementation here.
 *
 * Issue #86 owns the implementation and the `work-engine/src/docs/sop/`
 * directory. This file exists only so other docs modules (search text
 * extraction, content API `/lint` and `/parse`) can depend on stable types
 * while #86 is built in parallel. Do not add logic or constants here.
 */

// ── Parse result shape (mirrors sop_parse.parse) ──────────────────────────────

/**
 * Minimal frontmatter map. Values are scalars or string lists, matching the
 * YAML subset parsed by the SOP frontmatter reader.
 */
export type SopFrontmatter = Record<string, string | string[] | undefined>;

/** Attributes declared on a `<!-- sop-step-start ... -->` marker. */
export interface SopStepAttrs {
  /** Action verb, e.g. `navigate` / `click` / `verify`. Validated by lint. */
  action?: string;
  /** Systems this step touches; lint checks them against frontmatter systems. */
  systems?: string[];
  [attr: string]: unknown;
}

/** A screenshot block parsed from inside a step. */
export interface SopScreenshot {
  alt: string;
  src: string;
  caption: string;
}

/** A single procedure step. */
export interface SopStep {
  id: number;
  rendered_number: number | null;
  attrs: SopStepAttrs;
  body_md: string;
  screenshots: SopScreenshot[];
}

/** A titled group of steps. */
export interface SopGroup {
  title: string;
  steps: SopStep[];
}

/** A prose block interleaved between steps. */
export interface SopProse {
  after_step_id: number | null;
  body_md: string;
}

/** A parsed (non-raw) `procedure` section. */
export interface SopProcedureSection {
  raw: false;
  groups: SopGroup[];
  flat_steps: SopStep[];
  prose: SopProse[];
  todos: string[];
}

/** Any section captured as raw markdown (including a raw `procedure`). */
export interface SopRawSection {
  raw: boolean;
  body_md: string;
}

/** A section is either the structured procedure or a raw markdown block. */
export type SopSection = SopProcedureSection | SopRawSection;

/** The structured result of parsing a marked-up SOP. */
export interface StructuredSop {
  schema_version: number | string | null | undefined;
  frontmatter: SopFrontmatter;
  /** Keyed by section name (`summary`, `procedure`, `validation`, ...). */
  sections: Record<string, SopSection>;
}

// ── Lint result shape (mirrors sop_lint.lint_text) ────────────────────────────

/**
 * Result of linting a marked-up SOP. `violations` mirrors the Python list of
 * violation strings; `ok` is the convenience boolean `violations.length === 0`.
 */
export interface LintResult {
  ok: boolean;
  violations: string[];
}

// ── Engine interface ──────────────────────────────────────────────────────────

/**
 * SOP parse/lint engine. Implemented by issue #86 under
 * `work-engine/src/docs/sop/` (do not implement here).
 */
export interface SopEngine {
  /** Parse marked-up SOP markdown into a {@link StructuredSop}. */
  parse(markdown: string): StructuredSop;

  /** Lint marked-up SOP markdown, returning a {@link LintResult}. */
  lint(markdown: string): LintResult;
}
