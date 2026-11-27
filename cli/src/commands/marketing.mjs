import { readFileSync, writeFileSync } from "node:fs";
import { UsageError } from "../errors.mjs";
import { apiFor } from "../session.mjs";
import { enc, positional, required, list } from "../format.mjs";

export const summary = "Marketing plans, goals, steps and metric snapshots";
export const help = `dataops marketing - plans, work and measured results

  plans list [--status active] [--tag TAG]
  plans show <plan>
  plans create --id SLUG --title TITLE [--objective TEXT --owner ID --tags a,b --start DATE --end DATE]
  plans update <plan> --version N [same fields]
  plans note <plan> --version N --text TEXT [--ref REQUEST]
  goals add <plan> --version N --ref REF --title TITLE --metric KEY --scope S --source SRC
      --baseline VALUE@DATE --baseline-note NOTE --target VALUE@DATE [--window week|rolling28]
      Use --baseline deferred --target deferred until measurement and review.
  goals show <plan> <ref> [--from DATE --to DATE]
  goals update <plan> <ref> --version N [same fields]
  goals remove <plan> <ref> --version N
  steps list [--plan P --status S --kind K --size S|L --owner ID --tag TAG --week YYYY-Www]
      [--published --overdue --target-url URL --primary-keyword TEXT --done-criteria TEXT]
  steps show <step>
  steps add <plan> --version N --title TITLE --kind K --done-criteria TEXT [--size S|L]
      [--owner ID --goals a,b --target-url URL --target-type new|refresh --primary-keyword TEXT]
      [--brief-file PATH --publish-date DATE --prompts P02,P14 --link NAME=URL --ref REQUEST]
  steps update <step> --version N [same fields]
  steps schedule <step> --version N --publish-date DATE [--card --template TYPE | --task --assignee ID |
      --link-card ID --publish-task ID | --campaign-row ID] [--dry-run]
  steps live <step> --version N --url URL --date DATE
  steps drop <step> --version N --reason TEXT
  metrics keys
  metrics push --metric KEY --scope S --source SRC (--period YYYY-Www | --date YYYY-MM-DD) --value N
      [--unit UNIT --note TEXT --observed-at ISO --evidence-url URL --provider P --metric-version V]
  metrics push --file PATH [--replace --dry-run]
  metrics list [--metric KEY --scope S --source SRC --metric-version V --from DATE --to DATE]
  metrics missing
  sites list
  sites add --domain DOMAIN [--label LABEL --notes TEXT]
  sites update <domain> --version N [--label LABEL --notes TEXT --active true|false]
  sites remove <domain> --version N
  sites refresh-authority <domain>
  backlinks list [--bucket B --state S --source URL --target URL]
  backlinks add --source URL --target URL [--state STATE --owner OWNER --notes TEXT]
  backlinks import --file PATH [--update-existing]
  backlinks update <id> --version N [--state STATE --owner OWNER --notes TEXT]
  backlinks remove <id> --version N
  backlinks check [--id ID] [--chunk-size 10]
  utm <step> --source SRC [--placement footer]
  review [--week YYYY-Www]
  capacity [--weeks 6]
  import --file PATH [--version N --dry-run --write-ids]

All commands accept --json. Existing records require --version N.
Weekly capacity is 2; exceeding it warns and scheduling remains allowed.
Waitlist and GA4 series are excluded pending confirmed source/access.
Ahrefs site verification is an operator action outside code scope.
`;
const root = "/api/marketing";
const at = (a, n = 0) =>
  positional(a, n, "dataops marketing <group> <action> <id>");
const pick = (a, mapping) =>
  Object.fromEntries(
    Object.entries(mapping)
      .filter(([key]) => a[key] !== undefined)
      .map(([key, value]) => [value, a[key]]),
  );
const version = (a) => {
  const n = Number(required(a, "version", "version"));
  if (!Number.isSafeInteger(n) || n < 1)
    throw new UsageError("--version must be a positive integer.");
  return n;
};
function links(value) {
  return (Array.isArray(value) ? value : [value]).map((v) => {
    const i = String(v).indexOf("=");
    if (i < 1) throw new UsageError("Links require NAME=URL.");
    return { name: v.slice(0, i), url: v.slice(i + 1) };
  });
}
function common(a) {
  const b = pick(a, { title: "title", owner: "ownerId", status: "status" });
  if (a.tags !== undefined) b.tags = list(a.tags);
  return b;
}
function planBody(a) {
  const b = {
    ...common(a),
    ...pick(a, {
      id: "id",
      objective: "objective",
      start: "startDate",
      end: "endDate",
    }),
  };
  if (a.source !== undefined) b.sources = links(a.source);
  return b;
}
function point(v) {
  const i = String(v).indexOf("@");
  if (i < 1 || !Number.isFinite(Number(v.slice(0, i))))
    throw new UsageError("Expected VALUE@YYYY-MM-DD.");
  return { value: Number(v.slice(0, i)), date: v.slice(i + 1) };
}
function goalBody(a) {
  const b = pick(a, {
    ref: "ref",
    title: "title",
    metric: "metricKey",
    scope: "scope",
    source: "source",
    window: "window",
  });
  if (a.baseline !== undefined)
    b.baseline =
      a.baseline === "deferred"
        ? null
        : { ...point(a.baseline), note: a.baselineNote || "" };
  if (a.target !== undefined)
    b.target = a.target === "deferred" ? null : point(a.target);
  return b;
}
function stepBody(a) {
  const b = {
    ...common(a),
    ...pick(a, {
      key: "key",
      kind: "kind",
      size: "size",
      targetUrl: "targetUrl",
      targetType: "targetType",
      primaryKeyword: "primaryKeyword",
      doneCriteria: "doneCriteria",
      publishDate: "publishDate",
      ref: "requestRef",
      brief: "brief",
    }),
  };
  if (a.goals !== undefined) b.goalRefs = list(a.goals);
  if (a.prompts !== undefined) b.prompts = list(a.prompts);
  if (a.link !== undefined) b.links = links(a.link);
  if (a.briefFile) b.brief = readFileSync(a.briefFile, "utf8");
  return b;
}
function output(a, io, result) {
  if (!a.json)
    io.print(
      typeof result.url === "string"
        ? result.url
        : JSON.stringify(result, null, 2),
    );
  return result;
}
function nested(fn) {
  return (a, io) => {
    const action = at(a);
    return fn(action, { ...a, _: a._.slice(1) }, io);
  };
}
export const plans = nested(async (action, a, io) => {
  const api = apiFor(a);
  let result;
  if (action === "list")
    result = await api.get(`${root}/plans`, {
      query: pick(a, { status: "status", tag: "tag" }),
    });
  else if (action === "show")
    result = await api.get(`${root}/plans/${enc(at(a))}`);
  else if (action === "create")
    result = await api.post(`${root}/plans`, planBody(a));
  else if (action === "update")
    result = await api.patch(`${root}/plans/${enc(at(a))}`, {
      ...planBody(a),
      version: version(a),
    });
  else if (action === "note")
    result = await api.post(`${root}/plans/${enc(at(a))}/notes`, {
      text: required(a, "text", "text"),
      ...pick(a, { ref: "ref" }),
      version: version(a),
    });
  else
    throw new UsageError("Use marketing plans list|show|create|update|note.");
  return output(a, io, result);
});
export const goals = nested(async (action, a, io) => {
  const api = apiFor(a);
  const path = `${root}/plans/${enc(at(a))}/goals`;
  let result;
  if (action === "show")
    result = await api.get(`${path}/${enc(at(a, 1))}`, {
      query: pick(a, { from: "from", to: "to" }),
    });
  else if (action === "add")
    result = await api.post(path, {
      window: "week",
      ...goalBody(a),
      version: version(a),
    });
  else if (action === "update")
    result = await api.patch(`${path}/${enc(at(a, 1))}`, {
      ...goalBody(a),
      version: version(a),
    });
  else if (action === "remove")
    result = await api.delete(`${path}/${enc(at(a, 1))}`, {
      version: version(a),
    });
  else throw new UsageError("Use marketing goals add|show|update|remove.");
  return output(a, io, result);
});
export const steps = nested(async (action, a, io) => {
  const api = apiFor(a);
  let result;
  if (action === "list")
    result = await api.get(`${root}/steps`, {
      query: pick(a, {
        plan: "plan",
        status: "status",
        kind: "kind",
        size: "size",
        owner: "owner",
        tag: "tag",
        week: "week",
        published: "published",
        overdue: "overdue",
        targetUrl: "target_url",
        primaryKeyword: "primary_keyword",
        doneCriteria: "done_criteria",
      }),
    });
  else if (action === "add")
    result = await api.post(`${root}/plans/${enc(at(a))}/steps`, {
      ...stepBody(a),
      version: version(a),
    });
  else {
    const path = `${root}/steps/${enc(at(a))}`;
    if (action === "show") result = await api.get(path);
    else if (action === "update")
      result = await api.patch(path, { ...stepBody(a), version: version(a) });
    else if (action === "schedule") {
      const choices = [a.card, a.task, a.linkCard || a.campaignRow].filter(
        Boolean,
      );
      if (choices.length > 1)
        throw new UsageError("Choose one scheduling mode.");
      result = await api.post(`${path}/schedule`, {
        ...pick(a, {
          publishDate: "publishDate",
          template: "template",
          assignee: "assignee",
          linkCard: "linkCardId",
          publishTask: "publishTaskId",
          campaignRow: "campaignRowId",
          dryRun: "dryRun",
          mode: "mode",
        }),
        ...(a.card
          ? { mode: "card" }
          : a.task
            ? { mode: "task" }
            : a.linkCard || a.campaignRow
              ? { mode: "link" }
              : {}),
        version: version(a),
      });
    } else if (action === "live")
      result = await api.post(`${path}/live`, {
        url: required(a, "url", "url"),
        date: required(a, "date", "date"),
        version: version(a),
      });
    else if (action === "drop")
      result = await api.post(`${path}/drop`, {
        reason: required(a, "reason", "reason"),
        version: version(a),
      });
    else
      throw new UsageError(
        "Use marketing steps list|show|add|update|schedule|live|drop.",
      );
  }
  return output(a, io, result);
});
export const metrics = nested(async (action, a, io) => {
  const api = apiFor(a);
  let result;
  if (action === "keys") result = await api.get(`${root}/vocabulary`);
  else if (action === "missing")
    result = await api.get(`${root}/metrics/missing`);
  else if (action === "list")
    result = await api.get(`${root}/metrics`, {
      query: pick(a, {
        metric: "metricKey",
        scope: "scope",
        source: "source",
        metricVersion: "metricVersion",
        from: "from",
        to: "to",
      }),
    });
  else if (action === "push") {
    const options = { replace: !!a.replace, dryRun: !!a.dryRun };
    if (a.file) {
      const input = JSON.parse(readFileSync(a.file, "utf8"));
      result = await api.post(`${root}/metrics/batch`, {
        snapshots: input.snapshots,
        ...options,
      });
    } else
      result = await api.post(`${root}/metrics`, {
        ...pick(a, {
          metric: "metricKey",
          scope: "scope",
          source: "source",
          period: "period",
          unit: "unit",
          note: "note",
          artifactId: "artifactId",
          observedAt: "observedAt",
          evidenceUrl: "evidenceUrl",
          provider: "provider",
          metricVersion: "metricVersion",
        }),
        ...(a.date ? { period: required(a, "date", "date") } : {}),
        value: Number(required(a, "value", "value")),
        provisional: !!a.provisional,
        ...options,
      });
  } else throw new UsageError("Use marketing metrics keys|push|list|missing.");
  return output(a, io, result);
});

export function parseBacklinkSeedText(raw) {
  const trimmed = String(raw || "").trim();
  if (!trimmed) throw new UsageError("Backlink seed file is empty.");
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    const parsed = JSON.parse(trimmed);
    const items = Array.isArray(parsed) ? parsed : parsed.items;
    if (!Array.isArray(items) || !items.length) {
      throw new UsageError("JSON seed must contain a non-empty array or { items: [...] }.");
    }
    return items;
  }
  const targets = new Map();
  const items = [];
  for (const rawLine of trimmed.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const defMatch = /^(\d+)=(https?:\/\/\S+)$/.exec(line);
    if (defMatch) {
      targets.set(defMatch[1], defMatch[2]);
      continue;
    }
    const rowMatch = /^(\d+)\s+([a-z0-9_]+)\s+(https?:\/\/\S+)$/.exec(line);
    if (rowMatch) {
      const targetUrl = targets.get(rowMatch[1]);
      if (!targetUrl) {
        throw new UsageError(`Unknown target index ${rowMatch[1]} in seed line: ${line}`);
      }
      const outreachState = rowMatch[2];
      const owner =
        outreachState === "alexey_sent"
          ? "alexey"
          : outreachState === "orin_sent"
            ? "orin"
            : undefined;
      items.push({
        sourceUrl: rowMatch[3],
        targetUrl,
        outreachState,
        ...(owner ? { owner } : {}),
      });
      continue;
    }
    throw new UsageError(`Unrecognized backlink seed line: ${line}`);
  }
  if (!items.length) throw new UsageError("No backlink pairs found in seed file.");
  return items;
}

export const sites = nested(async (action, a, io) => {
  const api = apiFor(a);
  let result;
  if (action === "list") result = await api.get(`${root}/sites`);
  else if (action === "add")
    result = await api.post(`${root}/sites`, {
      domain: required(a, "domain", "domain"),
      ...pick(a, { label: "label", notes: "notes" }),
      ...(a.active !== undefined ? { active: a.active !== "false" && a.active !== false } : {}),
    });
  else {
    const domain = enc(at(a));
    if (action === "update")
      result = await api.patch(`${root}/sites/${domain}`, {
        ...pick(a, { label: "label", notes: "notes" }),
        ...(a.active !== undefined ? { active: a.active !== "false" && a.active !== false } : {}),
        version: version(a),
      });
    else if (action === "remove")
      result = await api.delete(`${root}/sites/${domain}`, {
        query: { version: version(a) },
      });
    else if (action === "refresh-authority")
      result = await api.post(`${root}/sites/${domain}/refresh-authority`, {});
    else
      throw new UsageError(
        "Use marketing sites list|add|update|remove|refresh-authority.",
      );
  }
  return output(a, io, result);
});

export const backlinks = nested(async (action, a, io) => {
  const api = apiFor(a);
  let result;
  if (action === "list")
    result = await api.get(`${root}/backlinks`, {
      query: pick(a, {
        bucket: "bucket",
        state: "outreachState",
        source: "sourceUrl",
        target: "targetUrl",
      }),
    });
  else if (action === "add")
    result = await api.post(`${root}/backlinks`, {
      sourceUrl: required(a, "source", "source"),
      targetUrl: required(a, "target", "target"),
      outreachState: a.state || "not_contacted",
      ...pick(a, { owner: "owner", notes: "notes" }),
    });
  else if (action === "import") {
    const items = parseBacklinkSeedText(readFileSync(required(a, "file", "file"), "utf8"));
    result = await api.post(`${root}/backlinks`, {
      items,
      ...(a.updateExisting ? { updateExisting: true } : {}),
    });
  } else if (action === "check") {
    const chunkSize = Math.max(1, Math.min(40, Number(a.chunkSize || 10)));
    if (a.id) {
      const ids = list(a.id);
      result = await api.post(`${root}/backlinks/check`, { ids });
    } else {
      const current = await api.get(`${root}/backlinks`);
      const allIds = (current.items || []).map((item) => item.id);
      if (!allIds.length) {
        result = { checked: 0, summary: current.summary, groups: current.groups };
      } else {
        let checked = 0;
        let last = null;
        for (let i = 0; i < allIds.length; i += chunkSize) {
          const slice = allIds.slice(i, i + chunkSize);
          last = await api.post(`${root}/backlinks/check`, { ids: slice });
          checked += last.checked || 0;
        }
        result = { checked, summary: last.summary, groups: last.groups };
      }
    }
  } else {
    const id = enc(at(a));
    if (action === "update")
      result = await api.patch(`${root}/backlinks/${id}`, {
        ...pick(a, { state: "outreachState", owner: "owner", notes: "notes" }),
        version: version(a),
      });
    else if (action === "remove")
      result = await api.delete(`${root}/backlinks/${id}`, {
        query: { version: version(a) },
      });
    else
      throw new UsageError(
        "Use marketing backlinks list|add|import|update|remove|check.",
      );
  }
  return output(a, io, result);
});
export async function importPlan(a, io) {
  const file = required(a, "file", "file");
  let yaml;
  try {
    yaml = (await import("js-yaml")).default;
  } catch {
    throw new UsageError(
      "Marketing imports need the js-yaml package; run with dependencies installed.",
    );
  }
  const input = yaml.load(readFileSync(file, "utf8"), {
    schema: yaml.JSON_SCHEMA,
  });
  if (!input || typeof input !== "object")
    throw new UsageError("Import file must contain plan, goals and steps.");
  const result = await apiFor(a).post(`${root}/import`, {
    ...input,
    ...(a.version ? { version: version(a) } : {}),
    dryRun: !!a.dryRun,
  });
  if (a.writeIds && !a.dryRun) {
    for (const s of input.steps || []) {
      const match = result.steps.find((x) => x.key === s.key);
      if (match) s.id = match.id;
    }
    writeFileSync(file, yaml.dump(input));
  }
  return output(a, io, result);
}
export const commands = {
  plans,
  goals,
  steps,
  metrics,
  sites,
  backlinks,
  import: importPlan,
  utm: async (a, io) =>
    output(
      a,
      io,
      await apiFor(a).get(`${root}/steps/${enc(at(a))}/utm`, {
        query: pick(a, { source: "source", placement: "placement" }),
      }),
    ),
  review: async (a, io) =>
    output(
      a,
      io,
      await apiFor(a).get(`${root}/review`, {
        query: pick(a, { week: "week" }),
      }),
    ),
  capacity: async (a, io) =>
    output(
      a,
      io,
      await apiFor(a).get(`${root}/capacity`, {
        query: pick(a, { weeks: "weeks" }),
      }),
    ),
};
