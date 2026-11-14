import { apiFor } from "../session.mjs";

export const summary = "Academy landing visits, signups and conversion per track";

export const help = `dataops academy-pageviews - academy.datatalks.club landing pageviews next to signups

Usage
  dataops academy-pageviews [--from YYYY-MM-DD] [--to YYYY-MM-DD] [--by-utm] [--include-tests] [--json]

Options
  --from DATE, --to DATE  Restrict to a UTC date range (inclusive)
  --by-utm                Print daily rows by page and utm_source/medium/campaign/content
  --include-tests         Include test traffic (utm_source/medium/campaign/content starting with "test")
  --json                  Output raw JSON payload

Conversion = signups / visits per track (signups exclude is_test rows). No PII is read or shown.
Test traffic: tag test visits with utm_source=test (or test-*), they are hidden by default.
`;

export async function run(args, io) {
  const api = apiFor(args);
  const query = {};
  if (args["include-tests"] || args.includeTests) query.includeTests = "true";
  if (args.from) query.from = String(args.from);
  if (args.to) query.to = String(args.to);
  const qs = new URLSearchParams(query).toString();
  const data = await api.get(`/api/academy-pageviews${qs ? `?${qs}` : ""}`);
  const s = data.summary || {};

  io.print(`Academy pageviews: ${s.visits || 0} visits shown (${s.testVisits || 0} test visits excluded unless --include-tests)`);
  io.print("\nTrack                 visits  signups  conversion");
  for (const [track, t] of Object.entries(s.byTrack || {})) {
    const conv = t.conversion == null ? "n/a" : `${(t.conversion * 100).toFixed(2)}%`;
    io.print(`  ${track.padEnd(20)} ${String(t.visits).padStart(6)}  ${String(t.signups).padStart(7)}  ${conv.padStart(10)}`);
  }
  io.print("\nVisits by day:");
  for (const [d, n] of Object.entries(s.byDay || {}).sort()) io.print(`  ${d}: ${n}`);
  if ((args["by-utm"] || args.byUtm) && Array.isArray(data.rows)) {
    io.print("\nPV# rows (date page utm_source/medium/campaign/content count):");
    for (const r of data.rows) {
      io.print(`  ${r.date}  ${r.page}  ${[r.utm_source, r.utm_medium, r.utm_campaign, r.utm_content].join("/")}  ${r.count}${r.is_test ? " [test]" : ""}`);
    }
  }
  return data;
}
