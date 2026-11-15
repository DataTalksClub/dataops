import { apiFor } from "../session.mjs";

export const summary = "Academy shortlist signups and UTM attribution across tracks";

export const help = `dataops academy-leads - list academy.datatalks.club shortlist signups and /sessions (source=layoff_proof) leads

Usage
  dataops academy-leads [--include-tests] [--status <confirmed|pending|all>] [--pending] [--track <track>] [--source <source>] [--json]

Options
  --include-tests     Include is_test rows (hidden by default)
  --status STATUS     Filter confirmation status: confirmed (default), pending, or all
  --pending           Shorthand for --status pending
  --track TRACK       Filter to one track (agentic-engineering or ai-engineering)
  --source SOURCE     Filter to one lead source (e.g. shortlist or layoff_proof)
  --json              Output raw JSON payload
`;

export async function run(args, io) {
  const api = apiFor(args);
  const query = {};
  if (args["include-tests"] || args.includeTests) query.includeTests = "true";
  if (args.pending) query.status = "pending";
  else if (args.status) query.status = String(args.status);
  if (args.track) query.track = String(args.track);
  if (args.source) query.source = String(args.source);
  const qs = new URLSearchParams(query).toString();
  const data = await api.get(`/api/academy-leads${qs ? `?${qs}` : ""}`);

  const s = data.summary || {};
  const byTrack = s.byTrack || {};
  const fc = s.firstChoice || {};
  io.print(
    `Academy leads: ${s.total || 0} shown (${s.pendingCount || 0} pending, ${s.testCount || 0} test rows total) | ` +
      `agentic-engineering: ${byTrack["agentic-engineering"] || 0}, ` +
      `ai-engineering: ${byTrack["ai-engineering"] || 0} | ` +
      `unique: agentic only=${fc["agentic only"] || 0}, AI only=${fc["AI only"] || 0}, both=${fc.both || 0}`,
  );
  const interest = s.byTrackInterest || {};
  if (Object.keys(interest).length > 0) {
    io.print(
      "Track of interest (layoff_proof): " +
        ["agentic", "ai", "both", "not_sure", "unspecified"]
          .filter((k) => interest[k])
          .map((k) => `${k}=${interest[k]}`)
          .join(", "),
    );
    const fmt = (m) =>
      Object.keys(m || {})
        .sort()
        .map((k) => `${k}=${m[k]}`)
        .join(", ") || "none";
    io.print(`Registered per session: ${fmt(s.bySession)}`);
    io.print(`Recording form per session: ${fmt(s.byQrSession)}`);
  }
  if (Array.isArray(s.byUtm) && s.byUtm.length > 0) {
    io.print("\nBy utm_source / utm_content:");
    for (const b of s.byUtm) {
      const mix = Object.entries(b.interest || {})
        .map(([k, n]) => `${k}=${n}`)
        .join(",");
      io.print(
        `  ${b.utm_source} / ${b.utm_content}: agentic=${b.agentic}, ai=${b.ai}, total=${b.total}${mix ? `, interest ${mix}` : ""}`,
      );
    }
  }
  if (Array.isArray(data.leads) && data.leads.length > 0) {
    io.print("\nSignups:");
    for (const row of data.leads) {
      const utm = [row.utm_source, row.utm_medium, row.utm_campaign, row.utm_content, row.utm_term]
        .map((v) => v || "-")
        .join("/");
      const ans = Object.entries(row.answers || {})
        .map(([k, v]) => `${k}=${v}`)
        .join(",");
      const conf = row.confirmed ? `confirmed=${row.confirmed_at || "yes"}` : "unconfirmed";
      const label = row.source && row.source !== "shortlist" ? `source=${row.source}` : row.track;
      const extra = [
        row.name ? `name=${row.name}` : "",
        Array.isArray(row.sessions) && row.sessions.length ? `sessions=${row.sessions.join(",")}` : "",
        row.status ? `status=${row.status}` : "",
        row.track_interest ? `track=${row.track_interest}` : "",
        row.years_dev ? `years=${row.years_dev}` : "",
        row.based_in ? `based_in=${row.based_in}` : "",
        row.berlin_germany ? `berlin=${row.berlin_germany}` : "",
        row.bildungsgutschein ? `bg=${row.bildungsgutschein}` : "",
        row.payment_plan ? `payment_plan=${row.payment_plan}` : "",
        row.session ? `qr_session=${row.session}` : "",
        Array.isArray(row.qr_sessions) && row.qr_sessions.length ? `qr_sessions=${row.qr_sessions.join(",")}` : "",
        row.academy_optin ? `april_optin=${row.academy_optin}` : "",
        row.unsubscribed ? "unsubscribed" : "",
        row.free_text ? `wants_to_learn=${JSON.stringify(row.free_text)}` : "",
      ]
        .filter(Boolean)
        .join("  ");
      io.print(
        `  ${row.created_at}  ${row.email}${row.is_test ? " [test]" : ""}  ${label}  ${conf}  utm=${utm}  page=${row.page || "-"}${ans ? `  answers=${ans}` : ""}${extra ? `  ${extra}` : ""}`,
      );
    }
  }
  return data;
}
