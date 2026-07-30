import { createHash } from "crypto";
import { promises as fs } from "fs";
import {
  MigrationFailure,
  type DestinationSnapshot,
  type ResolutionManifest,
  type SourceManifest,
  type SponsorSourceV1,
} from "./types";
import { digest } from "./canonical";

const HASH = /^[a-f0-9]{64}$/;
const OPAQUE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;
const NAMESPACE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,47}$/;
const DESTINATION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const BOOKING_STATUSES = new Set([
  "inquiry", "held", "confirmed", "materials-pending", "materials-ready",
  "scheduled", "published", "performance-due", "complete", "cancelled",
]);
const NEWSLETTER_STATUSES = new Set(["open", "reserved", "drafting", "scheduled", "sent", "cancelled"]);
const APPROVED_FIELDS = new Set([
  "organizations.recordId", "organizations.stableId", "organizations.displayName",
  "organizations.strongDiscriminator", "organizations.observedAt",
  "contacts.recordId", "contacts.stableId", "contacts.organizationRecordId",
  "contacts.name", "contacts.emails", "contacts.observedAt",
  "bookings.recordId", "bookings.stableId", "bookings.organizationRecordId",
  "bookings.primaryContactRecordId", "bookings.slotType", "bookings.sourceStatus",
  "bookings.plannedPublicationDate", "bookings.materialDeadline",
  "bookings.nextActionDate", "bookings.sourceSlotId", "bookings.observedAt",
]);

const exactKeys = (value: unknown, keys: string[]) =>
  !!value && typeof value === "object" && !Array.isArray(value) &&
  Object.keys(value as Record<string, unknown>).every((key) => keys.includes(key));

function validDate(value: unknown) {
  if (typeof value !== "string" || !DATE.test(value)) return false;
  return new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
}

function validTimestamp(value: unknown) {
  return typeof value === "string" && DATE_TIME.test(value) &&
    Number.isFinite(Date.parse(value)) && new Date(value).toISOString() ===
      (value.length === 20 ? value.replace("Z", ".000Z") : value);
}

export function validateSourceManifest(value: unknown): SourceManifest {
  if (!exactKeys(value, [
    "schemaVersion", "approvedAt", "approvedByRef", "cutoverTimestamp", "sources",
    "destinationSnapshotSha256", "statusMappingVersion", "bookingStatusMapping",
    "stableMappings", "slotMappings",
  ])) throw new MigrationFailure("invalid-source-manifest");
  const manifest = value as SourceManifest;
  if (
    manifest.schemaVersion !== 1 ||
    !validTimestamp(manifest.approvedAt) ||
    !OPAQUE.test(manifest.approvedByRef) ||
    !validTimestamp(manifest.cutoverTimestamp) ||
    !HASH.test(manifest.destinationSnapshotSha256) ||
    manifest.statusMappingVersion !== 1 ||
    !Array.isArray(manifest.sources) || !manifest.sources.length || manifest.sources.length > 50 ||
    !manifest.bookingStatusMapping || typeof manifest.bookingStatusMapping !== "object" ||
    Array.isArray(manifest.bookingStatusMapping) ||
    Object.keys(manifest.bookingStatusMapping).length > 1_000 ||
    !exactKeys(manifest.stableMappings, ["organizations", "contacts", "bookings"]) ||
    !Array.isArray(manifest.slotMappings) || manifest.slotMappings.length > 100_000
  ) throw new MigrationFailure("invalid-source-manifest");
  const ids = new Set<string>(), identities = new Set<string>();
  for (const source of manifest.sources) {
    if (
      !exactKeys(source, [
        "id", "immutableIdentity", "ownerRef", "namespace", "adapter", "parserVersion",
        "sha256", "approvedFields", "observedEarliest", "observedLatest",
        "includeUndatedEntities",
      ]) ||
      !OPAQUE.test(source.id) || ids.has(source.id) ||
      !OPAQUE.test(source.immutableIdentity) || identities.has(source.immutableIdentity) ||
      !OPAQUE.test(source.ownerRef) || !NAMESPACE.test(source.namespace) ||
      source.adapter !== "sponsor-crm-json-v1" || source.parserVersion !== 1 ||
      !HASH.test(source.sha256) || !Array.isArray(source.approvedFields) ||
      !source.approvedFields.length || source.approvedFields.some((field) => !APPROVED_FIELDS.has(field)) ||
      new Set(source.approvedFields).size !== source.approvedFields.length ||
      (source.observedEarliest !== undefined && !validDate(source.observedEarliest)) ||
      (source.observedLatest !== undefined && !validDate(source.observedLatest)) ||
      (source.observedEarliest && source.observedLatest &&
        source.observedEarliest > source.observedLatest) ||
      (source.includeUndatedEntities !== undefined &&
        typeof source.includeUndatedEntities !== "boolean")
    ) throw new MigrationFailure("invalid-approved-source");
    ids.add(source.id);
    identities.add(source.immutableIdentity);
  }
  for (const [sourceStatus, destinationStatus] of Object.entries(manifest.bookingStatusMapping))
    if (!OPAQUE.test(sourceStatus) || !BOOKING_STATUSES.has(destinationStatus))
      throw new MigrationFailure("invalid-status-mapping");
  for (const kind of ["organizations", "contacts", "bookings"] as const) {
    const mappings = manifest.stableMappings[kind];
    if (!Array.isArray(mappings) || mappings.length > 100_000)
      throw new MigrationFailure("invalid-stable-mapping");
    const sourceIds = new Set<string>(), destinationIds = new Set<string>();
    for (const mapping of mappings) {
      if (
        !exactKeys(mapping, ["sourceId", "destinationId"]) ||
        !OPAQUE.test(mapping.sourceId) || !DESTINATION_ID.test(mapping.destinationId) ||
        sourceIds.has(mapping.sourceId) || destinationIds.has(mapping.destinationId)
      ) throw new MigrationFailure("invalid-stable-mapping");
      sourceIds.add(mapping.sourceId);
      destinationIds.add(mapping.destinationId);
    }
  }
  const mappedBookings = new Set<string>(), mappedSlots = new Set<string>();
  for (const mapping of manifest.slotMappings) {
    if (
      !exactKeys(mapping, [
        "sourceBookingId", "sourceSlotId", "destinationSlotId",
        "expectedSlotVersion", "expectedNewsletterStatus",
      ]) ||
      !OPAQUE.test(mapping.sourceBookingId) ||
      (mapping.sourceSlotId !== undefined && !OPAQUE.test(mapping.sourceSlotId)) ||
      !DESTINATION_ID.test(mapping.destinationSlotId) ||
      !Number.isSafeInteger(mapping.expectedSlotVersion) || mapping.expectedSlotVersion < 1 ||
      !NEWSLETTER_STATUSES.has(mapping.expectedNewsletterStatus) ||
      mappedBookings.has(mapping.sourceBookingId) || mappedSlots.has(mapping.destinationSlotId)
    ) throw new MigrationFailure("invalid-slot-mapping");
    mappedBookings.add(mapping.sourceBookingId);
    mappedSlots.add(mapping.destinationSlotId);
  }
  return manifest;
}

export function validateSourceData(value: unknown): SponsorSourceV1 {
  if (!exactKeys(value, ["schemaVersion", "organizations", "contacts", "bookings"]))
    throw new MigrationFailure("invalid-source-data");
  const source = value as SponsorSourceV1;
  if (
    source.schemaVersion !== 1 ||
    !Array.isArray(source.organizations) || !Array.isArray(source.contacts) ||
    !Array.isArray(source.bookings) ||
    source.organizations.length + source.contacts.length + source.bookings.length > 100_000
  ) throw new MigrationFailure("invalid-source-data");
  const recordId = (candidate: unknown) => typeof candidate === "string" && OPAQUE.test(candidate);
  for (const organization of source.organizations)
    if (
      !exactKeys(organization, [
        "recordId", "stableId", "displayName", "strongDiscriminator", "observedAt",
      ]) ||
      !recordId(organization.recordId) ||
      (organization.stableId !== undefined && !recordId(organization.stableId)) ||
      typeof organization.displayName !== "string" || !organization.displayName.trim() ||
      organization.displayName.length > 200 ||
      (organization.strongDiscriminator !== undefined &&
        (typeof organization.strongDiscriminator !== "string" ||
          !organization.strongDiscriminator.trim() ||
          organization.strongDiscriminator.length > 300)) ||
      (organization.observedAt !== undefined && !validDate(organization.observedAt))
    ) throw new MigrationFailure("invalid-source-organization");
  for (const contact of source.contacts)
    if (
      !exactKeys(contact, [
        "recordId", "stableId", "organizationRecordId", "name", "emails", "observedAt",
      ]) ||
      !recordId(contact.recordId) || !recordId(contact.organizationRecordId) ||
      (contact.stableId !== undefined && !recordId(contact.stableId)) ||
      typeof contact.name !== "string" || !contact.name.trim() || contact.name.length > 200 ||
      (contact.emails !== undefined && (
        !Array.isArray(contact.emails) || contact.emails.length > 10 ||
        contact.emails.some((email) =>
          typeof email !== "string" || email.length > 254 ||
          !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email))
      )) ||
      (contact.observedAt !== undefined && !validDate(contact.observedAt))
    ) throw new MigrationFailure("invalid-source-contact");
  for (const booking of source.bookings)
    if (
      !exactKeys(booking, [
        "recordId", "stableId", "organizationRecordId", "primaryContactRecordId",
        "slotType", "sourceStatus", "plannedPublicationDate", "materialDeadline",
        "nextActionDate", "sourceSlotId", "observedAt",
      ]) ||
      !recordId(booking.recordId) || !recordId(booking.organizationRecordId) ||
      (booking.stableId !== undefined && !recordId(booking.stableId)) ||
      (booking.primaryContactRecordId !== undefined &&
        !recordId(booking.primaryContactRecordId)) ||
      !["main", "secondary", "standalone"].includes(booking.slotType) ||
      !recordId(booking.sourceStatus) ||
      ["plannedPublicationDate", "materialDeadline", "nextActionDate", "observedAt"]
        .some((field) => (booking as Record<string, unknown>)[field] !== undefined &&
          !validDate((booking as Record<string, unknown>)[field])) ||
      (booking.sourceSlotId !== undefined && !recordId(booking.sourceSlotId))
    ) throw new MigrationFailure("invalid-source-booking");
  return source;
}

export function validateDestinationSnapshot(value: unknown): DestinationSnapshot {
  if (!exactKeys(value, [
    "schemaVersion", "generatedAt", "originHash", "organizations", "contacts",
    "bookings", "newsletterSlots",
  ])) throw new MigrationFailure("invalid-destination-snapshot");
  const snapshot = value as DestinationSnapshot;
  if (
    snapshot.schemaVersion !== 1 || !validTimestamp(snapshot.generatedAt) ||
    !HASH.test(snapshot.originHash) ||
    !Array.isArray(snapshot.organizations) || !Array.isArray(snapshot.contacts) ||
    !Array.isArray(snapshot.bookings) || !Array.isArray(snapshot.newsletterSlots) ||
    [snapshot.organizations, snapshot.contacts, snapshot.bookings,
      snapshot.newsletterSlots].some((items) => items.length > 100_000)
  ) throw new MigrationFailure("invalid-destination-snapshot");
  const sourceKey = (candidate: unknown) =>
    candidate === undefined ||
    (typeof candidate === "string" && candidate.length >= 1 && candidate.length <= 200);
  const version = (candidate: unknown) =>
    Number.isSafeInteger(candidate) && Number(candidate) >= 1;
  const uniqueIds = <T extends { id: string }>(items: T[]) =>
    new Set(items.map((item) => item.id)).size === items.length;
  if (
    !uniqueIds(snapshot.organizations) || !uniqueIds(snapshot.contacts) ||
    !uniqueIds(snapshot.bookings) || !uniqueIds(snapshot.newsletterSlots)
  ) throw new MigrationFailure("invalid-destination-snapshot");
  for (const item of snapshot.organizations)
    if (
      !exactKeys(item, [
        "id", "sourceKey", "version", "active", "normalizedNameHash",
        "strongDiscriminatorHash",
      ]) ||
      !DESTINATION_ID.test(item.id) || !sourceKey(item.sourceKey) ||
      !version(item.version) || typeof item.active !== "boolean" ||
      !HASH.test(item.normalizedNameHash) ||
      (item.strongDiscriminatorHash !== undefined &&
        !HASH.test(item.strongDiscriminatorHash))
    ) throw new MigrationFailure("invalid-destination-snapshot");
  for (const item of snapshot.contacts)
    if (
      !exactKeys(item, [
        "id", "organizationId", "sourceKey", "version", "active",
        "normalizedEmailHashes",
      ]) ||
      !DESTINATION_ID.test(item.id) || !DESTINATION_ID.test(item.organizationId) ||
      !sourceKey(item.sourceKey) || !version(item.version) ||
      typeof item.active !== "boolean" ||
      !Array.isArray(item.normalizedEmailHashes) ||
      item.normalizedEmailHashes.length > 10 ||
      item.normalizedEmailHashes.some((hash) => !HASH.test(hash)) ||
      new Set(item.normalizedEmailHashes).size !== item.normalizedEmailHashes.length
    ) throw new MigrationFailure("invalid-destination-snapshot");
  for (const item of snapshot.bookings)
    if (
      !exactKeys(item, [
        "id", "organizationId", "primaryContactId", "sourceKey", "version",
        "status", "slotType", "scheduleEntryId",
      ]) ||
      !DESTINATION_ID.test(item.id) || !DESTINATION_ID.test(item.organizationId) ||
      (item.primaryContactId !== undefined &&
        !DESTINATION_ID.test(item.primaryContactId)) ||
      !sourceKey(item.sourceKey) || !version(item.version) ||
      !BOOKING_STATUSES.has(item.status) ||
      !["main", "secondary", "standalone"].includes(item.slotType) ||
      (item.scheduleEntryId !== undefined &&
        !DESTINATION_ID.test(item.scheduleEntryId))
    ) throw new MigrationFailure("invalid-destination-snapshot");
  for (const item of snapshot.newsletterSlots)
    if (
      !exactKeys(item, ["id", "version", "status", "sponsorBookingId"]) ||
      !DESTINATION_ID.test(item.id) || !version(item.version) ||
      !NEWSLETTER_STATUSES.has(item.status) ||
      (item.sponsorBookingId !== undefined &&
        !DESTINATION_ID.test(item.sponsorBookingId))
    ) throw new MigrationFailure("invalid-destination-snapshot");
  return snapshot;
}

export function validateResolutionManifest(value: unknown): ResolutionManifest {
  if (!exactKeys(value, [
    "schemaVersion", "sourceManifestDigest", "unresolvedPlanDigest", "approvedAt",
    "approvedByRef", "decisions",
  ])) throw new MigrationFailure("invalid-resolution-manifest");
  const resolution = value as ResolutionManifest;
  if (
    resolution.schemaVersion !== 1 || !HASH.test(resolution.sourceManifestDigest) ||
    !HASH.test(resolution.unresolvedPlanDigest) || !validTimestamp(resolution.approvedAt) ||
    !OPAQUE.test(resolution.approvedByRef) || !Array.isArray(resolution.decisions) ||
    resolution.decisions.length > 100_000
  ) throw new MigrationFailure("invalid-resolution-manifest");
  const operationIds = new Set<string>();
  for (const decision of resolution.decisions) {
    if (
      !exactKeys(decision, [
        "operationId", "action", "destinationId", "expectedVersion", "destinationDigest",
      ]) ||
      !HASH.test(decision.operationId) ||
      !["reuse", "create", "link", "skip"].includes(decision.action) ||
      (decision.destinationId !== undefined && !OPAQUE.test(decision.destinationId)) ||
      (decision.expectedVersion !== undefined &&
        (!Number.isSafeInteger(decision.expectedVersion) ||
          decision.expectedVersion < 1)) ||
      (decision.destinationDigest !== undefined && !HASH.test(decision.destinationDigest)) ||
      (decision.action === "reuse" &&
        (decision.destinationId === undefined || decision.expectedVersion === undefined ||
          decision.destinationDigest === undefined)) ||
      (decision.action !== "reuse" &&
        (decision.expectedVersion !== undefined || decision.destinationDigest !== undefined)) ||
      operationIds.has(decision.operationId)
    ) throw new MigrationFailure("invalid-resolution-decision");
    operationIds.add(decision.operationId);
  }
  return resolution;
}

export async function readPrivateJson(file: string, maximumBytes = 16 * 1024 * 1024) {
  const stat = await fs.lstat(file).catch(() => null);
  if (
    !stat?.isFile() || stat.isSymbolicLink() || stat.size > maximumBytes ||
    (stat.mode & 0o077) !== 0 ||
    (typeof process.getuid === "function" && stat.uid !== process.getuid())
  ) throw new MigrationFailure("unsafe-private-input");
  try {
    return JSON.parse(await fs.readFile(file, "utf8")) as unknown;
  } catch {
    throw new MigrationFailure("invalid-private-json");
  }
}

export async function sourceFileDigest(file: string) {
  const stat = await fs.lstat(file).catch(() => null);
  if (
    !stat?.isFile() || stat.isSymbolicLink() || stat.size > 64 * 1024 * 1024 ||
    (stat.mode & 0o077) !== 0 ||
    (typeof process.getuid === "function" && stat.uid !== process.getuid())
  ) throw new MigrationFailure("unsafe-private-input");
  return createHash("sha256").update(await fs.readFile(file)).digest("hex");
}
