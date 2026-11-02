import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import type { Template } from '../src/types';
import {
  DOCUMENT_INDEX_PATH,
  regenerateDerivedDocuments,
} from '../src/docs/derivedDocuments';

const SOP = (id: string, title: string, status: string, businessSystem = 'manage-event-calendar') => [
  '---',
  `id: ${id}`,
  `title: ${title}`,
  'doc_type: sop',
  'department: 03-programs-and-community',
  `business_system: ${businessSystem}`,
  'owner_role: event-operations-owner',
  `status: ${status}`,
  '---',
  '',
  `# ${title}`,
  '',
].join('\n');

const INDEX = [
  '---',
  'id: reference.indexes.document-index',
  'title: Document index',
  'doc_type: reference',
  'status: active',
  '---',
  '',
  '# Document Index',
  '',
  'stale',
].join('\n');

const GENERATED_SYSTEM = [
  '---',
  'id: system.programs-and-community.manage-event-calendar',
  'title: Manage the event calendar',
  'doc_type: system-overview',
  'department: 03-programs-and-community',
  'business_system: manage-event-calendar',
  'related_docs: []',
  'status: proposed',
  '---',
  '',
  '# Manage the event calendar',
  '',
  '<!-- This system page is seeded from the audit register. Enrich it after an owner validates a real run. -->',
  '',
  '## Supporting documents',
  '',
  '- stale entry',
  '',
  '## Controls and evidence',
  '',
  '- Keep a record.',
].join('\n');

const MAVEN_VIEW = [
  '---',
  'id: task-template.tasks.maven-ll',
  'title: Maven Lightning Lesson Workflow View',
  'doc_type: task-template',
  'status: active',
  'tags: [task-template, maven-ll]',
  '---',
  '',
  '# stale view',
].join('\n');

const template = {
  id: 'template-maven-ll',
  type: 'maven-ll',
  name: 'Maven Lightning Lesson',
  version: 17,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-11-01T00:00:00.000Z',
  origin: 'git',
  pinned: true,
  department: '03-programs-and-community',
  businessSystem: 'manage-event-calendar',
  ownerRole: 'event-operations-owner',
  status: 'active',
  sourceDocIds: ['sop.events.calendar.current-process'],
  taskDefinitions: [{
    refId: 'publish-lesson',
    description: 'Publish the lesson',
    offsetDays: 0,
    instructionDocId: 'sop.events.calendar.current-process',
    ownerRole: 'event-operations-owner',
  }],
} as unknown as Template;

describe('derived knowledge documents', () => {
  it('rebuilds the document index and generated system lists from current frontmatter', () => {
    const files = new Map([
      [DOCUMENT_INDEX_PATH, INDEX],
      ['content/03-programs-and-community/manage-event-calendar/system-overview.md', GENERATED_SYSTEM],
      ['content/03-programs-and-community/manage-event-calendar/sops/current.md', SOP('sop.events.calendar.current-process', 'Current calendar process', 'active')],
      ['content/03-programs-and-community/manage-event-calendar/sops/retired-a.md', SOP('sop.events.calendar.adding-events-to-course-calendars', 'Retired calendar procedure', 'deprecated')],
      ['content/05-education-operations/manage-course-calendars-and-homework/sops/retired-b.md', SOP('sop.courses.calendars.creating-a-calendar-in-the-course', 'Retired course calendar procedure', 'deprecated', 'manage-course-calendars-and-homework')],
    ]);

    const output = regenerateDerivedDocuments(files, [], { all: true });
    const index = output.get(DOCUMENT_INDEX_PATH) || '';
    const system = output.get('content/03-programs-and-community/manage-event-calendar/system-overview.md') || '';
    assert.match(index, /## Archived and deprecated documents[\s\S]*`deprecated`/);
    assert.match(index, /sop\.events\.calendar\.adding-events-to-course-calendars/);
    assert.match(index, /sop\.courses\.calendars\.creating-a-calendar-in-the-course/);
    assert.doesNotMatch(index.split('## Archived and deprecated documents')[0], /sop\.events\.calendar\.adding-events-to-course-calendars/);
    assert.match(system, /\[Current calendar process\]/);
    assert.doesNotMatch(system, /Retired calendar procedure/);
  });

  it('renders task-template pages from the current pinned Template version and instruction IDs', () => {
    const files = new Map([
      [DOCUMENT_INDEX_PATH, INDEX],
      ['content/00-start-here/workflow-catalog/reference/maven-lightning-lesson-workflow.md', MAVEN_VIEW],
      ['content/05-education-operations/process.md', SOP('sop.events.calendar.current-process', 'Current calendar process', 'active')],
    ]);
    const output = regenerateDerivedDocuments(files, [template], { all: true });
    const view = output.get('content/00-start-here/workflow-catalog/reference/maven-lightning-lesson-workflow.md') || '';
    assert.match(view, /Template version: `17`/);
    assert.match(view, /sop\.events\.calendar\.current-process/);
    assert.doesNotMatch(view, /stale view/);
  });

  it('regenerates one selected document ID without rewriting unrelated generated pages', () => {
    const files = new Map([
      [DOCUMENT_INDEX_PATH, INDEX],
      ['content/00-start-here/workflow-catalog/reference/maven-lightning-lesson-workflow.md', MAVEN_VIEW],
    ]);
    const output = regenerateDerivedDocuments(files, [template], { id: 'task-template.tasks.maven-ll' });
    assert.deepEqual([...output.keys()], ['content/00-start-here/workflow-catalog/reference/maven-lightning-lesson-workflow.md']);
  });

  it('keeps null and integer frontmatter scalars typed when rewriting generated pages', () => {
    const typedIndex = INDEX.replace('status: active\n', 'status: active\nschema_version: 1\nreview_cycle_days: 90\nlast_reviewed_at: null\n');
    const files = new Map([[DOCUMENT_INDEX_PATH, typedIndex]]);
    const index = regenerateDerivedDocuments(files, [], { all: true }).get(DOCUMENT_INDEX_PATH) || '';
    assert.match(index, /^schema_version: 1$/m);
    assert.match(index, /^review_cycle_days: 90$/m);
    assert.match(index, /^last_reviewed_at: null$/m);
    assert.doesNotMatch(index, /'null'|'1'|'90'/);
    const again = regenerateDerivedDocuments(new Map([[DOCUMENT_INDEX_PATH, index]]), [], { all: true }).get(DOCUMENT_INDEX_PATH);
    assert.equal(again, index);
  });

  it('repairs stringified scalars already stored in prod', () => {
    const stringified = INDEX.replace('status: active\n', "status: active\nschema_version: '1'\nreview_cycle_days: '90'\nlast_reviewed_at: 'null'\n");
    const index = regenerateDerivedDocuments(new Map([[DOCUMENT_INDEX_PATH, stringified]]), [], { all: true }).get(DOCUMENT_INDEX_PATH) || '';
    assert.match(index, /^schema_version: 1$/m);
    assert.match(index, /^review_cycle_days: 90$/m);
    assert.match(index, /^last_reviewed_at: null$/m);
  });
});
