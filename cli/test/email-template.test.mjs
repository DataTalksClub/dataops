import { test } from 'node:test';
import assert from 'node:assert/strict';
import { captureIo, fakePortal, isolateConfig } from './helpers.mjs';

isolateConfig();
const { sendTemplate } = await import('../src/commands/email.mjs');
const { parseArgs } = await import('../src/cli.mjs');

test('email template values accept repeated --value flags', () => {
  const args = parseArgs(['--value', 'COMPANY=Acme', '--value', 'MM-DD-YYYY=11-16-2026']);
  assert.deepEqual(args.value, ['COMPANY=Acme', 'MM-DD-YYYY=11-16-2026']);
});

test('email send-template posts the selected KB template and values to DataOps', async () => {
  const calls = fakePortal({
    'POST /api/email-templates/send': {
      emailDelivery: {
        state: 'sent',
        from: 'orin@datatalks.club',
        to: 'alexey.s.grigoriev@gmail.com',
        messageId: 'gmail-message-1',
      },
    },
  });
  const captured = captureIo();
  const io = { print: line => captured.log(line) };
  const result = await sendTemplate({
    _: ['template.newsletter.send-sponsorship-document-2-weeks-before'],
    section: 'Template 2: Initial Introduction to Sponsor (Scheduled Newsletter Date)',
    recipient: 'alexey.s.grigoriev@gmail.com',
    recipientName: 'Alex',
    task: 'task-1',
    subjectVariant: 'Secondary Slot',
    value: ['COMPANY=Acme', 'COPY_DOCUMENT_URL=https://ops.example.test/doc?code=abc'],
  }, io);

  assert.equal(calls.length, 1);
  assert.equal(calls[0].route, '/api/email-templates/send');
  assert.deepEqual(calls[0].body, {
    templateId: 'template.newsletter.send-sponsorship-document-2-weeks-before',
    sectionHeading: 'Template 2: Initial Introduction to Sponsor (Scheduled Newsletter Date)',
    recipientEmail: 'alexey.s.grigoriev@gmail.com',
    taskId: 'task-1',
    values: {
      COMPANY: 'Acme',
      COPY_DOCUMENT_URL: 'https://ops.example.test/doc?code=abc',
    },
    recipientName: 'Alex',
    subjectVariant: 'Secondary Slot',
  });
  assert.equal(result.emailDelivery.messageId, 'gmail-message-1');
  assert.match(captured.text(), /Gmail message gmail-message-1/);
});
