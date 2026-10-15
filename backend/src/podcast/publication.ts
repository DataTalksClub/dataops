/**
 * Podcast publication facts and the readiness derived from them.
 *
 * `publication` records what an operator observed: when the audio is
 * scheduled (a UTC instant plus the timezone it is read in), when the public
 * Spotify episode was verified playable, when the transcript was reviewed,
 * and when the website page went live. Readiness is derived from those facts
 * on every read and never stored; nothing here infers "public" from a date.
 *
 * The website needs BOTH a reviewed transcript and a verified public Spotify
 * episode. Scheduled audio does not satisfy it.
 */

export type PodcastPublication = {
  timezone?: string;
  audioScheduledAt?: string;
  spotify?: { publicVerifiedAt: string; episodeUrl: string };
  transcript?: { reviewedAt: string; proofUrl?: string };
  website?: { releasedAt: string; proofUrl: string; earlyReason?: string };
};

export type SpotifyState = 'not-scheduled' | 'scheduled' | 'awaiting-public-check' | 'public';
export type TranscriptState = 'pending' | 'reviewed';
export type WebsiteState = 'blocked' | 'ready' | 'released' | 'released-early';

export type PublicationReadiness = {
  spotify: SpotifyState;
  transcript: TranscriptState;
  website: WebsiteState;
  /** What still stops the website release; empty once ready or released. */
  websiteBlockers: string[];
  /** The audio's local calendar date in `timezone`, when scheduled. */
  scheduledLocalDate: string | null;
};

const SECTIONS = ['timezone', 'audioScheduledAt', 'spotify', 'transcript', 'website'];
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

export function websiteReady(publication: PodcastPublication | null | undefined): boolean {
  return Boolean(publication?.transcript?.reviewedAt && publication?.spotify?.publicVerifiedAt);
}

/**
 * Validate and normalise a `publication` body. Returns the cleaned value or an
 * error message; instants come back as UTC ISO strings.
 */
export function normalizePublication(
  value: unknown,
  now = new Date(),
): { ok: true; value: PodcastPublication } | { ok: false; error: string } {
  const fail = (error: string) => ({ ok: false as const, error });
  if (!isRecord(value)) return fail('Invalid publication');
  const unknown = Object.keys(value).find((name) => !SECTIONS.includes(name));
  if (unknown) return fail(`Unknown publication field: ${unknown}`);
  const latest = now.getTime() + CLOCK_SKEW_MS;
  const observed = (raw: unknown, label: string) => {
    const at = instant(raw);
    if (!at) return fail(`Invalid ${label}`);
    if (new Date(at).getTime() > latest) return fail(`${label} cannot be in the future`);
    return { ok: true as const, at };
  };
  const out: PodcastPublication = {};

  if (value.timezone != null) {
    if (!validTimezone(value.timezone)) return fail('Invalid publication timezone');
    out.timezone = value.timezone as string;
  }
  if (value.audioScheduledAt != null) {
    const at = instant(value.audioScheduledAt);
    if (!at) return fail('Invalid audioScheduledAt');
    if (!out.timezone) return fail('audioScheduledAt needs a timezone');
    out.audioScheduledAt = at;
  }

  if (value.spotify != null) {
    const spotify = value.spotify;
    if (
      !isRecord(spotify) ||
      Object.keys(spotify).some((name) => !['publicVerifiedAt', 'episodeUrl'].includes(name))
    )
      return fail('Invalid spotify verification');
    const verified = observed(spotify.publicVerifiedAt, 'spotify.publicVerifiedAt');
    if (!verified.ok) return verified;
    const url = httpsUrl(spotify.episodeUrl);
    if (!url || url.hostname !== 'open.spotify.com' || !url.pathname.startsWith('/episode/'))
      return fail('spotify.episodeUrl must be an https://open.spotify.com/episode/ link');
    out.spotify = { publicVerifiedAt: verified.at, episodeUrl: url.toString() };
  }

  if (value.transcript != null) {
    const transcript = value.transcript;
    if (
      !isRecord(transcript) ||
      Object.keys(transcript).some((name) => !['reviewedAt', 'proofUrl'].includes(name))
    )
      return fail('Invalid transcript review');
    const reviewed = observed(transcript.reviewedAt, 'transcript.reviewedAt');
    if (!reviewed.ok) return reviewed;
    out.transcript = { reviewedAt: reviewed.at };
    if (transcript.proofUrl != null) {
      if (!httpsUrl(transcript.proofUrl)) return fail('transcript.proofUrl must be an https link');
      out.transcript.proofUrl = transcript.proofUrl as string;
    }
  }

  if (value.website != null) {
    const website = value.website;
    if (
      !isRecord(website) ||
      Object.keys(website).some((name) => !['releasedAt', 'proofUrl', 'earlyReason'].includes(name))
    )
      return fail('Invalid website release');
    const released = observed(website.releasedAt, 'website.releasedAt');
    if (!released.ok) return released;
    if (!httpsUrl(website.proofUrl)) return fail('website.proofUrl must be an https link');
    out.website = { releasedAt: released.at, proofUrl: website.proofUrl as string };
    if (!websiteReady(out)) {
      const reason = typeof website.earlyReason === 'string' ? website.earlyReason.trim() : '';
      if (!reason || reason.length > 500)
        return fail(
          'The website needs a reviewed transcript and a verified public Spotify episode; ' +
            'record website.earlyReason (up to 500 characters) to release it before both',
        );
      out.website.earlyReason = reason;
    }
  }
  return { ok: true, value: out };
}

/** Derived readiness. `now` only decides scheduled vs awaiting-public-check. */
export function derivePublicationReadiness(
  publication: PodcastPublication | null | undefined,
  now = new Date(),
): PublicationReadiness {
  const facts = publication || {};
  let spotify: SpotifyState = 'not-scheduled';
  if (facts.spotify?.publicVerifiedAt) spotify = 'public';
  else if (facts.audioScheduledAt)
    spotify = new Date(facts.audioScheduledAt).getTime() <= now.getTime() ? 'awaiting-public-check' : 'scheduled';
  const transcript: TranscriptState = facts.transcript?.reviewedAt ? 'reviewed' : 'pending';
  const ready = websiteReady(facts);
  let website: WebsiteState;
  if (facts.website?.releasedAt) website = ready ? 'released' : 'released-early';
  else website = ready ? 'ready' : 'blocked';
  const websiteBlockers: string[] = [];
  if (!facts.website?.releasedAt && !ready) {
    if (transcript !== 'reviewed') websiteBlockers.push('Transcript not reviewed');
    if (spotify !== 'public') websiteBlockers.push('Spotify episode not verified public');
  }
  return {
    spotify,
    transcript,
    website,
    websiteBlockers,
    scheduledLocalDate:
      facts.audioScheduledAt && facts.timezone ? localDate(facts.audioScheduledAt, facts.timezone) : null,
  };
}
