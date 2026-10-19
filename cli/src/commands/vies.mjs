import { UsageError } from "../errors.mjs";
import { positional } from "../format.mjs";
import { apiFor } from "../session.mjs";

export const summary = "VIES: validate EU VAT IDs and preflight customer VAT before the monthly tax pack";

export const help = `dataops vies - EU VAT ID validation against VIES

Usage
  dataops vies check <vat-id> [--force]
      Validate one VAT ID (country prefix + number). Prints the VIES verdict
      and the recorded check (valid, not-found, invalid, unavailable).
      --force re-runs the live lookup even when a fresh result is recorded.
  dataops vies preflight [--refresh]
      Last known VAT state of every EU B2B customer, with flags:
      missing-vat-id, malformed-vat-id, invalid, not-found, unavailable, stale.
      --refresh re-runs VIES for flagged entries first. Exit code is 1 while
      any blocking flag remains: fix the VAT data before uploading the
      monthly bookkeeping pack.

A VAT ID needs its member-state prefix: DK12345678, not a bare CVR.
`;

const BLOCKING = new Set(["missing-vat-id", "malformed-vat-id", "invalid", "not-found"]);

function printCheck(io, check) {
  io.print(`VAT ID ${check.vatId}: ${check.status} (checked ${check.checkedAt})`);
  if (check.name) io.print(`Registered to: ${check.name}`);
  if (check.address) io.print(`Address: ${String(check.address).replace(/\n/g, ", ")}`);
  if (check.error) io.print(`Detail: ${check.error}`);
}

export async function check(args, io) {
  const [vatId] = positional(args);
  if (!vatId) throw new UsageError("usage: dataops vies check <vat-id> [--force]");
  const api = apiFor(args);
  const result = await api.post("/api/vies/check", { vatId, force: !!args.force });
  printCheck(io, result.check);
  return result;
}

export async function preflight(args, io) {
  const api = apiFor(args);
  const report = args.refresh
    ? await api.post("/api/vies/preflight", {})
    : await api.get("/api/vies/preflight");
  if (args.refresh && report.refreshed) io.print(`Re-checked ${report.refreshed} customer(s) against VIES.`);
  const flagged = report.entries.filter((entry) => entry.flags.length);
  io.print(`${report.scanned} EU B2B customer(s) in scope, ${flagged.length} flagged:`);
  for (const entry of flagged) {
    io.print(`  ${entry.displayName || entry.organizationId}${entry.country ? ` (${entry.country})` : ""}: ${entry.flags.join(", ")}${entry.vatId ? ` [${entry.vatId}]` : ""}`);
  }
  const blocking = report.entries.some((entry) => entry.flags.some((flag) => BLOCKING.has(flag)));
  if (blocking) {
    io.print("Blocking VAT issues remain: resolve them before uploading the monthly pack.");
    throw new Error("VIES preflight found blocking VAT issues");
  }
  if (!flagged.length) io.print("All customer VAT IDs are checked and valid.");
  return { ...report, blocking };
}
