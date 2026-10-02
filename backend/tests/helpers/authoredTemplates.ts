import {syntheticKnowledge} from './knowledge';
import yaml from 'js-yaml';

import { KnowledgeStore } from '../../src/docs/knowledgeStore';
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

export function syntheticKnowledgeStore(files: AuthoredTemplateFile[]) {
  const {store,s3}=syntheticKnowledge(Object.fromEntries(files.map(file=>[file.path,file.content])));
  const requests:string[]=[];const send=s3.send;
  s3.send=async(command:any)=>{requests.push(command.input.Key);return send(command);};
  return {store,requests};
}
