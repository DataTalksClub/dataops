import { createClient } from "./api.mjs";
import { resolveProfile } from "./config.mjs";
import { AuthError } from "./errors.mjs";

/** An authenticated client for the selected portal, or a clear sign-in error. */
export function apiFor(args) {
  const profile = resolveProfile(args);
  if (!profile.token) {
    throw new AuthError(
      "Not signed in. Run `dataops login`, or set DATAOPS_TOKEN (and DATAOPS_URL) for non-interactive use.",
    );
  }
  return createClient(profile);
}

/** The local calendar date, as the web app computes "today". */
export function today() {
  return new Date().toLocaleDateString("en-CA");
}
