import { digest, emailHash, identityHash } from "./canonical";
import type { SponsorMigrationApi } from "./api";
import {
  MigrationFailure,
  type MigrationCheckpoint,
  type MigrationPlan,
  type PlanOperation,
  type DestinationSnapshot,
  type RollbackEntry,
  type RollbackPlan,
} from "./types";

type Api = Pick<SponsorMigrationApi, "read" | "readOptional" | "mutate">;
type PersistCheckpoint = (checkpoint: MigrationCheckpoint) => Promise<void>;
type RecordValue = Record<string, unknown> & { id: string; version: number };

function expectedCreatedRecord(operation: PlanOperation): Record<string, unknown> {
  const payload = operation.payload || {};
  if (operation.kind === "organization")
    return {
      id: operation.destinationId,
      sourceKey: operation.sourceKey,
      version: 1,
      active: true,
      normalizedNameHash: identityHash(String(payload.displayName || "")),
    };
  if (operation.kind === "contact")
    return {
      id: operation.destinationId,
      organizationId: String(payload.organizationId || ""),
      sourceKey: operation.sourceKey,
      version: 1,
      active: true,
      normalizedEmailHashes: Array.isArray(payload.emails)
        ? [...new Set(payload.emails.map((email) => emailHash(String(email))))].sort()
        : [],
    };
  if (operation.kind === "booking")
    return {
      id: operation.destinationId,
      organizationId: String(payload.organizationId || ""),
      ...(typeof payload.primaryContactId === "string"
        ? { primaryContactId: payload.primaryContactId }
        : {}),
      sourceKey: operation.sourceKey,
      version: 1,
      status: String(payload.status || ""),
      slotType: String(payload.slotType || ""),
    };
  throw new MigrationFailure("invalid-operation-kind");
}

function withoutLinkState(record: Record<string, unknown>) {
  const copy = { ...record };
  delete copy.version;
  delete copy.scheduleEntryId;
  delete copy.sponsorBookingId;
  return copy;
}

function sameRecord(left: unknown, right: unknown) {
  return digest(left) === digest(right);
}

/**
 * Revalidates the complete approved destination snapshot on every resume. The
 * only accepted differences are deterministic creates and either side of a
 * checkpointed link whose outcome may have been unknown at process exit.
 */
export function validateApprovedDestinationState(input: {
  approved: DestinationSnapshot;
  current: DestinationSnapshot;
  plan: MigrationPlan;
  checkpoint: MigrationCheckpoint;
}) {
  const { approved, current, plan, checkpoint } = input;
  if (approved.originHash !== current.originHash)
    throw new MigrationFailure("destination-changed-after-approval");
  const operations = new Map(plan.operations.map((item) => [item.operationId, item]));
  for (const operationId of Object.keys(checkpoint.operations))
    if (!operations.has(operationId)) throw new MigrationFailure("stale-checkpoint");

  const linkByBooking = new Map<string, PlanOperation>();
  const linkBySlot = new Map<string, PlanOperation>();
  for (const operation of plan.operations)
    if (operation.kind === "newsletter-link" &&
      checkpoint.operations[operation.operationId]) {
      linkByBooking.set(String(operation.payload?.bookingId || ""), operation);
      linkBySlot.set(String(operation.payload?.slotId || operation.destinationId || ""), operation);
    }

  const validateCollection = (
    kind: "organization" | "contact" | "booking" | "newsletter-link",
    approvedRecords: RecordValue[],
    currentRecords: RecordValue[],
  ) => {
    const approvedById = new Map(approvedRecords.map((item) => [item.id, item]));
    const currentById = new Map(currentRecords.map((item) => [item.id, item]));
    const created = plan.operations.filter((item) =>
      item.kind === kind && item.action === "create" &&
      checkpoint.operations[item.operationId]);
    const allowedIds = new Set([...approvedById.keys(), ...created.map((item) => item.destinationId!)]);
    if ([...currentById.keys()].some((id) => !allowedIds.has(id)))
      throw new MigrationFailure("destination-changed-after-approval");

    for (const operation of created) {
      const record = currentById.get(operation.destinationId!);
      const saved = checkpoint.operations[operation.operationId];
      if (!record) {
        if (saved.state === "verified")
          throw new MigrationFailure("stale-checkpoint");
        continue;
      }
      const expected = expectedCreatedRecord(operation);
      const link = kind === "booking" ? linkByBooking.get(record.id) : undefined;
      const desired = link && record.scheduleEntryId ===
        String(link.payload?.slotId || link.destinationId);
      const expectedVersion = desired ? 2 : 1;
      if (
        record.version !== expectedVersion ||
        !sameRecord(withoutLinkState(record), withoutLinkState(expected)) ||
        (saved.state === "verified" && saved.postWriteVersion !== 1)
      ) throw new MigrationFailure("concurrent-destination-change");
    }

    for (const approvedRecord of approvedRecords) {
      const record = currentById.get(approvedRecord.id);
      if (!record) throw new MigrationFailure("destination-changed-after-approval");
      const link = kind === "booking"
        ? linkByBooking.get(record.id)
        : kind === "newsletter-link"
          ? linkBySlot.get(record.id)
          : undefined;
      if (!link) {
        if (!sameRecord(record, approvedRecord))
          throw new MigrationFailure("destination-changed-after-approval");
        continue;
      }
      const desiredId = kind === "booking"
        ? String(link.payload?.slotId || link.destinationId)
        : String(link.payload?.bookingId || "");
      const field = kind === "booking" ? "scheduleEntryId" : "sponsorBookingId";
      const original = approvedRecord[field];
      const linked = record[field] === desiredId;
      if (
        !sameRecord(withoutLinkState(record), withoutLinkState(approvedRecord)) ||
        (!linked && record[field] !== original) ||
        record.version !== approvedRecord.version + (linked && original !== desiredId ? 1 : 0)
      ) throw new MigrationFailure("concurrent-destination-change");
      if (checkpoint.operations[link.operationId].state === "verified" && !linked)
        throw new MigrationFailure("stale-checkpoint");
    }
  };

  validateCollection(
    "organization", approved.organizations as RecordValue[],
    current.organizations as RecordValue[],
  );
  validateCollection("contact", approved.contacts as RecordValue[], current.contacts as RecordValue[]);
  validateCollection("booking", approved.bookings as RecordValue[], current.bookings as RecordValue[]);
  validateCollection(
    "newsletter-link", approved.newsletterSlots as RecordValue[],
    current.newsletterSlots as RecordValue[],
  );
}

const endpoint = (kind: PlanOperation["kind"]) => {
  if (kind === "organization") return "organizations";
  if (kind === "contact") return "contacts";
  if (kind === "booking") return "bookings";
  throw new MigrationFailure("invalid-operation-kind");
};

function matchesPayload(record: Record<string, unknown>, operation: PlanOperation) {
  return !!operation.payload && Object.entries(operation.payload).every(
    ([key, value]) => JSON.stringify(record[key]) === JSON.stringify(value),
  );
}

async function recordFor(api: Api, operation: PlanOperation) {
  return api.readOptional<RecordValue>(
    `/api/sponsor-crm/${endpoint(operation.kind)}/${encodeURIComponent(operation.destinationId!)}`,
  );
}

async function requireExpectedRecord(api: Api, operation: PlanOperation) {
  const record = await recordFor(api, operation);
  if (!record) throw new MigrationFailure("destination-record-missing");
  if (
    operation.action === "create" &&
    (!matchesPayload(record, operation) || record.id !== operation.destinationId)
  ) throw new MigrationFailure("destination-record-conflict");
  if (
    operation.action === "reuse" &&
    operation.expectedVersion !== undefined &&
    record.version !== operation.expectedVersion
  ) throw new MigrationFailure("concurrent-destination-change");
  return record;
}

async function createWithReconciliation(
  api: Api,
  operation: PlanOperation,
  checkpoint: MigrationCheckpoint,
  persist: PersistCheckpoint,
) {
  const saved = checkpoint.operations[operation.operationId];
  const existing = await recordFor(api, operation);
  if (existing) {
    if (!saved || !["pending", "unknown", "verified"].includes(saved.state))
      throw new MigrationFailure("unexpected-destination-record");
    if (!matchesPayload(existing, operation) || existing.version !== 1)
      throw new MigrationFailure("destination-record-conflict");
    checkpoint.operations[operation.operationId] = {
      state: "verified",
      destinationId: existing.id,
      postWriteVersion: existing.version,
      outcome: "created",
    };
    await persist(checkpoint);
    return;
  }
  checkpoint.operations[operation.operationId] = {
    state: "pending",
    destinationId: operation.destinationId,
  };
  await persist(checkpoint);
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await api.mutate<RecordValue>(
        "POST",
        `/api/sponsor-crm/${endpoint(operation.kind)}`,
        operation.payload,
      );
    } catch (error) {
      if (!(error instanceof MigrationFailure) || error.reason !== "api-outcome-unknown")
        throw error;
      checkpoint.operations[operation.operationId] = {
        state: "unknown",
        destinationId: operation.destinationId,
      };
      await persist(checkpoint);
    }
    const reconciled = await recordFor(api, operation);
    if (reconciled) {
      if (!matchesPayload(reconciled, operation) || reconciled.version !== 1)
        throw new MigrationFailure("destination-record-conflict");
      checkpoint.operations[operation.operationId] = {
        state: "verified",
        destinationId: reconciled.id,
        postWriteVersion: reconciled.version,
        outcome: "created",
      };
      await persist(checkpoint);
      return;
    }
  }
  throw new MigrationFailure("api-outcome-unresolved");
}

async function currentLink(api: Api, operation: PlanOperation) {
  const payload = operation.payload || {};
  const bookingId = String(payload.bookingId || "");
  const slotId = String(payload.slotId || operation.destinationId || "");
  const [booking, slot] = await Promise.all([
    api.readOptional<RecordValue & { scheduleEntryId?: string }>(
      `/api/sponsor-crm/bookings/${encodeURIComponent(bookingId)}`,
    ),
    api.readOptional<RecordValue & { sponsorBookingId?: string }>(
      `/api/newsletter-slots/${encodeURIComponent(slotId)}`,
    ),
  ]);
  if (!booking || !slot) throw new MigrationFailure("destination-record-missing");
  if (
    (booking.scheduleEntryId && booking.scheduleEntryId !== slotId) ||
    (slot.sponsorBookingId && slot.sponsorBookingId !== bookingId)
  ) throw new MigrationFailure("incompatible-slot-claim");
  const bookingExpectedVersion = Number(payload.bookingExpectedVersion);
  const slotExpectedVersion = Number(payload.slotExpectedVersion);
  if (
    !Number.isSafeInteger(bookingExpectedVersion) ||
    !Number.isSafeInteger(slotExpectedVersion)
  ) throw new MigrationFailure("invalid-operation-version");
  const bookingWasLinked = payload.previousBookingSlotId === slotId;
  const slotWasLinked = payload.previousSlotBookingId === bookingId;
  const expectedBookingVersion = bookingExpectedVersion +
    (booking.scheduleEntryId === slotId && !bookingWasLinked ? 1 : 0);
  const expectedSlotVersion = slotExpectedVersion +
    (slot.sponsorBookingId === bookingId && !slotWasLinked ? 1 : 0);
  if (
    booking.version !== expectedBookingVersion ||
    slot.version !== expectedSlotVersion
  ) throw new MigrationFailure("concurrent-destination-change");
  return { booking, slot, bookingId, slotId };
}

async function linkWithReconciliation(
  api: Api,
  operation: PlanOperation,
  checkpoint: MigrationCheckpoint,
  persist: PersistCheckpoint,
) {
  checkpoint.operations[operation.operationId] ||= {
    state: "pending",
    destinationId: operation.destinationId,
  };
  await persist(checkpoint);
  for (let pass = 0; pass < 4; pass++) {
    let state = await currentLink(api, operation);
    if (!state.booking.scheduleEntryId) {
      try {
        await api.mutate(
          "PUT",
          `/api/sponsor-crm/bookings/${encodeURIComponent(state.bookingId)}/schedule-link`,
          {
            version: Number(operation.payload?.bookingExpectedVersion),
            scheduleEntryId: state.slotId,
          },
        );
      } catch (error) {
        if (!(error instanceof MigrationFailure) || error.reason !== "api-outcome-unknown")
          throw error;
        checkpoint.operations[operation.operationId] = {
          state: "unknown",
          destinationId: state.slotId,
        };
        await persist(checkpoint);
      }
      state = await currentLink(api, operation);
    }
    if (!state.slot.sponsorBookingId) {
      try {
        await api.mutate(
          "PUT",
          `/api/newsletter-slots/${encodeURIComponent(state.slotId)}`,
          {
            version: Number(operation.payload?.slotExpectedVersion),
            sponsorBookingId: state.bookingId,
          },
        );
      } catch (error) {
        if (!(error instanceof MigrationFailure) || error.reason !== "api-outcome-unknown")
          throw error;
        checkpoint.operations[operation.operationId] = {
          state: "unknown",
          destinationId: state.slotId,
        };
        await persist(checkpoint);
      }
      state = await currentLink(api, operation);
    }
    if (
      state.booking.scheduleEntryId === state.slotId &&
      state.slot.sponsorBookingId === state.bookingId
    ) {
      checkpoint.operations[operation.operationId] = {
        state: "verified",
        destinationId: state.slotId,
        postWriteVersion: state.slot.version,
        outcome: "linked",
      };
      await persist(checkpoint);
      return;
    }
  }
  throw new MigrationFailure("api-outcome-unresolved");
}

export async function executeMigrationPlan(input: {
  api: Api;
  plan: MigrationPlan;
  checkpoint: MigrationCheckpoint;
  persistCheckpoint: PersistCheckpoint;
}) {
  const { api, plan, checkpoint, persistCheckpoint } = input;
  if (
    checkpoint.manifestDigest !== plan.manifestDigest ||
    checkpoint.planDigest !== plan.planDigest
  ) throw new MigrationFailure("stale-checkpoint");
  const remaining = new Map(plan.operations.map((item) => [item.operationId, item]));
  while (remaining.size) {
    let progressed = false;
    for (const operation of remaining.values()) {
      if (operation.action === "quarantine")
        throw new MigrationFailure("unresolved-conflicts");
      if (operation.dependencies.some((dependency) =>
        checkpoint.operations[dependency]?.state !== "verified"))
        continue;
      if (checkpoint.operations[operation.operationId]?.state === "verified") {
        const saved = checkpoint.operations[operation.operationId];
        if (operation.kind === "newsletter-link") {
          const state = await currentLink(api, operation);
          if (
            state.booking.scheduleEntryId !== state.slotId ||
            state.slot.sponsorBookingId !== state.bookingId
          ) throw new MigrationFailure("stale-checkpoint");
        } else if (operation.action !== "skip") {
          const record = await requireExpectedRecord(api, operation);
          if (operation.action === "create") {
            const link = plan.operations.find((candidate) =>
              candidate.kind === "newsletter-link" &&
              candidate.payload?.bookingId === operation.destinationId &&
              checkpoint.operations[candidate.operationId]?.state === "verified");
            const linked = link && record.scheduleEntryId ===
              String(link.payload?.slotId || link.destinationId);
            const expectedVersion = Number(saved.postWriteVersion) + (linked ? 1 : 0);
            if (!Number.isSafeInteger(expectedVersion) || record.version !== expectedVersion)
              throw new MigrationFailure("stale-checkpoint");
          } else if (saved.postWriteVersion !== record.version) {
            throw new MigrationFailure("stale-checkpoint");
          }
        }
      } else if (operation.action === "skip") {
        checkpoint.operations[operation.operationId] = { state: "verified" };
        await persistCheckpoint(checkpoint);
      } else if (operation.action === "reuse") {
        if (operation.kind === "newsletter-link") {
          const state = await currentLink(api, operation);
          if (
            state.booking.scheduleEntryId !== state.slotId ||
            state.slot.sponsorBookingId !== state.bookingId
          ) throw new MigrationFailure("destination-link-mismatch");
          checkpoint.operations[operation.operationId] = {
            state: "verified", destinationId: state.slotId,
            postWriteVersion: state.slot.version, outcome: "reused",
          };
        } else {
          const record = await requireExpectedRecord(api, operation);
          checkpoint.operations[operation.operationId] = {
            state: "verified", destinationId: record.id,
            postWriteVersion: record.version, outcome: "reused",
          };
        }
        await persistCheckpoint(checkpoint);
      } else if (operation.kind === "newsletter-link") {
        await linkWithReconciliation(api, operation, checkpoint, persistCheckpoint);
      } else {
        await createWithReconciliation(api, operation, checkpoint, persistCheckpoint);
      }
      remaining.delete(operation.operationId);
      progressed = true;
    }
    if (!progressed) throw new MigrationFailure("operation-dependency-cycle");
  }
  return checkpoint;
}

export async function reconcileMigrationPlan(api: Api, plan: MigrationPlan) {
  const sourceKeys = new Set<string>();
  let skipped = 0;
  for (const operation of plan.operations) {
    if (operation.action === "skip") {
      skipped += 1;
      continue;
    }
    if (operation.kind === "newsletter-link") {
      const state = await currentLink(api, operation);
      if (
        state.booking.scheduleEntryId !== state.slotId ||
        state.slot.sponsorBookingId !== state.bookingId
      ) throw new MigrationFailure("destination-link-mismatch");
      continue;
    }
    const record = await requireExpectedRecord(api, operation);
    if (operation.action === "create" && record.sourceKey !== operation.sourceKey)
      throw new MigrationFailure("source-key-reconciliation-mismatch");
    if (sourceKeys.has(operation.sourceKey))
      throw new MigrationFailure("duplicate-destination-identity");
    sourceKeys.add(operation.sourceKey);
    if (operation.kind !== "organization") {
      const dependency = plan.operations.find((candidate) =>
        operation.dependencies.includes(candidate.operationId) &&
        candidate.kind === "organization");
      if (dependency && record.organizationId !== dependency.destinationId)
        throw new MigrationFailure("destination-relationship-mismatch");
    }
    if (operation.kind === "booking" && operation.payload?.primaryContactId &&
      record.primaryContactId !== operation.payload.primaryContactId)
      throw new MigrationFailure("destination-relationship-mismatch");
  }
  return {
    verified: plan.operations.length - skipped,
    skipped,
    conflicts: 0,
  };
}

export function buildRollbackPlan(
  runId: string,
  plan: MigrationPlan,
): RollbackPlan {
  const linkBookingIds = new Set(
    plan.operations
      .filter((item) => item.kind === "newsletter-link" && item.action === "link")
      .map((item) => String(item.payload?.bookingId || "")),
  );
  const entries: RollbackEntry[] = [];
  for (const operation of plan.operations) {
    if (operation.action === "create" && operation.kind !== "newsletter-link") {
      entries.push({
        operationId: operation.operationId,
        kind: operation.kind,
        destinationId: operation.destinationId!,
        expectedVersion: operation.kind === "booking" &&
          linkBookingIds.has(operation.destinationId!) ? 2 : 1,
        compensation: operation.kind === "booking" ? "cancel" : "archive",
      });
    } else if (operation.action === "link" && operation.kind === "newsletter-link") {
      entries.push({
        operationId: operation.operationId,
        kind: operation.kind,
        destinationId: String(operation.payload?.slotId || operation.destinationId),
        expectedVersion: Number(operation.payload?.slotExpectedVersion || operation.expectedVersion) +
          (operation.payload?.previousSlotBookingId ? 0 : 1),
        expectedBookingVersion: Number(operation.payload?.bookingExpectedVersion || 1) +
          (operation.payload?.previousBookingSlotId ? 0 : 1),
        compensation: "restore-link",
        ...(operation.payload?.previousBookingSlotId
          ? { previousBookingSlotId: String(operation.payload.previousBookingSlotId) }
          : {}),
        ...(operation.payload?.previousSlotBookingId
          ? { previousSlotBookingId: String(operation.payload.previousSlotBookingId) }
          : {}),
      });
    }
  }
  const base = {
    schemaVersion: 1 as const,
    runId,
    entries,
  };
  return { ...base, planDigest: digest(base) };
}

export async function executeRollback(input: {
  api: Api;
  migrationPlan: MigrationPlan;
  rollbackPlan: RollbackPlan;
  write: boolean;
}) {
  const { api, migrationPlan, rollbackPlan } = input;
  const operationById = new Map(migrationPlan.operations.map((item) => [item.operationId, item]));
  const results: Record<string, number> = {
    eligible: 0, compensated: 0, quarantined: 0,
  };
  const entries = [...rollbackPlan.entries].sort((left, right) => {
    const order = { "newsletter-link": 0, booking: 1, contact: 2, organization: 3 };
    return order[left.kind] - order[right.kind];
  });
  const unlinkedBookingIds = new Set<string>();
  const rollbackOperationIds = new Set(entries.map((entry) => entry.operationId));
  const safeChildren = new Set<string>();
  for (const entry of entries) {
    const operation = operationById.get(entry.operationId);
    if (!operation) throw new MigrationFailure("stale-rollback-plan");
    const uncompensatedChild = migrationPlan.operations.some((candidate) =>
      rollbackOperationIds.has(candidate.operationId) &&
      candidate.dependencies.includes(entry.operationId) &&
      !safeChildren.has(candidate.operationId));
    if (uncompensatedChild) {
      results.quarantined += 1;
      continue;
    }
    if (entry.kind === "newsletter-link") {
      const state = await currentLink(api, operation);
      if (
        state.booking.scheduleEntryId !== state.slotId ||
        state.slot.sponsorBookingId !== state.bookingId ||
        state.slot.version !== entry.expectedVersion ||
        state.booking.version !== entry.expectedBookingVersion
      ) {
        results.quarantined += 1;
        continue;
      }
      results.eligible += 1;
      if (!input.write) {
        safeChildren.add(entry.operationId);
        continue;
      }
      if (entry.previousSlotBookingId !== state.bookingId)
        await api.mutate(
          "PUT", `/api/newsletter-slots/${encodeURIComponent(state.slotId)}`,
          { version: state.slot.version, sponsorBookingId: entry.previousSlotBookingId || null },
        );
      if (entry.previousBookingSlotId !== state.slotId) {
        const booking = await api.read<RecordValue>(
          `/api/sponsor-crm/bookings/${encodeURIComponent(state.bookingId)}`,
        );
        await api.mutate(
          entry.previousBookingSlotId ? "PUT" : "DELETE",
          `/api/sponsor-crm/bookings/${encodeURIComponent(state.bookingId)}/schedule-link`,
          {
            version: booking.version,
            ...(entry.previousBookingSlotId
              ? { scheduleEntryId: entry.previousBookingSlotId }
              : {}),
          },
        );
        unlinkedBookingIds.add(state.bookingId);
      }
      results.compensated += 1;
      safeChildren.add(entry.operationId);
      continue;
    }
    const record = await recordFor(api, operation);
    if (
      !record ||
      record.version !== entry.expectedVersion +
        (entry.kind === "booking" && unlinkedBookingIds.has(record.id) ? 1 : 0) ||
      record.sourceKey !== operation.sourceKey ||
      String(record.sourceType || "") !== "historical-migration"
    ) {
      results.quarantined += 1;
      continue;
    }
    results.eligible += 1;
    if (!input.write) {
      safeChildren.add(entry.operationId);
      continue;
    }
    if (entry.kind === "booking")
      await api.mutate(
        "PUT", `/api/sponsor-crm/bookings/${encodeURIComponent(record.id)}`,
        { version: record.version, status: "cancelled" },
      );
    else
      await api.mutate(
        "PUT",
        `/api/sponsor-crm/${endpoint(entry.kind)}/${encodeURIComponent(record.id)}`,
        {
          version: record.version,
          active: false,
          archivedAt: new Date().toISOString(),
          ...(entry.kind === "contact" ? { primary: false } : {}),
        },
      );
    results.compensated += 1;
    safeChildren.add(entry.operationId);
  }
  return results;
}
