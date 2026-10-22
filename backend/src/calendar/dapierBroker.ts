/**
 * Shared Dapier calendar-broker credential resolution.
 *
 * Used by the owner-calendar free/busy overlay and by CalendarHold Google
 * Proposal mirroring. Product path is **through Dapier** (same machine-agent
 * pattern as other headless consumers):
 *
 *   1. explicit credential (tests / injected only)
 *   2. AWS Secrets Manager secret `personal-scheduler/dapier-api-token`
 *      — the Dapier machine API token (`dap_…`) for agent `personal-scheduler`
 *
 * Google OAuth refresh tokens and connection grants live in Dapier. DataOps
 * never asks operators to put PERSONAL_SCHEDULER_TOKEN / DATAOPS_HOLD_BROKER_TOKEN
 * in Coolify or DataOps env. Operator path: dapier auth + connect/grant
 * google-calendar for personal-scheduler; keep the machine token in the SM
 * secret the Lambda already may read (infra/template.full.yaml).
 */
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';

export const DAPIER_BASE_URL = 'https://dapier.dtcdev.click';
export const DAPIER_AGENT = 'personal-scheduler';
export const DAPIER_SECRET_NAME = 'personal-scheduler/dapier-api-token';
export const DEFAULT_CALENDAR_CONNECTION = 'google-calendar';

/**
 * SOP `sop.events.calendar.creating-tentative-event-on-google-calendar`:
 * every propose writes Proposal blocks on Alexey's personal calendar AND the
 * DataTalks.Club events calendar. Override with DATAOPS_HOLD_GOOGLE_CALENDARS
 * (comma-separated calendar ids) only when the defaults are wrong.
 */
export const DEFAULT_HOLD_GOOGLE_CALENDARS = [
  'primary',
  'f8qidjnq0jhscp8809k1eghs60@group.calendar.google.com',
] as const;

/** Operator path when the Dapier machine credential is missing or unusable. */
export const CREDENTIAL_OPERATOR_HINT =
  `Through Dapier (not DataOps/Coolify env): ` +
  `dapier auth login → ensure connection "${DEFAULT_CALENDAR_CONNECTION}" is connected with calendar event write scopes → ` +
  `dapier tokens create --name personal-scheduler --agent personal-scheduler (once) → ` +
  `dapier grants save with subject "token:personal-scheduler", agent "${DAPIER_AGENT}", connection_id "${DEFAULT_CALENDAR_CONNECTION}", operations ["use"] → ` +
  `store the dap_… value in AWS Secrets Manager secret "${DAPIER_SECRET_NAME}" (JSON {api_token} or raw) for the DataOps Lambda. ` +
  `Google refresh tokens stay in Dapier.`;

export type DapierCredential =
  | { credential: string; problem?: undefined }
  | { credential?: undefined; problem: string };

let secretClient = new SecretsManagerClient({});

export function setDapierBrokerClientsForTests(value: { secrets?: SecretsManagerClient }): void {
  if (value.secrets) secretClient = value.secrets;
}

async function readSecretCredential(): Promise<DapierCredential> {
  try {
    const res = await secretClient.send(new GetSecretValueCommand({ SecretId: DAPIER_SECRET_NAME }));
    if (res.SecretString) {
      try {
        const parsed = JSON.parse(res.SecretString);
        const token = parsed.api_token || parsed.token || res.SecretString;
        if (typeof token === 'string' && token.trim()) return { credential: token.trim() };
      } catch {
        if (res.SecretString.trim()) return { credential: res.SecretString.trim() };
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
 * Non-empty `explicit` wins (tests). Empty string falls through to Secrets
 * Manager so overlays that pass brokerCredential:'' still exercise SM.
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

export async function resolveDapierCredential(explicit?: string): Promise<string | undefined> {
  return (await readDapierCredential(explicit)).credential;
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
