import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { AssumeRoleCommand, STSClient } from '@aws-sdk/client-sts';
import { DynamoDBDocumentClient, ScanCommand } from '@aws-sdk/lib-dynamodb';

export interface AcademyLead {
  created_at: string;
  updated_at: string;
  email: string;
  track: string;
  utm_source: string;
  utm_medium: string;
  utm_campaign: string;
  utm_content: string;
  utm_term: string;
  last_utm_source: string;
  last_utm_medium: string;
  last_utm_campaign: string;
  last_utm_content: string;
  last_utm_term: string;
  referrer: string;
  page: string;
  lang: string;
  consent_version: string;
  is_test: boolean;
  submissions: number;
  answers: Record<string, string>;
}

export interface AcademyUtmBucket {
  utm_source: string;
  utm_content: string;
  agentic: number;
  ai: number;
  other: number;
  total: number;
}

export interface AcademyLeadsSummary {
  total: number;
  testCount: number;
  byTrack: Record<string, number>;
  firstChoice: {
    'agentic only': number;
    'AI only': number;
    both: number;
  };
  byUtm: AcademyUtmBucket[];
}

export interface AcademyLeadsResponse {
  leads: AcademyLead[];
  summary: AcademyLeadsSummary;
}

type RawItem = Record<string, unknown>;

let cachedCreds: {
  roleArn: string;
  region: string;
  expiresAt: number;
  credentials: { accessKeyId: string; secretAccessKey: string; sessionToken: string };
} | null = null;

async function assumeReaderCredentials(roleArn: string, region: string) {
  const now = Date.now();
  if (
    cachedCreds &&
    cachedCreds.roleArn === roleArn &&
    cachedCreds.region === region &&
    cachedCreds.expiresAt - now > 60_000
  ) {
    return cachedCreds.credentials;
  }
  const sts = new STSClient({ region });
  const res = await sts.send(
    new AssumeRoleCommand({
      RoleArn: roleArn,
      RoleSessionName: 'dataops-academy-leads-read',
    }),
  );
  const c = res.Credentials;
  if (!c?.AccessKeyId || !c.SecretAccessKey || !c.SessionToken) {
    throw new Error('STS AssumeRole for academy-signups returned incomplete credentials');
  }
  const credentials = {
    accessKeyId: c.AccessKeyId,
    secretAccessKey: c.SecretAccessKey,
    sessionToken: c.SessionToken,
  };
  cachedCreds = {
    roleArn,
    region,
    expiresAt: c.Expiration ? c.Expiration.getTime() : now + 15 * 60_000,
    credentials,
  };
  return credentials;
}

function asString(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

function asMap(v: unknown): Record<string, string> | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const out: Record<string, string> = {};
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    if (typeof val === 'string') out[k] = val;
  }
  return out;
}

export function normalizeAcademyLead(item: RawItem): AcademyLead {
  const firstUtm = asMap(item.first_utm);
  const lastUtm = asMap(item.last_utm);
  const answers = asMap(item.answers) ?? {};
  const utm = (key: string) => (firstUtm ? firstUtm[key] || '' : asString(item[key]));
  const lastUtmVal = (key: string) => (lastUtm ? lastUtm[key] || '' : asString(item[`last_${key}`]));

  return {
    created_at: asString(item.created_at),
    updated_at: asString(item.updated_at),
    email: asString(item.email),
    track: asString(item.track),
    utm_source: utm('utm_source'),
    utm_medium: utm('utm_medium'),
    utm_campaign: utm('utm_campaign'),
    utm_content: utm('utm_content'),
    utm_term: utm('utm_term'),
    last_utm_source: lastUtmVal('utm_source'),
    last_utm_medium: lastUtmVal('utm_medium'),
    last_utm_campaign: lastUtmVal('utm_campaign'),
    last_utm_content: lastUtmVal('utm_content'),
    last_utm_term: lastUtmVal('utm_term'),
    referrer: asString(item.referrer),
    page: asString(item.page),
    lang: asString(item.lang),
    consent_version: asString(item.consent_version),
    is_test: item.is_test === true,
    submissions: typeof item.submissions === 'number' ? item.submissions : Number(item.submissions) || 1,
    answers,
  };
}

export function summarizeAcademyLeads(leads: AcademyLead[], testCount: number): AcademyLeadsSummary {
  const byTrack: Record<string, number> = {
    'agentic-engineering': 0,
    'ai-engineering': 0,
  };
  const byEmail = new Map<string, Set<string>>();
  const utmBuckets = new Map<string, AcademyUtmBucket>();

  for (const lead of leads) {
    byTrack[lead.track] = (byTrack[lead.track] || 0) + 1;
    let tracks = byEmail.get(lead.email);
    if (!tracks) {
      tracks = new Set<string>();
      byEmail.set(lead.email, tracks);
    }
    tracks.add(lead.track);

    const src = lead.utm_source || '-';
    const content = lead.utm_content || '-';
    const key = `${src}\u0000${content}`;
    let bucket = utmBuckets.get(key);
    if (!bucket) {
      bucket = { utm_source: src, utm_content: content, agentic: 0, ai: 0, other: 0, total: 0 };
      utmBuckets.set(key, bucket);
    }
    if (lead.track === 'agentic-engineering') bucket.agentic += 1;
    else if (lead.track === 'ai-engineering') bucket.ai += 1;
    else bucket.other += 1;
    bucket.total += 1;
  }

  const firstChoice = { 'agentic only': 0, 'AI only': 0, both: 0 };
  for (const tracks of byEmail.values()) {
    const hasAgentic = tracks.has('agentic-engineering');
    const hasAi = tracks.has('ai-engineering');
    if (hasAgentic && hasAi) firstChoice.both += 1;
    else if (hasAgentic) firstChoice['agentic only'] += 1;
    else if (hasAi) firstChoice['AI only'] += 1;
  }

  const byUtm = Array.from(utmBuckets.values()).sort(
    (a, b) => b.total - a.total || a.utm_source.localeCompare(b.utm_source) || a.utm_content.localeCompare(b.utm_content),
  );

  return {
    total: leads.length,
    testCount,
    byTrack,
    firstChoice,
    byUtm,
  };
}

export async function scanAcademySignups(options?: {
  prefix?: string;
  tableName?: string;
  region?: string;
  roleArn?: string;
  client?: DynamoDBDocumentClient;
}): Promise<RawItem[]> {
  const tableName = options?.tableName || process.env.ACADEMY_SIGNUPS_TABLE || 'academy-signups';
  const region = options?.region || process.env.ACADEMY_SIGNUPS_REGION || 'eu-west-1';
  const roleArn = options?.roleArn ?? (process.env.ACADEMY_SIGNUPS_READER_ROLE_ARN || '');

  let docClient = options?.client;
  if (!docClient) {
    const credentials = roleArn ? await assumeReaderCredentials(roleArn, region) : undefined;
    const raw = new DynamoDBClient({ region, ...(credentials ? { credentials } : {}) });
    docClient = DynamoDBDocumentClient.from(raw);
  }

  const items: RawItem[] = [];
  let exclusiveStartKey: Record<string, unknown> | undefined;
  do {
    const page = await docClient.send(
      new ScanCommand({
        TableName: tableName,
        FilterExpression: 'begins_with(pk, :p)',
        ExpressionAttributeValues: { ':p': options?.prefix || 'SIGNUP#' },
        ...(exclusiveStartKey ? { ExclusiveStartKey: exclusiveStartKey } : {}),
      }),
    );
    if (page.Items) items.push(...(page.Items as RawItem[]));
    exclusiveStartKey = page.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (exclusiveStartKey);
  return items;
}

export async function listAcademyLeads(options?: {
  includeTests?: boolean;
  track?: string;
  scanItems?: () => Promise<RawItem[]>;
}): Promise<AcademyLeadsResponse> {
  const rawItems = await (options?.scanItems ? options.scanItems() : scanAcademySignups());
  const normalized = rawItems.map(normalizeAcademyLead);
  const testCount = normalized.filter((l) => l.is_test).length;
  const includeTests = options?.includeTests === true;
  const trackFilter = options?.track?.trim() || '';

  const leads = normalized
    .filter((l) => (includeTests || !l.is_test) && (!trackFilter || l.track === trackFilter))
    .sort((a, b) => b.created_at.localeCompare(a.created_at));

  return {
    leads,
    summary: summarizeAcademyLeads(leads, testCount),
  };
}
