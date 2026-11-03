import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import {
  handleEmailDocumentIntake,
  resetEmailDocumentIntakeStateForTests,
  setEmailDocumentIntakeClientsForTests,
} from '../src/routes/emailDocuments';
import {
  handleSponsorLeadIntake,
  resetSponsorLeadIntakeStateForTests,
  setSponsorLeadIntakeClientsForTests,
} from '../src/routes/sponsorLeads';

describe('shared intake auth module (emailDocuments + sponsorLeads)', () => {
  it('shares one credential cache across email-documents and sponsor-leads intake routes', async (t) => {
    const savedInline = process.env.EMAIL_DOCUMENT_INTAKE_SECRET;
    const savedName = process.env.EMAIL_DOCUMENT_INTAKE_SECRET_NAME;
    t.after(() => {
      if (savedInline === undefined) delete process.env.EMAIL_DOCUMENT_INTAKE_SECRET;
      else process.env.EMAIL_DOCUMENT_INTAKE_SECRET = savedInline;
      if (savedName === undefined) delete process.env.EMAIL_DOCUMENT_INTAKE_SECRET_NAME;
      else process.env.EMAIL_DOCUMENT_INTAKE_SECRET_NAME = savedName;
      resetEmailDocumentIntakeStateForTests();
      resetSponsorLeadIntakeStateForTests();
    });

    delete process.env.EMAIL_DOCUMENT_INTAKE_SECRET;
    process.env.EMAIL_DOCUMENT_INTAKE_SECRET_NAME = '/dataops/test/intake-secret';

    let secretReads = 0;
    const reader = async () => {
      secretReads += 1;
      return JSON.stringify({ id: 'shared-cred', credential: 'top-secret-value' });
    };
    resetEmailDocumentIntakeStateForTests();
    resetSponsorLeadIntakeStateForTests();
    setEmailDocumentIntakeClientsForTests({ readSecret: reader });
    setSponsorLeadIntakeClientsForTests({ readSecret: reader });

    const seenRateKeys: string[] = [];
    const client = {
      send: async (cmd: { input?: { Key?: { PK?: string } } }) => {
        if (cmd.input?.Key?.PK) seenRateKeys.push(cmd.input.Key.PK);
        return {};
      },
    } as unknown as DynamoDBDocumentClient;

    const docRes = await handleEmailDocumentIntake(
      {
        httpMethod: 'POST',
        path: '/api/intake/email-documents',
        headers: { 'x-dataops-intake-secret': 'top-secret-value' },
        body: '{invalid-json',
      },
      client,
    );
    assert.equal(docRes.statusCode, 400);

    const leadRes = await handleSponsorLeadIntake(
      {
        httpMethod: 'POST',
        path: '/api/sponsor-crm/leads/intake',
        headers: { 'x-dataops-intake-secret': 'top-secret-value' },
        body: '{invalid-json',
      },
      client,
    );
    assert.equal(leadRes.statusCode, 400);

    // One shared credential cache means the secret was fetched once, not once per route module.
    assert.equal(secretReads, 1);
    assert.equal(seenRateKeys.length, 2);
    assert.match(seenRateKeys[0], /^RATE#EMAIL_DOCUMENT#/);
    assert.match(seenRateKeys[1], /^RATE#LEADS#/);
  });
});
