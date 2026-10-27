import test from 'node:test';
import assert from 'node:assert/strict';
import { publicationConfig, setInvoiceProviderClientsForTests } from '../src/invoices/providers';

test('publication reads the imported store value and fails closed on reader denial', async () => {
  const env = { ...process.env };
  const config = { brokerUrl: 'https://broker.example', brokerCredential: 'fixture-token', agent: 'fixture',
    googleConnection: 'google', googleAccountId: 'google-account', dropboxConnection: 'dropbox',
    dropboxAccountId: 'dropbox-account', spreadsheetId: 'sheet', sheetTab: 'Expenses',
    dropboxRoot: '/Invoices', monthFolderPrefix: 'Month' };
  try {
    delete process.env.INVOICE_PUBLICATION_CONFIG;
    process.env.INVOICE_PUBLICATION_SECRET_NAME = 'dataops-v1.invoice-publication';
    let raw = JSON.stringify(config);
    setInvoiceProviderClientsForTests({ readSecret: async name => {
      assert.equal(name, 'dataops-v1.invoice-publication');
      return raw;
    } });
    assert.deepEqual(await publicationConfig(), config);
    raw = Buffer.from(raw).toString('base64');
    assert.deepEqual(await publicationConfig(), config);
    setInvoiceProviderClientsForTests({ readSecret: async () => { throw new Error('decrypt denied'); } });
    await assert.rejects(publicationConfig(), /decrypt denied/);
  } finally {
    process.env = env;
    setInvoiceProviderClientsForTests({});
  }
});
