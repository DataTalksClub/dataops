import assert from 'node:assert/strict';
import { after, afterEach, before, describe, it } from 'node:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
const scratch=resolve(__dirname,'../../.tmp/model-tests');
function tmpdir():string {mkdirSync(scratch,{recursive:true});return scratch;}
import {syntheticKnowledge} from './helpers/knowledge';
import {configureOperatingModelStoreForTests,handleOperatingModelRoutes} from '../src/routes/operatingModel';

import { KnowledgeStore } from '../src/docs/knowledgeStore';
import { loadOperatingModelSnapshot, parseCsv } from '../src/operatingModel/loader';
import { createCardFromDefinition, DefinitionCardConflictError } from '../src/db/templates';
import { getClient } from '../src/db/client';
import { createTables } from '../scripts/local-dynamodb';
import { startLocal, stopLocal } from '../scripts/local-dynamodb';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import type { Template } from '../src/types';

function write(root: string, path: string, body: string): void {
  const target = join(root, path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, body);
}

describe('operating model definition projection', () => {
  const roots: string[] = [];
  let client: DynamoDBDocumentClient;
  before(async () => { client = await getClient(await startLocal()); await createTables(client); });
  after(async () => { await stopLocal(); });
  afterEach(() => { configureOperatingModelStoreForTests(null);while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }); });

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
    write(root, '_docs/operating-model/asset-register.csv', 'asset_id,asset,type,primary_unit,secondary_units,owner,source_of_truth,status,separation_treatment,open_decision\nasset-1,Brand,brand,BU-X,,Owner,Registry,known,Transfer,\n');
    write(root, '_docs/operating-model/dependency-register.csv', 'dependency_id,consumer_unit,provider,dependency,risk,mitigation,roadmap\nDEP-1,BU-X,Owner,Distribution,Risk,Mitigation,W01\n');
    write(root, 'workflow-templates/operating-model-w01.yaml', 'type: operating-model-w01\nname: Session\ntasks:\n  - id: decide\n    name: Decide\n    schedule:\n      offset_days: 0\n');
    const store = new KnowledgeStore({cacheDir:root});
    const before = process.env.DTC_OFFLINE;
    process.env.DTC_OFFLINE = '1';
    try {
      const model = await loadOperatingModelSnapshot(store);
      assert.equal(model.roadmap.sessions.length, 1);
      assert.equal(model.roadmap.sessions[0].id, 'W01');
      assert.equal(model.gaps[0].schedule.kind, 'session');
      assert.equal(model.lifecycles.length, 1);
      assert.equal(model.assets.length, 1);
      assert.equal(model.dependencies.length, 1);
      assert.equal(model.roadmap.sessions[0].checklist[0].title, 'Decide');
      const files:Record<string,Uint8Array>={};
      function collect(dir:string,prefix=''):void {for(const e of readdirSync(dir,{withFileTypes:true})) {
        if(e.isDirectory())collect(join(dir,e.name),prefix+e.name+'/');else files[prefix+e.name]=readFileSync(join(dir,e.name));
      }}
      collect(root);
      const fixture=syntheticKnowledge(files,join(root,'cache'));
      configureOperatingModelStoreForTests(()=>new KnowledgeStore({bucket:fixture.store.bucket,client:fixture.s3 as any,cacheDir:join(root,'cache'),offline:false}));
      const first=await handleOperatingModelRoutes({path:'/api/operating-model',httpMethod:'GET'},client);
      assert.equal(first?.statusCode,200);const previous=JSON.parse(first!.body).model;
      const templatePath='workflow-templates/operating-model-w01.yaml';
      await fixture.store.pin();
      const pinned=new KnowledgeStore({bucket:fixture.store.bucket,client:fixture.s3 as any,cacheDir:join(root,'cache'),offline:false});await pinned.pin();
      await fixture.store.publish([{path:templatePath,bytes:Buffer.from(files[templatePath]).toString().replace('Decide','Updated decision')}],fixture.publication.revision,'actor','Update model template');
      const fresh=await handleOperatingModelRoutes({path:'/api/operating-model',httpMethod:'GET'},client);
      const next=JSON.parse(fresh!.body).model;assert.notEqual(next.revision,previous.revision);assert.equal(next.roadmap.sessions[0].checklist[0].title,'Updated decision');
      assert.match(await pinned.readFile(templatePath),/name: Decide/);
      const stale=await handleOperatingModelRoutes({path:'/api/my-plan/sessions/W01',httpMethod:'POST',body:JSON.stringify({expectedDefinitionRevision:previous.revision,anchorDate:'2026-09-10'})},client);
      assert.equal(stale?.statusCode,409);
      let injected=false;
      configureOperatingModelStoreForTests(()=>{
        const requestStore=new KnowledgeStore({bucket:fixture.store.bucket,client:fixture.s3 as any,cacheDir:join(root,'cache'),offline:false});
        const originalPin=requestStore.pin.bind(requestStore);
        requestStore.pin=async()=>{
          const publication=await originalPin();
          if(!injected) {injected=true;await fixture.store.publish([{path:templatePath,bytes:Buffer.from(files[templatePath]).toString().replace('Decide','Concurrent next decision')}],fixture.store.revision,'actor','Mid-request publication');}
          return publication;
        };
        return requestStore;
      });
      const coherent=await handleOperatingModelRoutes({path:'/api/my-plan/sessions/W01',httpMethod:'POST',body:JSON.stringify({expectedDefinitionRevision:next.revision,anchorDate:'2026-09-10'})},client);
      assert.equal(coherent?.statusCode,201);
      const created=JSON.parse(coherent!.body);
      assert.equal(created.card.operatingModelSource.definitionRevision,next.revision);
      assert.equal(created.tasks[0].description,'Updated decision');
      const subsequent=await handleOperatingModelRoutes({path:'/api/operating-model',httpMethod:'GET'},client);
      assert.equal(JSON.parse(subsequent!.body).model.roadmap.sessions[0].checklist[0].title,'Concurrent next decision');


    } finally {
      if (before === undefined) delete process.env.DTC_OFFLINE;
      else process.env.DTC_OFFLINE = before;
    }
  });

  it('creates one complete deterministic Card aggregate under concurrent retries', async () => {
    const template = {
      id: 'workflow.operating-model-w01', version: 1, name: 'Session', type: 'operating-model-w01',
      defaultAssigneeId: 'actor-1', sourceDocIds: ['reference.session'], sourceRevision: 'revision-1',
      taskDefinitions: [
        { refId: 'decide', description: 'Record decisions', offsetDays: 0, assigneeId: 'actor-1' },
        { refId: 'validate', description: 'Validate outcome', offsetDays: 0, assigneeId: 'actor-1' },
      ], createdAt: '2026-09-05T00:00:00Z', updatedAt: '2026-09-05T00:00:00Z',
    } as Template;
    const create = () => createCardFromDefinition(client, {
      id: 'operating-model-test-card', title: 'W01', anchorDate: '2026-09-10', ownerId: 'actor-1',
      operatingModelSource: { kind: 'roadmap-session', roadmapId: '2026-q4', sessionId: 'W01', documentId: 'reference.session', definitionRevision: 'revision-1' },
    }, template, '2026-09-10', (ref) => `operating-model-test-${ref}`);
    const results = await Promise.allSettled([create(), create()]);
    assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
    const rejected = results.find((result) => result.status === 'rejected');
    assert.ok(rejected && rejected.status === 'rejected' && rejected.reason instanceof DefinitionCardConflictError);
    const created = results.find((result) => result.status === 'fulfilled');
    assert.ok(created && created.status === 'fulfilled');
    assert.equal(created.value.tasks.length, 2);
    assert.ok(created.value.tasks.every((task) => task.assigneeId === 'actor-1'));
  });
});
