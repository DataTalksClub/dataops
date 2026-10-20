import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseTemplatePlaceholders, isTemplateDocument } from '../src/template-placeholders.js';
const doc = (body, rows = '| `<NAME>` | Recipient name | Alex |') => `## Template\n\n\`\`\`text\n${body}\n\`\`\`\n\n## Placeholders\n\n| Placeholder | What to put there | Example |\n| --- | --- | --- |\n${rows}\n`;
test('extracts fenced copy and strict definitions with bracketed names', () => {
  assert.deepEqual(parseTemplatePlaceholders(doc('Hello <NAME>')), { body: 'Hello <NAME>', placeholders: [{name:'<NAME>',description:'Recipient name',example:'Alex'}], issues:[] });
});
test('body boundaries exclude how-to and sent examples; headings inside fence are body', () => {
  const result = parseTemplatePlaceholders(doc('## Subject\nHello <NAME>') + '## How to send\nUse <OTHER>\n```text\nSent <SENT>\n```');
  assert.equal(result.body, '## Subject\nHello <NAME>'); assert.deepEqual(result.issues, []);
});
test('reports missing, unused, duplicate, malformed and empty definitions', () => {
  assert.ok(parseTemplatePlaceholders(doc('<OTHER>')).issues.some(i=>i.code==='missing-explanation'));
  assert.ok(parseTemplatePlaceholders(doc('Hello')).issues.some(i=>i.code==='unused-explanation'));
  assert.ok(parseTemplatePlaceholders(doc('<NAME>', '| <NAME> | Name | Alex |\n| <NAME> | Name | Bea |')).issues.some(i=>i.code==='duplicate-name'));
  for (const row of ['| <NAME> | | Alex |','| NAME | Name | Alex |','| <NAME> | Name |']) assert.ok(parseTemplatePlaceholders(doc('<NAME>', row)).issues.some(i=>i.code==='malformed-row'));
  assert.ok(parseTemplatePlaceholders(doc('Hello','')).issues.some(i=>i.code==='empty-table'));
  assert.ok(parseTemplatePlaceholders(doc('<NAME>').replace('What to put there','Description')).issues.some(i=>i.code==='malformed-table'));
});
test('ignores HTML, autolinks and comparisons, accepts literal templates without a table', () => {
  assert.deepEqual(parseTemplatePlaceholders('## Template\n~~~\n<DIV>Hi</DIV> <br> <https://example.invalid> <a@example.invalid> x < y > z < 3\n~~~').issues, []);
  assert.equal(parseTemplatePlaceholders('## Template\nUnfenced <NAME>').body, null);
  assert.ok(parseTemplatePlaceholders('## Template\n```\n<NAME>').issues.some(i=>i.code==='unclosed-body'));
});
test('identifies by type, id, path or frontmatter but leaves SOPs alone', () => {
  for (const metadata of [{doc_type:'template'},{id:'template.example'},{path:'content/example/templates/mail.md'}]) assert.equal(isTemplateDocument('',metadata),true);
  assert.equal(isTemplateDocument('---\ndoc_type: template\n---\n'),true);
  assert.equal(isTemplateDocument('## Template\n```\n<NAME>\n```',{doc_type:'sop'}),false);
});
