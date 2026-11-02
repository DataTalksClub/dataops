import { createClient } from "./api.mjs";
import { resolveProfile } from "./config.mjs";
import { sessionCredential } from "./commands/auth.mjs";
import { AuthError } from "./errors.mjs";
import { berlinToday } from "./format.mjs";

/** An authenticated client for the selected portal, or a clear sign-in error. */
export function apiFor(args) {
  const profile = resolveProfile(args);
  const credential = profile.source === "environment" ? null : sessionCredential(profile);
  if (!profile.token && !profile.accessToken && !profile.clientId) {
    throw new AuthError(
      "Not signed in. Run `dataops login`, or set DATAOPS_TOKEN (and DATAOPS_URL) for non-interactive use.",
    );
  }
  return createClient({ url: profile.url, token: profile.token, credential });
}

/** The agent's calendar date in Europe/Berlin, as the web queue computes "today". */
export function today() {
  if (process.env.DATAOPS_TODAY && /^\d{4}-\d{2}-\d{2}$/.test(process.env.DATAOPS_TODAY)) {
    return process.env.DATAOPS_TODAY;
  }
  return berlinToday();
}
