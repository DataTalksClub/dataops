/**
 * Placeholder extraction and rendering for generic text templates.
 *
 * These templates are plain text with `<UPPER_SNAKE>` placeholders, following
 * the same token convention as KB template documents
 * (`frontend/src/template-placeholders.js`): a token is `<` + a capital letter
 * followed by capitals, digits or underscores + `>`, and single/double letter
 * HTML tag names are never treated as placeholders. Deliberately kept
 * independent from card/workflow templates (`backend/src/templates`).
 */

/** Tokens include their angle brackets. */
const TOKEN = /<[A-Z][A-Z0-9_]*(?:\/[A-Z][A-Z0-9_]*)*>/g;

/** Tag names that must never count as placeholders (same list as the KB convention). */
const HTML_NAMES: ReadonlySet<string> = new Set([
  'A ABBR ADDRESS AREA ARTICLE ASIDE AUDIO B BASE BDI BDO BLOCKQUOTE BODY',
  'BR BUTTON CANVAS CAPTION CITE CODE COL COLGROUP DATA DATALIST DD DEL DETAILS',
  'DFN DIALOG DIV DL DT EM EMBED FIELDSET FIGCAPTION FIGURE FOOTER FORM H1',
  'H2 H3 H4 H5 H6 HEAD HEADER HGROUP HR HTML I IFRAME IMG',
  'INPUT INS KBD LABEL LEGEND LI LINK MAIN MAP MARK MENU META METER',
  'NAV NOSCRIPT OBJECT OL OPTGROUP OPTION OUTPUT P PICTURE PRE PROGRESS Q RP',
  'RT RUBY S SAMP SCRIPT SEARCH SECTION SELECT SLOT SMALL SOURCE SPAN STRONG',
  'STYLE SUB SUMMARY SUP TABLE TBODY TD TEMPLATE TEXTAREA TFOOT TH THEAD',
  'TITLE TR TRACK U UL VAR VIDEO WBR',
].join(' ').split(' '));

/** Unique `<UPPER_SNAKE>` placeholders in first-appearance order. */
export function extractPlaceholders(body: string): string[] {
  const seen = new Set<string>();
  const found: string[] = [];
  for (const token of body.match(TOKEN) || []) {
    const name = token.slice(1, -1);
    if (HTML_NAMES.has(name) || seen.has(name)) continue;
    seen.add(name);
    found.push(name);
  }
  return found;
}

export interface RenderTextTemplateResult {
  /** Body with every found placeholder replaced. */
  text: string;
  /** Placeholder names that had no value and were left as-is. */
  missing: string[];
  /** Supplied value names that no placeholder used. */
  unused: string[];
}

/**
 * Replace `<NAME>` placeholders with `values.NAME`. Unfilled placeholders stay
 * in the text and are reported in `missing` so callers can refuse to send
 * half-filled text; extra values are reported in `unused`.
 */
export function renderTextTemplate(body: string, values: Record<string, string>): RenderTextTemplateResult {
  const supplied = new Set(Object.keys(values || {}));
  const missing: string[] = [];
  const text = body.replace(TOKEN, (token) => {
    const name = token.slice(1, -1);
    if (HTML_NAMES.has(name)) return token;
    const value = values?.[name];
    if (typeof value !== 'string') {
      if (!missing.includes(name)) missing.push(name);
      return token;
    }
    supplied.delete(name);
    return value;
  });
  return { text, missing, unused: [...supplied] };
}
