import type { CanonicalPayload, CommunicationType, ProviderFacts } from './core';

export type CommunicationSuggestion = {
  id: string;
  recordType: 'communication-suggestion';
  bookingId: string;
  organizationId: string;
  communicationType: CommunicationType;
  occurrenceKey: string;
  bookingVersion: number;
  eligible: boolean;
  safeReason: string;
  status: 'open' | 'dismissed' | 'ineligible';
  version: number;
  createdAt: string;
  updatedAt: string;
};

export type CommunicationDraftVersion = {
  id: string;
  recordType: 'communication-draft-version';
  communicationId: string;
  bookingId: string;
  version: number;
  suggestionId: string;
  payloadRef: string;
  payloadHash: string;
  previewHash: string;
  configDigest: string;
  createdBy: string;
  createdAt: string;
  claimedAttemptId?: string;
  abandonedAt?: string;
  ttl?: number;
};

export type CommunicationPrivatePayload = {
  id: string;
  recordType: 'communication-private-payload';
  communicationId: string;
  version: number;
  payload: CanonicalPayload;
  payloadHash: string;
  retentionAnchoredAt?: string;
  ttl?: number;
  createdAt: string;
};

export type CommunicationPresentation = {
  id: string;
  recordType: 'communication-presentation';
  communicationId: string;
  bookingId: string;
  payloadRef: string;
  draftVersion: number;
  payloadHash: string;
  previewHash: string;
  tokenHash: string;
  state: 'active' | 'consumed' | 'revoked' | 'expired';
  expiresAt: string;
  ttl: number;
  revision: number;
  createdBy: string;
  createdAt: string;
};

export type SponsorSendAttempt = {
  id: string;
  recordType: 'sponsor-send-attempt';
  communicationId: string;
  bookingId: string;
  draftVersion: number;
  payloadRef: string;
  payloadHash: string;
  previewHash: string;
  approverId: string;
  roleSnapshot: 'admin';
  status: 'queued' | 'executing' | 'accepted' | 'provider_observed' | 'failed_safe' | 'outcome_unknown' | 'cancelled' | 'resolved';
  derivedStatus: string;
  configDigest: string;
  configGeneration: number;
  sesAccount: string;
  sesRegion: string;
  sesIdentityArn: string;
  from: string;
  replyTo?: string;
  configurationSet: string;
  configurationSetGeneration: string;
  correlationHash: string;
  revision: number;
  dueKey?: string;
  dueAt?: string;
  leaseOwner?: string;
  leaseGeneration?: number;
  leaseExpiresAt?: string;
  dispatchStartedAt?: string;
  dispatchGeneration?: number;
  providerMessageId?: string;
  providerFacts?: ProviderFacts;
  recoveryBlocked: boolean;
  payloadDeleteAt?: number;
  createdAt: string;
  updatedAt: string;
  ttl: number;
};

export type SanitizedSesEvent = {
  schemaVersion: '1';
  eventId: string;
  eventTime: string;
  eventType: 'SEND' | 'DELIVERY' | 'DELIVERY_DELAY' | 'REJECT' | 'RENDERING_FAILURE' | 'BOUNCE' | 'COMPLAINT';
  messageId: string;
  awsAccount: string;
  awsRegion: string;
  configurationSet: string;
  configurationSetGeneration: string;
  attemptCorrelation: string;
  communicationId: string;
  configGeneration: string;
};
