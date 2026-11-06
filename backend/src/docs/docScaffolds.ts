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
${parentLine}tags: []
systems: []
related_docs: []
---

# ${title}

## Summary

- Purpose:
- Outcome:
- Trigger:
- Frequency:

## Prerequisites

- Access:
- Tools:
- Inputs:

## Procedure

1. Describe the first step.
2. Describe the second step.

## Validation

- How to confirm the work is done correctly.

## Troubleshooting

- Common issue:
- Fix:

## References

-
`;
}

function minimalSopTemplate(title: string, docType: string, summary: string, parent?: string): string {
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

## Prerequisites

## Procedure

1. Describe the first step.

## Validation

## Troubleshooting

## References
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
