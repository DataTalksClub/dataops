import { test } from 'node:test';
import assert from 'node:assert/strict';
import { eventPolicyIssues, parseEventPolicy } from '../src/events/policy';
import { normalizeTemplateDefinition } from '../src/templates/templateEdits';
import { templateFromYaml, templateToYaml } from '../src/templates/yamlTemplates';
import { templateCardDefinitionSnapshot } from '../src/templates/cardTemplateProjection';
import type { Template } from '../src/types';

import { policy } from './helpers/eventPolicy';

test('event policies survive authored/API normalization and immutable Card snapshot projection', () => {
  for (const type of ['podcast', 'webinar', 'workshop']) {
    const definition = normalizeTemplateDefinition({
      type, name: `Synthetic ${type}`, triggerType: 'manual', eventPolicy: policy(type),
      taskDefinitions: [{ refId: 'prepare', description: 'Synthetic preparation', offsetDays: 0 }],
    });
    const authored = templateToYaml(definition);
    assert.deepEqual(authored.event_policy, policy(type));
    assert.deepEqual(templateFromYaml(authored), definition);
    const template = { ...definition, id: 'template', version: 2, createdAt: '', updatedAt: '' } as unknown as Template;
    const snapshot = templateCardDefinitionSnapshot(template, ['prepare']);
    assert.deepEqual(snapshot.eventPolicy, policy(type));
    template.eventPolicy!.titles.approved = 'Changed later';
    assert.equal(snapshot.eventPolicy!.titles.approved, `${type}: {title}`);
  }
});

test('strict policy rejects misspellings and invalid cross-field configuration at API boundary', () => {
  for (const mutate of [
    (p: any) => { p.durationMinutes = 0; },
    (p: any) => { p.timeZone = 'Not/AZone'; },
    (p: any) => { p.windows.midday = '24:01'; },
    (p: any) => { p.guests.proposal = false; },
    (p: any) => { p.guests.requiredEmails = ['bad']; },
    (p: any) => { p.zoom.url = 'https://example.invalid'; },
    (p: any) => { p.calendarAcceptance.quorum = 'everyone'; },
    (p: any) => { p.titles.approved = '{unsupported}'; },
    (p: any) => { p.titles.proposed = '{title}'; },
    (p: any) => { p.notifications.approve.emails[0].subject = 'Injected\nheader'; },
    (p: any) => { p.notification = {}; },
  ]) {
    const p = policy(); mutate(p);
    assert.ok(eventPolicyIssues(p).length);
    assert.throws(() => normalizeTemplateDefinition({ type: 'synthetic', name: 'Synthetic', eventPolicy: p, taskDefinitions: [{ refId: 'prepare', description: 'Prepare' }] }), /eventPolicy/);
  }
  for (const input of [null, [], false, 'policy']) assert.throws(() => parseEventPolicy(input));
});


test('aggregate policy limits count UTF-8 bytes across transitions and email templates', () => {
  const p = policy();
  for (const transition of ['propose', 'approve', 'reschedule', 'release'] as const) {
    p.notifications[transition].emails = Array.from({ length: 10 }, () => ({ to: 'guests' as const, subject: 'Synthetic', body: 'x'.repeat(10000) }));
  }
  assert.throws(() => parseEventPolicy(p), /byte budget/);
  const multibyte = policy();
  multibyte.description = '日'.repeat(10000);
  multibyte.inviteText = '日'.repeat(10000);
  multibyte.notifications.approve.emails = [{ to: 'guests', subject: 'Subject', body: '日'.repeat(2000) }];
  assert.throws(() => parseEventPolicy(multibyte), /byte budget/);
  multibyte.notifications.approve.emails = [];
  assert.deepEqual(parseEventPolicy(multibyte), multibyte);
});
