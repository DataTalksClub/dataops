/** Per-document counterparts of the private knowledge repository's content gates.
 * Diagnostics name rules and lines, never the matching sensitive values.
 */
import { parseFrontmatter, splitFrontmatter } from './frontmatter';

const secretPatterns: [string, RegExp][] = [
  ['private-key', /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/],
  ['github-token', /\bgh[pousr]_[A-Za-z0-9]{20,}\b/],
  ['github-pat', /\bgithub_pat_[A-Za-z0-9_]{20,}\b/],
  ['slack-token', /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/],
  ['aws-access-key', /\bAKIA[0-9A-Z]{16}\b/],
  ['stripe-secret', /\bsk_live_[A-Za-z0-9]{16,}\b/],
];
const email = /\b[\w.!#$%&'*+/=?^`{|}~-]+@[\w-]+(?:\.[\w-]+)+/i;
const placeholder = /\b(?:TODO|TBD|FIXME)\b|<insert image|couldn.t be converted automatically|content size mismatch/i;

function section(text: string, heading: string): string | undefined {
  const marked = new RegExp(`<!-- sop-section-start: [^>]+ -->\\s*\\n^## ${heading}\\s*$\\n([\\s\\S]*?)(?=<!-- sop-section-end -->)`, 'm').exec(text);
  return marked?.[1] ?? new RegExp(`^## ${heading}\\s*$\\n([\\s\\S]*?)(?=^## |(?![\\s\\S]))`, 'm').exec(text)?.[1];
}
function meaningful(text: string): boolean {
  return text.replace(/<!--[\s\S]*?-->/g, '').split(/\r?\n/).some(line => {
    const value = line.trim();
    return value && !/^[-*_ ]+$/.test(value) && !/^[-*]\s*[A-Za-z][\w /-]*:\s*$/.test(value);
  });
}

export function authoredContentIssues(path: string, text: string): string[] {
  if (!path.startsWith('content/') || !path.endsWith('.md')) return [];
  const issues: string[] = [];
  const [raw] = splitFrontmatter(text);
  let metadata: ReturnType<typeof parseFrontmatter>;
  try { metadata = parseFrontmatter(raw); }
  catch { return ['invalid frontmatter YAML']; }
  if (!raw) issues.push('missing or invalid frontmatter');
  if (!metadata.id) issues.push('missing stable id');
  // Privacy applies even to archived documents and documents without metadata.
  if (email.test(text) && !['restricted', 'restricted-internal'].includes(String(metadata.confidentiality))) {
    issues.push('email addresses require restricted or restricted-internal classification; remove unnecessary contact data');
  }
  for (const [name, pattern] of secretPatterns) {
    if (pattern.test(text)) issues.push(`high-confidence ${name} finding; remove the sensitive value`);
  }
  if ('systems' in metadata || 'loom' in metadata) issues.push('deprecated metadata field');
  if (/!\[\s*\]\(/.test(text)) issues.push('blank image alt text');
  const archived = ['archived', 'deprecated'].includes(String(metadata.status));
  if (!archived) {
    text.split(/\r?\n/).forEach((line, index) => {
      if (placeholder.test(line)) issues.push(`line ${index + 1}: unresolved placeholder`);
    });
    if (/<!-- sop-caption-start -->\s*This screenshot\b/i.test(text)) issues.push('generated screenshot caption is not step-specific');
    const summary = section(text, 'Summary');
    if (summary && !meaningful(summary)) issues.push('active document has empty Summary section');
  }
  const required: string[] = [];
  if (metadata.doc_type === 'sop' && !archived) required.push('Validation', 'Troubleshooting', 'References');
  if (['draft', 'proposed', 'active', 'review-due'].includes(String(metadata.status))) {
    if (metadata.doc_type === 'template') required.push('Usage', 'Notes');
    if (metadata.doc_type === 'prompt') required.push('Summary', 'Prerequisites', 'Validation', 'Troubleshooting', 'References');
    if (['reference', 'playbook', 'checklist'].includes(String(metadata.doc_type))) required.push('References');
  }
  for (const heading of required) {
    const body = section(text, heading);
    if (!body || !meaningful(body)) issues.push(`governed document has empty ${heading} section`);
  }
  return issues;
}

/** Incomplete draft controls may be saved with a loud warning; sensitive data
 * and unfinished placeholders never enter a new publication. */
export function blockingAuthoredContentIssues(path: string, text: string): string[] {
  return authoredContentIssues(path, text).filter(issue =>
    /high-confidence|email addresses|unresolved placeholder|invalid frontmatter YAML/.test(issue));
}
