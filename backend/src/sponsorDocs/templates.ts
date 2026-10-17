export type SponsorDocTemplateKey =
  | 'newsletter-main'
  | 'newsletter-secondary'
  | 'newsletter-standalone'
  | 'podcast';

export interface SponsorDocFieldDefinition {
  key: string;
  label: string;
  type: 'text' | 'textarea';
  placeholder: string;
  helpText?: string;
  maxCharsHint?: number;
  maxWordsHint?: number;
  rows?: number;
}

export interface SponsorDocSectionDefinition {
  id: string;
  title: string;
  description?: string;
  fields: SponsorDocFieldDefinition[];
}

export interface SponsorDocTemplateDefinition {
  key: SponsorDocTemplateKey;
  label: string;
  shortLabel: string;
  defaultLinkType: string;
  intro: string;
  guidelinesUrl?: string;
  exampleText?: string;
  sections: SponsorDocSectionDefinition[];
}

export const SPONSOR_DOC_TEMPLATE_KEYS: readonly SponsorDocTemplateKey[] = [
  'newsletter-main',
  'newsletter-secondary',
  'newsletter-standalone',
  'podcast',
] as const;

const VISUAL_GUIDELINES_URL = 'https://drive.google.com/file/d/1M_jEzcb1IWJmolx9N7e08gfdbctjcLH2/view?usp=sharing';

export const SPONSOR_DOC_TEMPLATES: Record<SponsorDocTemplateKey, SponsorDocTemplateDefinition> = {
  'newsletter-main': {
    key: 'newsletter-main',
    label: 'Weekly Newsletter — Main Sponsor',
    shortLabel: 'Newsletter (Main)',
    defaultLinkType: 'Sponsorship document',
    intro: 'This document outlines the format for adding your main sponsored placement to the DataTalks.Club weekly newsletter. Fill in the fields below, save your progress anytime, and mark the document as Submitted / Ready when your copy is final.',
    guidelinesUrl: VISUAL_GUIDELINES_URL,
    sections: [
      {
        id: 'newsletter-placement',
        title: '1) Newsletter Placement',
        description: 'Main sponsored block at the top of the weekly newsletter, plus the email subject line and inbox preview text.',
        fields: [
          {
            key: 'subjectLine',
            label: 'Email Subject Line (≤ 65 characters)',
            type: 'text',
            placeholder: 'e.g. Build real-time data pipelines in minutes',
            helpText: 'Appears in the inbox as: [Your text] | DataTalks.Club Weekly',
            maxCharsHint: 65,
          },
          {
            key: 'previewText',
            label: 'Email Preview Text (≤ 140 characters)',
            type: 'text',
            placeholder: 'Short summary shown next to the subject line in the inbox',
            maxCharsHint: 140,
          },
          {
            key: 'title',
            label: 'Title (≤ 12 words)',
            type: 'text',
            placeholder: 'Headline for your sponsored section (up to 12 words)',
            maxWordsHint: 12,
          },
          {
            key: 'graphicsUrl',
            label: 'Graphics (Link to cloud storage or image URL)',
            type: 'text',
            placeholder: 'https://... (or note if sending the file by email)',
          },
          {
            key: 'intro',
            label: 'Intro (1–2 sentences)',
            type: 'textarea',
            rows: 3,
            placeholder: '1–2 sentences introducing the problem, product, or resource.',
          },
          {
            key: 'bullets',
            label: 'Bullet Points (3 bullets)',
            type: 'textarea',
            rows: 4,
            placeholder: '• Bullet point 1\n• Bullet point 2\n• Bullet point 3',
          },
          {
            key: 'closing',
            label: 'Closing (1 sentence with a call-to-action)',
            type: 'textarea',
            rows: 2,
            placeholder: 'Use the specific name of your company or product instead of the pronouns "us" or "our".',
          },
          {
            key: 'ctaText',
            label: 'CTA Button Text',
            type: 'text',
            placeholder: 'e.g. Start Building For Free / Download the Guide',
          },
          {
            key: 'ctaUrl',
            label: 'CTA Button Link',
            type: 'text',
            placeholder: 'https://... (include UTM parameters if needed)',
          },
        ],
      },
      {
        id: 'social-media',
        title: '2) Social Media Posts (Optional)',
        description: 'When the newsletter goes out, we also share your promotion on DataTalks.Club’s LinkedIn and X (Twitter) accounts. Customize the posts below or leave them blank if you would like us to draft them for you.',
        fields: [
          {
            key: 'linkedinPost',
            label: 'LinkedIn Post',
            type: 'textarea',
            rows: 5,
            placeholder: 'Place your LinkedIn post copy here (or leave blank for us to draft).',
          },
          {
            key: 'twitterPost',
            label: 'X (Twitter) Post (~249 characters)',
            type: 'textarea',
            rows: 5,
            placeholder: 'A short sentence.\n\n🔸 Bullet point 1\n🔸 Bullet point 2\n🔸 Bullet point 3\n\nCTA\n👉 [link]',
            helpText: 'You have ~249 characters for the text, including spaces and emojis for bullet points. The link is counted separately.',
            maxCharsHint: 249,
          },
        ],
      },
      {
        id: 'notes',
        title: '3) Notes for DataTalks.Club Team (Optional)',
        fields: [
          {
            key: 'sponsorNotes',
            label: 'Additional Notes or Questions',
            type: 'textarea',
            rows: 3,
            placeholder: 'Any special instructions, tracking links, or questions for our team.',
          },
        ],
      },
    ],
  },

  'newsletter-secondary': {
    key: 'newsletter-secondary',
    label: 'Weekly Newsletter — Secondary Sponsor',
    shortLabel: 'Newsletter (Secondary)',
    defaultLinkType: 'Sponsorship document',
    intro: 'This document outlines the format for adding your secondary sponsored placement to the DataTalks.Club weekly newsletter. Fill in the fields below, save your progress anytime, and mark the document as Submitted / Ready when your copy is final.',
    guidelinesUrl: VISUAL_GUIDELINES_URL,
    sections: [
      {
        id: 'newsletter-placement',
        title: '1) Newsletter Placement (Secondary Slot)',
        description: 'Sponsored placement in the weekly newsletter.',
        fields: [
          {
            key: 'title',
            label: 'Title (≤ 12 words)',
            type: 'text',
            placeholder: 'e.g. A Data Engineer’s Guide to AI Orchestration with Airflow',
            maxWordsHint: 12,
          },
          {
            key: 'graphicsUrl',
            label: 'Graphics (Optional — link to cloud storage or image URL)',
            type: 'text',
            placeholder: 'https://...',
          },
          {
            key: 'intro',
            label: 'Intro (1–2 sentences)',
            type: 'textarea',
            rows: 3,
            placeholder: '1–2 sentences introducing your guide, product, or event.',
          },
          {
            key: 'bullets',
            label: 'Bullet Points (3 bullets)',
            type: 'textarea',
            rows: 4,
            placeholder: '→ Key takeaway 1\n→ Key takeaway 2\n→ Key takeaway 3',
          },
          {
            key: 'closing',
            label: 'Closing (1 sentence with a call-to-action)',
            type: 'textarea',
            rows: 2,
            placeholder: 'Use the specific name of your company or product instead of the pronouns "us" or "our".',
          },
          {
            key: 'ctaText',
            label: 'CTA Button / Link Text',
            type: 'text',
            placeholder: 'e.g. Download now',
          },
          {
            key: 'ctaUrl',
            label: 'CTA Button Link',
            type: 'text',
            placeholder: 'https://... (include UTM parameters if needed)',
          },
        ],
      },
      {
        id: 'social-media',
        title: '2) Social Media Posts (Optional)',
        description: 'When the newsletter goes out, we also share your promotion on DataTalks.Club’s LinkedIn and X (Twitter) accounts. Customize the posts below or leave them blank if you would like us to draft them for you.',
        fields: [
          {
            key: 'linkedinPost',
            label: 'LinkedIn Post',
            type: 'textarea',
            rows: 5,
            placeholder: 'Place your LinkedIn post copy here (or leave blank for us to draft).',
          },
          {
            key: 'twitterPost',
            label: 'X (Twitter) Post (~249 characters)',
            type: 'textarea',
            rows: 5,
            placeholder: 'A short sentence.\n\n🔸 Bullet point 1\n🔸 Bullet point 2\n🔸 Bullet point 3\n\nCTA\n👉 [link]',
            maxCharsHint: 249,
          },
        ],
      },
      {
        id: 'notes',
        title: '3) Notes for DataTalks.Club Team (Optional)',
        fields: [
          {
            key: 'sponsorNotes',
            label: 'Additional Notes or Questions',
            type: 'textarea',
            rows: 3,
            placeholder: 'Any special instructions, tracking links, or questions for our team.',
          },
        ],
      },
    ],
  },

  'newsletter-standalone': {
    key: 'newsletter-standalone',
    label: 'Stand-Alone Newsletter Specs',
    shortLabel: 'Stand-Alone Newsletter',
    defaultLinkType: 'Sponsorship document',
    intro: 'This document outlines the structure for a dedicated stand-alone newsletter blast with DataTalks.Club, including an early CTA and a closing CTA plus social media posts.',
    guidelinesUrl: VISUAL_GUIDELINES_URL,
    sections: [
      {
        id: 'standalone-placement',
        title: '1) Stand-Alone Newsletter Copy',
        description: 'Dedicated email blast copy with opening intro, early CTA button, main body with 3–4 bulleted takeaways, and closing CTA button.',
        fields: [
          {
            key: 'subjectLine',
            label: 'Email Subject Line (≤ 65 characters)',
            type: 'text',
            placeholder: 'e.g. Build real-time data pipelines in minutes',
            maxCharsHint: 65,
          },
          {
            key: 'previewText',
            label: 'Email Preview Text (≤ 140 characters)',
            type: 'text',
            placeholder: 'e.g. Unify streaming + batch. Move data from any source to any destination.',
            maxCharsHint: 140,
          },
          {
            key: 'title',
            label: 'Title (≤ 12 words)',
            type: 'text',
            placeholder: 'e.g. Real-time ETL and ELT pipelines, purpose-built for modern data teams',
            maxWordsHint: 12,
          },
          {
            key: 'graphicsUrl',
            label: 'Graphics (Link to cloud storage or image URL)',
            type: 'text',
            placeholder: 'https://...',
          },
          {
            key: 'intro',
            label: 'Intro (2 sentences)',
            type: 'textarea',
            rows: 3,
            placeholder: '2 sentences framing the problem or tradeoff and how your solution removes it.',
          },
          {
            key: 'earlyCtaText',
            label: 'CTA Button — Early Placement (Text)',
            type: 'text',
            placeholder: 'e.g. Start Building For Free',
          },
          {
            key: 'earlyCtaUrl',
            label: 'CTA Button — Early Placement (Link)',
            type: 'text',
            placeholder: 'https://...',
          },
          {
            key: 'mainBodyOpening',
            label: 'Main Body — Opening (1–2 sentences)',
            type: 'textarea',
            rows: 3,
            placeholder: '1–2 sentences introducing the session, product, or key story before the bullet list.',
          },
          {
            key: 'bullets',
            label: 'Main Body — Bulleted List (3–4 bullets)',
            type: 'textarea',
            rows: 5,
            placeholder: '• Takeaway or highlight 1\n• Takeaway or highlight 2\n• Takeaway or highlight 3\n• Takeaway or highlight 4',
          },
          {
            key: 'closing',
            label: 'Closing (1–2 sentences)',
            type: 'textarea',
            rows: 2,
            placeholder: '1–2 closing sentences leading into the final CTA button.',
          },
          {
            key: 'closingCtaText',
            label: 'CTA Button — Closing Placement (Text)',
            type: 'text',
            placeholder: 'e.g. SIGN ME UP',
          },
          {
            key: 'closingCtaUrl',
            label: 'CTA Button — Closing Placement (Link)',
            type: 'text',
            placeholder: 'https://...',
          },
        ],
      },
      {
        id: 'social-media',
        title: '2) Social Media Posts (LinkedIn & X / Twitter)',
        description: 'As part of this blast promo, we will also publish posts on DataTalks.Club social media (LinkedIn and X/Twitter).',
        fields: [
          {
            key: 'linkedinPost',
            label: 'LinkedIn Post',
            type: 'textarea',
            rows: 5,
            placeholder: 'Structure:\n• Hook (problem or tradeoff): 1–2 short sentences\n• Value proposition (how sponsor solves it): 1 sentence\n• Bulleted takeaways (3–4 points)\n• Final CTA line + link',
          },
          {
            key: 'twitterPost',
            label: 'X (Twitter) Post (≤ 280 characters)',
            type: 'textarea',
            rows: 5,
            placeholder: 'Structure:\n• Short, punchy hook (≤ 280 characters total)\n• Value prop + event/resource info in one line\n• 2–3 bullet-style emojis for highlights\n• Link at the end',
            maxCharsHint: 280,
          },
        ],
      },
      {
        id: 'notes',
        title: '3) Notes for DataTalks.Club Team (Optional)',
        fields: [
          {
            key: 'sponsorNotes',
            label: 'Additional Notes or Questions',
            type: 'textarea',
            rows: 3,
            placeholder: 'Any special instructions or questions for our team.',
          },
        ],
      },
    ],
  },

  podcast: {
    key: 'podcast',
    label: 'Podcast — Materials from the Guest',
    shortLabel: 'Podcast',
    defaultLinkType: 'Sponsorship document',
    intro: 'These notes help us draft focused interview questions and an episode description for your DataTalks.Club podcast episode. Write in plain text — feel free to fill in as much or as little as you like.',
    sections: [
      {
        id: 'general-questions',
        title: '1) General Questions',
        description: 'Core context about you and what you would most enjoy discussing on the episode.',
        fields: [
          {
            key: 'guestName',
            label: 'Guest Name & Role / Company',
            type: 'text',
            placeholder: 'e.g. Jane Doe, VP of Data Engineering at Acme',
          },
          {
            key: 'introduction',
            label: 'How would you like us to introduce you? (Bio)',
            type: 'textarea',
            rows: 3,
            placeholder: 'Short bio and career background for the episode introduction.',
          },
          {
            key: 'currentFocus',
            label: 'What are you currently focused on — projects or themes you’d enjoy discussing?',
            type: 'textarea',
            rows: 3,
            placeholder: 'Projects, problems, or themes you are currently working on.',
          },
          {
            key: 'topicsToCover',
            label: 'Which topics are you most keen to cover?',
            type: 'textarea',
            rows: 4,
            placeholder: 'What 3–5 milestones, ideas, or topics should we cover, in order?',
          },
          {
            key: 'topicsToAvoid',
            label: 'Are there any topics you’d rather skip or avoid discussing publicly?',
            type: 'textarea',
            rows: 2,
            placeholder: 'Optional — anything off-limits.',
          },
        ],
      },
      {
        id: 'social-links',
        title: '2) Social Media & Profile Links',
        description: 'Links to include in the episode description and show notes.',
        fields: [
          {
            key: 'linkedinUrl',
            label: 'LinkedIn',
            type: 'text',
            placeholder: 'https://www.linkedin.com/in/...',
          },
          {
            key: 'twitterUrl',
            label: 'X (Twitter)',
            type: 'text',
            placeholder: 'https://x.com/...',
          },
          {
            key: 'githubUrl',
            label: 'GitHub',
            type: 'text',
            placeholder: 'https://github.com/...',
          },
          {
            key: 'websiteUrl',
            label: 'Website',
            type: 'text',
            placeholder: 'https://...',
          },
        ],
      },
      {
        id: 'detailed-questions',
        title: '3) Episode Story & Practical Takeaways (Optional Guide)',
        description: 'Use any of the prompts below that help structure your practical takeaways or personal story. We will craft the final description and questions from whatever you provide.',
        fields: [
          {
            key: 'hookAndPainPoint',
            label: 'Hook & Listener Pain Point',
            type: 'textarea',
            rows: 3,
            placeholder: 'What vivid fact, stat, problem, or provocative question will hook listeners in the first 10 seconds?',
          },
          {
            key: 'keyInsightsAndMilestones',
            label: 'Key Insights, Milestones & Career Story',
            type: 'textarea',
            rows: 4,
            placeholder: 'What key insight or skill will listeners gain? Which events, successes, or stumbles taught you the most?',
          },
          {
            key: 'actionableTakeaway',
            label: 'Actionable First Step & Recommended Books / Resources',
            type: 'textarea',
            rows: 3,
            placeholder: 'If listeners have 15 minutes, what first step should they take? Any books or resources you recommend?',
          },
        ],
      },
      {
        id: 'notes',
        title: '4) Additional Notes (Optional)',
        fields: [
          {
            key: 'sponsorNotes',
            label: 'Extra Context or Links',
            type: 'textarea',
            rows: 3,
            placeholder: 'Any extra anecdotes, links, or notes for Alexey and the DataTalks.Club team.',
          },
        ],
      },
    ],
  },
};

export function isSponsorDocTemplateKey(value: unknown): value is SponsorDocTemplateKey {
  return typeof value === 'string' && (SPONSOR_DOC_TEMPLATE_KEYS as readonly string[]).includes(value);
}

export function getSponsorDocTemplate(key: SponsorDocTemplateKey): SponsorDocTemplateDefinition {
  return SPONSOR_DOC_TEMPLATES[key];
}

export function defaultContentForTemplate(key: SponsorDocTemplateKey): Record<string, string> {
  const def = SPONSOR_DOC_TEMPLATES[key];
  const content: Record<string, string> = {};
  for (const section of def.sections) {
    for (const field of section.fields) {
      content[field.key] = '';
    }
  }
  return content;
}

export function sanitizeTemplateContent(
  key: SponsorDocTemplateKey,
  raw: Record<string, unknown>,
  existing?: Record<string, string>,
): Record<string, string> {
  const def = SPONSOR_DOC_TEMPLATES[key];
  const next: Record<string, string> = { ...(existing || defaultContentForTemplate(key)) };
  for (const section of def.sections) {
    for (const field of section.fields) {
      if (Object.hasOwn(raw, field.key)) {
        const val = raw[field.key];
        next[field.key] = val === null || val === undefined ? '' : String(val).slice(0, 20000);
      }
    }
  }
  return next;
}

export interface SponsorDocExportInput {
  id: string;
  title: string;
  template: SponsorDocTemplateKey;
  sponsorName?: string | null;
  publicationDate?: string | null;
  status: 'draft' | 'submitted';
  lastEditedAt: string;
  lastEditedBy: 'sponsor' | 'staff';
  content: Record<string, string>;
}

function valOrPlaceholder(value: string | undefined, placeholder = '_[Not provided]_'): string {
  const trimmed = (value || '').trim();
  return trimmed.length > 0 ? trimmed : placeholder;
}

/**
 * Render a clean, read-only Markdown export for building the newsletter or
 * preparing the podcast episode.
 */
export function renderSponsorDocMarkdownExport(doc: SponsorDocExportInput): string {
  const c = doc.content || {};
  const lines: string[] = [
    `# ${doc.title}`,
    '',
    `- **Template**: ${SPONSOR_DOC_TEMPLATES[doc.template].label}`,
    ...(doc.sponsorName ? [`- **Sponsor**: ${doc.sponsorName}`] : []),
    ...(doc.publicationDate ? [`- **Publication Date**: ${doc.publicationDate}`] : []),
    `- **Status**: ${doc.status === 'submitted' ? 'Submitted / Ready' : 'Draft'}`,
    `- **Last Edited**: ${doc.lastEditedAt} (${doc.lastEditedBy})`,
    '',
    '---',
    '',
  ];

  if (doc.template === 'newsletter-main') {
    lines.push(
      '## 1) Newsletter Placement',
      '',
      `**Email Subject Line:** ${valOrPlaceholder(c.subjectLine)} | DataTalks.Club Weekly`,
      `**Email Preview Text:** ${valOrPlaceholder(c.previewText)}`,
      '',
      `### ${valOrPlaceholder(c.title, '[Title]')}`,
      '',
      ...(c.graphicsUrl?.trim() ? [`**Graphics:** ${c.graphicsUrl.trim()}`, ''] : []),
      valOrPlaceholder(c.intro, '_[Intro]_'),
      '',
      valOrPlaceholder(c.bullets, '_[Bullet points]_'),
      '',
      valOrPlaceholder(c.closing, '_[Closing]_'),
      '',
      `**CTA:** [${valOrPlaceholder(c.ctaText, 'CTA Text')}](${valOrPlaceholder(c.ctaUrl, '#')})`,
      '',
      '---',
      '',
      '## 2) Social Media Posts',
      '',
      '### LinkedIn Post',
      '',
      valOrPlaceholder(c.linkedinPost),
      '',
      '### X (Twitter) Post',
      '',
      valOrPlaceholder(c.twitterPost),
    );
  } else if (doc.template === 'newsletter-secondary') {
    lines.push(
      '## 1) Newsletter Placement (Secondary Slot)',
      '',
      `### ${valOrPlaceholder(c.title, '[Title]')}`,
      '',
      ...(c.graphicsUrl?.trim() ? [`**Graphics:** ${c.graphicsUrl.trim()}`, ''] : []),
      valOrPlaceholder(c.intro, '_[Intro]_'),
      '',
      valOrPlaceholder(c.bullets, '_[Bullet points]_'),
      '',
      ...(c.closing?.trim() ? [c.closing.trim(), ''] : []),
      `**CTA:** [${valOrPlaceholder(c.ctaText, 'CTA Text')}](${valOrPlaceholder(c.ctaUrl, '#')})`,
      '',
      '---',
      '',
      '## 2) Social Media Posts',
      '',
      '### LinkedIn Post',
      '',
      valOrPlaceholder(c.linkedinPost),
      '',
      '### X (Twitter) Post',
      '',
      valOrPlaceholder(c.twitterPost),
    );
  } else if (doc.template === 'newsletter-standalone') {
    lines.push(
      '## 1) Stand-Alone Newsletter Placement',
      '',
      `**Email Subject Line:** ${valOrPlaceholder(c.subjectLine)}`,
      `**Email Preview Text:** ${valOrPlaceholder(c.previewText)}`,
      '',
      `### ${valOrPlaceholder(c.title, '[Title]')}`,
      '',
      ...(c.graphicsUrl?.trim() ? [`**Graphics:** ${c.graphicsUrl.trim()}`, ''] : []),
      valOrPlaceholder(c.intro, '_[Intro]_'),
      '',
      `**Early CTA:** [${valOrPlaceholder(c.earlyCtaText, 'CTA Text')}](${valOrPlaceholder(c.earlyCtaUrl, '#')})`,
      '',
      valOrPlaceholder(c.mainBodyOpening, '_[Main body opening]_'),
      '',
      valOrPlaceholder(c.bullets, '_[Bullet points]_'),
      '',
      valOrPlaceholder(c.closing, '_[Closing]_'),
      '',
      `**Closing CTA:** [${valOrPlaceholder(c.closingCtaText, 'CTA Text')}](${valOrPlaceholder(c.closingCtaUrl, '#')})`,
      '',
      '---',
      '',
      '## 2) Social Media Posts',
      '',
      '### LinkedIn Post',
      '',
      valOrPlaceholder(c.linkedinPost),
      '',
      '### X (Twitter) Post',
      '',
      valOrPlaceholder(c.twitterPost),
    );
  } else {
    lines.push(
      '## 1) Materials from the Guest',
      '',
      `**Guest:** ${valOrPlaceholder(c.guestName)}`,
      '',
      '### Introduction / Bio',
      valOrPlaceholder(c.introduction),
      '',
      '### Current Focus',
      valOrPlaceholder(c.currentFocus),
      '',
      '### Topics to Cover',
      valOrPlaceholder(c.topicsToCover),
      '',
      '### Topics to Avoid',
      valOrPlaceholder(c.topicsToAvoid, '_[None specified]_'),
      '',
      '## 2) Social Media & Links',
      `- **LinkedIn:** ${valOrPlaceholder(c.linkedinUrl)}`,
      `- **X (Twitter):** ${valOrPlaceholder(c.twitterUrl)}`,
      `- **GitHub:** ${valOrPlaceholder(c.githubUrl)}`,
      `- **Website:** ${valOrPlaceholder(c.websiteUrl)}`,
      '',
      '## 3) Episode Story & Practical Takeaways',
      '',
      '### Hook & Pain Point',
      valOrPlaceholder(c.hookAndPainPoint),
      '',
      '### Key Insights & Milestones',
      valOrPlaceholder(c.keyInsightsAndMilestones),
      '',
      '### Actionable First Step & Resources',
      valOrPlaceholder(c.actionableTakeaway),
    );
  }

  if (c.sponsorNotes?.trim()) {
    lines.push(
      '',
      '---',
      '',
      '## Notes from Sponsor / Guest',
      '',
      c.sponsorNotes.trim(),
    );
  }

  lines.push('');
  return lines.join('\n');
}

function computeCopyDeadline(publicationDate: string | null | undefined): string {
  if (!publicationDate || !/^\d{4}-\d{2}-\d{2}$/.test(publicationDate)) {
    return '<DEADLINE (10 days before publication)>';
  }
  const ms = Date.parse(`${publicationDate}T00:00:00Z`);
  if (Number.isNaN(ms)) return '<DEADLINE (10 days before publication)>';
  const deadline = new Date(ms - 10 * 24 * 60 * 60 * 1000);
  return deadline.toISOString().slice(0, 10);
}

export interface SponsorEmailDraft {
  subject: string;
  body: string;
}

export function renderSponsorEmailDraft(options: {
  template: SponsorDocTemplateKey;
  sponsorName?: string | null;
  publicationDate?: string | null;
  shareUrl: string;
  accessCode: string;
}): SponsorEmailDraft {
  const company = options.sponsorName?.trim() || '<COMPANY>';
  const pubDate = options.publicationDate?.trim() || '<PUBLICATION DATE>';
  const deadline = computeCopyDeadline(options.publicationDate);

  let subjectSuffix = 'DataTalks.Club Newsletter';
  if (options.template === 'newsletter-secondary') {
    subjectSuffix = 'DataTalks.Club Newsletter (Secondary Slot)';
  } else if (options.template === 'newsletter-standalone') {
    subjectSuffix = 'DataTalks.Club Newsletter (Stand-alone)';
  } else if (options.template === 'podcast') {
    subjectSuffix = 'DataTalks.Club Podcast';
  }

  const subject = `${company} + ${subjectSuffix} - ${pubDate}`;

  if (options.template === 'podcast') {
    const body = [
      'Hi <NAME>,',
      '',
      `Confirming your DataTalks.Club podcast episode scheduled for ${pubDate}.`,
      '',
      'We have created a preparation document in the DataOps portal where you can share your bio, links, and talking points:',
      '',
      options.shareUrl,
      `(Access code if prompted: ${options.accessCode})`,
      '',
      `Please fill in your notes and mark the document as Submitted by ${deadline} so we can prepare the interview questions and episode description.`,
      '',
      'Looking forward to the conversation!',
      '',
      'Thank you!',
    ].join('\n');
    return { subject, body };
  }

  const body = [
    'Hi <NAME>,',
    '',
    `Confirming ${company}'s sponsored slot in the DataTalks.Club newsletter scheduled for ${pubDate}.`,
    '',
    'We have created a sponsorship document in the DataOps portal for you to enter your copy:',
    '',
    options.shareUrl,
    `(Access code if prompted: ${options.accessCode})`,
    '',
    `You will find the format guidelines directly in the document and in our visual guide (${VISUAL_GUIDELINES_URL}).`,
    '',
    `To ensure we have enough time for review and any adjustments, please enter your copy and mark the document as Submitted by ${deadline}.`,
    '',
    'I have also cc’d Valeriia (valeriia@datatalks.club) who will review the document.',
    '',
    'Looking forward to receiving your materials!',
    '',
    'Thank you!',
  ].join('\n');

  return { subject, body };
}
