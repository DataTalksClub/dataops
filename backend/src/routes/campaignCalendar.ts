import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import {
  CAMPAIGN_TEMPLATE_CARD_ID,
  CampaignCalendarRowInput,
  CampaignCalendarVersionConflict,
  campaignTargetExists,
  createCampaignCalendarRow,
  deleteCampaignCalendarRow,
  getCampaignCalendarRow,
  importCampaignCalendarRows,
  listCampaignCalendarRows,
  parseCampaignCalendarCsv,
  updateCampaignCalendarRow,
} from '../db/campaignCalendar';
import { resolveInteractiveActor } from '../identity/actor';
import type { LambdaEvent, LambdaResponse } from '../types';

const json = (statusCode: number, data: unknown): LambdaResponse => ({
  statusCode,
  headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  body: JSON.stringify(data),
});

function parseBody(event: LambdaEvent): Record<string, unknown> | null {
  try {
    const parsed =
      typeof event.body === 'string'
        ? JSON.parse(event.body)
        : ((event.body || null) as unknown as Record<string, unknown>);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return parsed;
  } catch {
    return null;
  }
}

function pickRowPatch(body: Record<string, unknown>): Partial<CampaignCalendarRowInput> {
  const fields: Array<keyof CampaignCalendarRowInput> = [
    'rowIndex',
    'date',
    'offset',
    'relativeWeek',
    'phase',
    'weekday',
    'channel',
    'format',
    'owner',
    'status',
    'title',
    'audience',
    'cta',
    'phrases',
    'assets',
    'typefullyExamples',
    'purpose',
  ];
  const out: Partial<CampaignCalendarRowInput> = {};
  for (const field of fields) {
    if (body[field] !== undefined) {
      if (field === 'rowIndex') {
        out.rowIndex = Number(body.rowIndex);
      } else if (typeof body[field] === 'string') {
        (out as Record<string, unknown>)[field] = body[field];
      } else if (body[field] === null) {
        (out as Record<string, unknown>)[field] = '';
      }
    }
  }
  return out;
}

export async function handleCampaignCalendarRoutes(
  event: LambdaEvent,
  client: DynamoDBDocumentClient,
): Promise<LambdaResponse | null> {
  const path = event.path || '';
  const match = /^\/api\/campaign-calendar(?:\/([^/]+))?\/?$/.exec(path);
  if (!match) return null;

  const method = event.httpMethod || 'GET';
  const actor = await resolveInteractiveActor(
    client,
    event,
    method === 'GET' ? 'work-read' : 'work-write',
  );
  if (!actor.ok) return actor.response;

  const segment = match[1];

  if (method === 'GET') {
    if (segment && segment !== 'import') {
      const row = await getCampaignCalendarRow(client, segment);
      return row ? json(200, { row }) : json(404, { error: 'Campaign calendar row not found' });
    }
    if (segment === 'import') {
      return json(405, { error: 'Method not allowed' });
    }
    const q = event.queryStringParameters || {};
    const cardId = typeof q.cardId === 'string' ? q.cardId.trim() : '';
    if (!cardId) {
      return json(400, { error: 'cardId is required' });
    }
    if (!(await campaignTargetExists(client, cardId))) {
      return json(404, { error: 'Card not found' });
    }
    const rows = await listCampaignCalendarRows(client, {
      cardId,
      channel: q.channel,
      status: q.status,
      phase: q.phase,
      owner: q.owner,
      format: q.format,
    });
    return json(200, { cardId, rows });
  }

  if (method === 'POST' && segment === 'import') {
    const body = parseBody(event);
    if (!body) return json(400, { error: 'Request body is required' });
    const cardId = typeof body.cardId === 'string' ? body.cardId.trim() : '';
    if (!cardId) return json(400, { error: 'cardId is required' });
    if (!(await campaignTargetExists(client, cardId))) {
      return json(404, { error: 'Card not found' });
    }

    const defaults = {
      channel: typeof body.channel === 'string' ? body.channel : undefined,
      owner: typeof body.owner === 'string' ? body.owner : undefined,
      status: typeof body.status === 'string' ? body.status : undefined,
    };

    let inputs: CampaignCalendarRowInput[];
    try {
      if (body.fromTemplate === true) {
        const templateRows = await listCampaignCalendarRows(client, {
          cardId: CAMPAIGN_TEMPLATE_CARD_ID,
        });
        if (templateRows.length === 0) {
          return json(400, { error: 'No campaign calendar template rows are stored yet' });
        }
        inputs = templateRows.map((r) => ({
          rowIndex: r.rowIndex,
          date: r.date,
          offset: r.offset,
          relativeWeek: r.relativeWeek,
          phase: r.phase,
          weekday: r.weekday,
          channel: r.channel,
          format: r.format,
          owner: defaults.owner || r.owner,
          status: defaults.status || r.status,
          title: r.title,
          audience: r.audience,
          cta: r.cta,
          phrases: r.phrases,
          assets: r.assets,
          typefullyExamples: r.typefullyExamples,
          purpose: r.purpose,
        }));
      } else if (typeof body.csv === 'string') {
        inputs = parseCampaignCalendarCsv(body.csv, defaults);
      } else if (Array.isArray(body.rows)) {
        if (body.rows.length === 0) {
          return json(400, { error: 'rows must be a non-empty array' });
        }
        inputs = body.rows.map((item) => {
          if (!item || typeof item !== 'object' || Array.isArray(item)) {
            throw new Error('Each row must be an object');
          }
          return pickRowPatch(item as Record<string, unknown>);
        });
      } else {
        return json(400, { error: 'Provide csv, rows, or fromTemplate' });
      }

      const result = await importCampaignCalendarRows(client, cardId, inputs, {
        replace: body.replace === true,
        ...defaults,
      });
      return json(201, result);
    } catch (error) {
      return json(400, { error: (error as Error).message });
    }
  }

  if (method === 'POST' && !segment) {
    const body = parseBody(event);
    if (!body) return json(400, { error: 'Request body is required' });
    const cardId = typeof body.cardId === 'string' ? body.cardId.trim() : '';
    if (!cardId) return json(400, { error: 'cardId is required' });
    if (!(await campaignTargetExists(client, cardId))) {
      return json(404, { error: 'Card not found' });
    }
    try {
      const row = await createCampaignCalendarRow(client, cardId, pickRowPatch(body));
      return json(201, { row });
    } catch (error) {
      return json(400, { error: (error as Error).message });
    }
  }

  if (method === 'PUT' && segment && segment !== 'import') {
    const body = parseBody(event);
    if (!body) return json(400, { error: 'Request body is required' });
    const version = Number(body.version);
    if (!Number.isSafeInteger(version) || version < 1) {
      return json(400, { error: 'version is required' });
    }
    try {
      const row = await updateCampaignCalendarRow(client, segment, pickRowPatch(body), version);
      return row ? json(200, { row }) : json(404, { error: 'Campaign calendar row not found' });
    } catch (error) {
      if (error instanceof CampaignCalendarVersionConflict) {
        return json(409, { error: error.message });
      }
      return json(400, { error: (error as Error).message });
    }
  }

  if (method === 'DELETE' && segment && segment !== 'import') {
    const queryVersion = event.queryStringParameters?.version;
    const body = event.body ? parseBody(event) : null;
    const version = Number(queryVersion ?? body?.version);
    if (!Number.isSafeInteger(version) || version < 1) {
      return json(400, { error: 'version is required' });
    }
    try {
      const deleted = await deleteCampaignCalendarRow(client, segment, version);
      return deleted
        ? json(200, { deleted: true })
        : json(404, { error: 'Campaign calendar row not found' });
    } catch (error) {
      if (error instanceof CampaignCalendarVersionConflict) {
        return json(409, { error: error.message });
      }
      throw error;
    }
  }

  return json(405, { error: 'Method not allowed' });
}
