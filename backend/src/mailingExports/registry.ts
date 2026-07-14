import { MailchimpProvider } from './mailchimp';
import type { MailingExportProvider, MailingExportProviderFactory } from './types';

export class MailingExportProviderRegistry {
  private readonly factories = new Map<string, { factory: MailingExportProviderFactory; minimumIntervalMs: number }>();

  register(name: string, factory: MailingExportProviderFactory, options: { minimumIntervalMs?: number } = {}): this {
    this.factories.set(name, { factory, minimumIntervalMs: options.minimumIntervalMs || 0 });
    return this;
  }

  create(name: string, secret: Record<string, string>): MailingExportProvider {
    const entry = this.factories.get(name);
    if (!entry) throw new Error(`Unsupported mailing export provider: ${name}`);
    return entry.factory(secret);
  }

  minimumIntervalMs(name: string): number {
    return this.factories.get(name)?.minimumIntervalMs || 0;
  }
}

export const defaultMailingExportProviderRegistry = new MailingExportProviderRegistry()
  .register('mailchimp', secret => new MailchimpProvider({ apiKey: secret.apiKey, server: secret.server }), {
    minimumIntervalMs: 24 * 60 * 60 * 1000,
  });
