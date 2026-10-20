/** Shared, dependency-free KB template convention. Names include their angle brackets. */
const TOKEN = /<[A-Z][A-Z0-9_]*>/g;
const HTML = new Set([
  'A ABBR ADDRESS AREA ARTICLE ASIDE AUDIO B BASE BDI BDO BLOCKQUOTE BODY',
  'BR BUTTON CANVAS CAPTION CITE CODE COL COLGROUP DATA DATALIST DD DEL DETAILS',
  'DFN DIALOG DIV DL DT EM EMBED FIELDSET FIGCAPTION FIGURE FOOTER FORM H1',
  'H2 H3 H4 H5 H6 HEAD HEADER HGROUP HR HTML I IFRAME IMG',
  'INPUT INS KBD LABEL LEGEND LI LINK MAIN MAP MARK MENU META METER',
  'NAV NOSCRIPT OBJECT OL OPTGROUP OPTION OUTPUT P PICTURE PRE PROGRESS Q RP',
  'RT RUBY S SAMP SCRIPT SEARCH SECTION SELECT SLOT SMALL SOURCE SPAN STRONG',
  'STYLE SUB SUMMARY SUP TABLE TBODY TD TEMPLATE TEXTAREA TFOOT TH THEAD TIME',
  'TITLE TR TRACK U UL VAR VIDEO WBR',
].join(' ').split(' '));

export function templateTokens(body) {
  return [...new Set((body.match(TOKEN) || []).filter(name => !HTML.has(name.slice(1, -1))))];
}

/** Identity is independent of body headings, so ordinary SOPs remain unaffected. */
export function isTemplateDocument(markdown, document = {}) {
  const frontmatter = markdown.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)?.[1] || '';
  const declaredType = document.doc_type || frontmatter.match(/^doc_type:\s*['"]?([a-z-]+)['"]?\s*$/m)?.[1];
  if (declaredType) return declaredType === 'template';
  return document.doc_type === 'template' || /^template[.]/.test(document.id || '')
    || /(?:^|\/)templates\//.test(document.path || '')
    || /^doc_type:\s*['"]?template['"]?\s*$/m.test(frontmatter)
    || /^id:\s*['"]?template\./m.test(frontmatter);
}

export function parseTemplatePlaceholders(markdown) {
  const issues = [];
  const issue = (code, message) => issues.push({ code, message });
  const sections = { Template: [], Placeholders: [] };
  let section = null, fence = null, bodyFence = null, label = null;
  const bodies = [];
  for (const line of markdown.replace(/\r\n/g, '\n').split('\n')) {
    const marker = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
    if (fence) {
      if (marker && marker[1][0] === fence[0] && marker[1].length >= fence.length && !marker[2].trim()) {
        if (bodyFence) { bodies.push({ label: label || (bodies.length ? `Variant ${bodies.length + 1}` : 'Template'), body: bodyFence.join('\n') }); bodyFence = null; }
        fence = null;
      } else if (bodyFence) bodyFence.push(line);
      continue;
    }
    if (marker) {
      fence = marker[1];
      if (section === 'Template') bodyFence = [];
      continue;
    }
    const variantHeading = line.match(/^###\s+(.+?)\s*#*\s*$/);
    if (section === 'Template' && variantHeading) label = variantHeading[1];
    const heading = line.match(/^(#{1,2})\s+(.+?)\s*#*\s*$/);
    if (heading) {
      label = null;
      section = Object.hasOwn(sections, heading[2]) && heading[1] === '##' ? heading[2] : null;
      if (section) {
        if (sections[section].length) issue('duplicate-section', `Duplicate ## ${section} section.`);
        sections[section].push('');
      }
    } else if (section) sections[section].push(line);
  }
  if (bodyFence) issue('unclosed-body', 'The ## Template body fence must be closed.');
  if (!bodies.length) issue('template-body', 'Provide a fenced body under ## Template.');
  const body = bodies.length === 1 ? bodies[0].body : null;
  const used = templateTokens(bodies.map(variant => variant.body).join('\n'));
  const placeholders = [];
  const rows = sections.Placeholders.filter(line => line.trim());
  const cells = line => line.trim().replace(/^\|/, '').replace(/\|$/, '').split(/(?<!\\)\|/).map(value => value.trim().replace(/\\\|/g, '|'));
  if (rows.length) {
    if (cells(rows[0]).join('|') !== 'Placeholder|What to put there|Example'
      || !rows[1] || cells(rows[1]).length !== 3 || !cells(rows[1]).every(cell => /^:?-{3,}:?$/.test(cell))) {
      issue('malformed-table', '## Placeholders requires columns Placeholder | What to put there | Example and a separator row.');
    } else {
      for (const row of rows.slice(2)) {
        const values = cells(row);
        const name = (values[0] || '').replace(/^`([^`]+)`$/, '$1');
        if (values.length !== 3 || !/^<[A-Z][A-Z0-9_]*>$/.test(name) || !values[1] || !values[2]) {
          issue('malformed-row', 'Each placeholder row needs a <NAME>, explanation, and example.');
          continue;
        }
        if (placeholders.some(item => item.name === name)) issue('duplicate-name', `Duplicate explanation for ${name}.`);
        placeholders.push({ name, description: values[1], example: values[2] });
      }
      if (!rows.slice(2).length) issue('empty-table', 'The ## Placeholders table is empty.');
    }
  } else if (sections.Placeholders.length) issue('empty-table', 'The ## Placeholders table is empty.');
  for (const name of used) if (!placeholders.some(item => item.name === name)) issue('missing-explanation', `Missing explanation for ${name}.`);
  for (const { name } of placeholders) if (!used.includes(name)) issue('unused-explanation', `${name} is explained but absent from the template body.`);
  return { body, variants: bodies, placeholders, issues };
}
