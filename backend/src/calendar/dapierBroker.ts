/**
 * Shared Dapier calendar-broker credential resolution.
 *
 * Used by the owner-calendar free/busy overlay and by CalendarHold Google
 * Proposal mirroring. Product path is **through Dapier**:
 *
 *   Day-to-day (Orin): pick a google-calendar Dapier connection in DataOps
 *   Planning → calendar settings (or `dataops calendar settings --connection <id>`).
 *   Propose / podcast invite mint Google tokens for that stored connectionId.
 *
 *   Platform (once): Lambda uses machine agent `personal-scheduler` via the team store
 *   `personal-scheduler.dapier-api-token` to call Dapier `/api/agent/token`.
 *   Google OAuth grants live in Dapier — never Coolify/DataOps env tokens, and
 *   Orin does not stuff `dap_…` into the team store as a day-to-day step.
 */
import { readRuntimeSecret } from '../secrets/reader';

export const DAPIER_BASE_URL = 'https://dapier.dtcdev.click';
export const DAPIER_AGENT = 'personal-scheduler';
export const DAPIER_SECRET_NAME = 'personal-scheduler.dapier-api-token';

/**
 * SOP `sop.events.calendar.creating-tentative-event-on-google-calendar`:
 * every propose writes Proposal blocks on Alexey's personal calendar AND the
 * DataTalks.Club events calendar. Override with DATAOPS_HOLD_GOOGLE_CALENDARS
 * (comma-separated calendar ids) only when the defaults are wrong.
 */
export const DEFAULT_HOLD_GOOGLE_CALENDARS = [
  'alexey.s.grigoriev@gmail.com',
  'f8qidjnq0jhscp8809k1eghs60@group.calendar.google.com',
] as const;

/** Orin day-to-day path when Google sync cannot mint a token. */
export const CREDENTIAL_OPERATOR_HINT =
  `In DataOps Planning → calendar settings (or \`dataops calendar settings\`), pick a suitable Dapier google-calendar connection — propose/invite uses it automatically. ` +
  `No Coolify env tokens and no day-to-day credential setup. ` +
  `If the connection is already selected and sync still defers: the selected connection needs a Dapier \`use\` grant for agent "${DAPIER_AGENT}" (platform keeps the machine token in the team store "${DAPIER_SECRET_NAME}" once). Google refresh tokens stay in Dapier.`;

/** When the operator has not selected a connection. */
export const CONNECTION_OPERATOR_HINT =
  `Pick a Dapier google-calendar connection in DataOps Planning → calendar settings (or \`dataops calendar settings --connection <id>\`). Propose/invite use that connection automatically.`;

export type DapierCredential =
  | { credential: string; problem?: undefined }
  | { credential?: undefined; problem: string };

/** Do not echo broker response bodies: they can contain provider details. */
export function dapierTokenProblem(status: number, connectionId: string, agent = DAPIER_AGENT): string {
  if (status === 403) return `Dapier denied access to calendar connection "${connectionId}". A Dapier operator must grant agent "${agent}" and its machine identity the \`use\` operation on this connection.`;
  if (status === 401) return 'Dapier rejected the calendar machine credential. A platform operator must repair the machine credential; Google tokens stay in Dapier.';
  if (status === 404) return `The selected Dapier calendar connection "${connectionId}" no longer exists. ${CONNECTION_OPERATOR_HINT}`;
  if (status === 409 || status === 502) return `Dapier cannot obtain a Google token for calendar connection "${connectionId}". Reconnect that connection in Dapier and check its Google Calendar permissions.`;
  return `The calendar broker refused the token request (HTTP ${status}).`;
}

let readSecret = readRuntimeSecret;

export function setDapierBrokerClientsForTests(value: { readSecret: typeof readRuntimeSecret }): void {
  readSecret = value.readSecret;
}

async function readSecretCredential(): Promise<DapierCredential> {
  try {
    const raw = await readSecret(DAPIER_SECRET_NAME);
    if (raw) {
      try {
        const parsed = JSON.parse(raw);
        const token = parsed.api_token || parsed.token || raw;
        if (typeof token === 'string' && token.trim()) return { credential: token.trim() };
      } catch {
        if (raw.trim()) return { credential: raw.trim() };
      }
      return { problem: `The calendar broker secret ${DAPIER_SECRET_NAME} is empty.` };
    }
    return { problem: `The calendar broker secret ${DAPIER_SECRET_NAME} is empty.` };
  } catch (error) {
    const name = (error as { name?: string })?.name || 'Error';
    if (name === 'ResourceNotFoundException') {
      return { problem: `The calendar broker secret ${DAPIER_SECRET_NAME} does not exist in this environment.` };
    }
    if (
      name === 'UnrecognizedClientException' ||
      name === 'CredentialsProviderError' ||
      name === 'InvalidSignatureException'
    ) {
      return { problem: 'This environment has no AWS credentials that can read the calendar broker secret.' };
    }
    if (name === 'AccessDeniedException') {
      return { problem: `This environment is not allowed to read the calendar broker secret ${DAPIER_SECRET_NAME}.` };
    }
    const detail = String((error as { message?: string })?.message || '').trim().slice(0, 160);
    return { problem: `The calendar broker secret could not be read in this environment (${detail ? `${name}: ${detail}` : name}).` };
  }
}

/**
 * Resolve the Dapier machine token used to mint short-lived Google Calendar
 * access tokens via POST /api/agent/token.
 *
 * Non-empty `explicit` wins (tests). Empty string reads the team
 * store so overlays that pass brokerCredential:'' still exercise the store.
 */
export async function readDapierCredential(explicit?: string): Promise<DapierCredential> {
  const trimmed = explicit === undefined || explicit === null ? '' : String(explicit).trim();
  if (trimmed) return { credential: trimmed };
  const fromSecret = await readSecretCredential();
  if (fromSecret.credential) return fromSecret;
  return {
    problem:
      fromSecret.problem ||
      `No calendar broker credential in this environment. ${CREDENTIAL_OPERATOR_HINT}`,
  };
}

/** Calendar ids for hold Proposal mirrors (SOP: personal + DTC events). */
export function resolveHoldGoogleCalendars(explicit?: string[]): string[] {
  if (explicit && explicit.length) return explicit;
  const env = (process.env.DATAOPS_HOLD_GOOGLE_CALENDARS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return env.length ? env : [...DEFAULT_HOLD_GOOGLE_CALENDARS];
}
