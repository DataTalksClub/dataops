import type { MailingExportProvider, ProviderExportResult } from './types';

interface MailchimpCredentials { apiKey: string; server?: string }

export class MailingExportProviderError extends Error {
  constructor(
    public readonly category: 'authorization' | 'provider-api' | 'provider-timeout' | 'provider-concurrency' | 'download-integrity',
    message: string,
    public readonly retryAfter?: string,
  ) { super(message); this.name = 'MailingExportProviderError'; }
}

export class MailchimpProvider implements MailingExportProvider {
  readonly minimumIntervalMs = 24 * 60 * 60 * 1000;
  private readonly baseUrl: string;
  private readonly authorization: string;

  constructor(credentials: MailchimpCredentials, private readonly fetcher: typeof fetch = fetch) {
    if (!credentials.apiKey) throw new Error('Mailchimp secret must contain apiKey');
    const derived = credentials.apiKey.includes('-') ? credentials.apiKey.split('-').pop() : undefined;
    const server = credentials.server || derived;
    if (!server || !/^[a-z]{2,4}\d+$/i.test(server)) throw new MailingExportProviderError('authorization', 'Mailchimp server prefix is invalid');
    if (credentials.server && derived && credentials.server.toLowerCase() !== derived.toLowerCase()) {
      throw new MailingExportProviderError('authorization', 'Mailchimp server prefix does not match the API key');
    }
    this.baseUrl = `https://${server}.api.mailchimp.com/3.0`;
    this.authorization = `Basic ${Buffer.from(`dataops:${credentials.apiKey}`).toString('base64')}`;
  }

  async requestExport(): Promise<ProviderExportResult> {
    const response = await this.call(`${this.baseUrl}/account-exports`, {
      method: 'POST', headers: { Authorization: this.authorization, 'Content-Type': 'application/json' },
      body: JSON.stringify({ include_stages: ['audiences'] }),
    });
    return this.parseResponse(response, undefined, true);
  }

  async checkExport(providerJobId: string): Promise<ProviderExportResult> {
    const response = await this.call(`${this.baseUrl}/account-exports/${encodeURIComponent(providerJobId)}`, {
      headers: { Authorization: this.authorization },
    });
    return this.parseResponse(response, providerJobId);
  }

  async download(url: string): Promise<Buffer> {
    const response = await this.call(url);
    if (!response.ok) throw providerError(response, `Mailchimp export download failed (${response.status})`);
    return Buffer.from(await response.arrayBuffer());
  }

  private async call(url: string, init: RequestInit = {}): Promise<Response> {
    try {
      return await this.fetcher(url, { ...init, signal: init.signal || AbortSignal.timeout(20_000) });
    } catch (error) {
      const timeout = error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError');
      throw new MailingExportProviderError(timeout ? 'provider-timeout' : 'provider-api', timeout ? 'Mailchimp request timed out' : 'Mailchimp request failed');
    }
  }

  private async parseResponse(response: Response, fallbackId?: string, requestOperation = false): Promise<ProviderExportResult> {
    if (!response.ok) throw providerError(response, `Mailchimp API request failed (${response.status})`, requestOperation);
    const body = await response.json() as Record<string, unknown>;
    const id = String(body.id || body.export_id || fallbackId || '');
    if (!id) throw new MailingExportProviderError('provider-api', 'Mailchimp response did not include an export id');
    const url = typeof body.download_url === 'string' ? body.download_url : undefined;
    const finished = body.finished === true || body.status === 'completed' || body.status === 'finished';
    if (finished && !url) throw new MailingExportProviderError('provider-api', 'Mailchimp reported completion without a download URL');
    return {
      status: url || finished ? 'completed' : 'pending',
      providerJobId: id,
      downloadUrl: url,
      filename: typeof body.filename === 'string' ? body.filename : undefined,
    };
  }
}

function providerError(response: Response, message: string, requestOperation = false): MailingExportProviderError {
  const status = response.status;
  const retryAfterHeader = response.headers.get('retry-after');
  const retryAfter = retryAfterHeader && /^\d+$/.test(retryAfterHeader)
    ? new Date(Date.now() + Number(retryAfterHeader) * 1000).toISOString()
    : undefined;
  if (status === 401 || status === 403) return new MailingExportProviderError('authorization', message);
  if (status === 408 || status === 504) return new MailingExportProviderError('provider-timeout', message);
  if (status === 409 || status === 429 || (requestOperation && status === 400)) return new MailingExportProviderError('provider-concurrency', message, retryAfter);
  return new MailingExportProviderError('provider-api', message);
}
