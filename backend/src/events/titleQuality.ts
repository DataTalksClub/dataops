/** Deterministic spelling checks; topic meaning and breadth are reviewed by an operator. */
const BRAND_SPELLINGS = new Set(['dbt', 'dlt', 'pandas', 'scikit-learn']);
const SMALL = new Set('a an the and or of to in on for with at'.split(' '));
export const TITLE_CHECKLIST = {
  meaningful: 'Names an agreed audience problem, skill or approach; not only a guest, employer or job title.',
  broad: 'Still useful without incidental company or city context. Databricks FDE → Forward Deployed Engineering.',
  consistent: 'The same topic is used in the episode, Card, hold, guest/prep documents, banners and public pages. Review existing copies; this check never publishes or renames them.',
};
export interface TitleReview {
  title: string;
  meaningful: true;
  broad: true;
  consistent: true;
  note: string;
  actor: string;
  reviewedAt: string;
}
export function suggestedTitle(title: string, guests: string[] = []): string {
  let first = true;
  const names = guests.filter(Boolean).flatMap(guest => {
    const start = title.indexOf(guest);
    return start < 0 ? [] : [{ start, end: start + guest.length }];
  });
  return title.replace(/https?:\/\/\S+|`[^`]*`|[\p{L}\p{N}]+(?:[’'/-][\p{L}\p{N}]+)*|:/gu, (word, offset: number) => {
    if (word === ':') { first = true; return word; }
    if (names.some(name => offset >= name.start && offset < name.end)) { first = false; return word; }
    if (/^https?:|^`/.test(word)) { first = false; return word; }
    const start = first;
    first = false;
    if (SMALL.has(word.toLowerCase())) return start ? word[0].toUpperCase() + word.slice(1).toLowerCase() : word.toLowerCase();
    if (BRAND_SPELLINGS.has(word)) return word;
    // Acronyms, mixed-case brands, code and URL spellings are never rewritten.
    if (/[A-Z].*[A-Z]|[a-z][A-Z]/.test(word) || word.includes('/')) return word;
    return word.split('-').map(part => part[0].toUpperCase() + part.slice(1)).join('-');
  });
}
export function checkTitle(title: unknown, guests: string[] = []) {
  const text = typeof title === 'string' ? title.trim() : '';
  const issues: Array<{ code: string; message: string }> = [];
  const draft = /^(?:\[draft\]|draft\b|tbd\b|to be determined\b)/i.test(text);
  if (!text) issues.push({ code: 'empty', message: 'Supply the agreed audience topic, or visibly mark the planning title Draft/TBD while the topic is missing.' });
  if (draft) issues.push({ code: 'draft', message: 'Draft/TBD is allowed in planning. Agree a meaningful title before topic approval.' });
  const suggested = suggestedTitle(text, guests);
  if (text && !draft && text !== suggested) issues.push({ code: 'title_case', message: `Use Title Case: ${suggested}. Keep small words lowercase except first or after a colon; preserve names, acronyms and brands.` });
  const prefix = /^(?:podcast(?: conversation)?|conversation|interview|webinar|workshop) with\s+/i;
  const guestOnly = prefix.test(text) && (guests.length
    ? guests.some(guest => text.replace(prefix, '').toLowerCase() === guest.trim().toLowerCase())
    : /^podcast conversation with\s+/i.test(text) && !/\b(?:about|on)\b|[:—]/i.test(text.replace(prefix, '')));
  if (guestOnly || guests.some(guest => guest.trim().toLowerCase() === text.toLowerCase())) issues.push({ code: 'guest_only', message: 'A guest-only placeholder is not a topic. Record the missing subject and keep it Draft/TBD; do not invent a topic from the guest’s employer or role.' });
  if (text.toLowerCase() === 'databricks fde') issues.push({ code: 'breadth_review', message: 'Known narrow-topic example: Databricks FDE. Review the agreed broader topic Forward Deployed Engineering; do not infer other topics from employers.' });
  return { title: text, suggestedTitle: suggested, draft, issues, checklist: TITLE_CHECKLIST, reviewRequired: true,
    planningAllowed: true, message: 'Planning saves are allowed. Topic approval requires the checklist and a reviewed meaningful title. No title is changed automatically.' };
}
export function titleReviewError(title: string, review: TitleReview | undefined, guests: string[] = []): string | null {
  const check = checkTitle(title, guests);
  const errors = check.issues.filter(issue => issue.code !== 'breadth_review');
  if (errors.length) return errors.map(issue => issue.message).join(' ');
  if (!review || review.title !== title || !review.meaningful || !review.broad || !review.consistent) return 'Review this exact title with dataops event approve-title <card> --meaningful --broad --consistent --note "review evidence" --expected-version <version>. Check the agreed topic and every title copy first.';
  return null;
}
