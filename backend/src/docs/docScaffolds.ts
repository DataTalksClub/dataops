/**
 * New-document scaffolds for the docs content API.
 *
 * Documents are plain markdown with YAML frontmatter.
 */

export function newDocContent(
  title: string,
  docType: string,
  summary: string,
  scaffold: 'full' | 'minimal',
  parent?: string,
): string {
  if (docType === 'template') {
    return `---\ntitle: ${JSON.stringify(title)}\nsummary: ${JSON.stringify(summary)}\ndoc_type: template\n---\n\n# ${title}\n\n## Template\n\n\`\`\`text\nWrite reusable copy here.\n\`\`\`\n`;
  }
  const parentLine = parent ? `parent: "${parent}"\n` : '';
  if (scaffold === 'minimal') {
    return `---
title: "${title}"
summary: "${summary}"
doc_type: ${docType}
${parentLine}tags: []
systems: []
related_docs: []
---

# ${title}

Write the document here.

`;
  }
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

${summary || ''}

## Content

## References

-
`;
}
