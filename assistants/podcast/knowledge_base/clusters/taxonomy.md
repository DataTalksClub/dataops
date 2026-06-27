# Podcast Taxonomy

This taxonomy is based on the current podcast document archive and is meant to guide search,
question brainstorming, and future guest intake.

## Recurring Episode Themes

- Career journeys and transitions
- AI engineering and production LLM systems
- Enterprise AI adoption
- Data engineering, MLOps, and infrastructure
- Applied ML in specific domains
- Learning, community, and public career-building
- Responsible, human-centered, and trustworthy AI

## Recurring Question Categories

- Background opener
- Career inflection points
- Current work and credibility
- Problem framing
- Technical deep dive
- Productionization
- Business and product impact
- Organizational reality
- Domain-specific constraints
- Advice and learning roadmap
- Future-looking questions

## Recommended Search Fields

- `source_path`
- `date`
- `status`
- `source_quality`
- `guest_name`
- `topic`
- `title`
- `subtitle`
- `bio`
- `links`
- `themes`
- `question_categories`
- `questions`
- `sections`
- `raw_text`

Question-bank fields:

- `episode_id`
- `guest_name`
- `topic`
- `question_text`
- `question_category`
- `question_order`
- `is_template_question`
- `source_path`

## Data Quality Caveats

- The corpus mixes templates, guest intake forms, host notes, event descriptions, and finalized question lists.
- Boilerplate appears in many documents, especially the opening background/resource questions.
- Some files are sparse or template-heavy, with `TODO`, `Topic`, `Title`, or blank social links.
- Dates and filenames are inconsistent. One source filename has `2024-14-10`, which is preserved as `date_raw`.
- Cancelled and template files are included but flagged through `status` and `source_quality`.
- Some guest names and spellings may need manual canonicalization.
- Word paragraph boundaries sometimes join question and answer text, so extraction is useful but not perfect.
