import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';

import { ContentsApiGithubStore } from '../src/docs/githubStore';
import { loadOperatingModelSnapshot, parseCsv } from '../src/operatingModel/loader';

function write(root: string, path: string, body: string): void {
  const target = join(root, path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, body);
}

describe('operating model definition projection', () => {
  const roots: string[] = [];
  afterEach(() => { while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }); });

  it('parses quoted CSV fields without splitting authored display text', () => {
    assert.deepStrictEqual(parseCsv('id,title\nW01,"One, two"\n'), [{ id: 'W01', title: 'One, two' }]);
  });

  it('projects work sessions while excluding calendar breaks', async () => {
    const root = mkdtempSync(join(tmpdir(), 'operating-model-'));
    roots.push(root);
    write(root, 'content/model/system-overview.md', '---\nid: system.example\ndoc_type: system-overview\ntitle: Example\n---\n');
    write(root, 'content/00-start-here/operating-model/reference/lifecycles/example.md', '---\nid: lifecycle.example\ndoc_type: reference\ntitle: Example lifecycle\n---\n');
    write(root, '_docs/operating-model/business-unit-registry.yaml', 'business_units:\n  - id: BU-X\n    tag: bu-x\n    name: Unit\n    role: Role\n');
    write(root, '_docs/operating-model/function-registry.yaml', 'functions:\n  - id: F01\n    slug: example\n    name: Example\n    manager_role: example-manager\n    manager_title: Example Manager\n    outcome: Outcome\n');
    write(root, '_docs/operating-model/system-function-map.csv', 'system_id,title,function_id,recommended_manager_role,status,criticality,path\nsystem.example,Example,F01,example-manager,proposed,core,content/model/system-overview.md\n');
    write(root, '_docs/operating-model/system-gap-register.csv', 'gap_id,priority,function_id,title,outcome,reason,business_units,proposed_system_id,skeleton_included,proposed_path,roadmap_week,status\nG001,P0,F01,Gap,Outcome,Reason,x,system.example,yes,content/model/system-overview.md,W01,draft-gap\n');
    write(root, '_docs/operating-model/weekly-roadmap.csv', 'week,date,work_status,title,goal,outputs,human_decisions,agent_work,definition_of_done,target_paths\nW01,2026-09-10,systems-day,Session,Goal,Outputs,Decisions,Agent work,Done,content/model\nBREAK-1,2026-09-17,no-work,Break,None,None,None,None,None,—\n');
    const store = new ContentsApiGithubStore({ owner: 'x', repo: 'x', token: '', cacheDir: root });
    const before = process.env.DTC_OFFLINE;
    process.env.DTC_OFFLINE = '1';
    try {
      const model = await loadOperatingModelSnapshot(store);
      assert.equal(model.roadmap.sessions.length, 1);
      assert.equal(model.roadmap.sessions[0].id, 'W01');
      assert.equal(model.gaps[0].schedule.kind, 'session');
      assert.equal(model.lifecycles.length, 1);
    } finally {
      if (before === undefined) delete process.env.DTC_OFFLINE;
      else process.env.DTC_OFFLINE = before;
    }
  });
});
