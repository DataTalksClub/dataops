export type EntityKind = "organization" | "contact" | "booking";
export type OperationKind = EntityKind | "newsletter-link";
export type PlannedAction = "create" | "reuse" | "link" | "skip" | "quarantine";

export class MigrationFailure extends Error {
  constructor(readonly reason: string) {
    super(reason);
    this.name = "MigrationFailure";
  }
}

export type SourceOrganization = {
  recordId: string;
  stableId?: string;
  displayName: string;
  strongDiscriminator?: string;
  observedAt?: string;
};

export type SourceContact = {
  recordId: string;
  stableId?: string;
  organizationRecordId: string;
  name: string;
  emails?: string[];
  observedAt?: string;
};

export type SourceBooking = {
  recordId: string;
  stableId?: string;
  organizationRecordId: string;
  primaryContactRecordId?: string;
  slotType: "main" | "secondary" | "standalone";
  sourceStatus: string;
  plannedPublicationDate?: string;
  materialDeadline?: string;
  nextActionDate?: string;
  sourceSlotId?: string;
  observedAt?: string;
};

export type SponsorSourceV1 = {
  schemaVersion: 1;
  organizations: SourceOrganization[];
  contacts: SourceContact[];
  bookings: SourceBooking[];
};

export type ApprovedSource = {
  id: string;
  immutableIdentity: string;
  ownerRef: string;
  namespace: string;
  adapter: "sponsor-crm-json-v1";
  parserVersion: 1;
  sha256: string;
  approvedFields: string[];
  observedEarliest?: string;
  observedLatest?: string;
  includeUndatedEntities?: boolean;
};

export type StableMapping = {
  sourceId: string;
  destinationId: string;
};

export type SlotMapping = {
  sourceBookingId: string;
  sourceSlotId?: string;
  destinationSlotId: string;
  expectedSlotVersion: number;
  expectedNewsletterStatus: string;
};

export type SourceManifest = {
  schemaVersion: 1;
  approvedAt: string;
  approvedByRef: string;
  cutoverTimestamp: string;
  sources: ApprovedSource[];
  destinationSnapshotSha256: string;
  statusMappingVersion: 1;
  bookingStatusMapping: Record<string, string>;
  stableMappings: {
    organizations: StableMapping[];
    contacts: StableMapping[];
    bookings: StableMapping[];
  };
  slotMappings: SlotMapping[];
};

export type DestinationOrganization = {
  id: string;
  sourceKey?: string;
  version: number;
  active: boolean;
  normalizedNameHash: string;
  strongDiscriminatorHash?: string;
};

export type DestinationContact = {
  id: string;
  organizationId: string;
  sourceKey?: string;
  version: number;
  active: boolean;
  normalizedEmailHashes: string[];
};

export type DestinationBooking = {
  id: string;
  organizationId: string;
  primaryContactId?: string;
  sourceKey?: string;
  version: number;
  status: string;
  slotType: string;
  scheduleEntryId?: string;
};

export type DestinationNewsletterSlot = {
  id: string;
  version: number;
  status: string;
  sponsorBookingId?: string;
};

export type DestinationSnapshot = {
  schemaVersion: 1;
  generatedAt: string;
  originHash: string;
  organizations: DestinationOrganization[];
  contacts: DestinationContact[];
  bookings: DestinationBooking[];
  newsletterSlots: DestinationNewsletterSlot[];
};

export type SourceCoordinate = {
  sourceId: string;
  kind: EntityKind;
  recordIdHash: string;
};

export type MigrationPayload = Record<string, unknown>;

export type PlanOperation = {
  operationId: string;
  kind: OperationKind;
  coordinate: SourceCoordinate;
  sourceKey: string;
  action: PlannedAction;
  reasonCode?: string;
  destinationId?: string;
  expectedVersion?: number;
  dependencies: string[];
  payload?: MigrationPayload;
  sourcePayloadHash: string;
};

export type MigrationPlan = {
  schemaVersion: 1;
  manifestDigest: string;
  destinationSnapshotDigest: string;
  operations: PlanOperation[];
  reasonCounts: Record<string, number>;
  planDigest: string;
};

export type ResolutionDecision = {
  operationId: string;
  action: "reuse" | "create" | "link" | "skip";
  destinationId?: string;
  expectedVersion?: number;
  destinationDigest?: string;
};

export type ResolutionManifest = {
  schemaVersion: 1;
  sourceManifestDigest: string;
  unresolvedPlanDigest: string;
  approvedAt: string;
  approvedByRef: string;
  decisions: ResolutionDecision[];
};

export type ReviewedApproval = {
  schemaVersion: 1;
  runId: string;
  targetOrigin: string;
  expiresAt: string;
  manifestDigest: string;
  resolutionDigest: string;
  planDigest: string;
  destinationSnapshotDigest: string;
};

export type CheckpointOperation = {
  state: "pending" | "unknown" | "verified";
  destinationId?: string;
  postWriteVersion?: number;
  outcome?: "created" | "reused" | "linked";
};

export type MigrationCheckpoint = {
  schemaVersion: 1;
  runId: string;
  manifestDigest: string;
  resolutionDigest: string;
  planDigest: string;
  operations: Record<string, CheckpointOperation>;
};

export type RollbackEntry = {
  operationId: string;
  kind: OperationKind;
  destinationId: string;
  expectedVersion: number;
  expectedBookingVersion?: number;
  compensation: "archive" | "cancel" | "restore-link";
  previousDestinationId?: string;
  previousBookingSlotId?: string;
  previousSlotBookingId?: string;
};

export type RollbackPlan = {
  schemaVersion: 1;
  runId: string;
  entries: RollbackEntry[];
  planDigest: string;
};
