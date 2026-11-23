export type FakeBlock = { id: number; position: number; type: string; data: Record<string, string>; updated_by: string; updated_at: string };

/** An in-memory Relay newsletter API: GET issue, GET/PUT block. */
export class FakeRelay {
  issues = new Map<string, { key: string; subject: string; campaign: { status: string } | null; blocks: FakeBlock[] }>();
  calls: string[] = [];
  tick = 0;
  /** Runs right before a block GET returns (to simulate a concurrent Relay edit). */
  beforeBlockGet: ((block: FakeBlock) => void) | null = null;
  apiKeySeen = '';

  stamp() {
    this.tick += 1;
    return `2026-11-23T10:00:${String(this.tick).padStart(2, '0')}+00:00`;
  }

  seed(key: string, blocks: Omit<FakeBlock, 'updated_at' | 'updated_by'>[]) {
    this.issues.set(key, {
      key,
      subject: `Subject ${key}`,
      campaign: null,
      blocks: blocks.map((block) => ({ ...block, updated_by: 'api:dtc-newsletter', updated_at: this.stamp() })),
    });
  }

  editInRelay(key: string, id: number, data: Record<string, string>) {
    const block = this.issues.get(key)!.blocks.find((item) => item.id === id)!;
    block.data = data;
    block.updated_by = 'alexey@datatalks.club';
    block.updated_at = this.stamp();
  }

  nextId = 200;
  typeKeys = ['intro', 'sponsor', 'sponsor_secondary', 'alexey_article', 'events_list', 'recording'];
  issueEdits: { subject?: string; preview_text?: string }[] = [];

  private renumber(issue: { blocks: FakeBlock[] }) {
    issue.blocks.sort((a, b) => a.position - b.position);
    issue.blocks.forEach((block, index) => { block.position = index; });
  }

  fetch = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const method = init?.method || 'GET';
    const u = new URL(String(url));
    this.calls.push(`${method} ${u.host}${u.pathname}`);
    this.apiKeySeen = String((init?.headers as Record<string, string>)?.authorization || '');
    const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
    if (u.pathname === '/api/newsletter-block-types') return reply(200, { block_types: this.typeKeys.map((type) => ({ type })) });
    const match = u.pathname.match(/^\/api\/newsletter-issues\/([^/]+)(\/blocks)?(?:\/(\d+))?$/);
    const issue = match && this.issues.get(decodeURIComponent(match[1]));
    if (!issue) return reply(404, { errors: { key: 'not_found' } });
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    const payload = () => ({ ...issue, preview_text: this.previews.get(match![1]) || '', updated_at: this.stamp() });
    if (!match![2]) {
      if (method === 'PUT') {
        this.issueEdits.push(body);
        if (typeof body.subject === 'string') issue.subject = body.subject;
        if (typeof body.preview_text === 'string') this.previews.set(match![1], body.preview_text);
      }
      this.renumber(issue);
      return reply(200, { issue: payload() });
    }
    if (!match![3]) {
      if (method !== 'POST') return reply(405, {});
      const block: FakeBlock = {
        id: ++this.nextId, position: typeof body.position === 'number' ? body.position - 0.5 : issue.blocks.length,
        type: body.type, data: body.data || {}, updated_by: 'api:dtc-newsletter', updated_at: this.stamp(),
      };
      issue.blocks.push(block);
      this.renumber(issue);
      return reply(201, { block });
    }
    const block = issue.blocks.find((item) => item.id === Number(match![3]));
    if (!block) return reply(404, { errors: { block_id: 'not_found' } });
    if (method === 'GET') {
      this.beforeBlockGet?.(block);
      return reply(200, { block });
    }
    if (method === 'DELETE') {
      issue.blocks = issue.blocks.filter((item) => item !== block);
      this.renumber(issue);
      return reply(200, { deleted: true });
    }
    if (body.type) block.type = body.type;
    if (body.data) block.data = body.data;
    if (body.data || body.type) {
      block.updated_by = 'api:dtc-newsletter';
      block.updated_at = this.stamp();
    }
    if (typeof body.position === 'number') {
      block.position = body.position - 0.5;
      this.renumber(issue);
    }
    return reply(200, { block });
  };
  previews = new Map<string, string>();
}

export const SECRETS: Record<string, string> = {
  'relay-production.dtc-newsletter-api-key': 'prod-key-123',
  'relay-dev.api-keys': JSON.stringify({ RELAY_API_KEY: 'dev-key-456', RELAY_WEBHOOK: 'x' }),
};

