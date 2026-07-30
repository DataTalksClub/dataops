import {
  digest,
  emailHash,
  identityHash,
  operationId,
  sourceKey as buildSourceKey,
} from "./canonical";
import {
  MigrationFailure,
  type ApprovedSource,
  type DestinationBooking,
  type DestinationContact,
  type DestinationOrganization,
  type DestinationSnapshot,
  type EntityKind,
  type MigrationPlan,
  type PlanOperation,
  type ResolutionManifest,
  type SourceCoordinate,
  type SourceManifest,
  type SponsorSourceV1,
} from "./types";

type InputSource = { manifest: ApprovedSource; data: SponsorSourceV1 };

const deterministicDestinationId = (kind: EntityKind, sourceKey: string) =>
  digest(`${kind}:${sourceKey}`);

function coordinate(source: ApprovedSource, kind: EntityKind, recordId: string): SourceCoordinate {
  return { sourceId: source.id, kind, recordIdHash: digest(`${source.immutableIdentity}\0${recordId}`) };
}

function operation(
  source: ApprovedSource,
  kind: EntityKind,
  recordId: string,
  payload: Record<string, unknown>,
): PlanOperation {
  const sourceKey = buildSourceKey(source.namespace, source.immutableIdentity, kind, recordId);
  return {
    operationId: operationId(sourceKey, kind),
    kind,
    coordinate: coordinate(source, kind, recordId),
    sourceKey,
    action: "create",
    destinationId: deterministicDestinationId(kind, sourceKey),
    dependencies: [],
    payload: { ...payload, sourceKey, sourceType: "historical-migration" },
    sourcePayloadHash: digest(payload),
  };
}

function quarantine(item: PlanOperation, reasonCode: string) {
  item.action = "quarantine";
  item.reasonCode = reasonCode;
}

function exactApprovedFields(source: ApprovedSource, kind: EntityKind, record: object) {
  const structural = new Set(["recordId"]);
  for (const key of Object.keys(record)) {
    if (structural.has(key)) continue;
    if (!source.approvedFields.includes(`${kind}s.${key}`))
      throw new MigrationFailure("unapproved-source-field");
  }
}

function dateReason(
  source: ApprovedSource,
  kind: EntityKind,
  observedAt: string | undefined,
  fallbackDate: string | undefined,
  cutoverTimestamp: string,
) {
  const date = observedAt || fallbackDate;
  if (!date)
    return kind === "booking" || !source.includeUndatedEntities
      ? "undated-record-not-approved"
      : undefined;
  if (source.observedEarliest && date < source.observedEarliest)
    return "record-before-approved-range";
  if (source.observedLatest && date > source.observedLatest)
    return "record-after-approved-range";
  if (`${date}T00:00:00.000Z` > cutoverTimestamp) return "record-after-cutover";
  return undefined;
}

function stableDestination(
  sourceId: string,
  stableId: string | undefined,
  mappings: { sourceId: string; destinationId: string }[],
) {
  if (!stableId) return undefined;
  return mappings.find((mapping) => mapping.sourceId === `${sourceId}:${stableId}`)?.destinationId;
}

function single<T>(items: T[], item: PlanOperation, ambiguousReason: string): T | undefined {
  if (items.length > 1) quarantine(item, ambiguousReason);
  return items.length === 1 ? items[0] : undefined;
}

function setReuse(item: PlanOperation, destination: { id: string; version: number }) {
  item.action = "reuse";
  item.destinationId = destination.id;
  item.expectedVersion = destination.version;
  delete item.payload;
}

function setPlannedReuse(item: PlanOperation, planned: PlanOperation) {
  item.action = "reuse";
  item.destinationId = planned.destinationId;
  item.dependencies = [...new Set([...item.dependencies, planned.operationId])];
  delete item.payload;
}

function approvalView(plan: Omit<MigrationPlan, "planDigest"> | MigrationPlan) {
  return {
    schemaVersion: plan.schemaVersion,
    manifestDigest: plan.manifestDigest,
    destinationSnapshotDigest: plan.destinationSnapshotDigest,
    operations: plan.operations.map(({ payload: _payload, ...item }) => item),
    reasonCounts: plan.reasonCounts,
  };
}

function finalize(
  manifestDigest: string,
  destinationSnapshotDigest: string,
  operations: PlanOperation[],
): MigrationPlan {
  operations.sort((left, right) => left.operationId.localeCompare(right.operationId));
  const reasonCounts: Record<string, number> = {};
  for (const operation of operations)
    if (operation.reasonCode)
      reasonCounts[operation.reasonCode] = (reasonCounts[operation.reasonCode] || 0) + 1;
  const base = {
    schemaVersion: 1 as const,
    manifestDigest,
    destinationSnapshotDigest,
    operations,
    reasonCounts: Object.fromEntries(Object.entries(reasonCounts).sort(([a], [b]) => a.localeCompare(b))),
  };
  return { ...base, planDigest: digest(approvalView(base)) };
}

export function buildMigrationPlan(input: {
  manifest: SourceManifest;
  manifestDigest: string;
  destinationSnapshot: DestinationSnapshot;
  destinationSnapshotDigest: string;
  sources: InputSource[];
}): MigrationPlan {
  if (input.manifest.destinationSnapshotSha256 !== input.destinationSnapshotDigest)
    throw new MigrationFailure("destination-snapshot-digest-mismatch");
  const operations: PlanOperation[] = [];
  const operationByRecord = new Map<string, PlanOperation>();
  const sourceKeys = new Set<string>();
  const stableSourceIds = {
    organization: new Map<string, PlanOperation>(),
    contact: new Map<string, PlanOperation>(),
    booking: new Map<string, PlanOperation>(),
  };
  const destination = input.destinationSnapshot;

  const remember = (
    source: ApprovedSource,
    kind: EntityKind,
    recordId: string,
    item: PlanOperation,
  ) => {
    const mapKey = `${source.id}\0${kind}\0${recordId}`;
    if (operationByRecord.has(mapKey)) quarantine(item, "duplicate-source-record-id");
    if (sourceKeys.has(item.sourceKey)) quarantine(item, "duplicate-source-key");
    operationByRecord.set(mapKey, item);
    sourceKeys.add(item.sourceKey);
    operations.push(item);
  };

  const checkStableDuplicate = (
    source: ApprovedSource,
    kind: EntityKind,
    stableId: string | undefined,
    item: PlanOperation,
  ) => {
    if (!stableId) return false;
    const key = `${source.id}:${stableId}`;
    const existing = stableSourceIds[kind].get(key);
    if (existing) {
      quarantine(existing, "duplicate-stable-source-id");
      quarantine(item, "duplicate-stable-source-id");
      return true;
    }
    stableSourceIds[kind].set(key, item);
    return false;
  };

  const organizationRows: {
    source: ApprovedSource;
    record: SponsorSourceV1["organizations"][number];
    item: PlanOperation;
  }[] = [];
  for (const { manifest: source, data } of input.sources) {
    for (const record of data.organizations) {
      exactApprovedFields(source, "organization", record);
      const item = operation(source, "organization", record.recordId, {
        displayName: record.displayName,
      });
      remember(source, "organization", record.recordId, item);
      organizationRows.push({ source, record, item });
      if (checkStableDuplicate(source, "organization", record.stableId, item)) continue;
      const rangeReason = dateReason(
        source, "organization", record.observedAt, undefined, input.manifest.cutoverTimestamp,
      );
      if (rangeReason) {
        quarantine(item, rangeReason);
        continue;
      }
      const bySourceKey = single(
        destination.organizations.filter((candidate) => candidate.sourceKey === item.sourceKey),
        item, "source-key-ambiguous",
      );
      if (item.action === "quarantine") continue;
      if (bySourceKey) {
        setReuse(item, bySourceKey);
        continue;
      }
      const mappedId = stableDestination(
        source.id, record.stableId, input.manifest.stableMappings.organizations,
      );
      if (mappedId) {
        const mapped = destination.organizations.find((candidate) => candidate.id === mappedId);
        if (!mapped || !mapped.active) quarantine(item, "stable-id-mapping-invalid");
        else setReuse(item, mapped);
        continue;
      }
    }
  }

  // Resolve every destination-authoritative match before choosing which source
  // row, if any, may create a new destination record. This makes source order
  // irrelevant when a later row has an exact sourceKey/stable match.
  for (const { record, item } of organizationRows) {
    if (item.action !== "create") continue;
    const sameName = destination.organizations.filter(
      (candidate) => candidate.active &&
        candidate.normalizedNameHash === identityHash(record.displayName),
    );
    if (sameName.length) {
      if (!record.strongDiscriminator) {
        quarantine(item, "organization-name-only");
        continue;
      }
      const matches = sameName.filter(
        (candidate) =>
          candidate.strongDiscriminatorHash === identityHash(record.strongDiscriminator!),
      );
      const exact = single(matches, item, "organization-strong-identity-ambiguous");
      if (exact) setReuse(item, exact);
      else if (matches.length <= 1)
        quarantine(item, "organization-strong-identity-conflict");
    }
  }
  const organizationIdentityGroups = new Map<string, PlanOperation[]>();
  const organizationIdentityBlockers = new Set([
    "source-key-ambiguous",
    "stable-id-mapping-invalid",
    "organization-strong-identity-ambiguous",
    "organization-strong-identity-conflict",
  ]);
  for (const { record, item } of organizationRows) {
    if (
      (item.action === "quarantine" &&
        !organizationIdentityBlockers.has(item.reasonCode || "")) ||
      !record.strongDiscriminator
    ) continue;
    const identity =
      `${identityHash(record.displayName)}:${identityHash(record.strongDiscriminator)}`;
    const group = organizationIdentityGroups.get(identity) || [];
    group.push(item);
    organizationIdentityGroups.set(identity, group);
  }
  for (const group of organizationIdentityGroups.values()) {
    if (group.some((item) => item.action === "quarantine")) {
      for (const item of group)
        if (item.action !== "quarantine") quarantine(item, "source-match-quarantined");
      continue;
    }
    const destinationIds = [...new Set(
      group.filter((item) => item.action === "reuse").map((item) => item.destinationId!),
    )].sort();
    if (destinationIds.length > 1) {
      for (const item of group)
        quarantine(item, "organization-strong-identity-ambiguous");
      continue;
    }
    if (destinationIds.length === 1) {
      const authoritative = destination.organizations.find(
        (candidate) => candidate.id === destinationIds[0],
      )!;
      for (const item of group)
        if (item.action === "create") setReuse(item, authoritative);
      continue;
    }
    const creates = group
      .filter((item) => item.action === "create")
      .sort((left, right) => left.operationId.localeCompare(right.operationId));
    const leader = creates[0];
    if (leader)
      for (const item of creates.slice(1)) setPlannedReuse(item, leader);
  }
  for (const item of operations.filter((candidate) =>
    candidate.kind === "organization" && candidate.action === "reuse"))
    if (item.dependencies.some((dependency) =>
      operations.find((candidate) => candidate.operationId === dependency)?.action === "quarantine"))
      quarantine(item, "source-match-quarantined");

  const contactRows: {
    source: ApprovedSource;
    record: SponsorSourceV1["contacts"][number];
    item: PlanOperation;
    organizationId?: string;
    hashes: string[];
  }[] = [];
  for (const { manifest: source, data } of input.sources) {
    for (const record of data.contacts) {
      exactApprovedFields(source, "contact", record);
      const organizationOperation = operationByRecord.get(
        `${source.id}\0organization\0${record.organizationRecordId}`,
      );
      const item = operation(source, "contact", record.recordId, {
        organizationId: organizationOperation?.destinationId,
        name: record.name,
        ...(record.emails ? {
          emails: [...new Set(record.emails.map((email) => email.trim().toLowerCase()))],
        } : {}),
      });
      if (organizationOperation) item.dependencies.push(organizationOperation.operationId);
      remember(source, "contact", record.recordId, item);
      const hashes = (record.emails || []).map(emailHash);
      const row = {
        source, record, item,
        organizationId: organizationOperation?.destinationId,
        hashes,
      };
      contactRows.push(row);
      if (checkStableDuplicate(source, "contact", record.stableId, item)) continue;
      const rangeReason = dateReason(
        source, "contact", record.observedAt, undefined, input.manifest.cutoverTimestamp,
      );
      if (rangeReason) {
        quarantine(item, rangeReason);
        continue;
      }
      if (!organizationOperation || organizationOperation.action === "quarantine") {
        quarantine(item, "invalid-organization-reference");
        continue;
      }
      const organizationId = organizationOperation.destinationId!;
      row.organizationId = organizationId;
      const bySourceKey = single(
        destination.contacts.filter((candidate) => candidate.sourceKey === item.sourceKey),
        item, "source-key-ambiguous",
      );
      if (item.action === "quarantine") continue;
      if (bySourceKey) {
        if (bySourceKey.organizationId !== organizationId)
          quarantine(item, "contact-organization-mismatch");
        else setReuse(item, bySourceKey);
        continue;
      }
      const mappedId = stableDestination(
        source.id, record.stableId, input.manifest.stableMappings.contacts,
      );
      if (mappedId) {
        const mapped = destination.contacts.find((candidate) => candidate.id === mappedId);
        if (!mapped || !mapped.active) quarantine(item, "stable-id-mapping-invalid");
        else if (mapped.organizationId !== organizationId)
          quarantine(item, "contact-organization-mismatch");
        else setReuse(item, mapped);
        continue;
      }
    }
  }

  for (const { item, organizationId, hashes } of contactRows) {
    if (item.action !== "create" || !organizationId) continue;
    if (hashes.length) {
      const emailMatches = destination.contacts.filter(
        (candidate) => candidate.active &&
          candidate.normalizedEmailHashes.some((hash) => hashes.includes(hash)),
      );
      const sameOrganization = emailMatches.filter(
        (candidate) => candidate.organizationId === organizationId,
      );
      const exact = single(sameOrganization, item, "contact-email-ambiguous");
      if (exact) setReuse(item, exact);
      else if (sameOrganization.length <= 1 && emailMatches.length)
        quarantine(item, "contact-organization-mismatch");
    }
  }

  // Email identity is a graph because a contact may carry multiple addresses.
  // Resolve each connected component globally so an exact destination match in
  // any row reserves that destination for every compatible historical row.
  const contactIdentityBlockers = new Set([
    "source-key-ambiguous",
    "stable-id-mapping-invalid",
    "contact-organization-mismatch",
    "contact-email-ambiguous",
  ]);
  const eligibleContactRows = contactRows.filter(
    (row) =>
      (row.item.action !== "quarantine" ||
        contactIdentityBlockers.has(row.item.reasonCode || "")) &&
      row.hashes.length > 0,
  );
  const rowByEmail = new Map<string, number[]>();
  eligibleContactRows.forEach((row, index) => {
    for (const hash of new Set(row.hashes)) {
      const indexes = rowByEmail.get(hash) || [];
      indexes.push(index);
      rowByEmail.set(hash, indexes);
    }
  });
  const visited = new Set<number>();
  for (let start = 0; start < eligibleContactRows.length; start++) {
    if (visited.has(start)) continue;
    const indexes: number[] = [];
    const queue = [start];
    let queueIndex = 0;
    visited.add(start);
    while (queueIndex < queue.length) {
      const index = queue[queueIndex++];
      indexes.push(index);
      for (const hash of eligibleContactRows[index].hashes)
        for (const neighbor of rowByEmail.get(hash) || [])
          if (!visited.has(neighbor)) {
            visited.add(neighbor);
            queue.push(neighbor);
          }
    }
    const group = indexes.map((index) => eligibleContactRows[index]);
    if (group.some((row) => row.item.action === "quarantine")) {
      for (const row of group)
        if (row.item.action !== "quarantine")
          quarantine(row.item, "source-match-quarantined");
      continue;
    }
    const organizationIds = [...new Set(group.map((row) => row.organizationId!))].sort();
    if (organizationIds.length > 1) {
      for (const row of group)
        quarantine(row.item, "contact-email-cross-organization-source");
      continue;
    }
    const destinationIds = [...new Set(
      group.filter((row) => row.item.action === "reuse")
        .map((row) => row.item.destinationId!),
    )].sort();
    if (destinationIds.length > 1) {
      for (const row of group)
        quarantine(row.item, "contact-email-source-ambiguous");
      continue;
    }
    if (destinationIds.length === 1) {
      const authoritative = destination.contacts.find(
        (candidate) => candidate.id === destinationIds[0],
      )!;
      for (const row of group)
        if (row.item.action === "create") setReuse(row.item, authoritative);
      continue;
    }
    const creates = group.map((row) => row.item)
      .filter((item) => item.action === "create")
      .sort((left, right) => left.operationId.localeCompare(right.operationId));
    const leader = creates[0];
    if (leader)
      for (const item of creates.slice(1)) setPlannedReuse(item, leader);
  }
  for (const item of operations.filter((candidate) =>
    candidate.kind === "contact" && candidate.action === "reuse"))
    if (item.dependencies.some((dependency) =>
      operations.find((candidate) => candidate.operationId === dependency)?.action === "quarantine"))
      quarantine(item, "source-match-quarantined");

  for (const { manifest: source, data } of input.sources) {
    for (const record of data.bookings) {
      exactApprovedFields(source, "booking", record);
      const organizationOperation = operationByRecord.get(
        `${source.id}\0organization\0${record.organizationRecordId}`,
      );
      const contactOperation = record.primaryContactRecordId
        ? operationByRecord.get(`${source.id}\0contact\0${record.primaryContactRecordId}`)
        : undefined;
      const status = input.manifest.bookingStatusMapping[record.sourceStatus];
      const item = operation(source, "booking", record.recordId, {
        organizationId: organizationOperation?.destinationId,
        ...(contactOperation ? { primaryContactId: contactOperation.destinationId } : {}),
        slotType: record.slotType,
        status,
        ...(record.plannedPublicationDate
          ? { plannedPublicationDate: record.plannedPublicationDate }
          : {}),
        ...(record.materialDeadline ? { materialDeadline: record.materialDeadline } : {}),
        ...(record.nextActionDate ? { nextActionDate: record.nextActionDate } : {}),
      });
      if (organizationOperation) item.dependencies.push(organizationOperation.operationId);
      if (contactOperation) item.dependencies.push(contactOperation.operationId);
      remember(source, "booking", record.recordId, item);
      if (checkStableDuplicate(source, "booking", record.stableId, item)) continue;
      const rangeReason = dateReason(
        source, "booking", record.plannedPublicationDate || record.observedAt, undefined,
        input.manifest.cutoverTimestamp,
      );
      if (rangeReason) {
        quarantine(item, rangeReason);
        continue;
      }
      if (!status) {
        quarantine(item, "status-mapping-missing");
        continue;
      }
      if (!organizationOperation || organizationOperation.action === "quarantine") {
        quarantine(item, "invalid-organization-reference");
        continue;
      }
      if (record.primaryContactRecordId &&
        (!contactOperation || contactOperation.action === "quarantine")) {
        quarantine(item, "invalid-contact-reference");
        continue;
      }
      const bySourceKey = single(
        destination.bookings.filter((candidate) => candidate.sourceKey === item.sourceKey),
        item, "source-key-ambiguous",
      );
      if (item.action === "quarantine") continue;
      if (bySourceKey) {
        if (bySourceKey.organizationId !== organizationOperation.destinationId)
          quarantine(item, "booking-organization-mismatch");
        else setReuse(item, bySourceKey);
        continue;
      }
      const mappedId = stableDestination(
        source.id, record.stableId, input.manifest.stableMappings.bookings,
      );
      if (mappedId) {
        const mapped = destination.bookings.find((candidate) => candidate.id === mappedId);
        if (!mapped) quarantine(item, "stable-id-mapping-invalid");
        else if (mapped.organizationId !== organizationOperation.destinationId)
          quarantine(item, "booking-organization-mismatch");
        else setReuse(item, mapped);
      }
    }
  }

  for (const { manifest: source, data } of input.sources) {
    for (const record of data.bookings) {
      const mapping = input.manifest.slotMappings.find(
        (candidate) => candidate.sourceBookingId === `${source.id}:${record.recordId}`,
      );
      if (!mapping) continue;
      const booking = operationByRecord.get(`${source.id}\0booking\0${record.recordId}`)!;
      const item: PlanOperation = {
        operationId: operationId(booking.sourceKey, "newsletter-link"),
        kind: "newsletter-link",
        coordinate: booking.coordinate,
        sourceKey: booking.sourceKey,
        action: "link",
        destinationId: mapping.destinationSlotId,
        expectedVersion: mapping.expectedSlotVersion,
        dependencies: [booking.operationId],
        payload: {
          bookingId: booking.destinationId,
          slotId: mapping.destinationSlotId,
          bookingExpectedVersion: booking.expectedVersion || 1,
          slotExpectedVersion: mapping.expectedSlotVersion,
        },
        sourcePayloadHash: digest(mapping),
      };
      operations.push(item);
      if (record.sourceSlotId && mapping.sourceSlotId !== record.sourceSlotId) {
        quarantine(item, "slot-source-mapping-conflict");
        continue;
      }
      if (booking.action === "quarantine") {
        quarantine(item, "invalid-booking-reference");
        continue;
      }
      const slot = destination.newsletterSlots.find(
        (candidate) => candidate.id === mapping.destinationSlotId,
      );
      if (!slot) {
        quarantine(item, "slot-mapping-invalid");
        continue;
      }
      if (
        slot.version !== mapping.expectedSlotVersion ||
        slot.status !== mapping.expectedNewsletterStatus
      ) {
        quarantine(item, "slot-state-disagreement");
        continue;
      }
      const bookingDestination = destination.bookings.find(
        (candidate) => candidate.id === booking.destinationId,
      );
      Object.assign(item.payload!, {
        previousBookingSlotId: bookingDestination?.scheduleEntryId,
        previousSlotBookingId: slot.sponsorBookingId,
      });
      if (
        (slot.sponsorBookingId && slot.sponsorBookingId !== booking.destinationId) ||
        (bookingDestination?.scheduleEntryId &&
          bookingDestination.scheduleEntryId !== slot.id)
      ) {
        quarantine(item, "slot-claim-conflict");
        continue;
      }
      if (
        slot.sponsorBookingId === booking.destinationId &&
        bookingDestination?.scheduleEntryId === slot.id
      ) {
        item.action = "reuse";
      }
    }
  }

  return finalize(input.manifestDigest, input.destinationSnapshotDigest, operations);
}

const SKIP_ONLY_REASONS = new Set([
  "undated-record-not-approved", "record-before-approved-range",
  "record-after-approved-range", "record-after-cutover", "status-mapping-missing",
  "invalid-organization-reference", "invalid-contact-reference",
  "invalid-booking-reference", "slot-state-disagreement", "slot-claim-conflict",
  "slot-source-mapping-conflict", "slot-mapping-invalid",
  "source-match-quarantined", "contact-email-cross-organization-source",
  "contact-email-source-ambiguous", "duplicate-stable-source-id",
]);

export function applyResolutions(
  unresolved: MigrationPlan,
  resolution: ResolutionManifest,
  destinationSnapshot: DestinationSnapshot,
): MigrationPlan {
  if (
    resolution.sourceManifestDigest !== unresolved.manifestDigest ||
    resolution.unresolvedPlanDigest !== unresolved.planDigest
  ) throw new MigrationFailure("stale-resolution-manifest");
  const decisions = new Map(resolution.decisions.map((item) => [item.operationId, item]));
  const unresolvedOperations = unresolved.operations.filter((item) => item.action === "quarantine");
  if (
    decisions.size !== unresolvedOperations.length ||
    unresolvedOperations.some((item) => !decisions.has(item.operationId))
  ) throw new MigrationFailure("incomplete-resolution-manifest");
  const operations = unresolved.operations.map((item): PlanOperation => {
    const decision = decisions.get(item.operationId);
    if (!decision) return { ...item, payload: item.payload ? { ...item.payload } : undefined };
    if (SKIP_ONLY_REASONS.has(item.reasonCode || "") && decision.action !== "skip")
      throw new MigrationFailure("unsafe-resolution-decision");
    if (decision.action === "reuse" && !decision.destinationId)
      throw new MigrationFailure("invalid-resolution-decision");
    if (decision.action === "link" && item.kind !== "newsletter-link")
      throw new MigrationFailure("invalid-resolution-decision");
    if (decision.action === "create" && item.kind === "newsletter-link")
      throw new MigrationFailure("invalid-resolution-decision");
    let expectedVersion: number | undefined;
    if (decision.action === "reuse") {
      const candidates = item.kind === "organization"
        ? destinationSnapshot.organizations
        : item.kind === "contact"
          ? destinationSnapshot.contacts
          : item.kind === "booking"
            ? destinationSnapshot.bookings
            : destinationSnapshot.newsletterSlots;
      const destination = candidates.find((candidate) => candidate.id === decision.destinationId);
      if (
        !destination ||
        decision.expectedVersion !== destination.version ||
        decision.destinationDigest !== digest(destination)
      ) throw new MigrationFailure("stale-resolution-decision");
      expectedVersion = destination.version;
    }
    return {
      ...item,
      action: decision.action,
      ...(decision.destinationId ? { destinationId: decision.destinationId } : {}),
      ...(expectedVersion !== undefined ? { expectedVersion } : {}),
      reasonCode: undefined,
      ...((decision.action === "reuse" && item.kind !== "newsletter-link") ||
        decision.action === "skip"
        ? { payload: undefined }
        : {}),
    };
  });
  return finalize(unresolved.manifestDigest, unresolved.destinationSnapshotDigest, operations);
}

export function redactedPlan(plan: MigrationPlan) {
  return approvalView(plan);
}

export function migrationCounts(plan: MigrationPlan) {
  const byAction: Record<string, number> = {};
  const byKind: Record<string, number> = {};
  for (const item of plan.operations) {
    byAction[item.action] = (byAction[item.action] || 0) + 1;
    byKind[item.kind] = (byKind[item.kind] || 0) + 1;
  }
  return {
    total: plan.operations.length,
    byAction: Object.fromEntries(Object.entries(byAction).sort(([a], [b]) => a.localeCompare(b))),
    byKind: Object.fromEntries(Object.entries(byKind).sort(([a], [b]) => a.localeCompare(b))),
    reasonCounts: plan.reasonCounts,
  };
}

export function findDestinationBooking(
  snapshot: DestinationSnapshot,
  operation: PlanOperation,
): DestinationBooking | undefined {
  return snapshot.bookings.find((item) => item.id === operation.destinationId);
}

export function findDestinationContact(
  snapshot: DestinationSnapshot,
  operation: PlanOperation,
): DestinationContact | undefined {
  return snapshot.contacts.find((item) => item.id === operation.destinationId);
}

export function findDestinationOrganization(
  snapshot: DestinationSnapshot,
  operation: PlanOperation,
): DestinationOrganization | undefined {
  return snapshot.organizations.find((item) => item.id === operation.destinationId);
}
