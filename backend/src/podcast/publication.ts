/**
 * Podcast publication evidence and the readiness derived from it.
 *
 * `publication` holds only what an operator observed, each fact with the time
 * it was observed and, where there is one, a proof link:
 *  - `audioSchedule`: the audio is scheduled in Spotify for an instant, read in
 *    a timezone. This is evidence of external scheduling, not a plan; the
 *    intended release is the episode's own `releaseDate`.
 *  - `spotify`: the public episode was verified playable.
 *  - `transcript`: the transcript was reviewed, with proof.
 *  - `website`: the page was released.
 *  - `websiteObserved`: the page was seen live.
 *
 * Readiness is derived on every read and never stored. Where no evidence is
 * recorded the state is `not-recorded`, never a definite "not scheduled".
 * Nothing here gates a status or a release: the episode's status moves with
 * its Card (cardStatus.ts), whose Tasks carry their own proof.
 */

export type PodcastPublication = {
  audioSchedule?: { scheduledAt: string; timezone: string; observedAt: string; proofUrl?: string };
  spotify?: { publicVerifiedAt: string; episodeUrl: string };
  transcript?: { reviewedAt: string; proofUrl: string };
  website?: { releasedAt: string; proofUrl: string };
  websiteObserved?: { observedAt: string; proofUrl: string };
};

export type SpotifyState = 'not-recorded' | 'scheduled' | 'awaiting-public-check' | 'public';
export type TranscriptState = 'not-recorded' | 'reviewed';
export type WebsiteState = 'not-recorded' | 'released' | 'observed-live';

export type PublicationReadiness = {
  spotify: SpotifyState;
  transcript: TranscriptState;
  website: WebsiteState;
  /** The scheduled audio's local calendar date, when scheduling is evidenced. */
  scheduledLocalDate: string | null;
};

const SECTIONS = ['audioSchedule', 'spotify', 'transcript', 'website', 'websiteObserved'];
const CLOCK_SKEW_MS = 5 * 60 * 1000;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

const httpsUrl = (value: unknown, max = 2000): URL | null => {
  if (typeof value !== 'string' || value.length > max) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' ? url : null;
  } catch {
    return null;
  }
};

const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;

/** A real ISO-8601 instant with an explicit offset, as a UTC ISO string. */
function instant(value: unknown): string | null {
  if (typeof value !== 'string' || !ISO_INSTANT.test(value)) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

export function validTimezone(value: unknown): boolean {
  if (typeof value !== 'string' || !value || value.length > 64) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

/** YYYY-MM-DD of `utcInstant` as read on the wall clock of `timezone`. */
export function localDate(utcInstant: string, timezone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(utcInstant));
  const part = (type: string) => parts.find((entry) => entry.type === type)?.value;
  return `${part('year')}-${part('month')}-${part('day')}`;
}

type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

/** Validate and normalise a `publication` body. Instants come back as UTC ISO strings. */
export function normalizePublication(
  value: unknown,
  now = new Date(),
): Parsed<PodcastPublication> {
  const fail = (error: string) => ({ ok: false as const, error });
  if (!isRecord(value)) return fail('Invalid publication');
  const unknown = Object.keys(value).find((name) => !SECTIONS.includes(name));
  if (unknown) return fail(`Unknown publication field: ${unknown}`);
  const latest = now.getTime() + CLOCK_SKEW_MS;
  const observed = (raw: unknown, label: string): Parsed<string> => {
    const at = instant(raw);
    if (!at) return fail(`Invalid ${label}`);
    if (new Date(at).getTime() > latest) return fail(`${label} cannot be in the future`);
    return { ok: true, value: at };
  };
  const section = (name: string, allowed: string[]) => {
    const body = value[name];
    if (!isRecord(body) || Object.keys(body).some((key) => !allowed.includes(key))) return null;
    return body;
  };
  const out: PodcastPublication = {};

  if (value.audioSchedule != null) {
    const body = section('audioSchedule', ['scheduledAt', 'timezone', 'observedAt', 'proofUrl']);
    if (!body) return fail('Invalid audioSchedule');
    const scheduledAt = instant(body.scheduledAt);
    if (!scheduledAt) return fail('Invalid audioSchedule.scheduledAt');
    if (!validTimezone(body.timezone)) return fail('Invalid audioSchedule.timezone');
    const seen = observed(body.observedAt, 'audioSchedule.observedAt');
    if (!seen.ok) return seen;
    out.audioSchedule = {
      scheduledAt,
      timezone: body.timezone as string,
      observedAt: seen.value,
    };
    if (body.proofUrl != null) {
      if (!httpsUrl(body.proofUrl)) return fail('audioSchedule.proofUrl must be an https link');
      out.audioSchedule.proofUrl = body.proofUrl as string;
    }
  }

  if (value.spotify != null) {
    const body = section('spotify', ['publicVerifiedAt', 'episodeUrl']);
    if (!body) return fail('Invalid spotify verification');
    const verified = observed(body.publicVerifiedAt, 'spotify.publicVerifiedAt');
    if (!verified.ok) return verified;
    const url = httpsUrl(body.episodeUrl);
    if (!url || url.hostname !== 'open.spotify.com' || !url.pathname.startsWith('/episode/'))
      return fail('spotify.episodeUrl must be an https://open.spotify.com/episode/ link');
    out.spotify = { publicVerifiedAt: verified.value, episodeUrl: url.toString() };
  }

  if (value.transcript != null) {
    const body = section('transcript', ['reviewedAt', 'proofUrl']);
    if (!body) return fail('Invalid transcript review');
    const reviewed = observed(body.reviewedAt, 'transcript.reviewedAt');
    if (!reviewed.ok) return reviewed;
    if (!httpsUrl(body.proofUrl)) return fail('transcript.proofUrl is required and must be an https link');
    out.transcript = { reviewedAt: reviewed.value, proofUrl: body.proofUrl as string };
  }

  if (value.websiteObserved != null) {
    const body = section('websiteObserved', ['observedAt', 'proofUrl']);
    if (!body) return fail('Invalid websiteObserved');
    const seen = observed(body.observedAt, 'websiteObserved.observedAt');
    if (!seen.ok) return seen;
    if (!httpsUrl(body.proofUrl)) return fail('websiteObserved.proofUrl must be an https link');
    out.websiteObserved = { observedAt: seen.value, proofUrl: body.proofUrl as string };
  }

  if (value.website != null) {
    const body = section('website', ['releasedAt', 'proofUrl']);
    if (!body) return fail('Invalid website release');
    const released = observed(body.releasedAt, 'website.releasedAt');
    if (!released.ok) return released;
    if (!httpsUrl(body.proofUrl)) return fail('website.proofUrl must be an https link');
    out.website = { releasedAt: released.value, proofUrl: body.proofUrl as string };
  }
  return { ok: true, value: out };
}

/** Derived readiness. `now` only decides scheduled vs awaiting-public-check. */
export function derivePublicationReadiness(
  publication: PodcastPublication | null | undefined,
  now = new Date(),
): PublicationReadiness {
  const facts = publication || {};
  let spotify: SpotifyState = 'not-recorded';
  if (facts.spotify?.publicVerifiedAt) spotify = 'public';
  else if (facts.audioSchedule)
    spotify =
      new Date(facts.audioSchedule.scheduledAt).getTime() <= now.getTime()
        ? 'awaiting-public-check'
        : 'scheduled';
  const transcript: TranscriptState =
    facts.transcript?.reviewedAt && facts.transcript.proofUrl ? 'reviewed' : 'not-recorded';
  let website: WebsiteState = 'not-recorded';
  if (facts.website?.releasedAt) website = 'released';
  else if (facts.websiteObserved?.observedAt) website = 'observed-live';
  return {
    spotify,
    transcript,
    website,
    scheduledLocalDate: facts.audioSchedule
      ? localDate(facts.audioSchedule.scheduledAt, facts.audioSchedule.timezone)
      : null,
  };
}
