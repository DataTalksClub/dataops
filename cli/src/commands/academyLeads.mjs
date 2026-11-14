import { apiFor } from "../session.mjs";

export const summary = "Academy shortlist signups and UTM attribution across tracks";

export const help = `dataops academy-leads - list academy.datatalks.club shortlist signups

Usage
  dataops academy-leads [--include-tests] [--track <track>] [--json]

Options
  --include-tests     Include is_test rows (hidden by default)
  --track TRACK       Filter to one track (agentic-engineering or ai-engineering)
  --json              Output raw JSON payload
`;

export async function run(args, io) {
  const api = apiFor(args);
  const query = {};
  if (args["include-tests"] || args.includeTests) query.includeTests = "true";
  if (args.track) query.track = String(args.track);
  const qs = new URLSearchParams(query).toString();
  const data = await api.get(`/api/academy-leads${qs ? `?${qs}` : ""}`);

  const s = data.summary || {};
  const byTrack = s.byTrack || {};
  const fc = s.firstChoice || {};
  io.print(
    `Academy leads: ${s.total || 0} shown (${s.testCount || 0} test rows total) | ` +
      `agentic-engineering: ${byTrack["agentic-engineering"] || 0}, ` +
      `ai-engineering: ${byTrack["ai-engineering"] || 0} | ` +
      `unique: agentic only=${fc["agentic only"] || 0}, AI only=${fc["AI only"] || 0}, both=${fc.both || 0}`,
  );
  if (Array.isArray(s.byUtm) && s.byUtm.length > 0) {
    io.print("\nBy utm_source / utm_content:");
    for (const b of s.byUtm) {
      io.print(`  ${b.utm_source} / ${b.utm_content}: agentic=${b.agentic}, ai=${b.ai}, total=${b.total}`);
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
      io.print(
        `  ${row.created_at}  ${row.email}${row.is_test ? " [test]" : ""}  ${row.track}  utm=${utm}  page=${row.page || "-"}${ans ? `  answers=${ans}` : ""}`,
      );
    }
  }
  return data;
}
