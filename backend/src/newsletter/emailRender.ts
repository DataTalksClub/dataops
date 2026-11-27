/**
 * Render a DataOps newsletter draft into the email Relay sends: subject,
 * inbox preview, HTML and plain text.
 *
 * DataOps owns the content and its rendering; Relay only transports the
 * finished payload. This is a TypeScript port of Relay's own block renderer
 * (DataTalksClub/relay `mailing/services/newsletter_layout.py` and
 * `render_issue` / `render_block_text` in `mailing/services/newsletters.py`),
 * filling the same #302 Mailchimp shell (./emailSkeleton.ts), so an issue built
 * here looks like the issues sent before. The renderer is pure: the same draft
 * always produces the same bytes, which is what makes an approval of "this
 * exact rendered revision" checkable (see ./draftApproval.ts).
 *
 * Markdown fields escape raw HTML first and keep only http(s)/mailto links; the
 * `html` block type inserts its HTML as is (as in Relay).
 */
import { BLOCK_TYPES, validUrl, type BlockData } from './blocks';
import { EMAIL_SKELETON } from './emailSkeleton';

export const BRAND_BLUE = '#2056A2';
const LINK_BLUE = 'rgb(0, 106, 177)';
const PROMO_BACKGROUND = '#ECECFB';
const FONT = "'Helvetica Neue', Helvetica, Arial, Verdana, sans-serif";
/** A kicker of "-" switches the section label off (the second recording of a section). */
export const NO_LABEL = '-';

/** Blocks drawn as the lavender card #302 used for the course promo. */
const PROMO_TYPES = new Set(['sponsor', 'sponsor_secondary', 'course_promo', 'own_promo']);
/** Course cards: banner first, then a smaller (h3) title, like the course cards in #302. */
const COURSE_TYPES = new Set(['course_update']);

type Render = 'card' | 'intro' | 'events' | 'links' | 'html';
const RENDER: Record<string, Render> = { intro: 'intro', events_list: 'events', link_list: 'links', html: 'html' };
const renderOf = (type: string): Render => RENDER[type] || 'card';

/** Python's html.escape(text, quote=True). */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;');
}

const escapeText = (value: string) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const lines = (value: string) => (value || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);

// ------------------------------------------------------------------ Markdown

const SAFE_HREF = /^(?:https?:\/\/|mailto:)/i;

/** Inline Markdown on already-escaped text: links, bold, italics, code. */
function inline(escaped: string): string {
  const codes: string[] = [];
  let text = escaped.replace(/`([^`]+)`/g, (_m, code: string) => {
    codes.push(`<code>${code}</code>`);
    return `\u0000${codes.length - 1}\u0000`;
  });
  text = text.replace(/\[([^\]]*)\]\(([^)\s]*)\)/g, (_m, label: string, href: string) => {
    // A code span inside a URL would be restored into the attribute: never a link.
    if (href.includes('\u0000')) return `<a href="#" target="_blank">${label}</a>`;
    const url = href.replace(/&amp;/g, '&');
    const safe = SAFE_HREF.test(url) ? escapeHtml(url) : '#';
    return `<a href="${safe}" target="_blank">${label}</a>`;
  });
  text = text.replace(/&lt;((?:https?:\/\/|mailto:)[^\s&]+)&gt;/g, (_m, url: string) => `<a href="${escapeHtml(url)}" target="_blank">${url}</a>`);
  text = text.replace(/\*\*(?=\S)([\s\S]*?\S)\*\*/g, '<strong>$1</strong>');
  text = text.replace(/__(?=\S)([\s\S]*?\S)__/g, '<strong>$1</strong>');
  text = text.replace(/(^|[^*\w])\*(?=\S)([^*]*?\S)\*(?!\*)/g, '$1<em>$2</em>');
  text = text.replace(/(^|[^_\w])_(?=\S)([^_]*?\S)_(?![_\w])/g, '$1<em>$2</em>');
  return text.replace(/\u0000(\d+)\u0000/g, (_m, index: string) => codes[Number(index)]);
}

const BULLET = /^\s*[-*+]\s+(.*)$/;
const NUMBERED = /^\s*\d+[.)]\s+(.*)$/;

/**
 * Operator Markdown -> the top-level Mailchimp text elements (`<p>`, `<ul>`,
 * `<ol>`), like Relay's `markdown_blocks`: raw HTML is escaped, a single
 * newline is a line break, list items are wrapped in `<p>`.
 */
export function markdownBlocks(text: string): string[] {
  if (!(text || '').trim()) return [];
  const out: string[] = [];
  let paragraph: string[] = [];
  let list: { tag: 'ul' | 'ol'; items: string[] } | null = null;
  const flushParagraph = () => {
    if (paragraph.length) out.push(`<p>${paragraph.map((line) => inline(escapeText(line))).join('<br/>')}</p>`);
    paragraph = [];
  };
  const flushList = () => {
    if (list) out.push(`<${list.tag}>${list.items.map((item) => `<li><p>${inline(escapeText(item))}</p></li>`).join('')}</${list.tag}>`);
    list = null;
  };
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/\s+$/, '');
    if (!line.trim()) {
      flushParagraph();
      flushList();
      continue;
    }
    const bullet = BULLET.exec(line);
    const numbered = bullet ? null : NUMBERED.exec(line);
    if (bullet || numbered) {
      const tag = bullet ? 'ul' : 'ol';
      flushParagraph();
      if (list && list.tag !== tag) flushList();
      list ||= { tag, items: [] };
      list.items.push((bullet || numbered)![1].trim());
      continue;
    }
    if (list) {
      // A continuation line of the last list item.
      const items = (list as { items: string[] }).items;
      items[items.length - 1] = `${items[items.length - 1]} ${line.trim()}`;
      continue;
    }
    paragraph.push(line.trim());
  }
  flushParagraph();
  flushList();
  return out;
}

/** Join elements like #302's editor: an empty line between paragraphs, none before a list; mark the last. */
function joinText(parts: string[]): string {
  const kept = parts.filter(Boolean);
  if (!kept.length) return '';
  const out: string[] = [];
  kept.forEach((part, index) => {
    if (index && !part.startsWith('<ul') && !part.startsWith('<ol')) out.push('<p><br/></p>');
    out.push(part);
  });
  out[out.length - 1] = out[out.length - 1].replace(/^<(p|ul|ol|h2|h3)(?=[ >])/, '<$1 class="last-child"');
  return out.join('');
}

function kickerHtml(text: string): string {
  return '<p style="letter-spacing: 1.5px;"><strong><span style="color:rgb(32, 86, 162);">'
    + '<span style="font-size: 13px"><span style="font-family: Helvetica, Arial, sans-serif">'
    + `${escapeHtml(text)}</span></span></span></strong></p>`;
}

function headingHtml(text: string, level = 'h2', url = ''): string {
  let inner = escapeHtml(text);
  if (url) inner = `<a href="${escapeHtml(url)}" target="_blank" style="color:rgb(34, 34, 34);text-decoration:none">${inner}</a>`;
  return `<${level}>${inner}</${level}>`;
}

// ------------------------------------------------------------------ Mailchimp building pieces

function textRow(inner: string, paddingTop = '12px'): string {
  if (!inner) return '';
  return '<tr><td style="padding-top:0;padding-bottom:0;padding-right:0;padding-left:0" valign="top" '
    + 'class="mceGutterContainer"><table border="0" cellpadding="0" cellspacing="0" width="100%" '
    + 'style="border-collapse:separate" role="presentation"><tbody><tr><td style="padding-top:0;'
    + 'padding-bottom:0;padding-right:0;padding-left:0;border:0;border-radius:0" valign="top">'
    + '<table width="100%" style="border:0;background-color:transparent;border-radius:0;'
    + 'border-collapse:separate"><tbody><tr><td style="padding-left:24px;padding-right:24px;'
    + `padding-top:${paddingTop};padding-bottom:12px" class="mceTextBlockContainer">`
    + `<div class="mceText" style="width:100%">${inner}</div></td></tr></tbody></table>`
    + '</td></tr></tbody></table></td></tr>';
}

function imageRow(url: string, link = '', alt = ''): string {
  if (!url) return '';
  const src = escapeHtml(url);
  const altText = escapeHtml(alt);
  const img = `<img alt="${altText}" src="${src}" width="612" height="auto" `
    + 'style="display:block;max-width:100%;height:auto;border-radius:0" class="mceImage"/>';
  let table = '<table align="center" border="0" cellpadding="0" cellspacing="0" width="100%" '
    + 'style="border-collapse:separate;margin:0;vertical-align:top;max-width:100%;width:100%;height:auto" '
    + `role="presentation"><tbody><tr><td style="border:0;border-radius:0;margin:0" valign="top">${img}`
    + '</td></tr></tbody></table>';
  let msoImg = `<img role="presentation" class="mceImage" src="${src}" alt="${altText}" width="612" height="auto" `
    + 'style="display:block;max-width:612px;width:612px;height:auto"/>';
  msoImg = '<span class="mceImageBorder" style="border:0;border-width:2px;vertical-align:top;margin:0">'
    + `${msoImg}</span>`;
  if (link) {
    const href = escapeHtml(link);
    table = `<a href="${href}" style="display:block" target="_blank">${table}</a>`;
    msoImg = `<a href="${href}">${msoImg}</a>`;
  }
  return '<tr><td style="background-color:transparent;padding-top:12px;padding-bottom:12px;padding-right:24px;'
    + 'padding-left:24px;border:0;border-radius:0" valign="top" class="mceImageBlockContainer" align="center">'
    + `<div><!--[if !mso]><!--></div>${table}<div><!--<![endif]--></div><div>\n<!--[if mso]>\n${msoImg}\n`
    + '<![endif]-->\n</div></td></tr>';
}

function buttonRow(text: string, url: string): string {
  if (!(text && url)) return '';
  const label = escapeHtml(text);
  const href = escapeHtml(url);
  // VML needs a fixed width; Mailchimp sized it from the label (Python's round()).
  const rounded = Math.round((56 + 9.3 * text.length) * 100) / 100;
  const width = Number.isInteger(rounded) ? rounded.toFixed(1) : String(rounded); // Python's str(float)
  return '<tr><td style="background-color:transparent;padding-top:12px;padding-bottom:12px;padding-right:24px;'
    + 'padding-left:24px;border:0;border-radius:0" valign="top" class="mceButtonBlockContainer" align="center">'
    + '<div><!--[if !mso]><!--></div><table align="center" border="0" cellpadding="0" cellspacing="0" '
    + 'role="presentation" class="mceButtonContainer"><tbody><tr class="mceStandardButton">'
    + `<td style="background-color:${BRAND_BLUE};border-radius:8px;text-align:center" valign="top" `
    + `class="mceButton"><a href="${href}" target="_blank" class="mceButtonLink" style="background-color:`
    + `${BRAND_BLUE};border-radius:8px;border:2px none #000000;color:#ffffff;display:block;font-family:${FONT};`
    + 'font-size:16px;font-weight:bold;font-style:normal;padding:16px 28px;text-decoration:none;'
    + `text-align:center;direction:ltr;letter-spacing:0px" rel="noreferrer">${label}</a></td></tr></tbody>`
    + '</table><div><!--<![endif]--></div><table align="center" border="0" cellpadding="0" cellspacing="0" '
    + 'role="presentation" class="mceButtonContainer"><tbody><tr>\n<!--[if mso]>\n<td align="center">\n'
    + '<v:roundrect xmlns:v="urn:schemas-microsoft-com:vml"\nxmlns:w="urn:schemas-microsoft-com:office:word"\n'
    + `href="${href}"\nstyle="v-text-anchor:middle; width:${width}px; height:51.5px;"\narcsize="5%"\n`
    + `strokecolor="${BRAND_BLUE}"\nstrokeweight="1px"\nfillcolor="${BRAND_BLUE}">\n`
    + '<v:stroke dashstyle="solid"/>\n<w:anchorlock />\n<center style="\ncolor: #ffffff;\ndisplay: block;\n'
    + `font-family: ${FONT};\nfont-size: 16;\nfont-style: normal;\nfont-weight: bold;\nletter-spacing: 0px;\n`
    + `text-decoration: none;\ntext-align: center;\ndirection: ltr;"\n>\n${label}\n</center>\n</v:roundrect>\n`
    + '</td>\n<![endif]-->\n</tr></tbody></table></td></tr>';
}

const DIVIDER_ROW = '<tr><td style="background-color:transparent;padding-top:12px;padding-bottom:12px;padding-right:24px;'
  + 'padding-left:24px;border:0;border-radius:0" valign="top" class="mceDividerBlockContainer">'
  + '<table align="center" border="0" cellpadding="0" cellspacing="0" width="100%" '
  + 'style="background-color:transparent;width:100%" role="presentation" class="mceDividerContainer"><tbody><tr>'
  + '<td style="min-width:100%;border-top-width:1px;border-top-style:solid;border-top-color:#E5E5E5;line-height:0;'
  + 'font-size:0" valign="top" class="mceDividerBlock"> </td></tr></tbody></table></td></tr>';

const COURSE_GAP_ROW = '<tr><td style="height:8px;line-height:8px;font-size:0" valign="top">&nbsp;</td></tr>';

function section(rows: string, background = '#FFFFFF', cssClass = 'mceSection54'): string {
  return `<tbody class="mceWrapper"><tr><td style="background-color:transparent" valign="top" align="center" `
    + `class="${cssClass}"><!--[if (gte mso 9)|(IE)]><table align="center" border="0" cellspacing="0" `
    + 'cellpadding="0" width="660" style="width:660px;"><tr><td><![endif]--><table border="0" cellpadding="0" '
    + 'cellspacing="0" width="100%" style="max-width:660px" role="presentation"><tbody><tr>'
    + `<td style="background-color:${background}" valign="top" class="mceWrapperInner"><table align="center" `
    + 'border="0" cellpadding="0" cellspacing="0" width="100%" role="presentation"><tbody><tr class="mceRow">'
    + '<td style="background-position:center;background-repeat:no-repeat;background-size:cover" valign="top">'
    + '<table border="0" cellpadding="0" cellspacing="0" width="100%" role="presentation"><tbody><tr>'
    + '<td style="padding-top:0;padding-bottom:0" valign="top" class="mceColumn" colspan="12" width="100%">'
    + `<table border="0" cellpadding="0" cellspacing="0" width="100%" role="presentation"><tbody>${rows}`
    + '</tbody></table></td></tr></tbody></table></td></tr></tbody></table></td></tr></tbody></table>'
    + '<!--[if (gte mso 9)|(IE)]></td></tr></table><![endif]--></td></tr></tbody>';
}

// ------------------------------------------------------------------ blocks

function value(type: string, data: BlockData, name: string): string {
  if (name === 'kicker' && data[name] === NO_LABEL) return '';
  return data[name] || BLOCK_TYPES[type]?.defaults[name] || '';
}

function eventsText(events: string, footer: string): string {
  const spacer = '<p style="line-height: 0; mso-line-height-alt: 0%;"><br/></p>';
  const out = [spacer];
  for (const line of lines(events)) {
    const parts = line.split('|').map((part) => part.trim());
    const when = parts[0];
    const title = parts[1] || '';
    const url = parts[2] && validUrl(parts[2]) ? parts[2] : '';
    const host = parts[3] ? ` ${escapeHtml(parts[3])}` : '';
    out.push(`<p><strong>${escapeHtml(when)}</strong></p>`);
    if (title) {
      const titleHtml = url ? `<a href="${escapeHtml(url)}" style="color: ${LINK_BLUE};">${escapeHtml(title)}</a>` : escapeHtml(title);
      out.push(`<p>${titleHtml}${host}</p>`);
    }
    out.push('<p><br/></p>');
  }
  const footerParts = markdownBlocks(footer);
  if (footerParts.length) {
    out.push(spacer);
    out.push(...footerParts.map((part) => part.replace(/target="_blank">/g, `target="_blank" style="color: ${BRAND_BLUE};">`)));
  }
  out[out.length - 1] = out[out.length - 1].replace(/^<p(?=[ >])/, '<p class="last-child"');
  return out.join('');
}

function linksText(links: string): string {
  const items = lines(links).map((line) => {
    const parts = line.split('|').map((part) => part.trim());
    const url = parts[1] && validUrl(parts[1]) ? parts[1] : '';
    const note = parts[2] ? ` — ${escapeHtml(parts[2])}` : '';
    const title = url ? `<a href="${escapeHtml(url)}" target="_blank">${escapeHtml(parts[0])}</a>` : escapeHtml(parts[0]);
    return `<li><p>${title}${note}</p></li>`;
  });
  return items.length ? `<ul class="last-child">${items.join('')}</ul>` : '';
}

function introRow(label: string, summary: string): string {
  const parts = [label ? `<p>${escapeHtml(label)}</p>` : '', ...markdownBlocks(summary)];
  return textRow(joinText(parts), '0');
}

/** Mailchimp rows for one block (without the section wrapper); "" when the block is empty or unknown. */
export function blockRows(type: string, data: BlockData): string {
  if (!BLOCK_TYPES[type]) return '';
  const get = (name: string) => value(type, data || {}, name);
  const render = renderOf(type);
  if (render === 'html') return textRow(get('html'));
  if (render === 'intro') return introRow(get('issue_label'), get('summary'));
  const kicker = get('kicker') ? textRow(joinText([kickerHtml(get('kicker'))])) : '';
  const titleRow = get('title') ? textRow(joinText([headingHtml(get('title'))])) : '';
  if (render === 'events') {
    const events = get('events') || get('footer') ? eventsText(get('events'), get('footer')) : '';
    return kicker + titleRow + textRow(events);
  }
  if (render === 'links') return kicker + titleRow + textRow(linksText(get('links')));
  const title = get('title');
  const imageUrl = get('image_url');
  const imageLink = get('image_link');
  const body = markdownBlocks(get('body'));
  const bullets = lines(get('bullets'));
  if (bullets.length) body.push(`<ul>${bullets.map((item) => `<li><p>${escapeHtml(item)}</p></li>`).join('')}</ul>`);
  body.push(...markdownBlocks(get('closing')));
  const meta = get('meta') ? `<p><strong>${escapeHtml(get('meta'))}</strong></p>` : '';
  const image = imageRow(imageUrl, imageLink, title);
  const button = buttonRow(get('cta_text'), get('cta_url'));
  if (COURSE_TYPES.has(type)) {
    const heading = title ? headingHtml(title, 'h3', imageUrl ? '' : imageLink) : '';
    return kicker + image + textRow(heading ? joinText([heading]) : '') + textRow(joinText([meta, ...body])) + button;
  }
  const heading = title ? headingHtml(title, 'h2', imageUrl ? '' : imageLink) : '';
  return kicker + textRow(heading ? joinText([heading]) : '') + textRow(meta ? joinText([meta]) : '') + image + textRow(joinText(body)) + button;
}

/**
 * The content sections, as #301/#302 laid them out: promo blocks are lavender
 * sections; every other block is a white section that starts with a divider
 * (except right after the intro); consecutive course cards share one section.
 * Only the first of two adjacent promo blocks is lavender, so a sponsored card
 * followed by a course promo still reads as two cards.
 */
function sectionsHtml(items: { type: string; rows: string }[]): string {
  const out: string[] = [];
  let current: string[] = [];
  let previous = 'intro';
  const flush = () => {
    if (current.length) out.push(section(current.join('')));
    current = [];
  };
  for (const { type, rows } of items) {
    if (PROMO_TYPES.has(type) && !PROMO_TYPES.has(previous)) {
      flush();
      out.push(section(rows, PROMO_BACKGROUND, 'mceSection46'));
    } else if (COURSE_TYPES.has(type) && COURSE_TYPES.has(previous) && current.length) {
      current.push(COURSE_GAP_ROW + rows);
    } else {
      flush();
      current.push((previous === 'intro' ? '' : DIVIDER_ROW) + rows);
    }
    previous = type;
  }
  if (previous !== 'intro') current.push(DIVIDER_ROW);
  flush();
  return out.join('');
}

function fill(markers: Record<string, string>): string {
  let html = EMAIL_SKELETON;
  for (const [marker, replacement] of Object.entries(markers)) {
    const at = html.indexOf(marker);
    if (at >= 0) html = html.slice(0, at) + replacement + html.slice(at + marker.length);
  }
  return html;
}

// ------------------------------------------------------------------ plain text

function textMarkdown(input: string): string {
  return (input || '')
    .replace(/\[([^\]]*)\]\(([^)\s]*)\)/g, '$1 ($2)')
    .replace(/^\s*[-+]\s+/gm, '* ')
    .replace(/\*\*/g, '')
    .trim();
}

export function blockText(type: string, data: BlockData): string {
  if (!BLOCK_TYPES[type]) return '';
  const get = (name: string) => value(type, data || {}, name);
  const render = renderOf(type);
  if (render === 'html') return get('html').replace(/<[^>]+>/g, '').trim();
  if (render === 'intro') return [get('issue_label'), textMarkdown(get('summary'))].filter(Boolean).join('\n\n');
  const parts: string[] = [];
  if (get('kicker')) parts.push(get('kicker'));
  if (get('title')) parts.push(`\n** ${get('title')}\n${'-'.repeat(60)}`);
  if (render === 'events') {
    for (const line of lines(get('events'))) {
      const fields = line.split('|').map((field) => field.trim());
      parts.push(fields[0]);
      if (fields.length > 1) {
        const link = fields[2] ? ` (${fields[2]})` : '';
        const host = fields[3] ? ` ${fields[3]}` : '';
        parts.push(`${fields[1]}${link}${host}`);
      }
    }
    parts.push(textMarkdown(get('footer')));
  } else if (render === 'links') {
    for (const line of lines(get('links'))) {
      const fields = line.split('|').map((field) => field.trim());
      const link = fields[1] ? ` (${fields[1]})` : '';
      const note = fields[2] ? ` — ${fields[2]}` : '';
      parts.push(`* ${fields[0]}${link}${note}`);
    }
  } else {
    if (get('meta')) parts.push(get('meta'));
    if (get('image_link')) parts.push(get('image_link'));
    parts.push(textMarkdown(get('body')));
    parts.push(lines(get('bullets')).map((item) => `* ${item}`).join('\n'));
    parts.push(textMarkdown(get('closing')));
    if (get('cta_text') && get('cta_url')) parts.push(`${get('cta_text')} (${get('cta_url')})`);
  }
  return parts.filter(Boolean).join('\n\n');
}

/** The footer of #302's text part, with the #301 footer links. */
const FOOTER_TEXT = "DataTalks.Club is a global community of data enthusiasts. If you haven't had a chance to join our Slack yet, "
  + 'use this invite link (http://join.datatalks.club/) . If you have problems with the invite link, fill in this '
  + "form (https://airtable.com/shrhUBN51Jy10fjJq) , and we'll add you to Slack manually.\n\n"
  + "Do you have any questions? Hit reply, and we'll be glad to answer.\n\nSee you in Slack!\n\n"
  + 'Forward to a friend ({forward_url}) · '
  + 'Subscribe (https://club.us19.list-manage.com/subscribe?u=0d7822ab98152f5afc118c176&id=97178021aa) · '
  + 'Past issues (https://us19.campaign-archive.com/home/?u=0d7822ab98152f5afc118c176&id=97178021aa) · '
  + 'Sponsor this newsletter '
  + '(https://datatalks.club/blog/sponsor-datatalks-club.html)\n\n'
  + 'https://twitter.com/datatalksclub\nhttps://linkedin.com/company/datatalks-club\n'
  + 'https://www.youtube.com/c/DataTalksClub\nhttps://datatalks.club/\nmailto:alexey@datatalks.club\n\n'
  + 'Copyright (C) 2026 DataTalks. All rights reserved.\n\nOur mailing address is:\n'
  + 'DataTalks, Langhansstr. 70, Berlin, 13086, DE\n\nWant to change how you receive these emails?\n'
  + 'You can update your preferences '
  + '(https://club.us19.list-manage.com/profile?u=0d7822ab98152f5afc118c176&id=97178021aa&e=[UNIQID]) or '
  + 'unsubscribe (https://club.us19.list-manage.com/unsubscribe?u=0d7822ab98152f5afc118c176&id=97178021aa&t=b'
  + '&e=[UNIQID])\n';

// ------------------------------------------------------------------ whole email

export interface RenderBlock {
  id?: string;
  type: string;
  data: BlockData;
}

export interface RenderInput {
  subject: string;
  previewText: string;
  blocks: RenderBlock[];
  /** "View this email in your browser"; '#' when the draft has no web view yet. */
  webViewUrl: string;
}

export interface RenderedEmail {
  subject: string;
  previewText: string;
  html: string;
  text: string;
}

/** "Forward to a friend": a mailto draft carrying the browser link. */
export function forwardUrl(subject: string, viewUrl: string): string {
  const query = (value: string) => encodeURIComponent(value).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `mailto:?subject=${query(subject)}&body=${query(`${subject}\n\n${viewUrl}`)}`;
}

/** A visible yellow box placed before a block with missing content, in editor previews only. */
function unfinishedRow(label: string, problems: string[]): string {
  return textRow(
    '<div style="background:#fff4ce;border:2px dashed #e0b400;border-radius:6px;padding:10px 14px;'
      + 'font-size:14px;line-height:1.4;color:#5c4400;font-family:Arial,sans-serif">'
      + `<strong>Needs content:</strong> ${escapeHtml(label)} — ${escapeHtml(problems.join(', '))}</div>`,
  );
}

/**
 * The email exactly as recipients get it. `unfinished` (editor previews only)
 * maps block ids to their missing fields, shown as a visible note before the
 * block; the final render never passes it.
 */
export function renderIssueEmail(input: RenderInput, options: { unfinished?: Map<string, string[]> } = {}): RenderedEmail {
  const intro: string[] = [];
  const items: { type: string; rows: string }[] = [];
  const texts: string[] = [];
  for (const block of input.blocks) {
    if (!BLOCK_TYPES[block.type]) continue;
    let rows = blockRows(block.type, block.data || {});
    const problems = block.id ? options.unfinished?.get(block.id) : undefined;
    if (problems?.length) rows = unfinishedRow(BLOCK_TYPES[block.type].label, problems) + rows;
    if (!rows.trim()) continue;
    if (block.type === 'intro') intro.push(rows);
    else items.push({ type: block.type, rows });
    const text = blockText(block.type, block.data || {});
    if (text.trim()) texts.push(text);
  }
  const subject = input.subject.trim();
  const previewText = input.previewText.trim();
  const viewUrl = input.webViewUrl || '#';
  const forward = forwardUrl(subject, viewUrl);
  const html = fill({
    '<!--RELAY:TITLE-->': escapeText(subject),
    '<!--RELAY:PREHEADER-->': escapeText(previewText),
    '<!--RELAY:BANNER-->': '',
    '<!--RELAY:WEB_VIEW_URL-->': escapeHtml(viewUrl),
    '<!--RELAY:INTRO-->': intro.join(''),
    '<!--RELAY:SECTIONS-->': sectionsHtml(items),
    '<!--RELAY:FORWARD_URL-->': escapeHtml(forward),
  });
  const text = [
    `View this email in your browser (${viewUrl})`,
    'https://datatalks.club/',
    ...texts,
    FOOTER_TEXT.replace('{forward_url}', forward),
  ].join('\n\n');
  return { subject, previewText, html, text };
}

/** One block as a standalone document in the newsletter's CSS (the editor's per-block preview). */
export function renderBlockPreview(type: string, data: BlockData): string {
  const rows = blockRows(type, data);
  if (!rows.trim()) return '';
  const head = EMAIL_SKELETON.slice(0, EMAIL_SKELETON.indexOf('<body'));
  let background = PROMO_TYPES.has(type) ? PROMO_BACKGROUND : '#FFFFFF';
  let cssClass = PROMO_TYPES.has(type) ? 'mceSection46' : 'mceSection54';
  if (type === 'intro') {
    cssClass = 'mceSection4';
    background = '#ffffff';
  }
  return `${head}<body style="margin:0;background:#ffffff"><table id="root" border="0" cellpadding="0" `
    + `cellspacing="0" width="100%" role="presentation">${section(rows, background, cssClass)}</table></body></html>`;
}

// Mailchimp's per-recipient preferences/unsubscribe links in the footer. Relay's
// campaign send rewrites them to the recipient's Relay unsubscribe page; a web
// view has no recipient, so they are disabled there (the sentence stays).
const ACCOUNT_HREF = /href="https:\/\/[^"]*list-manage\.com\/(?:profile|unsubscribe)\?[^"]*\[UNIQID\][^"]*"/g;

export function disableAccountLinks(html: string): string {
  return html.replace(ACCOUNT_HREF, 'href="#"');
}
