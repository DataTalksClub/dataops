import { ApiError, NetworkError } from "./api.mjs";

/**
 * Exit codes are part of the CLI contract: scripts and agents branch on them.
 * Keep this table and the README in step.
 */
export const EXIT = Object.freeze({
  ok: 0,
  error: 1, // anything not classified below
  usage: 2, // bad command, flag, or missing argument; nothing was sent
  auth: 3, // not signed in, token rejected (401), or role forbids it (403)
  notFound: 4, // 404
  conflict: 5, // 409: the operation conflicts with current state
  invalid: 6, // 400/422: the API rejected the input
  unavailable: 7, // 5xx or network failure; safe to retry later
});

export class UsageError extends Error {
  constructor(message) {
    super(message);
    this.name = "UsageError";
  }
}

/** The operation conflicts with the current state; nothing was written. */
export class ConflictError extends Error {
  constructor(message, details) {
    super(message);
    this.name = "ConflictError";
    this.details = details;
  }
}

export class AuthError extends Error {
  constructor(message) {
    super(message);
    this.name = "AuthError";
  }
}

export function exitCodeFor(error) {
  if (error instanceof UsageError) return EXIT.usage;
  if (error instanceof AuthError) return EXIT.auth;
  if (error instanceof ConflictError) return EXIT.conflict;
  if (error instanceof NetworkError) return EXIT.unavailable;
  if (error instanceof ApiError) {
    if (error.status === 401 || error.status === 403) return EXIT.auth;
    if (error.status === 404) return EXIT.notFound;
    if (error.status === 409) return EXIT.conflict;
    if (error.status === 400 || error.status === 422) return EXIT.invalid;
    if (error.status >= 500) return EXIT.unavailable;
  }
  return EXIT.error;
}

// Documented accountant readiness/package fields only: never serialize an API
// response wholesale into CLI errors, including nested blocker metadata.
const FINANCE_BLOCKER_FIELDS = [
  "reportPeriod", "period", "rowId", "date", "counterparty", "amount", "currency",
  "status", "reason", "rowDigest", "reference",
];
function financeGateDetails(error) {
  const body = error.body;
  if (error.status !== 409 || !body || typeof body !== "object" || typeof body.reportPeriod !== "string"
    || !/^\d{4}-(0[1-9]|1[0-2])$/.test(body.reportPeriod)
    || !Array.isArray(body.blockers)) return undefined;
  const blockers = body.blockers.filter((row) => row && !Array.isArray(row)
    && typeof row === "object" && typeof row.rowId === "string" && typeof row.reason === "string")
    .map((row) => Object.fromEntries(FINANCE_BLOCKER_FIELDS
      .filter((field) => typeof row[field] === "string").map((field) => [field, row[field]])));
  return { reportPeriod: body.reportPeriod, blockers };
}

/** The machine-readable error printed under `--json`. */
export function errorPayload(error) {
  const payload = { message: error.message, exitCode: exitCodeFor(error) };
  if (error instanceof ApiError) {
    payload.status = error.status;
    if (error.code) payload.code = error.code;
    const details = financeGateDetails(error);
    if (details) payload.details = details;
  }
  if (error instanceof ConflictError && error.details) payload.details = error.details;
  return { error: payload };
}

export function hintFor(error) {
  if (error instanceof ApiError && error.status === 409 && /^Record was changed; reload and retry\.?$/i.test(error.message)) {
    return "Re-read it and retry.";
  }
  if (error instanceof ApiError && error.status === 403) {
    return "Your role does not allow this. `dataops whoami` shows who you are signed in as.";
  }
  return "";
}
