export type MailingExportStatus = 'requested' | 'pending' | 'completed' | 'failed';

export type MailingExportErrorCategory =
  | 'authorization'
  | 'provider-api'
  | 'provider-timeout'
  | 'provider-concurrency'
  | 'download-integrity'
  | 'storage'
  | 'persistence'
  | 'task-link';

export interface MailingExportConfig {
  id: string;
  provider: string;
  account: string;
  /** Operator-facing label. Mailchimp exports the audiences stage account-wide. */
  scopeLabel: string;
  taskId?: string;
  credentialId: string;
  enabled?: boolean;
}

export interface MailingExportJob {
  id: string;
  configId: string;
  runKey: string;
  provider: string;
  account: string;
  scopeLabel: string;
  taskId?: string;
  providerJobId?: string;
  status: MailingExportStatus;
  requestedAt: string;
  completedAt?: string;
  filename?: string;
  checksum?: string;
  contentType?: 'application/zip';
  sizeBytes?: number;
  artifactId?: string;
  taskLinkStatus?: 'not-configured' | 'linked' | 'missing' | 'failed';
  errorCode?: MailingExportErrorCategory;
  errorMessage?: string;
  nextAction?: 'wait' | 'retry' | 'fix-authorization' | 'fix-storage' | 'fix-task-link' | 'download';
  retryAfter?: string;
  leaseOwner?: string;
  leaseExpiresAt?: number;
  createdAt: string;
  updatedAt: string;
}

export interface ProviderExportResult {
  status: 'pending' | 'completed';
  providerJobId: string;
  downloadUrl?: string;
  filename?: string;
  retryAfter?: string;
}

export interface MailingExportProvider {
  /** Provider-declared minimum interval between completed account exports. */
  readonly minimumIntervalMs?: number;
  requestExport(): Promise<ProviderExportResult>;
  checkExport(providerJobId: string): Promise<ProviderExportResult>;
  download(url: string): Promise<Buffer>;
}

export type MailingExportProviderFactory = (credential: Record<string, string>) => MailingExportProvider;
