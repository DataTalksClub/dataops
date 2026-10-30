import { isOrdinaryRecordingDay } from '../podcast/recordingSlots';

export type SponsorDocTemplateKey =
  | 'newsletter-main'
  | 'newsletter-secondary'
  | 'newsletter-standalone'
  | 'webinar'
  | 'workshop'
  | 'podcast'
  | 'podcast-guest-research'
  | 'podcast-run-sheet'
  | 'podcast-episode-brief';

export interface SponsorDocFieldOption {
  value: string;
  label: string;
}

export interface SponsorDocFieldDefinition {
  key: string;
  label: string;
  type: 'text' | 'textarea' | 'bullets' | 'select' | 'radio';
  placeholder: string;
  required?: boolean;
  format?: 'url';
  helpText?: string;
  maxCharsHint?: number;
  maxWordsHint?: number;
  rows?: number;
  minItems?: number;
  maxItems?: number;
  bulletMarker?: string;
  allowVisualUpload?: boolean;
  suggestNewsletterUtm?: boolean;
  /** For type=select/radio: static choices. Podcast guest forms also get free-slot options hydrated at read time. */
  options?: SponsorDocFieldOption[];
}

export interface SponsorDocSectionDefinition {
  id: string;
  title: string;
  description?: string;
  /** Rendered as a collapsed <details> (open when it already has content). */
  collapsible?: boolean;
  /** Staff-only: never shown to, exported for, or writable by the speaker. */
  internal?: boolean;
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
  'webinar',
  'workshop',
  'podcast',
  'podcast-guest-research',
  'podcast-run-sheet',
  'podcast-episode-brief',
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
            placeholder: 'https://... (or upload your visual below)',
            allowVisualUpload: true,
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
            type: 'bullets',
            minItems: 3,
            maxItems: 5,
            bulletMarker: '•',
            placeholder: 'Bullet point',
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
            required: true,
            placeholder: 'e.g. Start Building For Free / Download the Guide',
          },
          {
            key: 'ctaUrl',
            label: 'CTA Button Link',
            type: 'text',
            required: true,
            format: 'url',
            suggestNewsletterUtm: true,
            placeholder: 'https://... (e.g. https://example.com?utm_source=datatalksclub-newsletter)',
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
            placeholder: 'https://... (or upload your visual below)',
            allowVisualUpload: true,
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
            type: 'bullets',
            minItems: 3,
            maxItems: 5,
            bulletMarker: '→',
            placeholder: 'Key takeaway',
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
            required: true,
            placeholder: 'e.g. Download now',
          },
          {
            key: 'ctaUrl',
            label: 'CTA Button Link',
            type: 'text',
            required: true,
            format: 'url',
            suggestNewsletterUtm: true,
            placeholder: 'https://... (e.g. https://example.com?utm_source=datatalksclub-newsletter)',
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
            placeholder: 'https://... (or upload your visual below)',
            allowVisualUpload: true,
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
            format: 'url',
            suggestNewsletterUtm: true,
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
            type: 'bullets',
            minItems: 3,
            maxItems: 6,
            bulletMarker: '•',
            placeholder: 'Takeaway or highlight',
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
            required: true,
            placeholder: 'e.g. SIGN ME UP',
          },
          {
            key: 'closingCtaUrl',
            label: 'CTA Button — Closing Placement (Link)',
            type: 'text',
            required: true,
            format: 'url',
            suggestNewsletterUtm: true,
            placeholder: 'https://... (e.g. https://example.com?utm_source=datatalksclub-newsletter)',
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

  webinar: {
    key: 'webinar',
    label: 'Webinar — Speaker Materials',
    shortLabel: 'Webinar',
    defaultLinkType: 'Speaker materials',
    intro: 'Share your talk materials so we can prepare the event description. Talk title, 3–4 outline bullets, and speaker bio are required to submit. Summary and links are optional. You can save a draft and return using the same link.',
    sections: [
      {
        id: 'talk',
        title: '1) Your Talk',
        fields: [
          { key: 'talkTitle', label: 'Talk title', type: 'text', required: true, placeholder: 'Title for the event description' },
          { key: 'summary', label: 'Subtitle / short summary (optional)', type: 'textarea', rows: 3, placeholder: 'A short introduction to your talk' },
          { key: 'outline', label: 'Outline (3–4 bullets)', type: 'bullets', required: true, minItems: 3, maxItems: 4, placeholder: 'Topic or takeaway' },
        ],
      },
      {
        id: 'speaker',
        title: '2) About You',
        fields: [
          { key: 'bio', label: 'Speaker bio', type: 'textarea', rows: 4, required: true, placeholder: 'How should we introduce you in the event description?' },
        ],
      },
      {
        id: 'links',
        title: '3) Links (optional)',
        description: 'Public profile links to include in the event description. Use a full link beginning with https:// or http://.',
        fields: [
          { key: 'linkedinUrl', label: 'LinkedIn', type: 'text', format: 'url', placeholder: 'https://www.linkedin.com/in/...' },
          { key: 'twitterUrl', label: 'X (Twitter)', type: 'text', format: 'url', placeholder: 'https://x.com/...' },
          { key: 'githubUrl', label: 'GitHub', type: 'text', format: 'url', placeholder: 'https://github.com/...' },
          { key: 'websiteUrl', label: 'Website', type: 'text', format: 'url', placeholder: 'https://...' },
        ],
      },
    ],
  },

  workshop: {
    key: 'workshop',
    label: 'Workshop — Speaker Materials',
    shortLabel: 'Workshop',
    defaultLinkType: 'Workshop document',
    intro: 'Share your workshop materials so we can prepare the event page. Workshop title, description, 3–6 outline bullets, and speaker bio are required to submit. Everything else is optional. You can save a draft and return using the same link.',
    sections: [
      {
        id: 'workshop',
        title: '1) Your Workshop',
        fields: [
          { key: 'talkTitle', label: 'Workshop title', type: 'text', required: true, placeholder: 'Title for the event page' },
          { key: 'summary', label: 'Subtitle (optional)', type: 'textarea', rows: 2, placeholder: 'One line under the title' },
          { key: 'dateTime', label: 'Date and time', type: 'text', placeholder: 'e.g. 2026-11-12, 17:00 CET', helpText: 'Pre-filled by the DataTalks.Club team; tell us in the notes below if it does not work.' },
          { key: 'description', label: 'Description', type: 'textarea', rows: 5, required: true, placeholder: 'What the workshop is about and who it is for' },
          { key: 'outline', label: 'Outline (3–6 bullets)', type: 'bullets', required: true, minItems: 3, maxItems: 6, placeholder: 'Step or topic' },
          { key: 'prerequisites', label: 'Prerequisites (optional)', type: 'textarea', rows: 3, placeholder: 'Skills, accounts, or software attendees should prepare' },
          { key: 'takeaway', label: 'What attendees take away (optional)', type: 'textarea', rows: 3, placeholder: 'What attendees will have built or learned by the end' },
        ],
      },
      {
        id: 'speaker',
        title: '2) About You',
        fields: [
          { key: 'bio', label: 'Speaker bio', type: 'textarea', rows: 4, required: true, placeholder: 'How should we introduce you on the event page?' },
        ],
      },
      {
        id: 'links',
        title: '3) Links (optional)',
        description: 'Public profile links to include on the event page. Use a full link beginning with https:// or http://.',
        fields: [
          { key: 'linkedinUrl', label: 'LinkedIn', type: 'text', format: 'url', placeholder: 'https://www.linkedin.com/in/...' },
          { key: 'twitterUrl', label: 'X (Twitter)', type: 'text', format: 'url', placeholder: 'https://x.com/...' },
          { key: 'githubUrl', label: 'GitHub', type: 'text', format: 'url', placeholder: 'https://github.com/...' },
          { key: 'websiteUrl', label: 'Website', type: 'text', format: 'url', placeholder: 'https://...' },
        ],
      },
      {
        id: 'notes',
        title: '4) Notes for the DataTalks.Club Team (optional)',
        fields: [
          { key: 'sponsorNotes', label: 'Notes or questions', type: 'textarea', rows: 3, placeholder: 'Anything we should know' },
        ],
      },
      {
        id: 'internal',
        title: '5) Internal — DataTalks.Club team only',
        description: 'Not visible to the speaker.',
        internal: true,
        fields: [
          { key: 'prepNotes', label: 'Prep notes', type: 'textarea', rows: 4, placeholder: 'Rehearsal, setup, materials, run of show' },
          { key: 'partnerQuestions', label: 'Questions for the partner', type: 'textarea', rows: 4, placeholder: 'Open questions to settle with the partner' },
        ],
      },
    ],
  },

  podcast: {
    key: 'podcast',
    label: 'Podcast — Materials from the Guest',
    shortLabel: 'Podcast',
    defaultLinkType: 'Guest materials',
    intro: 'Use this form to confirm or change the recording slot, share your bio, and (if we have not already agreed) the topics you would most enjoy covering. Share as much or as little as you like. Write in plain text.',
    sections: [
      {
        id: 'scheduling',
        title: '1) Recording Time',
        description: 'The invite proposes one recording time (Europe/Berlin podcast windows: midday 12:30–13:30, evening 17:00–18:00). Confirm it, pick another free slot, or reply to the invite email if none fit — do not invent times here.',
        fields: [
          {
            key: 'proposedSlotLabel',
            label: 'Proposed time from the invite',
            type: 'text',
            placeholder: 'Pre-filled by Orin (Europe/Berlin)',
            helpText: 'The single time proposed in your invite — confirm it below or pick another free slot.',
          },
          {
            key: 'slotChoice',
            label: 'Recording slot',
            type: 'radio',
            placeholder: 'Choose one',
            helpText: 'One choice only — each option is a full date and time. Free slots are Mon/Tue only.',
            options: [
              { value: 'confirm_proposed', label: 'Yes — the proposed time in the invite works for me' },
              { value: 'none_fit', label: 'None of these work — just reply to the invite email and we’ll find an alternative' },
            ],
          },
        ],
      },
      {
        id: 'who-you-are',
        title: '2) Who You Are',
        description: 'How to introduce you on the episode.',
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
        ],
      },
      {
        id: 'topics',
        title: '3) Topics',
        description: 'What you would most enjoy discussing on the episode.',
        fields: [
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
        title: '4) Social Media & Profile Links',
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
        title: '5) Episode Story & Practical Takeaways (Optional)',
        description: 'Only if you enjoy this format — pick any prompt that helps structure your takeaways or story. We will craft the final description and questions from whatever you provide.',
        collapsible: true,
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
        title: '6) Additional Notes (Optional)',
        collapsible: true,
        fields: [
          {
            key: 'sponsorNotes',
            label: 'Anything else for the DataTalks.Club team?',
            type: 'textarea',
            rows: 3,
            placeholder: 'Any extra anecdotes, links, or notes for Alexey and the DataTalks.Club team.',
          },
        ],
      },
    ],
  },

  'podcast-guest-research': {
    key: 'podcast-guest-research',
    label: 'Podcast — Guest Research (internal)',
    shortLabel: 'Guest Research',
    defaultLinkType: 'Guest research',
    intro: 'Internal source-backed research for a podcast guest. Staff-only: do not share this document with the guest. Keep guest-facing questions in the episode brief or guest materials doc.',
    sections: [
      {
        id: 'guest-identity',
        title: '1) Guest Identity',
        description: 'Who the guest is and why they are a good fit.',
        fields: [
          {
            key: 'guestName',
            label: 'Guest Name & Role / Company',
            type: 'text',
            placeholder: 'e.g. Jane Doe, VP of Data Engineering at Acme',
          },
          {
            key: 'bio',
            label: 'Bio (confirmed with sources)',
            type: 'textarea',
            rows: 3,
            placeholder: 'Short bio with source links where possible.',
          },
          {
            key: 'currentFocus',
            label: 'Current Focus',
            type: 'textarea',
            rows: 3,
            placeholder: 'Projects, problems, or themes the guest is working on now.',
          },
        ],
      },
      {
        id: 'links',
        title: '2) Profile & Source Links',
        description: 'Links for the episode brief and show notes, plus research sources.',
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
            label: 'Website / Blog',
            type: 'text',
            placeholder: 'https://...',
          },
          {
            key: 'sourceLinks',
            label: 'Research Sources (talks, posts, papers)',
            type: 'textarea',
            rows: 4,
            placeholder: 'One link per line, with a one-line note on what each source supports.',
          },
        ],
      },
      {
        id: 'research',
        title: '3) Research Findings',
        description: 'Source-backed findings the host can rely on during the interview.',
        fields: [
          {
            key: 'keyInsights',
            label: 'Key Insights & Milestones',
            type: 'textarea',
            rows: 4,
            placeholder: 'What should the host know? Career story, key results, stumbles, lessons.',
          },
          {
            key: 'openQuestions',
            label: 'Open Questions / Angles to Explore',
            type: 'textarea',
            rows: 4,
            placeholder: 'Candidate question angles, each tied to a source where possible.',
          },
          {
            key: 'topicsToAvoid',
            label: 'Topics to Avoid',
            type: 'textarea',
            rows: 2,
            placeholder: 'Anything off-limits or sensitive.',
          },
        ],
      },
      {
        id: 'internal',
        title: '4) Host-Only Notes (Internal)',
        fields: [
          {
            key: 'hostOnlyNotes',
            label: 'Host-Only Notes',
            type: 'textarea',
            rows: 3,
            placeholder: 'Uncertainty, source extracts, or review notes. Never paste into the guest-shared doc.',
          },
        ],
      },
    ],
  },

  'podcast-run-sheet': {
    key: 'podcast-run-sheet',
    label: 'Podcast — Host Run Sheet (internal)',
    shortLabel: 'Host Run Sheet',
    defaultLinkType: 'Host run sheet',
    intro: 'One-page live sheet for the host during recording. Staff-only: keep internal notes here, not in the guest-shared document.',
    sections: [
      {
        id: 'setup',
        title: '1) Setup',
        fields: [
          {
            key: 'episodeTitle',
            label: 'Episode Title (working)',
            type: 'text',
            placeholder: 'e.g. Shipping ML features without the platform team',
          },
          {
            key: 'guestName',
            label: 'Guest Name & Role / Company',
            type: 'text',
            placeholder: 'e.g. Jane Doe, VP of Data Engineering at Acme',
          },
          {
            key: 'recordingDate',
            label: 'Recording Date',
            type: 'text',
            placeholder: 'YYYY-MM-DD HH:MM (Europe/Berlin)',
          },
          {
            key: 'durationMinutes',
            label: 'Planned Duration (minutes)',
            type: 'text',
            placeholder: 'e.g. 45',
          },
        ],
      },
      {
        id: 'flow',
        title: '2) Live Flow',
        description: 'Read top to bottom during the recording.',
        fields: [
          {
            key: 'coldOpen',
            label: 'Cold Open (first 10 seconds)',
            type: 'textarea',
            rows: 2,
            placeholder: 'Hook: vivid fact, stat, problem, or provocative question.',
          },
          {
            key: 'introScript',
            label: 'Intro Script',
            type: 'textarea',
            rows: 3,
            placeholder: 'How to introduce the guest on air.',
          },
          {
            key: 'questionBlocks',
            label: 'Question Blocks (in order)',
            type: 'textarea',
            rows: 8,
            placeholder: 'Block 1 — ...\nBlock 2 — ...\nFollow-ups marked with →',
          },
          {
            key: 'closingScript',
            label: 'Closing Script',
            type: 'textarea',
            rows: 3,
            placeholder: 'Wrap-up, takeaway question, where to find the guest, outro.',
          },
        ],
      },
      {
        id: 'host-only',
        title: '3) Host-Only Notes (Internal)',
        fields: [
          {
            key: 'hostNotes',
            label: 'Host Notes & Follow-ups',
            type: 'textarea',
            rows: 4,
            placeholder: 'Timing cues, fallback questions, things to double-check live.',
          },
        ],
      },
    ],
  },

  'podcast-episode-brief': {
    key: 'podcast-episode-brief',
    label: 'Podcast — Episode Planning Brief',
    shortLabel: 'Episode Brief',
    defaultLinkType: 'Episode brief',
    intro: 'Planning brief for the episode: goal, audience, structure, and logistics. This replaces the Google Doc episode brief; guest-facing questions stay here or in the guest materials doc.',
    sections: [
      {
        id: 'overview',
        title: '1) Overview',
        fields: [
          {
            key: 'episodeTitle',
            label: 'Episode Title (working)',
            type: 'text',
            placeholder: 'e.g. Shipping ML features without the platform team',
          },
          {
            key: 'guestName',
            label: 'Guest Name & Role / Company',
            type: 'text',
            placeholder: 'e.g. Jane Doe, VP of Data Engineering at Acme',
          },
          {
            key: 'recordingDate',
            label: 'Recording Date',
            type: 'text',
            placeholder: 'YYYY-MM-DD HH:MM (Europe/Berlin)',
          },
          {
            key: 'goal',
            label: 'Episode Goal',
            type: 'textarea',
            rows: 3,
            placeholder: 'What should listeners be able to do or understand after this episode?',
          },
          {
            key: 'audience',
            label: 'Target Audience',
            type: 'text',
            placeholder: 'e.g. Data engineers running Airflow in production',
          },
        ],
      },
      {
        id: 'content',
        title: '2) Content Plan',
        fields: [
          {
            key: 'keyMessages',
            label: 'Key Messages / Takeaways',
            type: 'textarea',
            rows: 4,
            placeholder: '3–5 takeaways the episode must land.',
          },
          {
            key: 'structure',
            label: 'Episode Structure',
            type: 'textarea',
            rows: 5,
            placeholder: 'Segments in order, with rough timings.',
          },
          {
            key: 'guestBio',
            label: 'Guest Bio (for intro & show notes)',
            type: 'textarea',
            rows: 3,
            placeholder: 'Confirmed bio, pasted here once the guest provides it.',
          },
        ],
      },
      {
        id: 'logistics',
        title: '3) Logistics',
        fields: [
          {
            key: 'linksAssets',
            label: 'Links & Assets',
            type: 'textarea',
            rows: 3,
            placeholder: 'Schedule links, assets, and related research/run-sheet doc links.',
          },
          {
            key: 'nextSteps',
            label: 'Next Steps & Owners',
            type: 'textarea',
            rows: 3,
            placeholder: 'Who does what before recording.',
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

export interface PodcastFreeSlotOption {
  date: string;
  window: string;
  localTime: string;
  label?: string;
}

/**
 * Guest materials form: confirm proposed OR pick a free ordinary podcast slot
 * OR reply by email. Free slots are injected at read time (not emailed).
 * Each option is one radio: a full datetime window in a single human label
 * (never a raw `slot:DATE:window` value or a separate day/time choice).
 */
export const PODCAST_NONE_FIT_VALUE = 'none_fit';
export const PODCAST_CONFIRM_VALUE = 'confirm_proposed';
export const PODCAST_NONE_FIT_LABEL =
  'None of these work — just reply to the invite email and we’ll find an alternative';

/** Human slot label: `Mon 26 Oct · 12:30–13:30 Berlin`. */
export function formatGuestSlotLabel(date: string, window: string): string {
  const range = window === 'evening' ? '17:00–18:00' : '12:30–13:30';
  const parsed = new Date(`${date}T12:00:00Z`);
  const weekday = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Berlin', weekday: 'short' }).format(parsed);
  const dayMonth = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Berlin', day: 'numeric', month: 'short' }).format(parsed);
  return `${weekday} ${dayMonth} · ${range} Berlin`;
}

export function hydratePodcastGuestSlotOptions(
  template: SponsorDocTemplateDefinition,
  freeSlots: PodcastFreeSlotOption[],
  proposedSlotLabel?: string | null,
): SponsorDocTemplateDefinition {
  if (template.key !== 'podcast') return template;
  const proposed = (proposedSlotLabel || '').trim();
  const confirmLabel = proposed
    ? `Yes — ${proposed} works for me`
    : 'Yes — the proposed time in the invite works for me';
  // Ordinary free slots are Mon/Tue midday/evening only (shared filter with
  // nextRecordingSlots): never offer Wed–Fri free slots here, even if the
  // caller passes them. Filter before the cap so stale days can't crowd out
  // real Mon/Tue windows.
  const ordinary = freeSlots.filter(
    (slot) => (slot.window === 'midday' || slot.window === 'evening')
      && isOrdinaryRecordingDay(slot.date),
  );
  const slotOptions = [
    { value: PODCAST_CONFIRM_VALUE, label: confirmLabel },
    ...ordinary.slice(0, 8).map((slot) => ({
      value: `slot:${slot.date}:${slot.window}`,
      label: formatGuestSlotLabel(slot.date, slot.window),
    })),
    { value: PODCAST_NONE_FIT_VALUE, label: PODCAST_NONE_FIT_LABEL },
  ];
  return {
    ...template,
    sections: template.sections.map((section) => {
      if (section.id !== 'scheduling') return section;
      return {
        ...section,
        fields: section.fields.map((field) =>
          field.key === 'slotChoice' ? { ...field, options: slotOptions } : field,
        ),
      };
    }),
  };
}

/** Staff-readable rendering of a stored slotChoice (never a raw slot:… value). */
export function humanizePodcastSlotChoice(value: string | undefined, proposedLabel?: string): string {
  const raw = (value || '').trim();
  if (!raw) return '_[Not selected]_';
  if (raw === PODCAST_CONFIRM_VALUE) {
    const proposed = (proposedLabel || '').trim();
    return proposed ? `Confirmed — ${proposed}` : 'Confirmed the proposed time';
  }
  if (raw === PODCAST_NONE_FIT_VALUE) return 'None fit — guest will reply to the invite email';
  const slotMatch = /^slot:(\d{4}-\d{2}-\d{2}):(midday|evening)$/.exec(raw);
  if (slotMatch) return formatGuestSlotLabel(slotMatch[1], slotMatch[2]);
  return raw;
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
  options: { includeInternal?: boolean } = {},
): Record<string, string> {
  const def = SPONSOR_DOC_TEMPLATES[key];
  const next: Record<string, string> = { ...(existing || defaultContentForTemplate(key)) };
  for (const section of def.sections) {
    if (section.internal && options.includeInternal === false) continue;
    for (const field of section.fields) {
      if (Object.hasOwn(raw, field.key)) {
        const val = raw[field.key];
        const maxLen = field.key === 'graphicsUrl' || field.allowVisualUpload ? 300000 : 20000;
        next[field.key] = val === null || val === undefined ? '' : String(val).slice(0, maxLen);
      }
    }
  }
  return next;
}

/** The template and content a speaker sees: internal sections removed. */
export function speakerTemplateView(def: SponsorDocTemplateDefinition): SponsorDocTemplateDefinition {
  return { ...def, sections: def.sections.filter((section) => !section.internal) };
}

export function speakerContentView(key: SponsorDocTemplateKey, content: Record<string, string>): Record<string, string> {
  const internalKeys = new Set(SPONSOR_DOC_TEMPLATES[key].sections
    .filter((section) => section.internal)
    .flatMap((section) => section.fields.map((field) => field.key)));
  return Object.fromEntries(Object.entries(content || {}).filter(([k]) => !internalKeys.has(k)));
}

export class SponsorDocValidationError extends Error {
  constructor(public readonly fields: Record<string, string>) {
    super(Object.values(fields).join(' '));
  }
}

/** Drafts may be incomplete; ready documents must satisfy their template. */
export function validateSubmittedContent(key: SponsorDocTemplateKey, content: Record<string, string>): void {
  const errors: Record<string, string> = {};
  for (const field of getSponsorDocTemplate(key).sections.flatMap((section) => section.fields)) {
    const value = (content[field.key] || '').trim();
    if (field.required && !value) {
      errors[field.key] = `${field.label} is required.`;
    } else if (field.required && field.type === 'bullets') {
      const bullets = value.split(/\r?\n/).map((line) => line.replace(/^(?:[-*•→]|\d+[.)])\s*/, '').trim()).filter(Boolean);
      if (bullets.length < (field.minItems || 1) || bullets.length > (field.maxItems || Infinity)) {
        errors[field.key] = `${field.label} must contain ${field.minItems}–${field.maxItems} non-empty bullets.`;
      }
    }
    if (value && field.format === 'url') {
      try {
        const url = new URL(value);
        if (!['http:', 'https:'].includes(url.protocol) || !url.hostname) throw new Error();
      } catch {
        errors[field.key] = `${field.label} must be a full http:// or https:// link.`;
      }
    }
  }
  if (Object.keys(errors).length) throw new SponsorDocValidationError(errors);
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

function formatGraphicsExportLines(rawUrl: string | undefined): string[] {
  const trimmed = (rawUrl || '').trim();
  if (!trimmed) return [];
  if (/^data:image\//i.test(trimmed)) {
    return ['**Graphics:** [Uploaded visual image]', ''];
  }
  return [`**Graphics:** ${trimmed}`, ''];
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
    ...(doc.sponsorName ? [`- **${doc.template === 'webinar' || doc.template === 'workshop' ? 'Speaker' : doc.template === 'podcast' ? 'Guest' : 'Sponsor'}**: ${doc.sponsorName}`] : []),
    ...(doc.publicationDate ? [`- **Publication Date**: ${doc.publicationDate}`] : []),
    `- **Status**: ${doc.status === 'submitted' ? 'Submitted / Ready' : 'Draft'}`,
    `- **Last Edited**: ${doc.lastEditedAt} (${(doc.template === 'webinar' || doc.template === 'workshop') && doc.lastEditedBy === 'sponsor' ? 'speaker' : doc.lastEditedBy})`,
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
      ...formatGraphicsExportLines(c.graphicsUrl),
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
      ...formatGraphicsExportLines(c.graphicsUrl),
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
      ...formatGraphicsExportLines(c.graphicsUrl),
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
  } else if (doc.template === 'webinar') {
    lines.push(
      '## Talk title', '', valOrPlaceholder(c.talkTitle), '',
      '## Subtitle / short summary', '', valOrPlaceholder(c.summary), '',
      '## Outline', '', valOrPlaceholder(c.outline), '',
      '## Speaker bio', '', valOrPlaceholder(c.bio), '',
      '## Links for the event description', '',
      `- LinkedIn: ${valOrPlaceholder(c.linkedinUrl)}`,
      `- X (Twitter): ${valOrPlaceholder(c.twitterUrl)}`,
      `- GitHub: ${valOrPlaceholder(c.githubUrl)}`,
      `- Website: ${valOrPlaceholder(c.websiteUrl)}`,
    );
  } else if (doc.template === 'workshop') {
    lines.push(
      '## Workshop title', '', valOrPlaceholder(c.talkTitle), '',
      '## Subtitle', '', valOrPlaceholder(c.summary), '',
      '## Date and time', '', valOrPlaceholder(c.dateTime), '',
      '## Description', '', valOrPlaceholder(c.description), '',
      '## Outline', '', valOrPlaceholder(c.outline), '',
      '## Prerequisites', '', valOrPlaceholder(c.prerequisites), '',
      '## What attendees take away', '', valOrPlaceholder(c.takeaway), '',
      '## Speaker bio', '', valOrPlaceholder(c.bio), '',
      '## Links for the event page', '',
      `- LinkedIn: ${valOrPlaceholder(c.linkedinUrl)}`,
      `- X (Twitter): ${valOrPlaceholder(c.twitterUrl)}`,
      `- GitHub: ${valOrPlaceholder(c.githubUrl)}`,
      `- Website: ${valOrPlaceholder(c.websiteUrl)}`,
    );
    if (Object.hasOwn(c, 'prepNotes') || Object.hasOwn(c, 'partnerQuestions')) {
      lines.push(
        '', '## Internal — prep notes', '', valOrPlaceholder(c.prepNotes), '',
        '## Internal — questions for the partner', '', valOrPlaceholder(c.partnerQuestions),
      );
    }
  } else if (doc.template === 'podcast') {
    lines.push(
      '## 1) Recording Slot',
      '',
      `**Proposed time:** ${valOrPlaceholder(c.proposedSlotLabel, '_[Not set]_')}`,
      '',
      `**Choice:** ${humanizePodcastSlotChoice(c.slotChoice, c.proposedSlotLabel)}`,
      '',
      '## 2) Guest',
      '',
      `**Guest:** ${valOrPlaceholder(c.guestName)}`,
      '',
      '### Introduction / Bio',
      valOrPlaceholder(c.introduction),
      '',
      '## 3) Topics',
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
      '## 4) Social Media & Links',
      `- **LinkedIn:** ${valOrPlaceholder(c.linkedinUrl)}`,
      `- **X (Twitter):** ${valOrPlaceholder(c.twitterUrl)}`,
      `- **GitHub:** ${valOrPlaceholder(c.githubUrl)}`,
      `- **Website:** ${valOrPlaceholder(c.websiteUrl)}`,
      '',
      '## 5) Episode Story & Practical Takeaways',
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
  } else if (doc.template === 'podcast-guest-research') {
    lines.push(
      '## 1) Guest Identity',
      '',
      `**Guest:** ${valOrPlaceholder(c.guestName)}`,
      '',
      '### Bio',
      valOrPlaceholder(c.bio),
      '',
      '### Current Focus',
      valOrPlaceholder(c.currentFocus),
      '',
      '## 2) Profile & Source Links',
      `- **LinkedIn:** ${valOrPlaceholder(c.linkedinUrl)}`,
      `- **X (Twitter):** ${valOrPlaceholder(c.twitterUrl)}`,
      `- **GitHub:** ${valOrPlaceholder(c.githubUrl)}`,
      `- **Website:** ${valOrPlaceholder(c.websiteUrl)}`,
      '',
      '### Research Sources',
      valOrPlaceholder(c.sourceLinks),
      '',
      '## 3) Research Findings',
      '',
      '### Key Insights & Milestones',
      valOrPlaceholder(c.keyInsights),
      '',
      '### Open Questions / Angles',
      valOrPlaceholder(c.openQuestions),
      '',
      '### Topics to Avoid',
      valOrPlaceholder(c.topicsToAvoid, '_[None specified]_'),
      '',
      '## 4) Host-Only Notes (Internal)',
      valOrPlaceholder(c.hostOnlyNotes),
    );
  } else if (doc.template === 'podcast-run-sheet') {
    lines.push(
      `**Guest:** ${valOrPlaceholder(c.guestName)}`,
      `**Recording:** ${valOrPlaceholder(c.recordingDate)} (${valOrPlaceholder(c.durationMinutes, '_[duration]_')} min)`,
      '',
      '## Cold Open',
      valOrPlaceholder(c.coldOpen),
      '',
      '## Intro Script',
      valOrPlaceholder(c.introScript),
      '',
      '## Question Blocks',
      valOrPlaceholder(c.questionBlocks),
      '',
      '## Closing Script',
      valOrPlaceholder(c.closingScript),
      '',
      '## Host Notes (Internal)',
      valOrPlaceholder(c.hostNotes),
    );
  } else {
    lines.push(
      `**Guest:** ${valOrPlaceholder(c.guestName)}`,
      `**Recording:** ${valOrPlaceholder(c.recordingDate)}`,
      '',
      '## Goal',
      valOrPlaceholder(c.goal),
      '',
      '## Target Audience',
      valOrPlaceholder(c.audience),
      '',
      '## Key Messages / Takeaways',
      valOrPlaceholder(c.keyMessages),
      '',
      '## Episode Structure',
      valOrPlaceholder(c.structure),
      '',
      '## Guest Bio',
      valOrPlaceholder(c.guestBio),
      '',
      '## Links & Assets',
      valOrPlaceholder(c.linksAssets),
      '',
      '## Next Steps & Owners',
      valOrPlaceholder(c.nextSteps),
    );
  }

  if (c.sponsorNotes?.trim()) {
    const notesHeading = doc.template === 'podcast' ? '## Notes from the Guest'
      : doc.template === 'workshop' ? '## Notes from the Speaker' : '## Notes from Sponsor';
    lines.push(
      '',
      '---',
      '',
      notesHeading,
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
  recipientName?: string | null;
}): SponsorEmailDraft {
  const recipientGreeting = options.recipientName?.trim()
    ? `Hi ${options.recipientName.trim()},`
    : 'Hi,';
  const namedGreeting = options.recipientName?.trim()
    ? `Hi ${options.recipientName.trim()},`
    : 'Hi <NAME>,';
  if (options.template === 'webinar') {
    return {
      subject: 'Your DataTalks.Club webinar speaker materials',
      body: [
        recipientGreeting, '',
        'Please share your talk materials for your DataTalks.Club webinar using this form:', '',
        options.shareUrl,
        `(Access code if prompted: ${options.accessCode})`, '',
        'Add your talk title, 3–4 outline bullets, and speaker bio. A subtitle or short summary and profile links are optional.',
        'You can save a draft and return using the same link. When ready, mark it as Submitted / Ready so we can prepare the event description.', '',
        'Thank you!',
      ].join('\n'),
    };
  }
  if (options.template === 'workshop') {
    return {
      subject: 'Your DataTalks.Club workshop materials',
      body: [
        recipientGreeting, '',
        'Please share the materials for your DataTalks.Club workshop using this form:', '',
        options.shareUrl,
        `(Access code if prompted: ${options.accessCode})`, '',
        'Add the workshop title, description, 3–6 outline bullets, and your bio. Subtitle, prerequisites, takeaways, and profile links are optional.',
        'You can save a draft and return using the same link. When ready, mark it as Submitted / Ready so we can prepare the event page.', '',
        'Thank you!',
      ].join('\n'),
    };
  }
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
  } else if (options.template === 'podcast-guest-research') {
    subjectSuffix = 'DataTalks.Club Podcast (Guest Research)';
  } else if (options.template === 'podcast-run-sheet') {
    subjectSuffix = 'DataTalks.Club Podcast (Host Run Sheet)';
  } else if (options.template === 'podcast-episode-brief') {
    subjectSuffix = 'DataTalks.Club Podcast (Episode Brief)';
  }

  const subject = `${company} + ${subjectSuffix} - ${pubDate}`;

  if (options.template === 'podcast') {
    const body = [
      namedGreeting,
      '',
      `Confirming your DataTalks.Club podcast episode scheduled for ${pubDate}.`,
      '',
      'We have created a preparation document in the DataOps portal where you can share your bio, links, and talking points:',
      '',
      options.shareUrl,
      `(Access code if prompted: ${options.accessCode})`,
      '',
      `Please fill in your notes and mark the document as Submitted by ${deadline} so we can prepare the interview questions and episode description. Use the form to confirm or change the recording slot, share your bio, and topics — do not invent alternate times in email.`,
      '',
      'Looking forward to the conversation!',
      '',
      'Thank you!',
    ].join('\n');
    return { subject, body };
  }

  if (
    options.template === 'podcast-guest-research'
    || options.template === 'podcast-run-sheet'
    || options.template === 'podcast-episode-brief'
  ) {
    const body = [
      'Hi team,',
      '',
      `Internal podcast prep document (${options.template}) for ${company} — ${pubDate}:`,
      '',
      options.shareUrl,
      `(Access code if prompted: ${options.accessCode})`,
      '',
      'This is a staff-only working document in the DataOps portal. Please keep host-only notes here, not in the guest-shared document.',
      '',
      'Thank you!',
    ].join('\n');
    return { subject, body };
  }

  const body = [
    namedGreeting,
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
