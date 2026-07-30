import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "crypto";
import { promises as fs } from "fs";
import path from "path";
import {
  SponsorMigrationApi,
  exportDestinationSnapshot,
} from "../src/sponsorCrmMigration/api";
import { migrationArtifactRoot } from "../src/sponsorCrmMigration/artifacts";
import { digest, emailHash, identityHash } from "../src/sponsorCrmMigration/canonical";
import {
  buildRollbackPlan,
  executeMigrationPlan,
  executeRollback,
  reconcileMigrationPlan,
  validateApprovedDestinationState,
} from "../src/sponsorCrmMigration/execution";
import {
  sourceFileDigest,
  validateDestinationSnapshot,
  validateResolutionManifest,
  validateSourceData,
  validateSourceManifest,
} from "../src/sponsorCrmMigration/manifest";
import {
  applyResolutions,
  buildMigrationPlan,
  redactedPlan,
} from "../src/sponsorCrmMigration/planner";
import {
  runApprovedMigration,
  runCleanup,
  runOfflineDryRun,
} from "../src/sponsorCrmMigration/runner";
import {
  MigrationFailure,
  type DestinationSnapshot,
  type MigrationCheckpoint,
  type MigrationPlan,
  type SourceManifest,
  type SponsorSourceV1,
} from "../src/sponsorCrmMigration/types";
import { parseSponsorMigrationArguments } from "../scripts/migrate-sponsor-crm";
import {
  collectBoundedPages,
  StoragePaginationError,
} from "../src/db/boundedPagination";
import { handleSponsorCrmRoutes } from "../src/routes/sponsorCrm";
import { handleNewsletterSlotRoutes } from "../src/routes/newsletterSlots";

const temporaryDirectories: string[] = [];
afterEach(async () => {
  for (const directory of temporaryDirectories.splice(0))
    await fs.rm(directory, { recursive: true, force: true });
});

const source: SponsorSourceV1 = {
  schemaVersion: 1,
  organizations: [{
    recordId: "org-1",
    stableId: "stable-org-1",
    displayName: "Synthetic Organization",
    strongDiscriminator: "synthetic-registration-1",
    observedAt: "2025-01-10",
  }],
  contacts: [{
    recordId: "contact-1",
    stableId: "stable-contact-1",
    organizationRecordId: "org-1",
    name: "Synthetic Operator",
    emails: ["operator@example.invalid"],
    observedAt: "2025-01-11",
  }],
  bookings: [{
    recordId: "booking-1",
    stableId: "stable-booking-1",
    organizationRecordId: "org-1",
    primaryContactRecordId: "contact-1",
    slotType: "main",
    sourceStatus: "approved",
    plannedPublicationDate: "2025-02-20",
    materialDeadline: "2025-02-10",
    nextActionDate: "2025-02-01",
    sourceSlotId: "legacy-slot-1",
    observedAt: "2025-01-12",
  }],
};

const approvedFields = [
  "organizations.stableId", "organizations.displayName",
  "organizations.strongDiscriminator", "organizations.observedAt",
  "contacts.stableId", "contacts.organizationRecordId", "contacts.name",
  "contacts.emails", "contacts.observedAt",
  "bookings.stableId", "bookings.organizationRecordId",
  "bookings.primaryContactRecordId", "bookings.slotType",
  "bookings.sourceStatus", "bookings.plannedPublicationDate",
  "bookings.materialDeadline", "bookings.nextActionDate",
  "bookings.sourceSlotId", "bookings.observedAt",
];

const emptySnapshot = (): DestinationSnapshot => ({
  schemaVersion: 1,
  generatedAt: "2026-07-30T00:00:00.000Z",
  originHash: digest("https://ops.dtcdev.click"),
  organizations: [],
  contacts: [],
  bookings: [],
  newsletterSlots: [{
    id: "newsletter-slot-1",
    version: 1,
    status: "reserved",
  }],
});

async function writePrivate(file: string, value: unknown) {
  await fs.writeFile(file, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await fs.chmod(file, 0o600);
}

async function inputs(options: {
  sourceData?: SponsorSourceV1;
  snapshot?: DestinationSnapshot;
  manifestChanges?: Partial<SourceManifest>;
} = {}) {
  const directory = await fs.mkdtemp(path.join(process.cwd(), ".tmp-issue-115-"));
  temporaryDirectories.push(directory);
  await fs.chmod(directory, 0o700);
  const sourceData = options.sourceData || source;
  const snapshot = options.snapshot || emptySnapshot();
  const sourceFile = path.join(directory, "source.json");
  const snapshotFile = path.join(directory, "snapshot.json");
  await writePrivate(sourceFile, sourceData);
  await writePrivate(snapshotFile, snapshot);
  const observedDates = [
    ...sourceData.organizations.flatMap((item) => item.observedAt ? [item.observedAt] : []),
    ...sourceData.contacts.flatMap((item) => item.observedAt ? [item.observedAt] : []),
    ...sourceData.bookings.flatMap((item) =>
      item.plannedPublicationDate ? [item.plannedPublicationDate] :
        item.observedAt ? [item.observedAt] : []),
  ].sort();
  const manifest: SourceManifest = {
    schemaVersion: 1,
    approvedAt: "2026-07-29T12:00:00.000Z",
    approvedByRef: "synthetic-approver",
    cutoverTimestamp: "2026-01-01T00:00:00.000Z",
    sources: [{
      id: "synthetic-source",
      immutableIdentity: "synthetic-export-v1",
      ownerRef: "synthetic-owner",
      namespace: "synthetic-history",
      adapter: "sponsor-crm-json-v1",
      parserVersion: 1,
      sha256: await sourceFileDigest(sourceFile),
      approvedFields,
      ...(observedDates.length ? {
        observedEarliest: observedDates[0],
        observedLatest: observedDates.at(-1),
      } : {}),
      includeUndatedEntities: false,
    }],
    destinationSnapshotSha256: digest(snapshot),
    statusMappingVersion: 1,
    bookingStatusMapping: { approved: "confirmed" },
    stableMappings: { organizations: [], contacts: [], bookings: [] },
    slotMappings: [{
      sourceBookingId: "synthetic-source:booking-1",
      sourceSlotId: "legacy-slot-1",
      destinationSlotId: "newsletter-slot-1",
      expectedSlotVersion: 1,
      expectedNewsletterStatus: "reserved",
    }],
    ...options.manifestChanges,
  };
  const manifestFile = path.join(directory, "manifest.json");
  await writePrivate(manifestFile, manifest);
  return {
    directory,
    manifest,
    manifestFile,
    sourceFile,
    snapshot,
    snapshotFile,
    sourceFiles: { "synthetic-source": sourceFile },
  };
}

async function directPlan(provided?: Awaited<ReturnType<typeof inputs>>) {
  const value = provided || await inputs();
  const manifestDigest = await sourceFileDigest(value.manifestFile);
  return buildMigrationPlan({
    manifest: value.manifest,
    manifestDigest,
    destinationSnapshot: value.snapshot,
    destinationSnapshotDigest: digest(value.snapshot),
    sources: [{ manifest: value.manifest.sources[0], data: validateSourceData(source) }],
  });
}

describe("sponsor CRM historical migration", () => {
  it("strictly validates the only approved parser, manifest, snapshot, and resolution schemas", async () => {
    const value = await inputs();
    assert.equal(validateSourceManifest(value.manifest).schemaVersion, 1);
    assert.equal(validateSourceData(source).contacts.length, 1);
    assert.equal(validateDestinationSnapshot(value.snapshot).newsletterSlots.length, 1);
    assert.throws(
      () => validateSourceData({ ...source, hidden: "must-not-parse" }),
      (error: unknown) => error instanceof MigrationFailure &&
        error.reason === "invalid-source-data",
    );
    assert.throws(
      () => validateSourceManifest({ ...value.manifest, statusMappingVersion: 2 }),
      (error: unknown) => error instanceof MigrationFailure &&
        error.reason === "invalid-source-manifest",
    );
    assert.throws(
      () => validateResolutionManifest({
        schemaVersion: 1,
        sourceManifestDigest: "a".repeat(64),
        unresolvedPlanDigest: "b".repeat(64),
        approvedAt: "2026-07-30T00:00:00.000Z",
        approvedByRef: "synthetic-approver",
        decisions: [
          { operationId: "c".repeat(64), action: "skip" },
          { operationId: "c".repeat(64), action: "skip" },
        ],
      }),
      (error: unknown) => error instanceof MigrationFailure &&
        error.reason === "invalid-resolution-decision",
    );
    assert.throws(
      () => validateResolutionManifest({
        schemaVersion: 1,
        sourceManifestDigest: "a".repeat(64),
        unresolvedPlanDigest: "b".repeat(64),
        approvedAt: "2026-07-30T00:00:00.000Z",
        approvedByRef: "synthetic-approver",
        decisions: [{
          operationId: "c".repeat(64),
          action: "reuse",
          destinationId: "synthetic-target",
        }],
      }),
      (error: unknown) => error instanceof MigrationFailure &&
        error.reason === "invalid-resolution-decision",
    );
    const staleBoundary = structuredClone(value.manifest);
    staleBoundary.sources[0].observedLatest = "2025-12-31";
    await writePrivate(value.manifestFile, staleBoundary);
    await assert.rejects(
      () => runOfflineDryRun({
        manifestFile: value.manifestFile,
        snapshotFile: value.snapshotFile,
        sourceFiles: value.sourceFiles,
        runId: `synthetic-${randomUUID()}`,
      }),
      (error: unknown) => error instanceof MigrationFailure &&
        error.reason === "source-date-boundary-mismatch",
    );
  });

  it("makes namespaced source keys stable across paths, names, and email casing", async () => {
    const first = await inputs();
    const plan = await directPlan(first);
    const changed: SponsorSourceV1 = structuredClone(source);
    changed.organizations[0].displayName = "Renamed Synthetic Organization";
    changed.contacts[0].emails = ["OPERATOR@EXAMPLE.INVALID"];
    const second = await inputs({ sourceData: changed });
    const changedPlan = buildMigrationPlan({
      manifest: second.manifest,
      manifestDigest: await sourceFileDigest(second.manifestFile),
      destinationSnapshot: second.snapshot,
      destinationSnapshotDigest: digest(second.snapshot),
      sources: [{ manifest: second.manifest.sources[0], data: changed }],
    });
    assert.deepEqual(
      plan.operations.map((item) => [item.kind, item.sourceKey]),
      changedPlan.operations.map((item) => [item.kind, item.sourceKey]),
    );
    assert.notEqual(plan.operations.find((item) => item.kind === "organization")!.sourcePayloadHash,
      changedPlan.operations.find((item) => item.kind === "organization")!.sourcePayloadHash);
  });

  it("deduplicates only compatible strong source identities and quarantines cross-organization email reuse", async () => {
    const duplicateSource: SponsorSourceV1 = {
      schemaVersion: 1,
      organizations: [
        {
          recordId: "org-a", displayName: "Synthetic Duplicate",
          strongDiscriminator: "synthetic-strong-id", observedAt: "2025-01-01",
        },
        {
          recordId: "org-b", displayName: "SYNTHETIC DUPLICATE",
          strongDiscriminator: "SYNTHETIC-STRONG-ID", observedAt: "2025-01-02",
        },
        {
          recordId: "org-c", displayName: "Synthetic Other",
          strongDiscriminator: "synthetic-other-id", observedAt: "2025-01-03",
        },
      ],
      contacts: [
        {
          recordId: "contact-a", organizationRecordId: "org-a", name: "Synthetic A",
          emails: ["shared@example.invalid"], observedAt: "2025-01-01",
        },
        {
          recordId: "contact-b", organizationRecordId: "org-b", name: "Synthetic B",
          emails: ["SHARED@EXAMPLE.INVALID"], observedAt: "2025-01-02",
        },
        {
          recordId: "contact-c", organizationRecordId: "org-c", name: "Synthetic C",
          emails: ["shared@example.invalid"], observedAt: "2025-01-03",
        },
      ],
      bookings: [],
    };
    const value = await inputs({
      sourceData: duplicateSource,
      manifestChanges: { slotMappings: [] },
    });
    const plan = buildMigrationPlan({
      manifest: value.manifest,
      manifestDigest: await sourceFileDigest(value.manifestFile),
      destinationSnapshot: value.snapshot,
      destinationSnapshotDigest: digest(value.snapshot),
      sources: [{ manifest: value.manifest.sources[0], data: duplicateSource }],
    });
    const organizations = plan.operations.filter((item) => item.kind === "organization");
    assert.equal(organizations.filter((item) => item.action === "reuse").length, 1);
    const reusedOrganization = organizations.find((item) => item.action === "reuse")!;
    assert.ok(organizations.some((item) =>
      item.action === "create" && item.destinationId === reusedOrganization.destinationId));
    const contacts = plan.operations.filter((item) => item.kind === "contact");
    assert.equal(contacts.filter((item) =>
      item.reasonCode === "contact-email-cross-organization-source").length, 3);
    assert.equal(contacts.filter((item) =>
      item.reasonCode === "source-match-quarantined").length, 0);
    const reorderedSource = {
      ...duplicateSource,
      organizations: [...duplicateSource.organizations].reverse(),
      contacts: [...duplicateSource.contacts].reverse(),
    };
    const reordered = buildMigrationPlan({
      manifest: value.manifest,
      manifestDigest: await sourceFileDigest(value.manifestFile),
      destinationSnapshot: value.snapshot,
      destinationSnapshotDigest: digest(value.snapshot),
      sources: [{ manifest: value.manifest.sources[0], data: reorderedSource }],
    });
    assert.deepEqual(reordered, plan, "create leadership and conflicts are order invariant");
  });

  it("lets exact destination identities dominate conflicting planned-source dedup", async () => {
    const duplicateSource: SponsorSourceV1 = {
      schemaVersion: 1,
      organizations: [
        {
          recordId: "org-planned", displayName: "Synthetic Shared",
          strongDiscriminator: "synthetic-shared-id", observedAt: "2025-01-01",
        },
        {
          recordId: "org-exact", displayName: "SYNTHETIC SHARED",
          strongDiscriminator: "SYNTHETIC-SHARED-ID", observedAt: "2025-01-02",
        },
      ],
      contacts: [
        {
          recordId: "contact-planned", organizationRecordId: "org-planned",
          name: "Synthetic Planned", emails: ["shared@example.invalid"],
          observedAt: "2025-01-01",
        },
        {
          recordId: "contact-exact", organizationRecordId: "org-exact",
          name: "Synthetic Exact", emails: ["SHARED@EXAMPLE.INVALID"],
          observedAt: "2025-01-02",
        },
      ],
      bookings: [],
    };
    const baseline = await inputs({
      sourceData: duplicateSource,
      manifestChanges: { slotMappings: [] },
    });
    const preliminary = buildMigrationPlan({
      manifest: baseline.manifest,
      manifestDigest: await sourceFileDigest(baseline.manifestFile),
      destinationSnapshot: baseline.snapshot,
      destinationSnapshotDigest: digest(baseline.snapshot),
      sources: [{ manifest: baseline.manifest.sources[0], data: duplicateSource }],
    });
    const exactOrganization = preliminary.operations.find((item) =>
      item.kind === "organization" && item.coordinate.recordIdHash ===
      digest(`${baseline.manifest.sources[0].immutableIdentity}\0org-exact`))!;
    const exactContact = preliminary.operations.find((item) =>
      item.kind === "contact" && item.coordinate.recordIdHash ===
      digest(`${baseline.manifest.sources[0].immutableIdentity}\0contact-exact`))!;
    const snapshot = emptySnapshot();
    snapshot.organizations.push({
      id: "approved-org-exact", sourceKey: exactOrganization.sourceKey,
      version: 7, active: true, normalizedNameHash: identityHash("Operator Renamed"),
      strongDiscriminatorHash: identityHash("operator-current-id"),
    });
    snapshot.contacts.push({
      id: "approved-contact-exact", sourceKey: exactContact.sourceKey,
      organizationId: "approved-org-exact", version: 5, active: true,
      normalizedEmailHashes: [emailHash("current@example.invalid")],
    });
    baseline.manifest.destinationSnapshotSha256 = digest(snapshot);
    const plan = buildMigrationPlan({
      manifest: baseline.manifest,
      manifestDigest: await sourceFileDigest(baseline.manifestFile),
      destinationSnapshot: snapshot,
      destinationSnapshotDigest: digest(snapshot),
      sources: [{ manifest: baseline.manifest.sources[0], data: duplicateSource }],
    });
    const organization = plan.operations.find((item) =>
      item.operationId === exactOrganization.operationId)!;
    const contact = plan.operations.find((item) => item.operationId === exactContact.operationId)!;
    assert.deepEqual(
      [organization.action, organization.destinationId, organization.expectedVersion],
      ["reuse", "approved-org-exact", 7],
    );
    assert.deepEqual(
      [contact.action, contact.destinationId, contact.expectedVersion],
      ["reuse", "approved-contact-exact", 5],
    );
    const organizationOperations = plan.operations.filter(
      (item) => item.kind === "organization",
    );
    const contactOperations = plan.operations.filter((item) => item.kind === "contact");
    assert.equal(organizationOperations.every((item) =>
      item.action === "reuse" && item.destinationId === "approved-org-exact" &&
      item.expectedVersion === 7), true);
    assert.equal(contactOperations.every((item) =>
      item.action === "reuse" && item.destinationId === "approved-contact-exact" &&
      item.expectedVersion === 5), true);
    assert.equal(plan.operations.some((item) => item.action === "create"), false);

    const reversedSource = {
      ...duplicateSource,
      organizations: [...duplicateSource.organizations].reverse(),
      contacts: [...duplicateSource.contacts].reverse(),
    };
    const reversed = buildMigrationPlan({
      manifest: baseline.manifest,
      manifestDigest: await sourceFileDigest(baseline.manifestFile),
      destinationSnapshot: snapshot,
      destinationSnapshotDigest: digest(snapshot),
      sources: [{ manifest: baseline.manifest.sources[0], data: reversedSource }],
    });
    assert.deepEqual(reversed, plan, "source row order does not change the approved plan");

    const api = new MemoryApi();
    api.records.organization.set("approved-org-exact", {
      id: "approved-org-exact", version: 7, active: true,
      displayName: "Operator Renamed",
    });
    api.records.contact.set("approved-contact-exact", {
      id: "approved-contact-exact", version: 5,
      organizationId: "approved-org-exact",
      emails: ["current@example.invalid"],
    });
    const checkpoint: MigrationCheckpoint = {
      schemaVersion: 1,
      runId: "synthetic-global-reservation",
      manifestDigest: plan.manifestDigest,
      resolutionDigest: "a".repeat(64),
      planDigest: plan.planDigest,
      operations: {},
    };
    await executeMigrationPlan({
      api: api as never,
      plan,
      checkpoint,
      persistCheckpoint: async () => undefined,
    });
    assert.equal(api.mutations, 0, "authoritative reservations require no create");
    assert.deepEqual(
      await reconcileMigrationPlan(api as never, plan),
      { verified: 4, skipped: 0, conflicts: 0 },
    );
  });

  it("globally reserves approved stable mappings before source dedup", async () => {
    const mappedSource: SponsorSourceV1 = {
      schemaVersion: 1,
      organizations: [
        {
          recordId: "org-planned", displayName: "Synthetic Stable Shared",
          strongDiscriminator: "historical-stable-id", observedAt: "2025-01-01",
        },
        {
          recordId: "org-mapped", stableId: "mapped-org",
          displayName: "SYNTHETIC STABLE SHARED",
          strongDiscriminator: "HISTORICAL-STABLE-ID", observedAt: "2025-01-02",
        },
      ],
      contacts: [
        {
          recordId: "contact-planned", organizationRecordId: "org-planned",
          name: "Synthetic Planned", emails: ["stable-shared@example.invalid"],
          observedAt: "2025-01-01",
        },
        {
          recordId: "contact-mapped", stableId: "mapped-contact",
          organizationRecordId: "org-mapped", name: "Synthetic Mapped",
          emails: ["STABLE-SHARED@EXAMPLE.INVALID"], observedAt: "2025-01-02",
        },
      ],
      bookings: [],
    };
    const snapshot = emptySnapshot();
    snapshot.organizations.push({
      id: "stable-org-destination", version: 8, active: true,
      normalizedNameHash: identityHash("Operator Stable Rename"),
      strongDiscriminatorHash: identityHash("operator-stable-id"),
    });
    snapshot.contacts.push({
      id: "stable-contact-destination", organizationId: "stable-org-destination",
      version: 6, active: true,
      normalizedEmailHashes: [emailHash("operator-stable@example.invalid")],
    });
    const value = await inputs({
      sourceData: mappedSource,
      snapshot,
      manifestChanges: {
        slotMappings: [],
        stableMappings: {
          organizations: [{
            sourceId: "synthetic-source:mapped-org",
            destinationId: "stable-org-destination",
          }],
          contacts: [{
            sourceId: "synthetic-source:mapped-contact",
            destinationId: "stable-contact-destination",
          }],
          bookings: [],
        },
      },
    });
    const plan = buildMigrationPlan({
      manifest: value.manifest,
      manifestDigest: await sourceFileDigest(value.manifestFile),
      destinationSnapshot: snapshot,
      destinationSnapshotDigest: digest(snapshot),
      sources: [{ manifest: value.manifest.sources[0], data: mappedSource }],
    });
    assert.equal(plan.operations.filter((item) => item.kind === "organization").every(
      (item) => item.action === "reuse" &&
        item.destinationId === "stable-org-destination" && item.expectedVersion === 8,
    ), true);
    assert.equal(plan.operations.filter((item) => item.kind === "contact").every(
      (item) => item.action === "reuse" &&
        item.destinationId === "stable-contact-destination" && item.expectedVersion === 6,
    ), true);
    assert.equal(plan.operations.some((item) => item.action === "create"), false);
  });

  it("uses exact ordered matching and quarantines name-only, cross-org, ambiguous, and slot conflicts", async () => {
    const baseline = await inputs();
    const preliminary = await directPlan(baseline);
    const organization = preliminary.operations.find((item) => item.kind === "organization")!;
    const contact = preliminary.operations.find((item) => item.kind === "contact")!;
    const booking = preliminary.operations.find((item) => item.kind === "booking")!;
    const snapshot = emptySnapshot();
    snapshot.organizations = [
      {
        id: "org-by-source-key", sourceKey: organization.sourceKey, version: 4, active: true,
        normalizedNameHash: identityHash("Other Name"),
      },
      {
        id: "org-stable-would-lose", version: 2, active: true,
        normalizedNameHash: identityHash("Synthetic Organization"),
        strongDiscriminatorHash: identityHash("synthetic-registration-1"),
      },
    ];
    snapshot.contacts = [{
      id: "contact-exact", organizationId: "org-by-source-key",
      sourceKey: contact.sourceKey, version: 3, active: true,
      normalizedEmailHashes: [emailHash("operator@example.invalid")],
    }];
    snapshot.bookings = [{
      id: "booking-exact", organizationId: "org-by-source-key",
      primaryContactId: "contact-exact", sourceKey: booking.sourceKey,
      version: 2, status: "confirmed", slotType: "main",
    }];
    snapshot.newsletterSlots[0].sponsorBookingId = "incompatible-booking";
    const value = await inputs({
      snapshot,
      manifestChanges: {
        destinationSnapshotSha256: digest(snapshot),
        stableMappings: {
          organizations: [{
            sourceId: "synthetic-source:stable-org-1",
            destinationId: "org-stable-would-lose",
          }],
          contacts: [],
          bookings: [],
        },
      },
    });
    const plan = buildMigrationPlan({
      manifest: value.manifest,
      manifestDigest: await sourceFileDigest(value.manifestFile),
      destinationSnapshot: snapshot,
      destinationSnapshotDigest: digest(snapshot),
      sources: [{ manifest: value.manifest.sources[0], data: source }],
    });
    assert.equal(plan.operations.find((item) => item.kind === "organization")!.destinationId,
      "org-by-source-key", "sourceKey wins before stable mapping");
    assert.equal(plan.operations.find((item) => item.kind === "contact")!.destinationId,
      "contact-exact");
    assert.equal(plan.operations.find((item) => item.kind === "booking")!.destinationId,
      "booking-exact");
    assert.equal(plan.operations.find((item) => item.kind === "newsletter-link")!.reasonCode,
      "slot-claim-conflict");

    const nameOnlySource: SponsorSourceV1 = {
      schemaVersion: 1,
      organizations: [{ recordId: "org-1", displayName: "Synthetic Organization", observedAt: "2025-01-01" }],
      contacts: [],
      bookings: [],
    };
    const nameOnly = await inputs({
      sourceData: nameOnlySource,
      snapshot: {
        ...emptySnapshot(),
        organizations: [{
          id: "candidate", version: 1, active: true,
          normalizedNameHash: identityHash("Synthetic Organization"),
        }],
      },
      manifestChanges: { slotMappings: [] },
    });
    nameOnly.manifest.destinationSnapshotSha256 = digest(nameOnly.snapshot);
    await writePrivate(nameOnly.manifestFile, nameOnly.manifest);
    const namePlan = buildMigrationPlan({
      manifest: nameOnly.manifest,
      manifestDigest: await sourceFileDigest(nameOnly.manifestFile),
      destinationSnapshot: nameOnly.snapshot,
      destinationSnapshotDigest: digest(nameOnly.snapshot),
      sources: [{ manifest: nameOnly.manifest.sources[0], data: nameOnlySource }],
    });
    assert.equal(namePlan.operations[0].reasonCode, "organization-name-only");
  });

  it("quarantines undated/post-cutover/status/reference cases and rejects unsafe resolutions", async () => {
    const unsafeSource: SponsorSourceV1 = {
      schemaVersion: 1,
      organizations: [
        { recordId: "undated", displayName: "Undated Synthetic" },
        { recordId: "late", displayName: "Late Synthetic", observedAt: "2026-02-01" },
      ],
      contacts: [{
        recordId: "orphan", organizationRecordId: "missing", name: "Orphan Synthetic",
        emails: ["orphan@example.invalid"], observedAt: "2025-01-01",
      }],
      bookings: [{
        recordId: "unknown-status", organizationRecordId: "late", slotType: "main",
        sourceStatus: "not-mapped", plannedPublicationDate: "2025-02-01",
      }],
    };
    const value = await inputs({
      sourceData: unsafeSource,
      manifestChanges: { slotMappings: [] },
    });
    const plan = buildMigrationPlan({
      manifest: value.manifest,
      manifestDigest: await sourceFileDigest(value.manifestFile),
      destinationSnapshot: value.snapshot,
      destinationSnapshotDigest: digest(value.snapshot),
      sources: [{ manifest: value.manifest.sources[0], data: unsafeSource }],
    });
    const reasons = new Set(plan.operations.map((item) => item.reasonCode));
    assert.ok(reasons.has("undated-record-not-approved"));
    assert.ok(reasons.has("record-after-cutover"));
    assert.ok(reasons.has("invalid-organization-reference"));
    assert.ok(reasons.has("status-mapping-missing") ||
      reasons.has("invalid-organization-reference"));
    const resolution = {
      schemaVersion: 1 as const,
      sourceManifestDigest: plan.manifestDigest,
      unresolvedPlanDigest: plan.planDigest,
      approvedAt: "2026-07-30T00:00:00.000Z",
      approvedByRef: "synthetic-approver",
      decisions: plan.operations.filter((item) => item.action === "quarantine").map((item) => ({
        operationId: item.operationId,
        action: "skip" as const,
      })),
    };
    const resolved = applyResolutions(plan, resolution, value.snapshot);
    assert.equal(resolved.operations.every((item) => item.action !== "quarantine"), true);
    assert.throws(
      () => applyResolutions(plan, {
        ...resolution,
        decisions: resolution.decisions.map((decision, index) =>
          index ? decision : { ...decision, action: "create" as const }),
      }, value.snapshot),
      (error: unknown) => error instanceof MigrationFailure &&
        error.reason === "unsafe-resolution-decision",
    );
    assert.throws(
      () => applyResolutions(
        plan, { ...resolution, decisions: resolution.decisions.slice(1) }, value.snapshot,
      ),
      (error: unknown) => error instanceof MigrationFailure &&
        error.reason === "incomplete-resolution-manifest",
    );
  });

  it("binds manual reuse resolutions to an approved destination record version and digest", async () => {
    const resolutionSource: SponsorSourceV1 = {
      schemaVersion: 1,
      organizations: [{
        recordId: "org-conflict", displayName: "Synthetic Conflict",
        strongDiscriminator: "source-id", observedAt: "2025-01-01",
      }],
      contacts: [],
      bookings: [],
    };
    const snapshot = emptySnapshot();
    snapshot.organizations.push({
      id: "approved-resolution-target", version: 9, active: true,
      normalizedNameHash: identityHash("Synthetic Conflict"),
      strongDiscriminatorHash: identityHash("different-id"),
    });
    const value = await inputs({
      sourceData: resolutionSource,
      snapshot,
      manifestChanges: { slotMappings: [] },
    });
    const plan = buildMigrationPlan({
      manifest: value.manifest,
      manifestDigest: await sourceFileDigest(value.manifestFile),
      destinationSnapshot: snapshot,
      destinationSnapshotDigest: digest(snapshot),
      sources: [{ manifest: value.manifest.sources[0], data: resolutionSource }],
    });
    const target = snapshot.organizations[0];
    const resolution = {
      schemaVersion: 1 as const,
      sourceManifestDigest: plan.manifestDigest,
      unresolvedPlanDigest: plan.planDigest,
      approvedAt: "2026-07-30T00:00:00.000Z",
      approvedByRef: "synthetic-approver",
      decisions: [{
        operationId: plan.operations[0].operationId,
        action: "reuse" as const,
        destinationId: target.id,
        expectedVersion: target.version,
        destinationDigest: digest(target),
      }],
    };
    assert.equal(
      applyResolutions(plan, resolution, snapshot).operations[0].expectedVersion,
      9,
    );
    assert.throws(
      () => applyResolutions(plan, {
        ...resolution,
        decisions: [{ ...resolution.decisions[0], expectedVersion: 10 }],
      }, snapshot),
      (error: unknown) => error instanceof MigrationFailure &&
        error.reason === "stale-resolution-decision",
    );
    assert.throws(
      () => applyResolutions(plan, {
        ...resolution,
        decisions: [{ ...resolution.decisions[0], destinationDigest: "f".repeat(64) }],
      }, snapshot),
      (error: unknown) => error instanceof MigrationFailure &&
        error.reason === "stale-resolution-decision",
    );
  });

  it("runs offline by default and persists only redacted private artifacts", async () => {
    const value = await inputs();
    const runId = `synthetic-${randomUUID()}`;
    let networkCalls = 0;
    const previousFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      networkCalls += 1;
      throw new Error("network must not be called");
    }) as typeof fetch;
    try {
      const first = await runOfflineDryRun({
        manifestFile: value.manifestFile,
        snapshotFile: value.snapshotFile,
        sourceFiles: value.sourceFiles,
        runId,
      });
      const resolutionFile = path.join(value.directory, "resolution.json");
      await writePrivate(resolutionFile, {
        schemaVersion: 1,
        sourceManifestDigest: first.manifestDigest,
        unresolvedPlanDigest: first.planDigest,
        approvedAt: "2026-07-30T00:00:00.000Z",
        approvedByRef: "synthetic-approver",
        decisions: [],
      });
      const second = await runOfflineDryRun({
        manifestFile: value.manifestFile,
        snapshotFile: value.snapshotFile,
        sourceFiles: value.sourceFiles,
        resolutionFile,
        runId,
        now: new Date("2026-07-30T00:00:00.000Z"),
      });
      assert.equal(second.approvalReady, true);
      assert.equal(networkCalls, 0);
      const artifactDirectory = path.join(await migrationArtifactRoot(), runId);
      temporaryDirectories.push(artifactDirectory);
      const rendered = (await Promise.all(
        (await fs.readdir(artifactDirectory)).map((file) =>
          fs.readFile(path.join(artifactDirectory, file), "utf8")),
      )).join("\n");
      for (const secret of [
        "Synthetic Organization", "Synthetic Operator", "operator@example.invalid",
        "synthetic-registration-1",
      ]) assert.equal(rendered.includes(secret), false, secret);
      for (const file of await fs.readdir(artifactDirectory))
        assert.equal((await fs.stat(path.join(artifactDirectory, file))).mode & 0o077, 0);
      assert.equal((await fs.stat(artifactDirectory)).mode & 0o077, 0);
    } finally {
      globalThis.fetch = previousFetch;
    }
  });

  it("fails every write gate before network access", async () => {
    const value = await inputs();
    const runId = `synthetic-${randomUUID()}`;
    const dry = await runOfflineDryRun({
      manifestFile: value.manifestFile,
      snapshotFile: value.snapshotFile,
      sourceFiles: value.sourceFiles,
      runId,
    });
    const resolutionFile = path.join(value.directory, "resolution.json");
    await writePrivate(resolutionFile, {
      schemaVersion: 1,
      sourceManifestDigest: dry.manifestDigest,
      unresolvedPlanDigest: dry.planDigest,
      approvedAt: "2026-07-30T00:00:00.000Z",
      approvedByRef: "synthetic-approver",
      decisions: [],
    });
    await runOfflineDryRun({
      manifestFile: value.manifestFile,
      snapshotFile: value.snapshotFile,
      sourceFiles: value.sourceFiles,
      resolutionFile,
      runId,
      now: new Date("2026-07-30T00:00:00.000Z"),
    });
    let calls = 0;
    const approvalFile = path.join(await migrationArtifactRoot(), runId, "approval.json");
    await assert.rejects(
      () => runApprovedMigration({
        manifestFile: value.manifestFile,
        snapshotFile: value.snapshotFile,
        sourceFiles: value.sourceFiles,
        resolutionFile,
        runId,
        approvalFile,
        targetOrigin: "https://ops.dtcdev.click",
        confirmOrigin: "https://ops.dtcdev.click",
        bearerToken: "synthetic_token_abcdefghijklmnopqrstuvwxyz",
        backupConfirmation: "{}",
        requestFetch: (async () => {
          calls += 1;
          throw new Error();
        }) as typeof fetch,
        now: new Date("2026-07-30T01:00:00.000Z"),
      }),
      (error: unknown) => error instanceof MigrationFailure &&
        error.reason === "backup-confirmation-required",
    );
    assert.equal(calls, 0);
  });

  it("detects source and destination changes after approval before any mutation", async () => {
    const origin = "https://synthetic.example.invalid";
    const snapshot = emptySnapshot();
    snapshot.originHash = digest(origin);
    const value = await inputs({
      snapshot,
      manifestChanges: { destinationSnapshotSha256: digest(snapshot) },
    });
    const runId = `synthetic-${randomUUID()}`;
    const first = await runOfflineDryRun({
      manifestFile: value.manifestFile,
      snapshotFile: value.snapshotFile,
      sourceFiles: value.sourceFiles,
      runId,
    });
    const resolutionFile = path.join(value.directory, "resolution.json");
    await writePrivate(resolutionFile, {
      schemaVersion: 1,
      sourceManifestDigest: first.manifestDigest,
      unresolvedPlanDigest: first.planDigest,
      approvedAt: "2026-07-30T00:00:00.000Z",
      approvedByRef: "synthetic-approver",
      decisions: [],
    });
    await runOfflineDryRun({
      manifestFile: value.manifestFile,
      snapshotFile: value.snapshotFile,
      sourceFiles: value.sourceFiles,
      resolutionFile,
      runId,
      now: new Date("2026-07-30T00:00:00.000Z"),
    });
    const artifactDirectory = path.join(await migrationArtifactRoot(), runId);
    temporaryDirectories.push(artifactDirectory);
    const approvalFile = path.join(artifactDirectory, "approval.json");
    const approval = JSON.parse(await fs.readFile(approvalFile, "utf8"));
    approval.targetOrigin = origin;
    await writePrivate(approvalFile, approval);
    const backupConfirmation = JSON.stringify({
      confirmed: true,
      targetOrigin: origin,
      confirmedAt: "2026-07-30T00:30:00.000Z",
      crmBackupIdHash: "a".repeat(64),
      newsletterBackupIdHash: "b".repeat(64),
      approvedByRef: "synthetic-approver",
    });
    let network = 0;
    const noNetwork = (async () => {
      network += 1;
      throw new Error();
    }) as typeof fetch;
    const mutatedSource = structuredClone(source);
    mutatedSource.organizations[0].displayName = "Changed After Approval";
    await writePrivate(value.sourceFile, mutatedSource);
    await assert.rejects(
      () => runApprovedMigration({
        manifestFile: value.manifestFile,
        snapshotFile: value.snapshotFile,
        sourceFiles: value.sourceFiles,
        resolutionFile,
        runId,
        approvalFile,
        targetOrigin: origin,
        confirmOrigin: origin,
        bearerToken: "synthetic_token_abcdefghijklmnopqrstuvwxyz",
        backupConfirmation,
        allowTestOrigin: true,
        requestFetch: noNetwork,
        now: new Date("2026-07-30T01:00:00.000Z"),
      }),
      (error: unknown) => error instanceof MigrationFailure &&
        error.reason === "source-digest-mismatch",
    );
    assert.equal(network, 0);
    await writePrivate(value.sourceFile, source);

    const response = (body: unknown, status = 200) => new Response(
      status === 404 ? "" : JSON.stringify(body),
      { status, headers: status === 404 ? {} : { "content-type": "application/json" } },
    );
    const crmSnapshot = (items: unknown[]) => response({
      items, nextCursor: null, complete: true, snapshotDigest: digest(items),
    });
    const newsletterSnapshot = (items: unknown[]) => response({
      items, complete: true, snapshotDigest: digest(items),
    });
    let mutations = 0;
    const changedDestination = (async (request: string | URL | Request, init?: RequestInit) => {
      const url = String(request), method = init?.method || "GET";
      if (method !== "GET") mutations += 1;
      if (url.endsWith("/api/me")) return response({ user: { enabled: true } });
      if (url.includes("/organizations?"))
        return crmSnapshot([{
          id: "concurrent-org", version: 1, displayName: "Concurrent Synthetic",
        }]);
      if (url.includes("/contacts?") || url.includes("/bookings?"))
        return crmSnapshot([]);
      if (url.includes("/newsletter-slots?"))
        return newsletterSnapshot([{
          id: "newsletter-slot-1", version: 1, status: "reserved",
        }]);
      return response({}, 404);
    }) as typeof fetch;
    await assert.rejects(
      () => runApprovedMigration({
        manifestFile: value.manifestFile,
        snapshotFile: value.snapshotFile,
        sourceFiles: value.sourceFiles,
        resolutionFile,
        runId,
        approvalFile,
        targetOrigin: origin,
        confirmOrigin: origin,
        bearerToken: "synthetic_token_abcdefghijklmnopqrstuvwxyz",
        backupConfirmation,
        allowTestOrigin: true,
        requestFetch: changedDestination,
        now: new Date("2026-07-30T01:00:00.000Z"),
      }),
      (error: unknown) => error instanceof MigrationFailure &&
        error.reason === "destination-changed-after-approval",
    );
    assert.equal(mutations, 0);
    mutations = 0;
    const incompleteStorage = (async (
      request: string | URL | Request,
      init?: RequestInit,
    ) => {
      const url = String(request), method = init?.method || "GET";
      if (method !== "GET") mutations += 1;
      if (url.endsWith("/api/me")) return response({ user: { enabled: true } });
      if (url.includes("/newsletter-slots?"))
        return newsletterSnapshot([{
          id: "newsletter-slot-1", version: 1, status: "reserved",
        }]);
      return response({ items: [], nextCursor: null });
    }) as typeof fetch;
    await assert.rejects(
      () => runApprovedMigration({
        manifestFile: value.manifestFile,
        snapshotFile: value.snapshotFile,
        sourceFiles: value.sourceFiles,
        resolutionFile,
        runId,
        approvalFile,
        targetOrigin: origin,
        confirmOrigin: origin,
        bearerToken: "synthetic_token_abcdefghijklmnopqrstuvwxyz",
        backupConfirmation,
        allowTestOrigin: true,
        requestFetch: incompleteStorage,
        now: new Date("2026-07-30T01:00:00.000Z"),
      }),
      (error: unknown) => error instanceof MigrationFailure &&
        error.reason === "unexpected-api-response",
    );
    assert.equal(mutations, 0, "incomplete storage evidence stops before migration writes");
  });

  it("exports an authenticated hash-only destination snapshot through HTTP", async () => {
    const requests: { url: string; authorization: string | null }[] = [];
    const response = (body: unknown) => new Response(JSON.stringify(body), {
      status: 200, headers: { "content-type": "application/json" },
    });
    const crmSnapshot = (items: unknown[]) => response({
      items, nextCursor: null, complete: true, snapshotDigest: digest(items),
    });
    const newsletterSnapshot = (items: unknown[]) => response({
      items, complete: true, snapshotDigest: digest(items),
    });
    const requestFetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      requests.push({
        url,
        authorization: new Headers(init?.headers).get("authorization"),
      });
      if (url.endsWith("/api/me")) return response({ user: { enabled: true } });
      if (url.includes("/organizations?"))
        return crmSnapshot([{
          id: "org-1", version: 2, displayName: "Private Synthetic Name",
          strongDiscriminator: "private-synthetic-id", sourceKey: "safe-source",
        }]);
      if (url.includes("/contacts?"))
        return crmSnapshot([{
          id: "contact-1", version: 1, organizationId: "org-1",
          emails: ["private@example.invalid"],
        }]);
      if (url.includes("/bookings?"))
        return crmSnapshot([{
          id: "booking-1", version: 1, organizationId: "org-1",
          status: "held", slotType: "main",
        }]);
      if (url.includes("/newsletter-slots?"))
        return newsletterSnapshot([{
          id: "slot-1", version: 1, status: "reserved",
        }]);
      throw new Error("unexpected synthetic URL");
    }) as typeof fetch;
    const api = SponsorMigrationApi.create({
      origin: "https://synthetic.example.invalid",
      bearerToken: "synthetic_token_abcdefghijklmnopqrstuvwxyz",
      allowTestOrigin: true,
      requestFetch,
      sleep: async () => undefined,
    });
    const snapshot = await exportDestinationSnapshot(
      api, new Date("2026-07-30T00:00:00.000Z"),
    );
    const rendered = JSON.stringify(snapshot);
    assert.equal(rendered.includes("Private Synthetic Name"), false);
    assert.equal(rendered.includes("private@example.invalid"), false);
    assert.equal(rendered.includes("private-synthetic-id"), false);
    assert.equal(snapshot.contacts[0].normalizedEmailHashes[0],
      emailHash("private@example.invalid"));
    assert.ok(requests.every((request) =>
      request.authorization === "Bearer synthetic_token_abcdefghijklmnopqrstuvwxyz"));
    assert.ok(requests.every((request) => request.url.startsWith("https://")));
    assert.ok(requests.some((request) =>
      request.url.includes("migrationSnapshot=true")));
  });

  it("exhausts Dynamo pages before planning later-page authoritative identities", async () => {
    const baseline = await inputs();
    const preliminary = await directPlan(baseline);
    const bookingSourceKey = preliminary.operations.find(
      (item) => item.kind === "booking",
    )!.sourceKey;
    const now = "2026-07-30T00:00:00.000Z";
    const stored = (kind: string, record: Record<string, unknown>) => ({
      PK: `${kind.toUpperCase()}#${record.id}`,
      SK: `${kind.toUpperCase()}#${record.id}`,
      createdAt: now,
      updatedAt: now,
      ...record,
    });
    const crmPages: Record<string, Record<string, unknown>[][]> = {
      organization: [
        [stored("organization", {
          id: "decoy-org", version: 1, displayName: "Synthetic Decoy",
          strongDiscriminator: "decoy-id", active: true,
        })],
        [stored("organization", {
          id: "later-org", version: 7, displayName: "Synthetic Organization",
          strongDiscriminator: "synthetic-registration-1", active: true,
        })],
      ],
      contact: [
        [stored("contact", {
          id: "decoy-contact", version: 1, organizationId: "decoy-org",
          name: "Synthetic Decoy", emails: ["decoy@example.invalid"], active: true,
        })],
        [stored("contact", {
          id: "later-contact", version: 5, organizationId: "later-org",
          name: "Synthetic Operator", emails: ["operator@example.invalid"], active: true,
        })],
      ],
      booking: [
        [stored("booking", {
          id: "decoy-booking", version: 1, organizationId: "decoy-org",
          status: "held", slotType: "main",
        })],
        [stored("booking", {
          id: "later-booking", version: 3, organizationId: "later-org",
          primaryContactId: "later-contact", sourceKey: bookingSourceKey,
          status: "confirmed", slotType: "main",
          scheduleEntryId: "newsletter-slot-1",
        })],
      ],
    };
    const slotPages = [
      [{
        PK: "SLOT#decoy-slot", SK: "SLOT#decoy-slot", rangeKey: "SLOTS",
        publicationKey: "2025-02-19#decoy-slot", id: "decoy-slot",
        publicationDate: "2025-02-19", status: "open", version: 1,
        createdAt: now, updatedAt: now,
      }],
      [{
        PK: "SLOT#newsletter-slot-1", SK: "SLOT#newsletter-slot-1",
        rangeKey: "SLOTS",
        publicationKey: "2025-02-20#newsletter-slot-1",
        id: "newsletter-slot-1", publicationDate: "2025-02-20",
        status: "reserved", version: 1, sponsorBookingId: "later-booking",
        createdAt: now, updatedAt: now,
      }],
    ];
    const storageClient = {
      send: async (command: { input: Record<string, any> }) => {
        const commandInput = command.input;
        const second = !!commandInput.ExclusiveStartKey;
        if (commandInput.IndexName === "GSI-Date")
          return {
            Items: slotPages[second ? 1 : 0],
            ...(second ? {} : {
              LastEvaluatedKey: {
                PK: "SLOT#cursor", SK: "SLOT#cursor",
                rangeKey: "SLOTS", publicationKey: "cursor",
              },
            }),
          };
        const prefix = String(commandInput.ExpressionAttributeValues?.[":prefix"] || "");
        const kind = prefix.slice(0, -1).toLowerCase();
        return {
          Items: crmPages[kind][second ? 1 : 0],
          ...(second ? {} : {
            LastEvaluatedKey: {
              PK: `${kind.toUpperCase()}#cursor`,
              SK: `${kind.toUpperCase()}#cursor`,
            },
          }),
        };
      },
    };
    const response = (value: { statusCode: number; body: string; headers?: unknown }) =>
      new Response(value.body, {
        status: value.statusCode,
        headers: { "content-type": "application/json" },
      });
    const requestFetch = (async (request: string | URL | Request) => {
      const url = new URL(String(request));
      if (url.pathname === "/api/me")
        return new Response(JSON.stringify({ user: { enabled: true } }), {
          headers: { "content-type": "application/json" },
        });
      const event = {
        httpMethod: "GET",
        path: url.pathname,
        headers: { "x-user-id": "synthetic-operator" },
        queryStringParameters: Object.fromEntries(url.searchParams),
        body: null,
      };
      if (url.pathname.startsWith("/api/sponsor-crm/"))
        return response(await handleSponsorCrmRoutes(
          url.pathname, "GET", event as never, storageClient as never,
        ));
      if (url.pathname === "/api/newsletter-slots")
        return response(await handleNewsletterSlotRoutes(
          url.pathname, "GET", event as never, storageClient as never,
        ));
      throw new Error("unexpected synthetic snapshot URL");
    }) as typeof fetch;
    const snapshot = await exportDestinationSnapshot(
      SponsorMigrationApi.create({
        origin: "https://synthetic.example.invalid",
        bearerToken: "synthetic_token_abcdefghijklmnopqrstuvwxyz",
        allowTestOrigin: true,
        requestFetch,
        sleep: async () => undefined,
      }),
      new Date(now),
    );
    assert.deepEqual(
      [
        snapshot.organizations.length,
        snapshot.contacts.length,
        snapshot.bookings.length,
        snapshot.newsletterSlots.length,
      ],
      [2, 2, 2, 2],
    );
    const manifest = {
      ...baseline.manifest,
      destinationSnapshotSha256: digest(snapshot),
    };
    const plan = buildMigrationPlan({
      manifest,
      manifestDigest: await sourceFileDigest(baseline.manifestFile),
      destinationSnapshot: snapshot,
      destinationSnapshotDigest: digest(snapshot),
      sources: [{ manifest: manifest.sources[0], data: source }],
    });
    assert.deepEqual(
      Object.fromEntries(plan.operations.map((item) =>
        [item.kind, [item.action, item.destinationId]])),
      {
        organization: ["reuse", "later-org"],
        contact: ["reuse", "later-contact"],
        booking: ["reuse", "later-booking"],
        "newsletter-link": ["reuse", "newsletter-slot-1"],
      },
    );
    assert.equal(plan.operations.some((item) => item.action === "create"), false);
    const api = new MemoryApi();
    api.records.organization.set("later-org", {
      id: "later-org", version: 7, displayName: "Synthetic Organization",
    });
    api.records.contact.set("later-contact", {
      id: "later-contact", version: 5, organizationId: "later-org",
      emails: ["operator@example.invalid"],
    });
    api.records.booking.set("later-booking", {
      id: "later-booking", version: 3, organizationId: "later-org",
      primaryContactId: "later-contact", sourceKey: bookingSourceKey,
      status: "confirmed", slotType: "main", scheduleEntryId: "newsletter-slot-1",
    });
    api.slots.set("newsletter-slot-1", {
      id: "newsletter-slot-1", version: 1, status: "reserved",
      sponsorBookingId: "later-booking",
    });
    const checkpoint: MigrationCheckpoint = {
      schemaVersion: 1,
      runId: "later-page-snapshot",
      manifestDigest: plan.manifestDigest,
      resolutionDigest: "a".repeat(64),
      planDigest: plan.planDigest,
      operations: {},
    };
    await executeMigrationPlan({
      api: api as never, plan, checkpoint,
      persistCheckpoint: async () => undefined,
    });
    assert.equal(api.mutations, 0);
    assert.deepEqual(
      await reconcileMigrationPlan(api as never, plan),
      { verified: 4, skipped: 0, conflicts: 0 },
    );
  });

  it("fails closed on incomplete, cyclic, over-limit, and timed-out storage pagination", async () => {
    const limits = {
      maxPages: 2, maxItems: 2, maxBytes: 100, deadlineMs: 20,
    };
    const rejectReason = async (
      reason: string,
      loadPage: Parameters<typeof collectBoundedPages>[0]["loadPage"],
      selected = limits,
    ) => assert.rejects(
      () => collectBoundedPages({ loadPage, limits: selected }),
      (error: unknown) => error instanceof StoragePaginationError &&
        error.reason === reason,
    );
    await rejectReason("storage-pagination-cycle", async () => ({
      Items: [], LastEvaluatedKey: { SK: "cursor", PK: "cursor" },
    }));
    await rejectReason("storage-pagination-malformed", async () => ({
      Items: [], LastEvaluatedKey: {},
    }));
    await rejectReason("storage-pagination-page-limit", async (cursor) => ({
      Items: [],
      LastEvaluatedKey: { PK: cursor ? "third" : "second", SK: "cursor" },
    }));
    await rejectReason("storage-pagination-item-limit", async () => ({
      Items: [{ id: "1" }, { id: "2" }, { id: "3" }],
    }));
    await rejectReason(
      "storage-pagination-byte-limit",
      async () => ({ Items: [{ value: "x".repeat(100) }] }),
      { ...limits, maxBytes: 10 },
    );
    await rejectReason("storage-pagination-failed", async () => {
      throw new Error("synthetic storage failure");
    });
    await rejectReason(
      "storage-pagination-timeout",
      async (_cursor, signal) => new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      }),
    );
  });

  it("sends mutations only through authenticated HTTPS and redacts permanent errors", async () => {
    const requests: { url: string; method: string; auth: string | null; body?: string }[] = [];
    const api = SponsorMigrationApi.create({
      origin: "https://synthetic.example.invalid",
      bearerToken: "synthetic_token_abcdefghijklmnopqrstuvwxyz",
      allowTestOrigin: true,
      requestFetch: (async (request: string | URL | Request, init?: RequestInit) => {
        requests.push({
          url: String(request),
          method: String(init?.method),
          auth: new Headers(init?.headers).get("authorization"),
          body: String(init?.body || ""),
        });
        return new Response(JSON.stringify({
          error: "private synthetic destination detail must not escape",
        }), {
          status: 422,
          headers: { "content-type": "application/json" },
        });
      }) as typeof fetch,
    });
    await assert.rejects(
      () => api.mutate("POST", "/api/sponsor-crm/organizations", {
        displayName: "Synthetic",
      }),
      (error: unknown) => error instanceof MigrationFailure &&
        error.reason === "api-request-rejected" &&
        !error.message.includes("private synthetic"),
    );
    assert.deepEqual(requests.map((request) => ({
      protocol: new URL(request.url).protocol,
      method: request.method,
      authenticated: request.auth === "Bearer synthetic_token_abcdefghijklmnopqrstuvwxyz",
    })), [{ protocol: "https:", method: "POST", authenticated: true }]);
  });

  it("bounds fetch deadlines, streamed bodies, and hostile pagination", async () => {
    const token = "synthetic_token_abcdefghijklmnopqrstuvwxyz";
    const hanging = SponsorMigrationApi.create({
      origin: "https://synthetic.example.invalid",
      bearerToken: token,
      allowTestOrigin: true,
      requestTimeoutMs: 10,
      requestFetch: (async (_request: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(new DOMException("synthetic abort", "AbortError")), { once: true });
        })) as typeof fetch,
      sleep: async () => undefined,
    });
    await assert.rejects(
      () => hanging.read("/api/me"),
      (error: unknown) => error instanceof MigrationFailure &&
        error.reason === "api-read-unavailable",
    );
    await assert.rejects(
      () => hanging.mutate("POST", "/api/sponsor-crm/organizations", {}),
      (error: unknown) => error instanceof MigrationFailure &&
        error.reason === "api-outcome-unknown",
    );
    const bodyHanging = SponsorMigrationApi.create({
      origin: "https://synthetic.example.invalid",
      bearerToken: token,
      allowTestOrigin: true,
      requestTimeoutMs: 10,
      requestFetch: (async (_request: string | URL | Request, init?: RequestInit) =>
        new Response(new ReadableStream({
          start(controller) {
            init?.signal?.addEventListener("abort", () =>
              controller.error(new DOMException("synthetic body abort", "AbortError")),
            { once: true });
          },
        }), { headers: { "content-type": "application/json" } })) as typeof fetch,
      sleep: async () => undefined,
    });
    await assert.rejects(
      () => bodyHanging.read("/api/me"),
      (error: unknown) => error instanceof MigrationFailure &&
        error.reason === "api-read-unavailable",
    );

    const oversized = SponsorMigrationApi.create({
      origin: "https://synthetic.example.invalid",
      bearerToken: token,
      allowTestOrigin: true,
      maxResponseBytes: 128,
      requestFetch: (async () => new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(`"${"x".repeat(256)}"`));
            controller.close();
          },
        }),
        { headers: { "content-type": "application/json" } },
      )) as typeof fetch,
    });
    await assert.rejects(
      () => oversized.read("/api/me"),
      (error: unknown) => error instanceof MigrationFailure &&
        error.reason === "api-response-too-large",
    );
    await assert.rejects(
      () => oversized.mutate("POST", "/api/sponsor-crm/organizations", {}),
      (error: unknown) => error instanceof MigrationFailure &&
        error.reason === "api-outcome-unknown",
    );

    const json = (body: unknown) => new Response(JSON.stringify(body), {
      headers: { "content-type": "application/json" },
    });
    const paginationApi = (
      mode: "cycle" | "pages" | "items" | "evidence" | "incomplete",
    ) =>
      SponsorMigrationApi.create({
        origin: "https://synthetic.example.invalid",
        bearerToken: token,
        allowTestOrigin: true,
        maxPages: mode === "pages" ? 1 : 3,
        maxItems: mode === "items" ? 1 : mode === "evidence" ? 200 : 10,
        requestFetch: (async (request: string | URL | Request) => {
          const url = String(request);
          if (url.endsWith("/api/me")) return json({ user: { enabled: true } });
          if (url.includes("/newsletter-slots?"))
            return json({
              items: [], complete: true, snapshotDigest: digest([]),
            });
          const cursor = new URL(url).searchParams.get("cursor") || "0";
          if (mode === "incomplete")
            return json({ items: [], nextCursor: null });
          if (mode === "evidence") {
            const first = cursor === "0";
            return json({
              items: first
                ? Array.from({ length: 100 }, (_value, index) => ({
                  id: `synthetic-${index}`, version: 1,
                }))
                : [{ id: "synthetic-100", version: 1 }],
              nextCursor: first ? "100" : null,
              complete: true,
              snapshotDigest: (first ? "a" : "b").repeat(64),
            });
          }
          if (mode === "items")
            return json({
              items: [
                { id: "synthetic-1", version: 1 },
                { id: "synthetic-2", version: 1 },
              ],
              nextCursor: null,
              complete: true,
              snapshotDigest: digest([
                { id: "synthetic-1", version: 1 },
                { id: "synthetic-2", version: 1 },
              ]),
            });
          return json({
            items: [],
            nextCursor: mode === "cycle" ? cursor : String(Number(cursor) + 1),
            complete: true,
            snapshotDigest: digest([]),
          });
        }) as typeof fetch,
        sleep: async () => undefined,
      });
    await assert.rejects(
      () => exportDestinationSnapshot(paginationApi("cycle")),
      (error: unknown) => error instanceof MigrationFailure &&
        error.reason === "api-pagination-cycle",
    );
    await assert.rejects(
      () => exportDestinationSnapshot(paginationApi("pages")),
      (error: unknown) => error instanceof MigrationFailure &&
        error.reason === "api-pagination-limit",
    );
    await assert.rejects(
      () => exportDestinationSnapshot(paginationApi("items")),
      (error: unknown) => error instanceof MigrationFailure &&
        error.reason === "api-pagination-limit",
    );
    await assert.rejects(
      () => exportDestinationSnapshot(paginationApi("evidence")),
      (error: unknown) => error instanceof MigrationFailure &&
        error.reason === "destination-changed-during-snapshot",
    );
    await assert.rejects(
      () => exportDestinationSnapshot(paginationApi("incomplete")),
      (error: unknown) => error instanceof MigrationFailure &&
        error.reason === "unexpected-api-response",
    );
  });

  it("requires recorded sign-off for artifact cleanup and preserves the 35-day backup gate", async () => {
    const value = await inputs();
    const runId = `synthetic-${randomUUID()}`;
    await runOfflineDryRun({
      manifestFile: value.manifestFile,
      snapshotFile: value.snapshotFile,
      sourceFiles: value.sourceFiles,
      runId,
    });
    const signoffFile = path.join(value.directory, "signoff.json");
    await writePrivate(signoffFile, {
      schemaVersion: 1,
      runId,
      signedOffAt: "2026-07-30T00:00:00.000Z",
      approvedByRef: "synthetic-approver",
    });
    await assert.rejects(
      () => runCleanup({
        runId, signoffFile, confirmRunId: "wrong-run",
        now: new Date("2026-07-31T00:00:00.000Z"),
      }),
      (error: unknown) => error instanceof MigrationFailure &&
        error.reason === "cleanup-confirmation-required",
    );
    const result = await runCleanup({
      runId, signoffFile, confirmRunId: runId,
      now: new Date("2026-07-31T00:00:00.000Z"),
    });
    assert.equal(result.artifactsDeleted, true);
    assert.equal(result.backupDeleteEligibleAt, "2026-09-03T00:00:00.000Z");
    assert.equal(result.backupDeletionRequiresHumanApproval, true);
  });

  it("keeps credentials out of CLI arguments and makes dry-run the default mode", () => {
    const parsed = parseSponsorMigrationArguments([
      "--manifest", "/private/synthetic-manifest.json",
      "--snapshot", "/private/synthetic-snapshot.json",
      "--source", "synthetic-source=/private/synthetic-source.json",
      "--run-id", "synthetic-run",
    ]);
    assert.equal(parsed.write, false);
    assert.equal(parsed.rollback, false);
    assert.equal(parsed.exportDestination, false);
    assert.throws(
      () => parseSponsorMigrationArguments(["--auth-token", "must-not-be-an-argument"]),
      (error: unknown) => error instanceof MigrationFailure &&
        error.reason === "invalid-arguments",
    );
  });
});

class MemoryApi {
  records = {
    organization: new Map<string, Record<string, unknown>>(),
    contact: new Map<string, Record<string, unknown>>(),
    booking: new Map<string, Record<string, unknown>>(),
  };
  slots = new Map<string, Record<string, unknown>>();
  mutations = 0;
  unknownCreateOnce = true;
  unknownLinkOnce = true;

  constructor() {
    this.slots.set("newsletter-slot-1", {
      id: "newsletter-slot-1", version: 1, status: "reserved",
    });
  }

  private locate(pathname: string) {
    const crm = pathname.match(/^\/api\/sponsor-crm\/(organizations|contacts|bookings)\/([^/]+)$/);
    if (crm) {
      const kind = crm[1].slice(0, -1) as keyof MemoryApi["records"];
      return this.records[kind].get(decodeURIComponent(crm[2]));
    }
    const slot = pathname.match(/^\/api\/newsletter-slots\/([^/]+)$/);
    if (slot) return this.slots.get(decodeURIComponent(slot[1]));
    return undefined;
  }

  async read<T>(pathname: string): Promise<T> {
    const value = await this.readOptional<T>(pathname);
    if (!value) throw new MigrationFailure("destination-record-missing");
    return value;
  }

  async readOptional<T>(pathname: string): Promise<T | undefined> {
    return this.locate(pathname) as T | undefined;
  }

  async mutate<T>(method: "POST" | "PUT" | "DELETE", pathname: string, body: any): Promise<T> {
    this.mutations += 1;
    const create = pathname.match(/^\/api\/sponsor-crm\/(organizations|contacts|bookings)$/);
    if (method === "POST" && create) {
      const kind = create[1].slice(0, -1) as keyof MemoryApi["records"];
      const id = createHash("sha256").update(`${kind}:${body.sourceKey}`).digest("hex");
      const record = { ...body, id, version: 1 };
      this.records[kind].set(id, record);
      if (this.unknownCreateOnce) {
        this.unknownCreateOnce = false;
        throw new MigrationFailure("api-outcome-unknown");
      }
      return record as T;
    }
    const schedule = pathname.match(/^\/api\/sponsor-crm\/bookings\/([^/]+)\/schedule-link$/);
    if (schedule) {
      const id = decodeURIComponent(schedule[1]);
      const current = this.records.booking.get(id)!;
      if (current.version !== body.version) throw new MigrationFailure("concurrent-destination-change");
      const next = {
        ...current,
        version: Number(current.version) + 1,
        ...(method === "DELETE" ? { scheduleEntryId: undefined } : { scheduleEntryId: body.scheduleEntryId }),
      };
      this.records.booking.set(id, next);
      if (this.unknownLinkOnce && method === "PUT") {
        this.unknownLinkOnce = false;
        throw new MigrationFailure("api-outcome-unknown");
      }
      return next as T;
    }
    const slot = pathname.match(/^\/api\/newsletter-slots\/([^/]+)$/);
    if (slot && method === "PUT") {
      const id = decodeURIComponent(slot[1]), current = this.slots.get(id)!;
      if (current.version !== body.version) throw new MigrationFailure("concurrent-destination-change");
      const next = { ...current, ...body, id, version: Number(current.version) + 1 };
      this.slots.set(id, next);
      return next as T;
    }
    const crm = pathname.match(/^\/api\/sponsor-crm\/(organizations|contacts|bookings)\/([^/]+)$/);
    if (crm) {
      const kind = crm[1].slice(0, -1) as keyof MemoryApi["records"];
      const id = decodeURIComponent(crm[2]), current = this.records[kind].get(id)!;
      if (body.version !== current.version) throw new MigrationFailure("concurrent-destination-change");
      const next = method === "DELETE"
        ? { ...current, version: Number(current.version) + 1, active: false, archivedAt: "synthetic" }
        : { ...current, ...body, id, version: Number(current.version) + 1 };
      this.records[kind].set(id, next);
      return next as T;
    }
    throw new MigrationFailure("unexpected-test-request");
  }
}

describe("sponsor CRM migration execution and compensation", () => {
  it("reconciles unknown creates and one-sided links, resumes safely, and reruns with zero writes", async () => {
    const plan = await directPlan();
    assert.equal(plan.operations.some((item) => item.action === "quarantine"), false);
    const api = new MemoryApi();
    const checkpoint: MigrationCheckpoint = {
      schemaVersion: 1,
      runId: "synthetic-run",
      manifestDigest: plan.manifestDigest,
      resolutionDigest: "a".repeat(64),
      planDigest: plan.planDigest,
      operations: {},
    };
    const saved: string[] = [];
    await executeMigrationPlan({
      api: api as never,
      plan,
      checkpoint,
      persistCheckpoint: async (value) => { saved.push(JSON.stringify(value)); },
    });
    assert.ok(saved.some((value) => value.includes('"state":"unknown"')));
    const reconciliation = await reconcileMigrationPlan(api as never, plan);
    assert.deepEqual(reconciliation, { verified: 4, skipped: 0, conflicts: 0 });
    const writes = api.mutations;
    await executeMigrationPlan({
      api: api as never,
      plan,
      checkpoint,
      persistCheckpoint: async () => undefined,
    });
    assert.equal(api.mutations, writes, "completed rerun performs zero mutations");
    assert.equal(api.slots.get("newsletter-slot-1")!.sponsorBookingId,
      plan.operations.find((item) => item.kind === "booking")!.destinationId);
  });

  it("rejects version drift in checkpointed creates and partially completed links", async () => {
    const plan = await directPlan();
    const completedApi = new MemoryApi();
    const completed: MigrationCheckpoint = {
      schemaVersion: 1,
      runId: "synthetic-version-run",
      manifestDigest: plan.manifestDigest,
      resolutionDigest: "a".repeat(64),
      planDigest: plan.planDigest,
      operations: {},
    };
    await executeMigrationPlan({
      api: completedApi as never, plan, checkpoint: completed,
      persistCheckpoint: async () => undefined,
    });
    const organizationId = plan.operations.find(
      (item) => item.kind === "organization",
    )!.destinationId!;
    completedApi.records.organization.get(organizationId)!.version = 2;
    await assert.rejects(
      () => executeMigrationPlan({
        api: completedApi as never, plan, checkpoint: completed,
        persistCheckpoint: async () => undefined,
      }),
      (error: unknown) => error instanceof MigrationFailure &&
        error.reason === "stale-checkpoint",
    );

    const partialApi = new MemoryApi();
    const originalMutate = partialApi.mutate.bind(partialApi);
    partialApi.mutate = async (method, pathname, body) => {
      if (method === "PUT" && pathname === "/api/newsletter-slots/newsletter-slot-1")
        throw new MigrationFailure("api-request-rejected");
      return originalMutate(method, pathname, body);
    };
    const partial: MigrationCheckpoint = {
      schemaVersion: 1,
      runId: "synthetic-partial-run",
      manifestDigest: plan.manifestDigest,
      resolutionDigest: "a".repeat(64),
      planDigest: plan.planDigest,
      operations: {},
    };
    await assert.rejects(
      () => executeMigrationPlan({
        api: partialApi as never, plan, checkpoint: partial,
        persistCheckpoint: async () => undefined,
      }),
      (error: unknown) => error instanceof MigrationFailure &&
        error.reason === "api-request-rejected",
    );
    const bookingId = plan.operations.find((item) => item.kind === "booking")!.destinationId!;
    assert.equal(partialApi.records.booking.get(bookingId)!.version, 2);
    partialApi.records.booking.get(bookingId)!.version = 3;
    partialApi.mutate = originalMutate;
    await assert.rejects(
      () => executeMigrationPlan({
        api: partialApi as never, plan, checkpoint: partial,
        persistCheckpoint: async () => undefined,
      }),
      (error: unknown) => error instanceof MigrationFailure &&
        error.reason === "stale-checkpoint",
    );
  });

  it("revalidates untouched approved records even after a checkpoint exists", async () => {
    const plan = await directPlan();
    const organization = plan.operations.find((item) => item.kind === "organization")!;
    const checkpoint: MigrationCheckpoint = {
      schemaVersion: 1,
      runId: "synthetic-snapshot-run",
      manifestDigest: plan.manifestDigest,
      resolutionDigest: "a".repeat(64),
      planDigest: plan.planDigest,
      operations: {
        [organization.operationId]: {
          state: "verified",
          destinationId: organization.destinationId,
          postWriteVersion: 1,
          outcome: "created",
        },
      },
    };
    const approved = emptySnapshot();
    const current = structuredClone(approved);
    current.organizations.push({
      id: organization.destinationId!,
      sourceKey: organization.sourceKey,
      version: 1,
      active: true,
      normalizedNameHash: identityHash(String(organization.payload!.displayName)),
    });
    current.newsletterSlots[0].version = 2;
    assert.throws(
      () => validateApprovedDestinationState({ approved, current, plan, checkpoint }),
      (error: unknown) => error instanceof MigrationFailure &&
        error.reason === "destination-changed-after-approval",
    );
  });

  it("stops permanent failures with a resumable checkpoint", async () => {
    const plan = await directPlan();
    const api = new MemoryApi();
    const original = api.mutate.bind(api);
    api.mutate = async (method, pathname, body) => {
      if (pathname === "/api/sponsor-crm/contacts")
        throw new MigrationFailure("api-request-rejected");
      return original(method, pathname, body);
    };
    const checkpoint: MigrationCheckpoint = {
      schemaVersion: 1,
      runId: "synthetic-run",
      manifestDigest: plan.manifestDigest,
      resolutionDigest: "a".repeat(64),
      planDigest: plan.planDigest,
      operations: {},
    };
    await assert.rejects(
      () => executeMigrationPlan({
        api: api as never,
        plan,
        checkpoint,
        persistCheckpoint: async () => undefined,
      }),
      (error: unknown) => error instanceof MigrationFailure &&
        error.reason === "api-request-rejected",
    );
    assert.ok(Object.values(checkpoint.operations).some((item) => item.state === "verified"));
    assert.ok(Object.values(checkpoint.operations).some((item) => item.state === "pending"));
  });

  it("preplans API-only rollback, compensates only unchanged migration-owned values, and quarantines edits", async () => {
    const plan = await directPlan();
    const api = new MemoryApi();
    const checkpoint: MigrationCheckpoint = {
      schemaVersion: 1,
      runId: "synthetic-run",
      manifestDigest: plan.manifestDigest,
      resolutionDigest: "a".repeat(64),
      planDigest: plan.planDigest,
      operations: {},
    };
    await executeMigrationPlan({
      api: api as never, plan, checkpoint,
      persistCheckpoint: async () => undefined,
    });
    const rollback = buildRollbackPlan("synthetic-run", plan);
    const preview = await executeRollback({
      api: api as never, migrationPlan: plan, rollbackPlan: rollback, write: false,
    });
    assert.equal(preview.eligible, 4);
    assert.equal(preview.compensated, 0);
    const result = await executeRollback({
      api: api as never, migrationPlan: plan, rollbackPlan: rollback, write: true,
    });
    assert.equal(result.compensated, 4);
    const bookingId = plan.operations.find((item) => item.kind === "booking")!.destinationId!;
    assert.equal(api.records.booking.get(bookingId)!.status, "cancelled");
    assert.equal(api.slots.get("newsletter-slot-1")!.sponsorBookingId, null);

    const secondPlan = await directPlan();
    const editedApi = new MemoryApi();
    const secondCheckpoint = {
      ...checkpoint,
      operations: {},
      planDigest: secondPlan.planDigest,
      manifestDigest: secondPlan.manifestDigest,
    };
    await executeMigrationPlan({
      api: editedApi as never, plan: secondPlan, checkpoint: secondCheckpoint,
      persistCheckpoint: async () => undefined,
    });
    const organizationId = secondPlan.operations.find(
      (item) => item.kind === "organization",
    )!.destinationId!;
    editedApi.records.organization.get(organizationId)!.version = 2;
    const guarded = await executeRollback({
      api: editedApi as never,
      migrationPlan: secondPlan,
      rollbackPlan: buildRollbackPlan("synthetic-run", secondPlan),
      write: false,
    });
    assert.equal(guarded.quarantined, 1);

    const childEditedApi = new MemoryApi();
    const childCheckpoint = {
      ...checkpoint,
      operations: {},
      planDigest: secondPlan.planDigest,
      manifestDigest: secondPlan.manifestDigest,
    };
    await executeMigrationPlan({
      api: childEditedApi as never, plan: secondPlan, checkpoint: childCheckpoint,
      persistCheckpoint: async () => undefined,
    });
    const contactId = secondPlan.operations.find(
      (item) => item.kind === "contact",
    )!.destinationId!;
    childEditedApi.records.contact.get(contactId)!.version = 2;
    const childGuarded = await executeRollback({
      api: childEditedApi as never,
      migrationPlan: secondPlan,
      rollbackPlan: buildRollbackPlan("synthetic-run", secondPlan),
      write: false,
    });
    assert.equal(childGuarded.quarantined, 2,
      "an edited child also prevents its migration-created parent from being archived");
  });

  it("restores only the missing side of a pre-existing partial newsletter link", async () => {
    const baseline = await directPlan();
    const organization = baseline.operations.find((item) => item.kind === "organization")!;
    const contact = baseline.operations.find((item) => item.kind === "contact")!;
    const booking = baseline.operations.find((item) => item.kind === "booking")!;
    const snapshot = emptySnapshot();
    snapshot.organizations = [{
      id: organization.destinationId!, sourceKey: organization.sourceKey,
      version: 2, active: true,
      normalizedNameHash: identityHash("Synthetic Organization"),
      strongDiscriminatorHash: identityHash("synthetic-registration-1"),
    }];
    snapshot.contacts = [{
      id: contact.destinationId!, sourceKey: contact.sourceKey,
      organizationId: organization.destinationId!, version: 2, active: true,
      normalizedEmailHashes: [emailHash("operator@example.invalid")],
    }];
    snapshot.bookings = [{
      id: booking.destinationId!, sourceKey: booking.sourceKey,
      organizationId: organization.destinationId!,
      primaryContactId: contact.destinationId!,
      version: 2, status: "confirmed", slotType: "main",
    }];
    snapshot.newsletterSlots[0].sponsorBookingId = booking.destinationId;
    const value = await inputs({
      snapshot,
      manifestChanges: { destinationSnapshotSha256: digest(snapshot) },
    });
    const plan = buildMigrationPlan({
      manifest: value.manifest,
      manifestDigest: await sourceFileDigest(value.manifestFile),
      destinationSnapshot: snapshot,
      destinationSnapshotDigest: digest(snapshot),
      sources: [{ manifest: value.manifest.sources[0], data: source }],
    });
    const api = new MemoryApi();
    api.records.organization.set(organization.destinationId!, {
      id: organization.destinationId!, sourceKey: organization.sourceKey, version: 2,
    });
    api.records.contact.set(contact.destinationId!, {
      id: contact.destinationId!, sourceKey: contact.sourceKey, version: 2,
      organizationId: organization.destinationId,
    });
    api.records.booking.set(booking.destinationId!, {
      id: booking.destinationId!, sourceKey: booking.sourceKey, version: 2,
      organizationId: organization.destinationId,
      primaryContactId: contact.destinationId,
    });
    api.slots.set("newsletter-slot-1", {
      id: "newsletter-slot-1", version: 1, status: "reserved",
      sponsorBookingId: booking.destinationId,
    });
    const checkpoint: MigrationCheckpoint = {
      schemaVersion: 1, runId: "synthetic-partial",
      manifestDigest: plan.manifestDigest, resolutionDigest: "a".repeat(64),
      planDigest: plan.planDigest, operations: {},
    };
    await executeMigrationPlan({
      api: api as never, plan, checkpoint,
      persistCheckpoint: async () => undefined,
    });
    assert.equal(api.records.booking.get(booking.destinationId!)!.scheduleEntryId,
      "newsletter-slot-1");
    const rollback = buildRollbackPlan("synthetic-partial", plan);
    const result = await executeRollback({
      api: api as never, migrationPlan: plan, rollbackPlan: rollback, write: true,
    });
    assert.equal(result.compensated, 1);
    assert.equal(api.records.booking.get(booking.destinationId!)!.scheduleEntryId, undefined);
    assert.equal(api.slots.get("newsletter-slot-1")!.sponsorBookingId,
      booking.destinationId, "the pre-existing slot side remains intact");
  });

  it("redacted plans never serialize source payload values", async () => {
    const plan = await directPlan();
    const rendered = JSON.stringify(redactedPlan(plan));
    assert.equal(rendered.includes("Synthetic Organization"), false);
    assert.equal(rendered.includes("operator@example.invalid"), false);
    assert.equal(rendered.includes("synthetic-registration-1"), false);
    assert.ok(rendered.includes(plan.planDigest) === false,
      "the digest is stored alongside, not recursively inside its own approval view");
  });
});
