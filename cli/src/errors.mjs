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
  conflict: 5, // 409: the record changed; re-read and retry
  invalid: 6, // 400/422: the API rejected the input
  unavailable: 7, // 5xx or network failure; safe to retry later
});

export class UsageError extends Error {
  constructor(message) {
    super(message);
    this.name = "UsageError";
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

/** The machine-readable error printed under `--json`. */
export function errorPayload(error) {
  const payload = { message: error.message, exitCode: exitCodeFor(error) };
  if (error instanceof ApiError) {
    payload.status = error.status;
    if (error.code) payload.code = error.code;
  }
  return { error: payload };
}

export function hintFor(error) {
  if (error instanceof ApiError && error.status === 409) {
    return "The record changed since it was read. Re-read it and retry.";
  }
  if (error instanceof ApiError && error.status === 403) {
    return "Your role does not allow this. `dataops whoami` shows who you are signed in as.";
  }
  return "";
}
