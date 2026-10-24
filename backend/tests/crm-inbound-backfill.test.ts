import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { classifyThread, dedupePeople, main, normalizeEmail, type RawMailMessage } from '../scripts/crm-inbound-backfill';

function message(overrides: Partial<RawMailMessage> = {}): RawMailMessage {
  return { id: 'm1', from: 'Pat Example <pat@vendor.example>', internalDate: '1000',
    subject: 'Newsletter sponsorship inquiry', body: 'We would like to sponsor your newsletter. Could you share your rates?', ...overrides };
}

test('excludes own bot domains, subdomains and configured private aliases', () => {
  for (const domain of ['datatalks.club', 'mail.grokbot.com', 'grokbot.com', 'dtcdev.click', 'aishippinglabs.com', 'sub.grokbot.com']) {
    assert.equal(classifyThread('t', [message({ from: `cdg.business@${domain}` })]).exclusion, 'alexey_outbound_or_internal');
  }
  assert.equal(classifyThread('t', [message({ from: 'ops@private.example' })], ['private.example']).candidate, undefined);
  assert.equal(classifyThread('t', [message({ from: 'staff@elsewhere.example' })], [], ['STAFF@elsewhere.example']).candidate, undefined);
  assert.ok(classifyThread('t', [message({ from: 'pat@notgrokbot.com' })]).candidate);
});

test('Hanzo beta invitation and a media-kit reply cannot become a sponsor ask', () => {
  const first = message({ from: 'hello@hanzo.ai', subject: 'quick question about your github work',
    body: 'We like your GitHub contributions. Please join our beta and tell us what you think.' });
  const reply = message({ id: 'm2', from: 'alexey@datatalks.club', internalDate: '2000', body: 'Here is our mediakit for sponsorship.' });
  assert.equal(classifyThread('t', [reply, first]).candidate, undefined);
  for (const body of ['mediakit', 'media kit', 'Here is https://datatalks.club/mediakit/',
    'Please review my project.\nOn Monday Alexey wrote:\nWould you sponsor your newsletter? media kit',
    '<p>Please try our beta.</p><div>On Monday Alexey wrote:</div><p>We would like to sponsor your newsletter</p>']) {
    assert.equal(classifyThread('t', [message({ subject: 'Feedback?', body })]).candidate, undefined);
  }
});

test('generic email needs a real placement ask', () => {
  assert.equal(classifyThread('t', [message({ from: 'person@gmail.com', subject: 'Your engineering post', body: 'I built a tool. What do you think? https://datatalks.club/mediakit/' })]).candidate, undefined);
  assert.ok(classifyThread('t', [message({ from: 'person@gmail.com', body: 'I would like to sponsor your newsletter placement for my project. Can you share your rates?' })]).candidate);
});

test('accepts clear sponsor, workshop and guest requests', () => {
  for (const msg of [message(),
    message({ subject: 'Workshop idea', body: "We'd like to explore a workshop for our launch. Would this suit DataTalks.Club? Could you share your media kit, rate and availability?" }),
    message({ subject: 'Podcast guest pitch', body: "I'd like to suggest our founder as a guest on your podcast." }),
    message({ subject: 'Event', body: 'Could you share this with your community? We are running a free event.' }),
  ]) assert.ok(classifyThread('t', [msg]).candidate, msg.subject);
});

test('excludes calendar, automated, broadcast and supplier pitches', () => {
  for (const msg of [
    message({ subject: 'Updated invitation: planning', body: 'Newsletter sponsorship inquiry; media kit' }),
    message({ subject: 'Out of office Re: Sponsorship inquiry' }),
    message({ subject: 'Paid sponsorships this week', body: "In this week's issue: looking for creators for paid newsletter campaigns." }),
    message({ body: "We'd love to discuss our sponsorship opportunities. Your newsletter could advertise in ours." }),
    message({ subject: 'Guest Speaker Invitation', body: 'I wanted to invite you for a session with our students. We love your podcast.' }),
    message({ subject: 'Would love to connect', body: "We're both members of PitchPodcasts. Your profile for DataTalks.Club stood out. Can you send a link to your podcast? Matching podcast guests and hosts is our service." }),
    message({ subject: 'Community question', body: 'I am not requesting a paid placement. Could you review my project for your community?' }),
  ]) assert.equal(classifyThread('t', [msg]).candidate, undefined, msg.subject);
});

test('dedupes Ciprian threads, normalized email aliases, and name plus domain', () => {
  const candidate = classifyThread('t1', [message({ from: 'Ciprian Example <ciprian@vendor.example>' })]).candidate!;
  assert.equal(dedupePeople([candidate, { ...candidate, threadId: 't2', email: ' CIpRIAN@vendor.example ' },
    { ...candidate, threadId: 't3', name: ' CIPRIAN  Example ', email: 'c.example@vendor.example' }]).length, 1);
  assert.equal(normalizeEmail(' Pat.Example+newsletter@Googlemail.com '), 'patexample@gmail.com');
  assert.equal(dedupePeople([candidate, { ...candidate, email: 'ciprian@other.example' }]).length, 2);
});

test('dry-run matches name/domain and suppresses needs-review records without writes', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'crm-inbound-test-'));
  const originalFetch = global.fetch;
  const originalToken = process.env.DATAOPS_TOKEN;
  process.env.DATAOPS_TOKEN = 'synthetic-test-token';
  try {
    for (const mailbox of ['alexey@datatalks.club', 'alexey.s.grigoriev@gmail.com']) {
      await mkdir(path.join(root, mailbox));
      await writeFile(path.join(root, mailbox, 'messages.jsonl'), mailbox.startsWith('alexey@') ? [
        message({ id: '1', threadId: '1' }),
        message({ id: '2', threadId: '2', from: 'Review Person <person@review.example>' }),
        message({ id: '3', threadId: '3', from: 'New Person <new@review.example>' }),
        message({ id: '4', threadId: '4', from: 'Private Staff <staff@private.example>' }),
      ].map(x => JSON.stringify(x)).join('\n') : '');
    }
    const configPath = path.join(root, 'exclude.json');
    await writeFile(configPath, JSON.stringify({ ownEmails: ['staff@private.example'] }));
    let reads = 0;
    global.fetch = (async (input, options) => {
      assert.equal(options?.method, undefined, 'dry-run must only read');
      reads++;
      const items = String(input).includes('/organizations?') ? [
        { id: 'org', displayName: 'Vendor', domain: 'vendor.example', version: 1, tags: ['existing'] },
        { id: 'review-org', displayName: 'Review', domain: 'review.example', version: 1, tags: ['needs-review'] },
      ] : [
        { id: 'person', name: 'Pat Example', emails: ['old@vendor.example'], organizationId: 'org', version: 1, tags: ['existing'] },
        { id: 'review-person', name: 'Review Person', emails: ['person@review.example'], organizationId: 'review-org', version: 1, tags: ['needs-review'] },
      ];
      return new Response(JSON.stringify({ items }));
    }) as typeof fetch;
    const report = path.join(root, 'report.json');
    const result = await main(['--dry-run', '--mail-root', root, '--exclude-config', configPath, '--out-json', report]);
    assert.equal(reads, 2);
    assert.equal(result.summaryCounts.newPeople, 0);
    assert.equal(result.summaryCounts.existingPeopleToTag, 1);
    assert.equal(result.summaryCounts.suppressedCompanies, 1);
    assert.equal(result.summaryCounts.suppressedPeople, 2);
    const json = JSON.parse(await readFile(report, 'utf8'));
    assert.deepEqual(json.plannedActions.peopleToTag, ['person']);
    assert.equal(json.samples.filter((x: {name: string}) => x.name === 'Pat Example').length, 1);
  } finally {
    global.fetch = originalFetch;
    if (originalToken === undefined) delete process.env.DATAOPS_TOKEN; else process.env.DATAOPS_TOKEN = originalToken;
    await rm(root, { recursive: true, force: true });
  }
});
