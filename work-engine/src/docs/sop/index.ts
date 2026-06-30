/**
 * SOP structured-markdown engine (TypeScript port).
 *
 * Public surface for parsing and linting marked-up SOP files. Mirrors the
 * canonical Python implementation under `lambda-functions/`; the marker spec is
 * `docs/sop-format.md`. Parity is enforced by `tests/sop.test.ts`.
 */

export {
  ParseError,
  REQUIRED_SECTIONS,
  parse,
  parseFrontmatter,
  splitFrontmatter,
  splitlines,
} from './parse';
export { ALLOWED_ACTIONS, lintText } from './lint';
export type {
  Frontmatter,
  Group,
  ParsedSop,
  ProcedureSection,
  ProseBlock,
  RawSection,
  Screenshot,
  Section,
  Step,
  StepAttrs,
} from './types';
