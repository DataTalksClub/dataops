/**
 * An in-memory Relay client campaign API (`/api/campaigns/<key>`): GET, PUT
 * (draft upsert, refused once the campaign left draft), test-send, queue and
 * cancel, with Relay's validation of client/audience scope. Every request is
 * recorded so tests can prove which calls DataOps made, and when.
 */
export interface FakeCampaign {
  external_key: string;
  client: string;
  audience: string;
  status: string;
  subject: string;
  preview_text: string;
  html_body: string;
  text_body: string;
  scheduled_at: string | null;
  metadata: Record<string, unknown>;
}

export interface FakeCall {
  method: string;
  path: string;
  body: Record<string, unknown> | null;
}

export const SECRETS: Record<string, string> = {
  'relay-production.dtc-newsletter-api-key': 'prod-key-1',
  'relay-dev.api-keys': JSON.stringify({ RELAY_API_KEY: 'dev-key-1' }),
};

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

export class FakeRelay {
  campaigns = new Map<string, FakeCampaign>();
  calls: FakeCall[] = [];
  testSends: { key: string; emails: string[] }[] = [];
  apiKeySeen = '';
  /** Make the next queue call succeed in Relay but answer with this HTTP status (a lost response). */
  failNextQueueResponse = 0;
  /** Delay (ms) before answering a queue call, to let concurrent requests interleave. */
  queueDelayMs = 0;

  fetch = async (input: string | URL, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(String(input));
    const method = (init.method || 'GET').toUpperCase();
    const body = init.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null;
    this.calls.push({ method, path: url.pathname, body });
    this.apiKeySeen = String((init.headers as Record<string, string>)?.authorization || '');
    const match = /^\/api\/campaigns\/([^/]+)(\/[a-z-]+)?$/.exec(url.pathname);
    if (!match) return json(404, { error: 'not found' });
    const key = decodeURIComponent(match[1]);
    const action = match[2] || '';
    const scope = method === 'GET' ? { client: url.searchParams.get('client'), audience: url.searchParams.get('audience') } : body || {};
    if (scope.client !== 'dtc-newsletter') return json(403, { client: 'forbidden' });
    if (!scope.audience) return json(400, { audience: 'required' });
    const campaign = this.campaigns.get(key);
    if (action === '' && method === 'GET') return campaign ? json(200, { campaign }) : json(404, { external_key: 'not_found' });
    if (action === '' && method === 'PUT') {
      if (campaign && campaign.status !== 'draft') return json(409, { status: 'not_editable' });
      const saved: FakeCampaign = {
        external_key: key,
        client: String(body!.client),
        audience: String(body!.audience),
        status: 'draft',
        subject: String(body!.subject || ''),
        preview_text: String(body!.preview_text || ''),
        html_body: String(body!.html_body || ''),
        text_body: String(body!.text_body || ''),
        scheduled_at: body!.scheduled_at ? new Date(String(body!.scheduled_at)).toISOString() : null,
        metadata: (body!.metadata as Record<string, unknown>) || {},
      };
      this.campaigns.set(key, saved);
      return json(campaign ? 200 : 201, { campaign: saved, created: !campaign });
    }
    if (!campaign) return json(404, { external_key: 'not_found' });
    if (action === '/test-send' && method === 'POST') {
      const emails = (body!.emails as string[]) || [];
      this.testSends.push({ key, emails });
      return json(200, { campaign, sent_count: emails.length, recipients: emails.map((email, i) => ({ email, message_id: `m-${i}` })), status: 'provider_accepted' });
    }
    if (action === '/queue' && method === 'POST') {
      if (this.queueDelayMs) await new Promise((resolve) => setTimeout(resolve, this.queueDelayMs));
      const already = campaign.status === 'scheduled';
      if (campaign.status === 'draft') campaign.status = campaign.scheduled_at ? 'scheduled' : 'queued';
      if (this.failNextQueueResponse) {
        const status = this.failNextQueueResponse;
        this.failNextQueueResponse = 0;
        return new Response('upstream timeout', { status });
      }
      return json(200, { campaign, queued: !already, already_queued: already, scheduled: campaign.status === 'scheduled' });
    }
    if (action === '/cancel' && method === 'POST') {
      const cancelled = campaign.status === 'draft' || campaign.status === 'scheduled';
      if (cancelled) campaign.status = 'cancelled';
      return json(200, { campaign, cancelled });
    }
    return json(405, { error: 'method' });
  };
}
