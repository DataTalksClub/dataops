/**
 * Types for the SOP structured-markdown engine.
 *
 * Ported from the canonical Python implementation
 * (`lambda-functions/src/lambda_functions/sop_parse.py` and `sop_lint.py`).
 * See `docs/sop-format.md` for the marker spec.
 *
 * The JSON shapes here mirror the Python `parse()` output exactly so the two
 * implementations stay interchangeable (parity-tested over the `content/` corpus).
 */

export type Frontmatter = Record<string, string | string[]>;

export interface Screenshot {
  alt: string;
  src: string;
  caption: string;
}

export interface StepAttrs {
  // `systems` is a list, every other attribute is free-text. `id` is removed
  // from attrs by the parser (it becomes the step's `id`).
  systems?: string[];
  action?: string;
  tool?: string;
  [key: string]: string | string[] | undefined;
}

export interface Step {
  id: number;
  rendered_number: number | null;
  attrs: StepAttrs;
  body_md: string;
  screenshots: Screenshot[];
}

export interface Group {
  title: string;
  steps: Step[];
}

export interface ProseBlock {
  after_step_id: number | null;
  body_md: string;
}

export interface RawSection {
  raw: boolean;
  body_md: string;
}

export interface ProcedureSection {
  raw: false;
  groups: Group[];
  flat_steps: Step[];
  prose: ProseBlock[];
  todos: string[];
}

export type Section = RawSection | ProcedureSection;

export interface ParsedSop {
  schema_version: string | string[] | null;
  frontmatter: Frontmatter;
  sections: Record<string, Section>;
}
