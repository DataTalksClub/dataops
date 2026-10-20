/**
 * New-document scaffolds for the docs content API (ported from
 * `api_handler.py`). Extracted from `contentApi.ts`.
 */

export function newDocContent(
  title: string,
  docType: string,
  summary: string,
  scaffold: 'full' | 'minimal',
  parent?: string,
): string {
  if (docType === 'sop' || docType === 'checklist') {
    return scaffold === 'minimal'
      ? minimalSopTemplate(title, docType, summary, parent)
      : fullSopTemplate(title, docType, summary, parent);
  }
  if (docType === 'template') {
    return `---\ntitle: ${JSON.stringify(title)}\nsummary: ${JSON.stringify(summary)}\ndoc_type: template\n---\n\n# ${title}\n\n## Template\n\n\`\`\`text\nWrite reusable copy here.\n\`\`\`\n`;
  }
  if (docType === 'code-view') {
    return codeViewTemplate(title, summary, parent);
  }
  const parentLine = parent ? `parent: "${parent}"\n` : '';
  return `---
title: "${title}"
summary: "${summary}"
doc_type: ${docType}
${parentLine}tags: []
systems: []
related_docs: []
---

# ${title}

## Summary

## Content

`;
}

function fullSopTemplate(title: string, docType: string, summary: string, parent?: string): string {
  const parentLine = parent ? `parent: "${parent}"\n` : '';
  return `---
title: "${title}"
summary: "${summary}"
doc_type: ${docType}
schema_version: 1
${parentLine}tags: []
systems: []
related_docs: []
---

# ${title}

<!-- sop-section-start: summary -->
## Summary

- Purpose:
- Outcome:
- Trigger:
- Frequency:
<!-- sop-section-end -->

<!-- sop-section-start: prerequisites -->
## Prerequisites

- Access:
- Tools:
- Inputs:
<!-- sop-section-end -->

<!-- sop-section-start: procedure -->
## Procedure

<!-- sop-step-start id=1 -->
1.  Describe the first step.
<!-- sop-step-end -->

<!-- sop-section-end -->

<!-- sop-section-start: validation -->
## Validation

- How to confirm the work is done correctly.
<!-- sop-section-end -->

<!-- sop-section-start: troubleshooting -->
## Troubleshooting

- Common issue:
- Fix:
<!-- sop-section-end -->

<!-- sop-section-start: references -->
## References

-
<!-- sop-section-end -->
`;
}

function minimalSopTemplate(title: string, docType: string, summary: string, parent?: string): string {
  const parentLine = parent ? `parent: "${parent}"\n` : '';
  return `---
title: "${title}"
summary: "${summary}"
doc_type: ${docType}
schema_version: 1
${parentLine}tags: []
systems: []
related_docs: []
---

# ${title}

<!-- sop-section-start: summary -->
## Summary
<!-- sop-section-end -->

<!-- sop-section-start: prerequisites -->
## Prerequisites
<!-- sop-section-end -->

<!-- sop-section-start: procedure -->
## Procedure

<!-- sop-step-start id=1 -->
1.
<!-- sop-step-end -->

<!-- sop-section-end -->

<!-- sop-section-start: validation -->
## Validation
<!-- sop-section-end -->

<!-- sop-section-start: troubleshooting -->
## Troubleshooting
<!-- sop-section-end -->

<!-- sop-section-start: references -->
## References
<!-- sop-section-end -->
`;
}

function codeViewTemplate(title: string, summary: string, parent?: string): string {
  const parentLine = parent ? `parent: "${parent}\n"` : '';
  return `---
title: "${title}"
summary: "${summary}"
doc_type: code-view
schema_version: 1
sop: ""
${parentLine}tags: []
systems: []
related_docs: []
---

# ${title}

Code-only alternate view. Set \`sop:\` to the canonical SOP this codes, then
name every file block and keep them in running order. Files must be runnable
in sequence, start read-only/dry-run, and stop before browser-only or
human-only steps instead of claiming them.

\`\`\`bash file=run.sh
# Dry-run first: nothing below writes until DRY_RUN=0.
DRY_RUN="\${DRY_RUN:-1}"
echo "dry-run=\${DRY_RUN}"
\`\`\`
`;
}
