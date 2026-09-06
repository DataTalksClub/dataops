import assert from 'node:assert/strict';
import yaml from 'js-yaml';

import { ContentsApiGithubStore } from '../../src/docs/githubStore';
import type { AuthoredTemplateFile } from '../../src/templates/authoredTemplates';

/** Public-safe definitions invented for mapper and deployment regression tests. */
export function syntheticAuthoredTemplate(type = 'synthetic-workflow') {
  return {
    id: `workflow.${type}`, schema_version: 2, type, name: `Synthetic ${type}`,
    department: 'synthetic-department', business_system: 'synthetic-system',
    owner_role: 'synthetic-owner', status: 'draft', criticality: 'supporting',
    outcome: 'A synthetic result is checked', tools: ['synthetic-editor', 'synthetic-checker'],
    review_cycle_days: 30, last_reviewed_at: null, next_review_at: '2030-06-15',
    emoji: '', tags: [], default_assignee_id: 'synthetic-user', source_document_ids: [],
    external_source_documents: [{
      id: 'synthetic.source', location: 'https://example.invalid/synthetic-source',
      kind: 'external-process', status: 'provenance-only', note: 'Synthetic reference only',
    }],
    trigger: { mode: 'automatic', schedule: '0 9 * * 1', lead_days: 0, enabled: false },
    references: [], card_links: [{ name: 'Synthetic result' }],
    phases: [{
      id: 'prepare', name: 'Prepare', stage: 'preparation',
      entry_criteria: ['Synthetic input exists', 'Synthetic check is available'],
      exit_criteria: ['Synthetic result is checked'], allowed_next_phase_ids: ['finish'],
    }, {
      id: 'finish', name: 'Finish', stage: 'done',
      entry_criteria: ['Synthetic check is complete'], exit_criteria: ['Synthetic result is filed'],
      allowed_next_phase_ids: [],
    }],
    tasks: [{
      id: 'first', name: 'Check the synthetic result', schedule: { offset_days: 0 },
      task_kind: 'checklist', owner_role: 'synthetic-reviewer', tools: [],
      instruction_exempt_reason: 'Synthetic self-contained check',
      runtime_instruction_source: 'synthetic-input',
      milestone: false, stage_on_complete: 'preparation', assignee_id: 'synthetic-user',
      instruction_doc_id: 'synthetic.instructions', instruction_step_id: 'check', phase_id: 'prepare',
      systems: [], validation: { enabled: false, attempts: 0, checks: [] },
      required_link: 'Synthetic result', requires_file: false,
      proof: { type: 'comment', label: 'Synthetic check result', required: false },
      closure: {
        success_criteria: 'Synthetic checks pass', follow_up: 'waiting',
        close_condition: 'Synthetic response is recorded', waiting_for: 'Synthetic response',
        follow_up_after_days: 3, recipient_role: 'synthetic-reviewer',
      },
      artifact_refs: [], assistant_job_refs: [], intake_refs: [], audit_event_refs: [],
    }],
  };
}

export function syntheticAuthoredFiles(count = 11): AuthoredTemplateFile[] {
  return Array.from({ length: count }, (_, index) => {
    const type = `synthetic-${index + 1}`;
    return {
      path: `workflow-templates/${type}.yaml`, revision: `synthetic-blob-${index + 1}`,
      content: yaml.dump(syntheticAuthoredTemplate(type)),
    };
  });
}

/** Real Contents API adapter, but every tree/blob response is synthetic and offline. */
export function syntheticGithubStore(files: AuthoredTemplateFile[]) {
  const requests: string[] = [];
  const store = new ContentsApiGithubStore({
    owner: 'synthetic-owner', repo: 'synthetic-repo', token: 'synthetic-test-token',
    fetchImpl: async (input, init) => {
      const url = new URL(String(input));
      assert.equal(init?.method, 'GET', 'template loading must be read-only');
      requests.push(`${url.pathname}${url.search}`);
      if (url.pathname.endsWith('/git/trees/main')) {
        assert.equal(url.search, '?recursive=1');
        return Response.json({ tree: [
          ...[...files].reverse().map((file) => ({ path: file.path, sha: file.revision, type: 'blob' })),
          { path: 'workflow-templates', sha: 'directory', type: 'tree' },
          { path: 'workflow-templates/README.md', sha: 'readme', type: 'blob' },
          { path: 'other/ignored.yaml', sha: 'ignored', type: 'blob' },
        ] });
      }
      const file = files.find((candidate) => url.pathname.endsWith(`/git/blobs/${candidate.revision}`));
      assert.ok(file, 'unexpected synthetic GitHub request');
      return Response.json({ content: Buffer.from(file.content).toString('base64') });
    },
  });
  return { store, requests };
}
