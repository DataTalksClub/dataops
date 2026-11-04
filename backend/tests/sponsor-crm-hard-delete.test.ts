import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { GetCommand, PutCommand, ScanCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { handler } from '../src/handler';
import { getClient } from '../src/db/client';
import { TABLE_SPONSOR_CRM } from '../src/db/tableNames';
import { createUserWithId } from '../src/db/users';
import { createSession } from '../src/db/sessions';
import { createTables, startLocal, stopLocal } from '../scripts/local-dynamodb';
import { createCrmRecord, hardDeleteCrmRecord } from '../src/db/sponsorCrm';

const invoke = (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
  const url = new URL(path, 'http://crm.test');
  return handler({ httpMethod: method, path: url.pathname, headers,
    queryStringParameters: Object.fromEntries(url.searchParams), body: body === undefined ? null : JSON.stringify(body) }, {});
};
const data = (response: any) => JSON.parse(response.body);
const org = async (fields = {}) => data(await invoke('POST', '/api/sponsor-crm/organizations', { displayName: 'Synthetic delete fixture', ...fields }));
const person = async (organizationId: string, fields = {}) => data(await invoke('POST', '/api/sponsor-crm/contacts', { organizationId, name: 'Synthetic person', ...fields }));
const remove = (kind: string, id: string, query = '') => invoke('DELETE', `/api/sponsor-crm/${kind}/${id}?hard=true${query}`);

describe('CRM hard delete', () => {
  let client: DynamoDBDocumentClient;
  before(async () => { client = await getClient(await startLocal()); await createTables(client); });
  after(stopLocal);

  it('removes contact then organization, history and indexes without changing other records', async () => {
    const company = await org({ domain: 'delete.example.test' });
    const contact = await person(company.id, { primary: true });
    await org({ domain: 'keep.example.test' });
    const beforeRows = (await client.send(new ScanCommand({ TableName: TABLE_SPONSOR_CRM }))).Items!;
    assert.equal((await remove('contacts', contact.id)).statusCode, 200);
    assert.equal((await remove('organizations', company.id)).statusCode, 200);
    for (const [plural, directory, id] of [['organizations', 'companies', company.id], ['contacts', 'people', contact.id]]) {
      assert.equal((await invoke('GET', `/api/sponsor-crm/${plural}/${id}`)).statusCode, 404);
      assert.equal((await invoke('GET', `/api/sponsor-crm/directory/${directory}/${id}`)).statusCode, 404);
      assert.ok(!data(await invoke('GET', `/api/sponsor-crm/${plural}`)).items.some((r: any) => r.id === id));
      const result = data(await invoke('GET', `/api/sponsor-crm/directory/${directory}?active=all`));
      assert.ok(!result.items.some((r: any) => r.id === id));
      assert.equal(result.total, result.items.length);
      assert.equal((await remove(plural, id)).statusCode, 404);
    }
    const rows = (await client.send(new ScanCommand({ TableName: TABLE_SPONSOR_CRM }))).Items!;
    // The retained delete-audit snapshot rows are the only traces: everything
    // else keyed to the deleted ids is gone. Scan order is not stable, so
    // both sides are compared key-sorted.
    const byKey = (x: any, y: any) => `${x.PK}\u0000${x.SK}`.localeCompare(`${y.PK}\u0000${y.SK}`);
    const deletable = rows.filter(r => !String(r.PK).startsWith('ORGANIZATION_DELETE_AUDIT#') && !String(r.PK).startsWith('CONTACT_DELETE_AUDIT#'));
    assert.deepEqual(
      [...deletable].sort(byKey),
      [...beforeRows.filter(r => !String(r.PK).includes(company.id) && !String(r.PK).includes(contact.id) && r.organizationId !== company.id && r.contactId !== contact.id)].sort(byKey),
    );
    for (const [prefix, entityId] of [['ORGANIZATION_DELETE_AUDIT', company.id], ['CONTACT_DELETE_AUDIT', contact.id]]) {
      const audits = rows.filter(row => String(row.PK) === `${prefix}#${entityId}`);
      assert.equal(audits.length, 1, `one ${prefix} snapshot`);
      assert.equal(audits[0].entityKind, `${prefix === 'ORGANIZATION_DELETE_AUDIT' ? 'organization' : 'contact'}-delete-audit`);
      assert.equal(audits[0].entityId, entityId);
    }
    const replacement = await invoke('POST', '/api/sponsor-crm/organizations', { displayName: 'Replacement', domain: company.domain });
    assert.equal(replacement.statusCode, 201, replacement.body);
  });

  it('cleans only the deleted targets message indexes and keeps shared message records', async () => {
    const company = await org(); const contact = await person(company.id);
    await createCrmRecord(client, 'message', {
      organizationId: company.id, contactId: contact.id, dealId: 'other-target',
      sourceType: 'gmail', sentAt: '2026-10-01T12:00:00Z',
    });
    const beforeRows = (await client.send(new ScanCommand({ TableName: TABLE_SPONSOR_CRM }))).Items!;
    assert.ok(beforeRows.some(row => row.PK === `MESSAGE_TARGET#contact:${contact.id}`));
    assert.ok(beforeRows.some(row => row.PK === `MESSAGE_TARGET#organization:${company.id}`));
    assert.equal((await remove('contacts', contact.id)).statusCode, 200);
    assert.equal((await remove('organizations', company.id)).statusCode, 200);
    const ownedKeys = new Set([
      `ORGANIZATION#${company.id}`, `CONTACT#${contact.id}`,
      `HISTORY#organization:${company.id}`, `HISTORY#contact:${contact.id}`,
      `MESSAGE_TARGET#organization:${company.id}`, `MESSAGE_TARGET#contact:${contact.id}`,
    ]);
    const afterRows = (await client.send(new ScanCommand({ TableName: TABLE_SPONSOR_CRM }))).Items!;
    const byKey = (x: any, y: any) => `${x.PK}\u0000${x.SK}`.localeCompare(`${y.PK}\u0000${y.SK}`);
    const isDeleteAudit = (row: any) => String(row.PK).startsWith('ORGANIZATION_DELETE_AUDIT#') || String(row.PK).startsWith('CONTACT_DELETE_AUDIT#');
    assert.deepEqual(
      afterRows.filter(row => !isDeleteAudit(row)).sort(byKey),
      [...beforeRows.filter(row => !ownedKeys.has(String(row.PK)) && !isDeleteAudit(row))].sort(byKey),
    );
  });

  it('removes an organizations stale primary index after its contact is already gone', async () => {
    const company = await org();
    const pk = `PRIMARY#${company.id}`;
    await client.send(new PutCommand({ TableName: TABLE_SPONSOR_CRM, Item: { PK: pk, SK: pk, contactId: 'already-gone' } }));
    assert.equal((await remove('organizations', company.id)).statusCode, 200);
    const rows = (await client.send(new ScanCommand({ TableName: TABLE_SPONSOR_CRM }))).Items!;
    assert.ok(!rows.some(row => row.PK === pk));
  });

  it('refuses organizations with active or archived contacts without cascading', async () => {
    const company = await org(); const contact = await person(company.id);
    for (const archive of [false, true]) {
      if (archive) await invoke('DELETE', `/api/sponsor-crm/contacts/${contact.id}`);
      const result = await remove('organizations', company.id);
      assert.equal(result.statusCode, 409); assert.match(data(result).error, /contacts/);
      assert.equal((await invoke('GET', `/api/sponsor-crm/contacts/${contact.id}`)).statusCode, 200);
    }
  });

  it('refuses organization deals and contact deal/deliverable links including archived records', async () => {
    const company = await org(); const contact = await person(company.id);
    const deal = data(await invoke('POST', '/api/sponsor-crm/deals', { organizationId: company.id, primaryContactId: contact.id, status: 'open' }));
    for (const archive of [false, true]) {
      if (archive) await invoke('DELETE', `/api/sponsor-crm/deals/${deal.id}`);
      for (const [plural, id] of [['organizations', company.id], ['contacts', contact.id]]) {
        const result = await remove(plural, id); assert.equal(result.statusCode, 409); assert.match(data(result).error, /deal/i);
      }
    }
    for (const [kind, field] of [['deal', 'contactId'], ['deal', 'contactIds'], ['deliverable', 'primaryContactId']]) {
      const linked = await person(company.id);
      await client.send(new PutCommand({ TableName: TABLE_SPONSOR_CRM, Item: {
        PK: `${kind.toUpperCase()}#linked`, SK: `${kind.toUpperCase()}#linked`, id: 'linked', [field]: field === 'contactIds' ? [linked.id] : linked.id,
      } }));
      assert.equal((await remove('contacts', linked.id)).statusCode, 409);
    }
  });

  it('protects inline and workspace notes for both kinds', async () => {
    for (const kind of ['organizations', 'contacts']) for (const inline of [true, false]) {
      const company = await org(kind === 'organizations' && inline ? { notes: 'Human note' } : {});
      const record = kind === 'organizations' ? company : await person(company.id, inline ? { notes: 'Human note' } : {});
      if (!inline) {
        const target = kind === 'organizations' ? 'organization' : 'contact';
        const note = await invoke('POST', `/api/sponsor-crm/notes/${target}/${record.id}`, { body: 'Human workspace note' }, { 'x-user-id': 'synthetic-author' });
        assert.equal(note.statusCode, 201, note.body);
      }
      const result = await remove(kind, record.id);
      assert.equal(result.statusCode, 409); assert.match(data(result).error, /notes/);
    }
  });

  it('protects organization and contact human touches', async () => {
    for (const target of ['organization', 'contact']) {
      const company = await org(); const record = target === 'organization' ? company : await person(company.id);
      const touch = await invoke('POST', '/api/sponsor-crm/touches', { targetType: target, targetId: record.id, channel: 'call', note: 'Human touch' });
      assert.equal(touch.statusCode, 201, touch.body);
      const result = await remove(target === 'organization' ? 'organizations' : 'contacts', record.id);
      assert.equal(result.statusCode, 409); assert.match(data(result).error, /touches/);
    }
  });

  it('checks version, validates hard requests and preserves archive behavior', async () => {
    const company = await org();
    assert.equal((await remove('organizations', company.id, '&expectedVersion=2')).statusCode, 409);
    assert.equal((await remove('organizations', company.id, '&expectedVersion=0')).statusCode, 400);
    assert.equal((await invoke('DELETE', `/api/sponsor-crm/organizations/${company.id}?hard=false`)).statusCode, 400);
    assert.equal((await invoke('DELETE', '/api/sponsor-crm/deals/missing?hard=false')).statusCode, 400);
    assert.equal((await invoke('DELETE', `/api/sponsor-crm/organizations/${company.id}`)).statusCode, 200);
    assert.ok(data(await invoke('GET', `/api/sponsor-crm/organizations/${company.id}`)).archivedAt);
    assert.equal((await remove('organizations', company.id, '&expectedVersion=2')).statusCode, 200);
  });

  it('previews a hard delete with dryRun=true without deleting anything', async () => {
    const company = await org({ domain: 'dry.example.test' });
    const beforeRows = (await client.send(new ScanCommand({ TableName: TABLE_SPONSOR_CRM }))).Items!;
    const preview = await remove('organizations', company.id, '&dryRun=true');
    assert.equal(preview.statusCode, 200);
    assert.equal(data(preview).mode, 'dry-run');
    assert.equal(data(preview).deleted, false);
    assert.equal(data(preview).auditSnapshotRetained, false);
    assert.equal(data(preview).historyRows >= 1, true, 'the preview names the owned history rows');
    const untouched = (await client.send(new ScanCommand({ TableName: TABLE_SPONSOR_CRM }))).Items!;
    assert.deepEqual(
      [...untouched].sort((a, b) => `${a.PK}\u0000${a.SK}`.localeCompare(`${b.PK}\u0000${b.SK}`)),
      [...beforeRows].sort((a, b) => `${a.PK}\u0000${a.SK}`.localeCompare(`${b.PK}\u0000${b.SK}`)),
    );
    // A preview runs the same referential guards as an apply.
    const contact = await person(company.id, { primary: true });
    const refused = await remove('organizations', company.id, '&dryRun=true');
    assert.equal(refused.statusCode, 409);
    assert.match(data(refused).error, /contacts/);
    // dryRun never rides the archive verb, and its value is validated.
    const bare = await invoke('DELETE', `/api/sponsor-crm/organizations/${company.id}?dryRun=true`);
    assert.equal(bare.statusCode, 400);
    assert.equal(data(await invoke('GET', `/api/sponsor-crm/organizations/${company.id}`)).archivedAt, undefined);
    assert.equal((await remove('organizations', company.id, '&dryRun=maybe')).statusCode, 400);
  });

  it('retains one delete-audit snapshot with actor provenance', async () => {
    const company = await org({ domain: 'audited.example.test' });
    await createUserWithId(client, 'audit-admin', { name: 'Auditor', email: 'auditor@example.test', role: 'admin' });
    const admin = await createSession(client, 'audit-admin');
    process.env.SKIP_AUTH = 'false';
    try {
      const response = await invoke('DELETE', `/api/sponsor-crm/organizations/${company.id}?hard=true`, undefined, { Authorization: `Bearer ${admin.token}` });
      assert.equal(response.statusCode, 200);
      assert.equal(data(response).mode, 'applied');
      assert.equal(data(response).deleted, true);
      assert.equal(data(response).auditSnapshotRetained, true);
      const rows = (await client.send(new ScanCommand({ TableName: TABLE_SPONSOR_CRM }))).Items!;
      const audits = rows.filter(row => row.PK === `ORGANIZATION_DELETE_AUDIT#${company.id}`);
      assert.equal(audits.length, 1);
      assert.equal(audits[0].entityKind, 'organization-delete-audit');
      assert.equal(audits[0].entityId, company.id);
      assert.equal(audits[0].actorId, 'audit-admin');
      assert.equal(audits[0].snapshot.record.displayName, 'Synthetic delete fixture');
      assert.equal(audits[0].snapshot.record.domain, 'audited.example.test');
    } finally { process.env.SKIP_AUTH = 'true'; }
    assert.equal((await invoke('GET', `/api/sponsor-crm/organizations/${company.id}`)).statusCode, 404);
  });

  it('rolls back the whole deletion when cleanup fails', async () => {
    const company = await org({ domain: 'rollback.example.test' });
    const beforeRows = (await client.send(new ScanCommand({ TableName: TABLE_SPONSOR_CRM }))).Items;
    process.env.SPONSOR_CRM_TEST_FAIL_AFTER = '1';
    try { assert.equal((await remove('organizations', company.id)).statusCode, 500); }
    finally { delete process.env.SPONSOR_CRM_TEST_FAIL_AFTER; }
    assert.deepEqual((await client.send(new ScanCommand({ TableName: TABLE_SPONSOR_CRM }))).Items, beforeRows);
  });

  it('requires an authenticated active admin and rejects spoofed identity', async () => {
    const company = await org();
    await createUserWithId(client, 'delete-admin', { name: 'Admin', email: 'admin@example.test', role: 'admin' });
    await createUserWithId(client, 'delete-operator', { name: 'Operator', email: 'operator@example.test', role: 'operator' });
    const admin = await createSession(client, 'delete-admin'); const operator = await createSession(client, 'delete-operator');
    process.env.SKIP_AUTH = 'false';
    try {
      const path = `/api/sponsor-crm/organizations/${company.id}?hard=true`;
      assert.equal((await invoke('DELETE', path, undefined, { 'x-user-id': 'delete-admin' })).statusCode, 401);
      assert.equal((await invoke('DELETE', path, undefined, { Authorization: `Bearer ${operator.token}`, 'x-user-id': 'delete-admin' })).statusCode, 403);
      assert.equal((await invoke('DELETE', path, undefined, { Authorization: `Bearer ${admin.token}` })).statusCode, 200);
    } finally { process.env.SKIP_AUTH = 'true'; }
  });

  it('checks later scan pages before allowing deletion', async () => {
    const commands: any[] = [];
    const fake = { send: async (cmd: any) => {
      if (cmd instanceof GetCommand) return { Item: { PK: 'ORGANIZATION#o', SK: 'ORGANIZATION#o', id: 'o', version: 1 } };
      commands.push(cmd);
      assert.ok(cmd instanceof ScanCommand, 'a guard failure must not write');
      return cmd.input.ExclusiveStartKey
        ? { Items: [{ PK: 'CONTACT#c', SK: 'CONTACT#c', organizationId: 'o' }] }
        : { Items: [{ PK: 'ORGANIZATION#o', SK: 'ORGANIZATION#o', id: 'o', version: 1 }],
          LastEvaluatedKey: { PK: 'page1', SK: 'page1' } };
    } } as any;
    await assert.rejects(hardDeleteCrmRecord(fake, 'organization', 'o'),
      (error: any) => error.statusCode === 409 && /contacts/.test(error.message));
    assert.equal(commands.length, 2);
    assert.deepEqual(commands[1].input.ExclusiveStartKey, { PK: 'page1', SK: 'page1' });
  });

  it('refuses oversized history atomically and protects history notes', async () => {
    for (const notes of [false, true]) {
      const fake = { send: async (cmd: any) => {
        if (cmd instanceof GetCommand) return { Item: { PK: 'ORGANIZATION#o', SK: 'ORGANIZATION#o', id: 'o', version: 1 } };
        assert.ok(cmd instanceof ScanCommand, 'a guard failure must not write');
        return { Items: [
          { PK: 'ORGANIZATION#o', SK: 'ORGANIZATION#o', id: 'o', version: 1 },
          ...Array.from({ length: notes ? 1 : 100 }, (_, i) => ({
            PK: 'HISTORY#organization:o', SK: String(i), ...(notes ? { note: 'Human note' } : {}),
          })),
        ] };
      } } as any;
      await assert.rejects(hardDeleteCrmRecord(fake, 'organization', 'o'),
        (error: any) => error.statusCode === 409 && (notes ? /notes/ : /limit/).test(error.message));
    }
  });

  it('uses one version-conditional production transaction for record and cleanup', async () => {
    const previous = process.env.NODE_ENV; const commands: any[] = [];
    const fake = { send: async (cmd: any) => {
      commands.push(cmd);
      if (cmd instanceof GetCommand) return { Item: { PK: 'ORGANIZATION#o', SK: 'ORGANIZATION#o', id: 'o', version: 7 } };
      if (cmd instanceof ScanCommand) return { Items: [
        { PK: 'ORGANIZATION#o', SK: 'ORGANIZATION#o', id: 'o', version: 7 },
        { PK: 'HISTORY#organization:o', SK: 'created', action: 'created' },
        { PK: 'DOMAIN#example.test', SK: 'DOMAIN#example.test', organizationId: 'o' },
      ] };
      return {};
    } } as any;
    process.env.NODE_ENV = 'production';
    try {
      await hardDeleteCrmRecord(fake, 'organization', 'o', undefined, { actorId: 'admin-1' });
      assert.equal(commands[0].input.ConsistentRead, true);
      assert.equal(commands[1].input.ConsistentRead, true);
      assert.equal(commands[2].constructor.name, 'TransactWriteCommand');
      assert.equal(commands[2].input.TransactItems.length, 4);
      assert.equal(commands[2].input.TransactItems[0].Delete.ExpressionAttributeValues[':version'], 7);
      const audit = commands[2].input.TransactItems[3].Put.Item;
      assert.equal(audit.PK, 'ORGANIZATION_DELETE_AUDIT#o');
      assert.equal(audit.entityKind, 'organization-delete-audit');
      assert.equal(audit.actorId, 'admin-1');
      assert.equal(audit.snapshot.record.id, 'o');
      assert.ok(!('PK' in audit.snapshot.record));
    } finally { process.env.NODE_ENV = previous; }
  });
});
