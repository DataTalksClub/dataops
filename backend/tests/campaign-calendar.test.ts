import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DynamoDBDocumentClient, PutCommand, DeleteCommand } from '@aws-sdk/lib-dynamodb';
import { getClient } from '../src/db/client';
import { TABLE_CARDS, TABLE_USERS } from '../src/db/tableNames';
import { startLocal, stopLocal, createTables } from '../scripts/local-dynamodb';
import { handleCampaignCalendarRoutes } from '../src/routes/campaignCalendar';

const SAMPLE_CAMPAIGN_CSV = `Date,Relative week,Relative date,Phase,Preferred day,Platform,Post type,Typefully examples,Working title / angle,Audience,Primary CTA,Phrases,Assets needed,Why this belongs in this phase,Status
TBD,T-12 weeks,T-84 days,Foundation,Monday,Primary social,Problem framing,,Why {{ course_topic }} matters now,Potential learners,Read the course overview or join the waitlist,,Course positioning; market context,This creates relevance before asking people to register.,Planned
2026-10-26,T-3 weeks,T-21 days,2. Announcement,Monday,DTC newsletter,Course registration slot,,"#300: new free course, apply by Mon Nov 30",Newsletter subscribers,Apply for free,"H1, O1, A3",newsletter/issues/2026-10-26-weekly-300/issue.md,First announcement to the newsletter audience.,Ready
2026-06-22,T-12 weeks,T-84 days,Foundation,Monday,Primary social,Problem framing,,Why ML matters now,Potential learners,Join waitlist,,Course positioning,Relevance before registration.,Skipped (date already passed)
`;

const SAMPLE_TELEGRAM_CSV = `recommended_date,kind,file,status
2026-09-21,announcement,01-module-1-announcement.md,Past reference; do not post as a new release
2026-10-12,announcement,04-module-4-announcement.md,Draft; posting date is a recommendation
`;

describe('Campaign calendar / social post rows per cohort Card', () => {
  let client: DynamoDBDocumentClient;

  before(async () => {
    process.env.SKIP_AUTH = 'true';
    client = await getClient(await startLocal());
    await createTables(client);
    for (const id of ['cohort-gen-media-2026', 'cohort-ml-2026', 'cohort-temp']) {
      await client.send(
        new PutCommand({
          TableName: TABLE_CARDS,
          Item: {
            PK: `CARD#${id}`,
            SK: `CARD#${id}`,
            id,
            version: 1,
            title: id,
            status: 'active',
            stage: 'preparation',
            taskCount: 0,
            openTaskCount: 0,
            templateId: 'course',
            templateVersion: 1,
            templateDefinitionSnapshot: { taskRefs: [] },
            selectedOptionalGroups: [],
          },
        }),
      );
    }
  });

  after(async () => {
    await stopLocal();
  });

  async function request(
    method: string,
    suffix = '',
    body?: unknown,
    queryStringParameters?: Record<string, string>,
    headers?: Record<string, string>,
  ) {
    const res = await handleCampaignCalendarRoutes(
      {
        httpMethod: method,
        path: `/api/campaign-calendar${suffix}`,
        body: body === undefined ? undefined : JSON.stringify(body),
        queryStringParameters,
        headers,
      },
      client,
    );
    assert.ok(res);
    return res;
  }

  it('imports a campaign calendar CSV into template and cohort Cards, lists with filters, and updates with optimistic locking', async () => {
    const tplRes = await request('POST', '/import', {
      cardId: 'template',
      csv: SAMPLE_CAMPAIGN_CSV,
      replace: true,
    });
    assert.equal(tplRes.statusCode, 201, tplRes.body);
    const tplData = JSON.parse(tplRes.body);
    assert.equal(tplData.importedCount, 3);
    assert.equal(tplData.rows[0].offset, 'T-84 days');
    assert.equal(tplData.rows[1].phrases, 'H1, O1, A3');
    assert.equal(tplData.rows[2].status, 'Skipped (date already passed)');

    const seedRes = await request('POST', '/import', {
      cardId: 'cohort-gen-media-2026',
      fromTemplate: true,
      owner: 'Orin',
    });
    assert.equal(seedRes.statusCode, 201, seedRes.body);
    const seedData = JSON.parse(seedRes.body);
    assert.equal(seedData.importedCount, 3);
    assert.equal(seedData.rows[0].owner, 'Orin');

    const listedAll = JSON.parse(
      (await request('GET', '', undefined, { cardId: 'cohort-gen-media-2026' })).body,
    );
    assert.equal(listedAll.rows.length, 3);
    assert.deepEqual(
      listedAll.rows.map((r: { rowIndex: number }) => r.rowIndex),
      [1, 2, 3],
    );

    const listedReady = JSON.parse(
      (await request('GET', '', undefined, { cardId: 'cohort-gen-media-2026', status: 'Ready' })).body,
    );
    assert.equal(listedReady.rows.length, 1);
    assert.equal(listedReady.rows[0].channel, 'DTC newsletter');

    const targetRow = listedReady.rows[0];
    const updatedRes = await request('PUT', `/${targetRow.id}`, {
      status: 'Published',
      owner: 'Alexey',
      date: '2026-10-27',
      version: targetRow.version,
    });
    assert.equal(updatedRes.statusCode, 200, updatedRes.body);
    const updated = JSON.parse(updatedRes.body).row;
    assert.equal(updated.status, 'Published');
    assert.equal(updated.owner, 'Alexey');
    assert.equal(updated.date, '2026-10-27');
    assert.equal(updated.version, 2);

    const staleRes = await request('PUT', `/${targetRow.id}`, {
      status: 'Drafted',
      version: 1,
    });
    assert.equal(staleRes.statusCode, 409);

    const singleRes = await request('GET', `/${targetRow.id}`);
    assert.equal(singleRes.statusCode, 200);
    assert.equal(JSON.parse(singleRes.body).row.status, 'Published');
  });

  it('imports Telegram announcement calendar CSVs and supports append vs replace', async () => {
    const first = await request('POST', '/import', {
      cardId: 'cohort-ml-2026',
      csv: SAMPLE_CAMPAIGN_CSV,
      replace: true,
    });
    assert.equal(first.statusCode, 201);
    assert.equal(JSON.parse(first.body).importedCount, 3);

    const appended = await request('POST', '/import', {
      cardId: 'cohort-ml-2026',
      csv: SAMPLE_TELEGRAM_CSV,
      replace: false,
    });
    assert.equal(appended.statusCode, 201, appended.body);
    const appendedData = JSON.parse(appended.body);
    assert.equal(appendedData.importedCount, 2);
    assert.equal(appendedData.rows[0].channel, 'Telegram');
    assert.equal(appendedData.rows[0].format, 'announcement');
    assert.equal(appendedData.rows[0].assets, '01-module-1-announcement.md');
    assert.equal(appendedData.rows[0].rowIndex, 4);

    const allMl = JSON.parse(
      (await request('GET', '', undefined, { cardId: 'cohort-ml-2026' })).body,
    );
    assert.equal(allMl.rows.length, 5);

    const replaced = await request('POST', '/import', {
      cardId: 'cohort-ml-2026',
      csv: SAMPLE_TELEGRAM_CSV,
      replace: true,
    });
    assert.equal(replaced.statusCode, 201);
    const replacedData = JSON.parse(replaced.body);
    assert.equal(replacedData.importedCount, 2);
    assert.equal(replacedData.replacedCount, 5);
  });

  it('creates, deletes, validates inputs, enforces auth, and hides rows when the cohort Card is removed', async () => {
    const createRes = await request('POST', '', {
      cardId: 'cohort-temp',
      offset: 'T-14 days',
      channel: 'YouTube community',
      format: 'Pre-course Q&A',
      owner: 'Orin',
      status: 'Planned',
      title: 'Live Q&A reminder',
    });
    assert.equal(createRes.statusCode, 201, createRes.body);
    const created = JSON.parse(createRes.body).row;
    assert.equal(created.offset, 'T-14 days');

    assert.equal((await request('POST', '', { cardId: 'missing-card', offset: 'T-1', channel: 'X', format: 'Post' })).statusCode, 404);
    assert.equal((await request('POST', '', { cardId: 'cohort-temp', channel: 'X', format: 'Post' })).statusCode, 400);
    assert.equal((await request('GET')).statusCode, 400);
    assert.equal((await request('GET', '', undefined, { cardId: 'missing-card' })).statusCode, 404);

    delete process.env.SKIP_AUTH;
    try {
      assert.equal((await request('GET', '', undefined, { cardId: 'cohort-temp' })).statusCode, 401);
      await client.send(
        new PutCommand({
          TableName: TABLE_USERS,
          Item: { PK: 'USER#viewer-1', SK: 'USER#viewer-1', id: 'viewer-1', role: 'viewer', disabled: false },
        }),
      );
      assert.equal(
        (await request('POST', '', { cardId: 'cohort-temp', offset: 'T-1', channel: 'X', format: 'Post' }, undefined, { 'x-user-id': 'viewer-1' })).statusCode,
        403,
      );
    } finally {
      process.env.SKIP_AUTH = 'true';
    }

    assert.equal((await request('DELETE', `/${created.id}`, undefined, { version: '2' })).statusCode, 409);

    await client.send(
      new DeleteCommand({
        TableName: TABLE_CARDS,
        Key: { PK: 'CARD#cohort-temp', SK: 'CARD#cohort-temp' },
      }),
    );
    assert.equal((await request('GET', `/${created.id}`)).statusCode, 404);
  });
});
