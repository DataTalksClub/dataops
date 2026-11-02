import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { KnowledgeStore } from '../../src/docs/knowledgeStore';
import { EVENT_RESCHEDULE_CHECKLIST_ID } from '../../src/taskChecklist';

export function createTaskChecklistFixture() {
  const cacheDir = mkdtempSync(join(tmpdir(), 'dataops-task-checklist-'));
  const contentDir = join(cacheDir, 'content');
  mkdirSync(join(contentDir, 'checklists'), { recursive: true });
  mkdirSync(join(contentDir, 'sops'), { recursive: true });
  writeFileSync(join(contentDir, 'checklists', 'rescheduling.md'), `---\nid: ${EVENT_RESCHEDULE_CHECKLIST_ID}\ndoc_type: checklist\ntitle: Event rescheduling checklist\n---\n<!-- sop-section-start: procedure -->\n## Procedure\n\n<!-- sop-step-start id=1 -->\n1. Review the updated event details with [the review guide](../sops/review-event-details.md#step-2).\n<!-- sop-step-end -->\n\n<!-- sop-step-start id=2 -->\n2. Notify participants with [[doc:sop.test.notify-participants|the notification guide]].\n<!-- sop-step-end -->\n<!-- sop-section-end -->\n`);
  writeFileSync(join(contentDir, 'sops', 'review-event-details.md'), `---\nid: sop.test.review-event-details\ndoc_type: sop\ntitle: Review event details\n---\n# Review event details\n`);
  writeFileSync(join(contentDir, 'sops', 'notify-participants.md'), `---\nid: sop.test.notify-participants\ndoc_type: sop\ntitle: Notify participants\n---\n# Notify participants\n`);

  return {
    store: new KnowledgeStore({ offline: true, cacheDir }),
    cleanup() {
      rmSync(cacheDir, { recursive: true, force: true });
    },
  };
}
