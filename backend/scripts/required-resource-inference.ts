/**
 * Keyword inference of a Task's required resources from its text.
 *
 * Used where no authored template step says what a Task requires: the Trello
 * importer and the one-off `requires` backfill. Rules prefer precision over
 * recall: a missed requirement only means the Task is offered to an agent that
 * will discover it lacks access, while a wrong one hides the Task from agents
 * that could do it. An authored template step always wins over inference.
 */
import { REQUIRED_RESOURCE_IDS } from '../src/resources/vocabulary';

const RULES: ReadonlyArray<readonly [string, RegExp]> = [
  ['youtube', /\byoutube\b|youtu\.be|\btime ?codes?\b|\bthumbnail|\blive ?stream|\bstream(ing)?\b|\bplaylist/],
  ['streamyard', /streamyard/],
  ['zoom', /\bzoom\b/],
  ['video-editor', /\bedit(ing|ed)? (the )?(video|recording)|\bvideo edit/],
  ['luma', /\bluma\b|lu\.ma/],
  ['meetup', /\bmeetup\b/],
  ['google-calendar', /\bcalendar\b|\bcalender\b/],
  ['calendly', /calendly/],
  ['gmail', /\bgmail\b|\b(send|reply|write|forward)\b[^.\n]{0,30}\be-?mail\b|\be-?mail (the |a |an )?(sponsor|guest|speaker|author|publisher|accountant|partner)s?\b/],
  ['mailchimp', /mailchimp|\bnewsletter (draft|edition|campaign)|\b(new|draft|schedule|send) (a |the )?newsletter|book of the week.{0,10}block|\bsubscribers?\b/],
  ['slack', /\bslack\b/],
  ['telegram', /\btelegram\b/],
  ['discord', /\bdiscord\b/],
  ['linkedin', /linkedin/],
  ['x', /twitter|\btweets?\b|\bx\.com\b|\bon x\b|\bx (post|thread)s?\b/],
  ['typefully', /typefully/],
  ['facebook', /facebook/],
  ['reddit', /\breddit\b/],
  ['hackernews', /hacker ?news|\bhn\b/],
  ['quora', /\bquora\b/],
  ['google-drive', /google drive|\bdrive\b/],
  ['google-docs', /google ?docs?\b|docs\.google\.com|\bgdoc|sponsorship doc(ument)?|placement doc/],
  ['google-sheets', /spreadsheet|google ?sheets?|\bsheet\b/],
  ['airtable', /airtable/],
  ['dropbox', /dropbox/],
  ['canva', /\bcanva\b/],
  ['figma', /figma/],
  ['spotify', /spotify|anchor\.fm|\banchor\b/],
  ['apple-podcasts', /apple podcasts?/],
  ['website', /website|github\.io|\bweb ?site\b|\b(podcast|event|events|book|speaker) page\b/],
  ['github', /\bgithub\b/],
  ['trello', /trello/],
  ['maven', /\bmaven\b/],
  ['finom', /\bfinom\b|\binvoices?\b/],
  ['revolut', /revolut/],
  ['wise', /\bwise\b/],
  ['accountant-portal', /accountant|steuerberater/],
];

for (const [id] of RULES) {
  if (!REQUIRED_RESOURCE_IDS.has(id)) throw new Error(`Inference rule for unknown resource '${id}'`);
}

/**
 * Normalise a Task description: drop the leading `[Checklist]` tag (it names
 * the whole checklist, e.g. "[YouTube video editing]", not this item) and
 * read links to the website repository as the website.
 */
function taskText(description: string): string {
  return description
    .replace(/^\s*\[[^\]]{1,60}\]\s*/, '')
    .toLowerCase()
    .replace(/https?:\/\/github\.com\/datatalksclub\/datatalksclub\.github\.io\S*/g, 'website')
    .replace(/datatalksclub\.github\.io/g, 'website');
}

/**
 * The area and tool segments of an instruction document id
 * (`sop.newsletter.mailchimp.<slug>` gives "newsletter mailchimp"). The slug
 * describes the whole procedure, so it is left out.
 */
function documentArea(instructionDocId: string): string {
  const parts = instructionDocId.toLowerCase().split('.');
  return parts.slice(1, -1).join(' ');
}

/** Resource ids a Task's description and instruction document point at. */
export function inferRequires(description?: string | null, instructionDocId?: string | null): string[] {
  const text = [
    description ? taskText(description) : '',
    instructionDocId ? documentArea(instructionDocId) : '',
  ].join('\n');
  if (!text.trim()) return [];
  return RULES.filter(([, pattern]) => pattern.test(text)).map(([id]) => id);
}
