import { randomUUID } from 'node:crypto';
import {
  DeleteCommand,
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  ScanCommand,
} from '@aws-sdk/lib-dynamodb';
import { collectBoundedPages } from './boundedPagination';
import { getCardConsistent } from './cards';
import { TABLE_ARTIFACTS } from './tableNames';

export const CAMPAIGN_TEMPLATE_CARD_ID = 'template';

export interface CampaignCalendarRow {
  id: string;
  cardId: string;
  rowIndex: number;
  date: string;
  offset: string;
  relativeWeek: string;
  phase: string;
  weekday: string;
  channel: string;
  format: string;
  owner: string;
  status: string;
  title: string;
  audience: string;
  cta: string;
  phrases: string;
  assets: string;
  typefullyExamples: string;
  purpose: string;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface CampaignCalendarRowInput {
  rowIndex?: number;
  date?: string;
  offset?: string;
  relativeWeek?: string;
  phase?: string;
  weekday?: string;
  channel?: string;
  format?: string;
  owner?: string;
  status?: string;
  title?: string;
  audience?: string;
  cta?: string;
  phrases?: string;
  assets?: string;
  typefullyExamples?: string;
  purpose?: string;
}

export interface CampaignCalendarFilters {
  cardId: string;
  channel?: string;
  status?: string;
  phase?: string;
  owner?: string;
  format?: string;
}

export class CampaignCalendarVersionConflict extends Error {
  constructor(message = 'Campaign calendar row changed; reload before saving') {
    super(message);
    this.name = 'CampaignCalendarVersionConflict';
  }
}

const key = (id: string) => ({ PK: `CAMPAIGN_ROW#${id}`, SK: `CAMPAIGN_ROW#${id}` });

function clean(item: Record<string, unknown>): CampaignCalendarRow {
  const { PK, SK, ...rest } = item;
  return rest as unknown as CampaignCalendarRow;
}

export async function campaignTargetExists(
  client: DynamoDBDocumentClient,
  cardId: string,
): Promise<boolean> {
  if (!cardId || typeof cardId !== 'string') return false;
  if (cardId === CAMPAIGN_TEMPLATE_CARD_ID) return true;
  return Boolean(await getCardConsistent(client, cardId));
}

function str(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value.trim() : fallback;
}

export function normalizeRowInput(
  input: CampaignCalendarRowInput,
  rowIndex: number,
  defaults?: { channel?: string; owner?: string; status?: string },
): Omit<CampaignCalendarRow, 'id' | 'cardId' | 'version' | 'createdAt' | 'updatedAt'> {
  const date = str(input.date);
  const offset = str(input.offset);
  const relativeWeek = str(input.relativeWeek);
  const phase = str(input.phase);
  const weekday = str(input.weekday);
  const channel = str(input.channel) || str(defaults?.channel);
  const format = str(input.format);
  const owner = str(input.owner) || str(defaults?.owner);
  const status = str(input.status) || str(defaults?.status, 'Planned');
  const assets = str(input.assets);
  const title = str(input.title) || assets;
  const audience = str(input.audience);
  const cta = str(input.cta);
  const phrases = str(input.phrases);
  const typefullyExamples = str(input.typefullyExamples);
  const purpose = str(input.purpose);

  return {
    rowIndex: Number.isSafeInteger(input.rowIndex) && Number(input.rowIndex) > 0 ? Number(input.rowIndex) : rowIndex,
    date,
    offset,
    relativeWeek,
    phase,
    weekday,
    channel,
    format,
    owner,
    status,
    title,
    audience,
    cta,
    phrases,
    assets,
    typefullyExamples,
    purpose,
  };
}

export function validateNormalizedRow(
  row: Omit<CampaignCalendarRow, 'id' | 'cardId' | 'version' | 'createdAt' | 'updatedAt'>,
): string | null {
  if (!row.date && !row.offset) {
    return 'Each campaign calendar row requires date or offset';
  }
  if (!row.channel) {
    return 'Each campaign calendar row requires channel';
  }
  if (!row.format) {
    return 'Each campaign calendar row requires format';
  }
  if (!row.status) {
    return 'Each campaign calendar row requires status';
  }
  return null;
}

export async function getCampaignCalendarRow(
  client: DynamoDBDocumentClient,
  id: string,
): Promise<CampaignCalendarRow | null> {
  const result = await client.send(
    new GetCommand({ TableName: TABLE_ARTIFACTS, Key: key(id), ConsistentRead: true }),
  );
  if (!result.Item) return null;
  const row = clean(result.Item as Record<string, unknown>);
  return (await campaignTargetExists(client, row.cardId)) ? row : null;
}

export async function listCampaignCalendarRows(
  client: DynamoDBDocumentClient,
  filters: CampaignCalendarFilters,
): Promise<CampaignCalendarRow[]> {
  const rawRows = await collectBoundedPages<Record<string, unknown>>({
    loadPage: async (ExclusiveStartKey, abortSignal) =>
      client.send(
        new ScanCommand({
          TableName: TABLE_ARTIFACTS,
          ExclusiveStartKey,
          ConsistentRead: true,
          FilterExpression: 'begins_with(PK, :prefix) AND cardId = :cardId',
          ExpressionAttributeValues: {
            ':prefix': 'CAMPAIGN_ROW#',
            ':cardId': filters.cardId,
          },
        }),
        { abortSignal },
      ),
    limits: { maxPages: 1000, maxItems: 5000, maxBytes: 8 * 1024 * 1024, deadlineMs: 10000 },
  });

  const channelFilter = filters.channel?.trim().toLowerCase();
  const statusFilter = filters.status?.trim().toLowerCase();
  const phaseFilter = filters.phase?.trim().toLowerCase();
  const ownerFilter = filters.owner?.trim().toLowerCase();
  const formatFilter = filters.format?.trim().toLowerCase();

  return rawRows
    .map(clean)
    .filter((row) => {
      if (channelFilter && row.channel.toLowerCase() !== channelFilter) return false;
      if (statusFilter && row.status.toLowerCase() !== statusFilter) return false;
      if (phaseFilter && row.phase.toLowerCase() !== phaseFilter) return false;
      if (ownerFilter && row.owner.toLowerCase() !== ownerFilter) return false;
      if (formatFilter && row.format.toLowerCase() !== formatFilter) return false;
      return true;
    })
    .sort(
      (a, b) =>
        (a.rowIndex || 0) - (b.rowIndex || 0) ||
        a.createdAt.localeCompare(b.createdAt) ||
        a.id.localeCompare(b.id),
    );
}

export async function createCampaignCalendarRow(
  client: DynamoDBDocumentClient,
  cardId: string,
  input: CampaignCalendarRowInput,
  defaults?: { channel?: string; owner?: string; status?: string },
): Promise<CampaignCalendarRow> {
  const existing = await listCampaignCalendarRows(client, { cardId });
  const nextIndex = existing.reduce((max, r) => Math.max(max, r.rowIndex || 0), 0) + 1;
  const normalized = normalizeRowInput(input, nextIndex, defaults);
  const validationError = validateNormalizedRow(normalized);
  if (validationError) throw new Error(validationError);

  const now = new Date().toISOString();
  const row: CampaignCalendarRow = {
    id: randomUUID(),
    cardId,
    ...normalized,
    version: 1,
    createdAt: now,
    updatedAt: now,
  };
  await client.send(
    new PutCommand({
      TableName: TABLE_ARTIFACTS,
      Item: { ...key(row.id), ...row },
      ConditionExpression: 'attribute_not_exists(PK)',
    }),
  );
  return row;
}

export async function importCampaignCalendarRows(
  client: DynamoDBDocumentClient,
  cardId: string,
  inputs: CampaignCalendarRowInput[],
  options?: { replace?: boolean; channel?: string; owner?: string; status?: string },
): Promise<{ cardId: string; importedCount: number; replacedCount: number; rows: CampaignCalendarRow[] }> {
  const existing = await listCampaignCalendarRows(client, { cardId });
  let startIndex = existing.reduce((max, r) => Math.max(max, r.rowIndex || 0), 0) + 1;
  if (options?.replace) {
    startIndex = 1;
  }

  const now = new Date().toISOString();
  const prepared: CampaignCalendarRow[] = inputs.map((input, idx) => {
    const normalized = normalizeRowInput(input, startIndex + idx, options);
    const error = validateNormalizedRow(normalized);
    if (error) {
      throw new Error(`Row ${idx + 1}: ${error}`);
    }
    return {
      id: randomUUID(),
      cardId,
      ...normalized,
      version: 1,
      createdAt: now,
      updatedAt: now,
    };
  });

  let replacedCount = 0;
  if (options?.replace && existing.length > 0) {
    for (let i = 0; i < existing.length; i += 20) {
      const batch = existing.slice(i, i + 20);
      await Promise.all(
        batch.map((oldRow) =>
          client.send(
            new DeleteCommand({
              TableName: TABLE_ARTIFACTS,
              Key: key(oldRow.id),
            }),
          ),
        ),
      );
    }
    replacedCount = existing.length;
  }

  for (let i = 0; i < prepared.length; i += 20) {
    const batch = prepared.slice(i, i + 20);
    await Promise.all(
      batch.map((row) =>
        client.send(
          new PutCommand({
            TableName: TABLE_ARTIFACTS,
            Item: { ...key(row.id), ...row },
            ConditionExpression: 'attribute_not_exists(PK)',
          }),
        ),
      ),
    );
  }

  return {
    cardId,
    importedCount: prepared.length,
    replacedCount,
    rows: prepared,
  };
}

export async function updateCampaignCalendarRow(
  client: DynamoDBDocumentClient,
  id: string,
  updates: Partial<CampaignCalendarRowInput>,
  version: number,
): Promise<CampaignCalendarRow | null> {
  const current = await getCampaignCalendarRow(client, id);
  if (!current) return null;
  if (current.version !== version) {
    throw new CampaignCalendarVersionConflict();
  }

  const merged: Omit<CampaignCalendarRow, 'id' | 'cardId' | 'version' | 'createdAt' | 'updatedAt'> = {
    rowIndex:
      updates.rowIndex !== undefined && Number.isSafeInteger(updates.rowIndex) && Number(updates.rowIndex) > 0
        ? Number(updates.rowIndex)
        : current.rowIndex,
    date: updates.date !== undefined ? str(updates.date) : current.date,
    offset: updates.offset !== undefined ? str(updates.offset) : current.offset,
    relativeWeek: updates.relativeWeek !== undefined ? str(updates.relativeWeek) : current.relativeWeek,
    phase: updates.phase !== undefined ? str(updates.phase) : current.phase,
    weekday: updates.weekday !== undefined ? str(updates.weekday) : current.weekday,
    channel: updates.channel !== undefined ? str(updates.channel) : current.channel,
    format: updates.format !== undefined ? str(updates.format) : current.format,
    owner: updates.owner !== undefined ? str(updates.owner) : current.owner,
    status: updates.status !== undefined ? str(updates.status) : current.status,
    title: updates.title !== undefined ? str(updates.title) : current.title,
    audience: updates.audience !== undefined ? str(updates.audience) : current.audience,
    cta: updates.cta !== undefined ? str(updates.cta) : current.cta,
    phrases: updates.phrases !== undefined ? str(updates.phrases) : current.phrases,
    assets: updates.assets !== undefined ? str(updates.assets) : current.assets,
    typefullyExamples:
      updates.typefullyExamples !== undefined ? str(updates.typefullyExamples) : current.typefullyExamples,
    purpose: updates.purpose !== undefined ? str(updates.purpose) : current.purpose,
  };

  const validationError = validateNormalizedRow(merged);
  if (validationError) throw new Error(validationError);

  const next: CampaignCalendarRow = {
    ...current,
    ...merged,
    version: version + 1,
    updatedAt: new Date().toISOString(),
  };

  try {
    await client.send(
      new PutCommand({
        TableName: TABLE_ARTIFACTS,
        Item: { ...key(id), ...next },
        ConditionExpression: '#version = :version',
        ExpressionAttributeNames: { '#version': 'version' },
        ExpressionAttributeValues: { ':version': version },
      }),
    );
  } catch (error) {
    if ((error as Error).name === 'ConditionalCheckFailedException') {
      throw new CampaignCalendarVersionConflict();
    }
    throw error;
  }

  return next;
}

export async function deleteCampaignCalendarRow(
  client: DynamoDBDocumentClient,
  id: string,
  version: number,
): Promise<boolean> {
  try {
    await client.send(
      new DeleteCommand({
        TableName: TABLE_ARTIFACTS,
        Key: key(id),
        ConditionExpression: '#version = :version',
        ExpressionAttributeNames: { '#version': 'version' },
        ExpressionAttributeValues: { ':version': version },
      }),
    );
    return true;
  } catch (error) {
    if ((error as Error).name !== 'ConditionalCheckFailedException') throw error;
    if (!(await getCampaignCalendarRow(client, id))) return false;
    throw new CampaignCalendarVersionConflict('Campaign calendar row changed; reload before deleting');
  }
}

export function parseCsvMatrix(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  const source = text.replace(/^\uFEFF/, '');

  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i];
    if (inQuotes) {
      if (ch === '"') {
        if (source[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n') {
      row.push(field);
      field = '';
      if (row.length > 1 || row[0].trim() !== '') rows.push(row);
      row = [];
    } else if (ch !== '\r') {
      field += ch;
    }
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    if (row.length > 1 || row[0].trim() !== '') rows.push(row);
  }
  return rows;
}

function normalizeHeaderKey(header: string): string {
  return header
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

const HEADER_FIELD_MAP: Record<string, keyof CampaignCalendarRowInput> = {
  date: 'date',
  recommended_date: 'date',
  scheduled_date: 'date',
  posting_local: 'date',
  relative_date: 'offset',
  offset: 'offset',
  relative_week: 'relativeWeek',
  phase: 'phase',
  preferred_day: 'weekday',
  weekday: 'weekday',
  day: 'weekday',
  platform: 'channel',
  channel: 'channel',
  channel_username: 'channel',
  post_type: 'format',
  format: 'format',
  kind: 'format',
  owner: 'owner',
  assignee: 'owner',
  status: 'status',
  state: 'status',
  working_title_angle: 'title',
  working_title: 'title',
  angle: 'title',
  title: 'title',
  audience: 'audience',
  primary_cta: 'cta',
  cta: 'cta',
  phrases: 'phrases',
  assets_needed: 'assets',
  assets: 'assets',
  file: 'assets',
  typefully_examples: 'typefullyExamples',
  why_this_belongs_in_this_phase: 'purpose',
  purpose: 'purpose',
  notes: 'purpose',
};

export function parseCampaignCalendarCsv(
  csvText: string,
  defaults?: { channel?: string; owner?: string; status?: string },
): CampaignCalendarRowInput[] {
  const matrix = parseCsvMatrix(csvText);
  if (matrix.length < 2) {
    throw new Error('CSV must contain a header row and at least one data row');
  }
  const rawHeaders = matrix[0];
  const headerKeys = rawHeaders.map(normalizeHeaderKey);
  const mappedFields = headerKeys.map((keyName) => HEADER_FIELD_MAP[keyName] || null);
  if (!mappedFields.some(Boolean)) {
    throw new Error('CSV header does not contain recognized campaign calendar columns');
  }

  const isTelegramSchedule =
    headerKeys.includes('recommended_date') && headerKeys.includes('kind') && headerKeys.includes('file');
  const effectiveDefaults = {
    ...defaults,
    channel: defaults?.channel || (isTelegramSchedule ? 'Telegram' : undefined),
  };

  const results: CampaignCalendarRowInput[] = [];
  for (let r = 1; r < matrix.length; r += 1) {
    const cells = matrix[r];
    if (cells.every((c) => c.trim() === '')) continue;
    const rawInput: CampaignCalendarRowInput = {};
    for (let c = 0; c < mappedFields.length; c += 1) {
      const targetField = mappedFields[c];
      if (!targetField) continue;
      const cellValue = (cells[c] ?? '').trim();
      if (cellValue && !rawInput[targetField]) {
        (rawInput as Record<string, unknown>)[targetField] = cellValue;
      }
    }
    const normalized = normalizeRowInput(rawInput, results.length + 1, effectiveDefaults);
    const err = validateNormalizedRow(normalized);
    if (err) {
      throw new Error(`CSV row ${r + 1}: ${err}`);
    }
    const { rowIndex: _ignoredIndex, ...withoutIndex } = normalized;
    results.push(withoutIndex);
  }
  if (results.length === 0) {
    throw new Error('CSV contains no valid campaign calendar rows');
  }
  return results;
}
