/**
 * New-document scaffolds for the docs content API (ported from
 * `api_handler.py`). Extracted from `contentApi.ts`.
 */

export function newDocContent(title: string, docType: string, summary: string, scaffold: 'full' | 'minimal'): string {
  if (docType === 'sop' || docType === 'checklist') {
    return scaffold === 'minimal'
      ? minimalSopTemplate(title, docType, summary)
      : fullSopTemplate(title, docType, summary);
  }
  return `---
title: "${title}"
summary: "${summary}"
doc_type: ${docType}
tags: []
systems: []
related_docs: []
---

# ${title}

## Summary

## Content

`;
}

function fullSopTemplate(title: string, docType: string, summary: string): string {
  return `---
title: "${title}"
summary: "${summary}"
doc_type: ${docType}
schema_version: 1
tags: []
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

function minimalSopTemplate(title: string, docType: string, summary: string): string {
  return `---
title: "${title}"
summary: "${summary}"
doc_type: ${docType}
schema_version: 1
tags: []
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
