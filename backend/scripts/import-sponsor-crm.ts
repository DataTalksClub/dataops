#!/usr/bin/env node

/**
 * One-off Sponsor CRM source importer.
 *
 * This intentionally has no generalized plan, approval manifest, checkpoint,
 * resume, destination snapshot, reconciliation, rollback, or cleanup engine.
 * It reads one retained raw JSON export and writes through the ordinary CRM
 * API. Run without --write to validate and count the source records.
 *
 * Usage:
 *   tsx scripts/import-sponsor-crm.ts --source sponsor.json \
 *     [--status-map statuses.json] [--api-base-url URL] \
 *     [--confirm-origin URL] [--write]
 *
 * Writes require DATAOPS_OPERATOR_SESSION_TOKEN and an exact --confirm-origin.
 */

import { promises as fs } from "fs";
import path from "path";

const PRODUCTION_ORIGIN = "https://ops.dtcdev.click";
const OPAQUE = /^(?!\.{1,2}$)[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const SLOT_TYPES = new Set(["main", "secondary", "standalone"]);
const BOOKING_STATUSES = new Set([
  "inquiry", "held", "confirmed", "materials-pending", "materials-ready",
  "scheduled", "published", "performance-due", "complete", "cancelled",
]);

type SourceOrganization = {
  recordId: string;
  displayName: string;
  strongDiscriminator?: string;
};
type SourceContact = {
  recordId: string;
  organizationRecordId: string;
  name: string;
  emails?: string[];
};
type SourceBooking = {
  recordId: string;
  organizationRecordId: string;
  primaryContactRecordId?: string;
  slotType: string;
  sourceStatus: string;
  plannedPublicationDate?: string;
  materialDeadline?: string;
  nextActionDate?: string;
};
type SponsorSource = {
  schemaVersion: 1;
  organizations: SourceOrganization[];
  contacts: SourceContact[];
  bookings: SourceBooking[];
};
type Arguments = {
  sourceFile?: string;
  statusMapFile?: string;
  origin: string;
  confirmOrigin?: string;
  write: boolean;
};

class ImportFailure extends Error {
  constructor(readonly reason: string) {
    super(reason);
    this.name = "ImportFailure";
  }
}

function parseArguments(argv: string[]): Arguments {
  const result: Arguments = { origin: PRODUCTION_ORIGIN, write: false };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (flag === "--write") result.write = true;
    else if (["--source", "--status-map", "--api-base-url", "--confirm-origin"].includes(flag) && value) {
      if (flag === "--source") result.sourceFile = path.resolve(value);
      if (flag === "--status-map") result.statusMapFile = path.resolve(value);
      if (flag === "--api-base-url") result.origin = value.replace(/\/$/, "");
      if (flag === "--confirm-origin") result.confirmOrigin = value.replace(/\/$/, "");
      index += 1;
    } else throw new ImportFailure("invalid-arguments");
  }
  if (!result.sourceFile) throw new ImportFailure("source-required");
  let parsed: URL;
  try { parsed = new URL(result.origin); } catch { throw new ImportFailure("invalid-origin"); }
  if (parsed.protocol !== "https:" && parsed.hostname !== "127.0.0.1" && parsed.hostname !== "localhost")
    throw new ImportFailure("invalid-origin");
  return result;
}

function validDate(value: unknown) {
  if (typeof value !== "string" || !DATE.test(value)) return false;
  return new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
}

function validateSource(value: unknown): SponsorSource {
  if (!value || typeof value !== "object") throw new ImportFailure("invalid-source");
  const source = value as SponsorSource;
  if (source.schemaVersion !== 1 || !Array.isArray(source.organizations) ||
      !Array.isArray(source.contacts) || !Array.isArray(source.bookings) ||
      source.organizations.length + source.contacts.length + source.bookings.length > 100_000)
    throw new ImportFailure("invalid-source");
  for (const item of source.organizations)
    if (!OPAQUE.test(item.recordId) || typeof item.displayName !== "string" ||
        !item.displayName.trim() || item.displayName.length > 200)
      throw new ImportFailure("invalid-organization");
  for (const item of source.contacts)
    if (!OPAQUE.test(item.recordId) || !OPAQUE.test(item.organizationRecordId) ||
        typeof item.name !== "string" || !item.name.trim() || item.name.length > 200 ||
        (item.emails !== undefined && (!Array.isArray(item.emails) || item.emails.length > 10 ||
          item.emails.some((email) => typeof email !== "string" || email.length > 254 ||
            !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)))))
      throw new ImportFailure("invalid-contact");
  for (const item of source.bookings)
    if (!OPAQUE.test(item.recordId) || !OPAQUE.test(item.organizationRecordId) ||
        (item.primaryContactRecordId !== undefined && !OPAQUE.test(item.primaryContactRecordId)) ||
        !SLOT_TYPES.has(item.slotType) || !OPAQUE.test(item.sourceStatus) ||
        [item.plannedPublicationDate, item.materialDeadline, item.nextActionDate]
          .some((date) => date !== undefined && !validDate(date)))
      throw new ImportFailure("invalid-booking");
  return source;
}

async function readJson(file: string) {
  try { return JSON.parse(await fs.readFile(file, "utf8")) as unknown; }
  catch { throw new ImportFailure("invalid-json"); }
}

async function apiCreate(origin: string, token: string, plural: string, body: Record<string, unknown>) {
  const response = await fetch(`${origin}/api/sponsor-crm/${plural}`, {
    method: "POST",
    redirect: "error",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  if (response.status !== 200 && response.status !== 201)
    throw new ImportFailure(`api-${plural}-rejected-${response.status}`);
  const record = await response.json() as Record<string, unknown>;
  if (typeof record.id !== "string") throw new ImportFailure(`api-${plural}-invalid-response`);
  return record;
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArguments(argv);
  const source = validateSource(await readJson(args.sourceFile!));
  const statusMap = args.statusMapFile
    ? await readJson(args.statusMapFile) as Record<string, string>
    : {};
  const statuses = source.bookings.map((booking) => statusMap[booking.sourceStatus] || booking.sourceStatus);
  if (statuses.some((status) => !BOOKING_STATUSES.has(status)))
    throw new ImportFailure("unmapped-booking-status");
  const counts = {
    organizations: source.organizations.length,
    contacts: source.contacts.length,
    bookings: source.bookings.length,
  };
  if (!args.write) return { mode: "validate", source: args.sourceFile, counts };
  if (args.confirmOrigin !== args.origin) throw new ImportFailure("origin-confirmation-required");
  const token = process.env.DATAOPS_OPERATOR_SESSION_TOKEN;
  if (!token) throw new ImportFailure("operator-session-required");

  const organizationIds = new Map<string, string>();
  for (const item of source.organizations) {
    const created = await apiCreate(args.origin, token, "organizations", {
      displayName: item.displayName,
      ...(item.strongDiscriminator ? { strongDiscriminator: item.strongDiscriminator } : {}),
      sourceKey: `sponsor-import:${item.recordId}`,
      sourceType: "import",
    });
    organizationIds.set(item.recordId, String(created.id));
  }
  const contactIds = new Map<string, string>();
  for (const item of source.contacts) {
    const organizationId = organizationIds.get(item.organizationRecordId);
    if (!organizationId) throw new ImportFailure("missing-organization-reference");
    const created = await apiCreate(args.origin, token, "contacts", {
      organizationId,
      name: item.name,
      ...(item.emails ? { emails: item.emails } : {}),
      sourceKey: `sponsor-import:${item.recordId}`,
      sourceType: "import",
    });
    contactIds.set(item.recordId, String(created.id));
  }
  for (const [index, item] of source.bookings.entries()) {
    const organizationId = organizationIds.get(item.organizationRecordId);
    const primaryContactId = item.primaryContactRecordId
      ? contactIds.get(item.primaryContactRecordId)
      : undefined;
    if (!organizationId || (item.primaryContactRecordId && !primaryContactId))
      throw new ImportFailure("missing-booking-reference");
    await apiCreate(args.origin, token, "bookings", {
      organizationId,
      ...(primaryContactId ? { primaryContactId } : {}),
      slotType: item.slotType,
      status: statuses[index],
      ...(item.plannedPublicationDate ? { plannedPublicationDate: item.plannedPublicationDate } : {}),
      ...(item.materialDeadline ? { materialDeadline: item.materialDeadline } : {}),
      ...(item.nextActionDate ? { nextActionDate: item.nextActionDate } : {}),
      sourceKey: `sponsor-import:${item.recordId}`,
      sourceType: "import",
    });
  }
  return { mode: "write", origin: args.origin, counts };
}

if (require.main === module)
  main().then(
    (result) => process.stdout.write(`${JSON.stringify({ ok: true, ...result })}\n`),
    (error) => {
      const reason = error instanceof ImportFailure ? error.reason : "unexpected-failure";
      process.stderr.write(`${JSON.stringify({ ok: false, reason })}\n`);
      process.exitCode = 1;
    },
  );
