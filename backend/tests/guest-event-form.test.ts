import assert from 'node:assert/strict';
import { test } from 'node:test';
import { getSponsorDocTemplate, hydrateGuestEventSlotOptions } from '../src/sponsorDocs/templates';
test('all three guest forms collect scheduling, optional photo/materials and time zone in their existing form', () => {
  for (const type of ['podcast', 'webinar', 'workshop'] as const) {
    const template = getSponsorDocTemplate(type);
    assert.equal(template.metadataSource, 'card-event');
    const fields = template.sections.flatMap(section => section.fields);
    for (const key of ['slotChoice', 'proposedSlotLabel', 'guestTimezone', 'photoUrl', 'preparationMaterials']) assert.ok(fields.some(field => field.key === key), `${type}: ${key}`);
    assert.equal(fields.find(field => field.key === 'photoUrl')!.allowVisualUpload, true);
    assert.equal(fields.find(field => field.key === 'photoUrl')!.maxCharsHint, 300000);
    if (type !== 'podcast') for (const key of ['talkTitle', 'outline', 'bio']) assert.equal(fields.find(field => field.key === key)!.required, true);
  }
});
test('general hydration preserves canonical instants/values and retains podcast day policy only for podcast', () => {
  const slots = [{ date: '2030-12-04', window: 'evening', localTime: '17:00', label: 'Scheduler label', startIso: '2030-12-04T16:00:00Z', endIso: '2030-12-04T17:00:00Z' }];
  for (const type of ['podcast', 'webinar', 'workshop'] as const) {
    const original = getSponsorDocTemplate(type);
    const form = hydrateGuestEventSlotOptions(original, slots, { label: 'Proposed label', startIso: '2030-12-02T16:00:00Z', endIso: '2030-12-02T17:00:00Z' });
    const options = form.sections.flatMap(section => section.fields).find(field => field.key === 'slotChoice')!.options!;
    assert.equal(options[0].startIso, '2030-12-02T16:00:00Z');
    assert.equal(options[0].value, 'confirm_proposed');
    assert.equal(options.length, type === 'podcast' ? 2 : 3);
    if (type !== 'podcast') assert.deepEqual(options[1], { value: 'slot:2030-12-04:evening', label: 'Scheduler label', startIso: slots[0].startIso, endIso: slots[0].endIso });
    assert.ok(!original.sections.flatMap(section => section.fields).find(field => field.key === 'slotChoice')!.options!.some(option => option.startIso), 'no mutation of static definition');
  }
});
