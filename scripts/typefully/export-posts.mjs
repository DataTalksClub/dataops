import fs from "node:fs/promises";
import path from "node:path";

const API_BASE_URL = "https://api.typefully.com";
const MAX_LIMIT = 50;
const DEFAULT_OUTPUT = ".tmp/typefully-export";

function parseArgs(argv) {
  const args = {
    output: DEFAULT_OUTPUT,
    status: "all",
    socialSets: [],
    includeXAnalytics: false,
    analyticsStartYear: 2022,
    analyticsEndDate: new Date().toISOString().slice(0, 10),
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--output") {
      args.output = argv[++index];
    } else if (arg === "--status") {
      args.status = argv[++index];
    } else if (arg === "--social-set") {
      args.socialSets.push(argv[++index]);
    } else if (arg === "--include-x-analytics") {
      args.includeXAnalytics = true;
    } else if (arg === "--analytics-start-year") {
      args.analyticsStartYear = Number(argv[++index]);
    } else if (arg === "--analytics-end-date") {
      args.analyticsEndDate = argv[++index];
    } else if (arg === "--help" || arg === "-h") {
      args.help = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return args;
}

function usage() {
  return `Usage:
  node scripts/typefully/export-posts.mjs [options]

Options:
  --output <dir>                 Output directory, default ${DEFAULT_OUTPUT}
  --status <status|all>          all, published, draft, scheduled, error, publishing
  --social-set <name|username|id> Restrict export; can be repeated
  --include-x-analytics          Also fetch X analytics samples in yearly windows
  --analytics-start-year <year>  Start year for X analytics, default 2022
  --analytics-end-date <date>    End date YYYY-MM-DD, default today
`;
}

async function readEnvFile(repoRoot) {
  try {
    return await fs.readFile(path.join(repoRoot, ".env"), "utf8");
  } catch (error) {
    if (error.code === "ENOENT") {
      return "";
    }
    throw error;
  }
}

async function loadApiToken(repoRoot) {
  if (process.env.TYPEFULLY_API_KEY) {
    return process.env.TYPEFULLY_API_KEY;
  }

  const envText = await readEnvFile(repoRoot);
  const tokenMatch = envText.match(/^TYPEFULLY_API_KEY=(.*)$/m);
  const token = tokenMatch?.[1]?.trim().replace(/^['"]|['"]$/g, "");
  if (!token) {
    throw new Error("TYPEFULLY_API_KEY is missing from the environment and .env");
  }
  return token;
}

function slugify(value) {
  return String(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function csvCell(value) {
  if (value === null || value === undefined) {
    return "";
  }
  const text = Array.isArray(value) ? value.join(";") : String(value);
  return /[",\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function oneLine(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

class TypefullyClient {
  constructor(apiToken) {
    this.apiToken = apiToken;
  }

  async requestJson(url) {
    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${this.apiToken}`,
        Accept: "application/json",
      },
    });
    const text = await response.text();
    let json = null;
    if (text) {
      try {
        json = JSON.parse(text);
      } catch (error) {
        throw new Error(`Non-JSON response from Typefully: ${text.slice(0, 200)}`);
      }
    }
    if (!response.ok) {
      const message = json?.error?.message || response.statusText;
      throw new Error(`Typefully ${response.status}: ${message}`);
    }
    return json;
  }
}

async function listSocialSets(client) {
  const socialSets = [];
  let offset = 0;
  const limit = 10;

  while (true) {
    const page = await client.requestJson(`${API_BASE_URL}/v2/social-sets?limit=${limit}&offset=${offset}`);
    socialSets.push(...page.results);
    if (!page.next || socialSets.length >= page.count) {
      break;
    }
    offset += limit;
  }

  const detailed = [];
  for (const socialSet of socialSets) {
    detailed.push(await client.requestJson(`${API_BASE_URL}/v2/social-sets/${socialSet.id}/`));
    await sleep(100);
  }
  return detailed;
}

function matchesSelector(socialSet, selector) {
  const normalized = String(selector).toLowerCase();
  if (String(socialSet.id) === normalized) {
    return true;
  }
  if (String(socialSet.name || "").toLowerCase() === normalized) {
    return true;
  }
  return Object.values(socialSet.platforms || {}).some((platform) => {
    if (!platform) {
      return false;
    }
    return [platform.username, platform.name]
      .filter(Boolean)
      .some((value) => String(value).toLowerCase() === normalized);
  });
}

function selectSocialSets(socialSets, selectors) {
  if (!selectors.length) {
    return socialSets;
  }

  const selected = [];
  const missing = [];

  for (const selector of selectors) {
    const match = socialSets.find((socialSet) => matchesSelector(socialSet, selector));
    if (match) {
      if (!selected.some((socialSet) => socialSet.id === match.id)) {
        selected.push(match);
      }
    } else {
      missing.push(selector);
    }
  }

  if (missing.length) {
    throw new Error(`No Typefully social set matched: ${missing.join(", ")}`);
  }

  return selected;
}

async function listDrafts(client, socialSetId, status) {
  const records = [];
  let offset = 0;
  const statusQuery = status === "all" ? "" : `status=${encodeURIComponent(status)}&`;

  while (true) {
    const page = await client.requestJson(
      `${API_BASE_URL}/v2/social-sets/${socialSetId}/drafts?${statusQuery}order_by=created_at&limit=${MAX_LIMIT}&offset=${offset}`,
    );
    records.push(...page.results);
    if (!page.next || records.length >= page.count) {
      break;
    }
    offset += MAX_LIMIT;
  }

  return records;
}

async function getDraftDetails(client, socialSetId, records) {
  const details = [];
  for (const draft of records) {
    details.push(
      await client.requestJson(
        `${API_BASE_URL}/v2/social-sets/${socialSetId}/drafts/${draft.id}?exclude_comment_markers=true`,
      ),
    );
    await sleep(125);
  }
  return details;
}

function flattenPosts(account) {
  const rows = [];

  for (const draft of account.details) {
    for (const [platform, platformData] of Object.entries(draft.platforms || {})) {
      if (!platformData?.enabled) {
        continue;
      }

      const posts = platformData.posts || [];
      posts.forEach((post, postIndex) => {
        rows.push({
          social_set_id: account.social_set.id,
          social_set_name: account.social_set.name,
          platform,
          draft_id: draft.id,
          status: draft.status,
          publish_state: draft.publish_state,
          draft_title: draft.draft_title,
          tags: draft.tags || [],
          created_at: draft.created_at,
          updated_at: draft.updated_at,
          scheduled_date: draft.scheduled_date,
          published_at: draft.published_at,
          platform_published_at: draft[`${platform}_post_published_at`] || null,
          published_url: draft[`${platform}_published_url`] || null,
          private_url: draft.private_url,
          share_url: draft.share_url,
          post_index: postIndex,
          text: post.text || "",
          media_ids: post.media_ids || [],
          preview: oneLine(draft.preview),
        });
      });
    }
  }

  return rows;
}

function toJsonl(rows) {
  return rows.map((row) => JSON.stringify(row)).join("\n") + "\n";
}

function toCsv(rows) {
  const headers = [
    "social_set_id",
    "social_set_name",
    "platform",
    "draft_id",
    "status",
    "publish_state",
    "draft_title",
    "tags",
    "created_at",
    "updated_at",
    "scheduled_date",
    "published_at",
    "platform_published_at",
    "published_url",
    "private_url",
    "share_url",
    "post_index",
    "text",
    "media_ids",
    "preview",
  ];
  return [
    headers.join(","),
    ...rows.map((row) => headers.map((header) => csvCell(row[header])).join(",")),
  ].join("\n") + "\n";
}

function isoDate(date) {
  return date.toISOString().slice(0, 10);
}

function analyticsWindows(startYear, endDateString) {
  const ranges = [];
  const endDate = new Date(`${endDateString}T00:00:00Z`);
  let start = new Date(Date.UTC(startYear, 0, 1));
  while (start <= endDate) {
    const end = new Date(start);
    end.setUTCDate(end.getUTCDate() + 365);
    const cappedEnd = end > endDate ? endDate : end;
    ranges.push([isoDate(start), isoDate(cappedEnd)]);
    start = new Date(cappedEnd);
    start.setUTCDate(start.getUTCDate() + 1);
  }
  return ranges;
}

async function fetchXAnalytics(client, socialSet, startYear, endDate) {
  const analytics = {
    social_set_id: socialSet.id,
    social_set_name: socialSet.name,
    platform: "x",
    fetched_at: new Date().toISOString(),
    windows: [],
    posts: [],
  };

  for (const [startDate, windowEndDate] of analyticsWindows(startYear, endDate)) {
    const url = `${API_BASE_URL}/v2/social-sets/${socialSet.id}/analytics/x/posts?start_date=${startDate}&end_date=${windowEndDate}&include_replies=false`;
    const page = await client.requestJson(url);
    const posts = Array.isArray(page) ? page : Array.isArray(page?.results) ? page.results : [];
    analytics.windows.push({ start_date: startDate, end_date: windowEndDate, count: posts.length });
    analytics.posts.push(...posts);
    console.log(`${socialSet.name} X analytics ${startDate}..${windowEndDate}: ${posts.length}`);
    await sleep(150);
  }

  return analytics;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(usage());
    return;
  }

  const repoRoot = process.cwd();
  const outputDir = path.resolve(repoRoot, args.output);
  const apiToken = await loadApiToken(repoRoot);
  const client = new TypefullyClient(apiToken);

  await fs.mkdir(outputDir, { recursive: true });

  const socialSets = await listSocialSets(client);
  const selectedSocialSets = selectSocialSets(socialSets, args.socialSets);
  await fs.writeFile(path.join(outputDir, "social-sets.json"), JSON.stringify(socialSets, null, 2));

  const accounts = [];
  const normalizedRows = [];
  const analyticsAccounts = [];

  for (const socialSet of selectedSocialSets) {
    console.log(`Fetching ${args.status} draft records for ${socialSet.name} (${socialSet.id})`);
    const records = await listDrafts(client, socialSet.id, args.status);
    const details = await getDraftDetails(client, socialSet.id, records);
    const account = {
      social_set: socialSet,
      status_filter: args.status,
      fetched_at: new Date().toISOString(),
      count: records.length,
      records,
      details,
    };

    accounts.push(account);
    normalizedRows.push(...flattenPosts(account));

    const slug = slugify(socialSet.platforms?.x?.username || socialSet.name || socialSet.id);
    await fs.writeFile(path.join(outputDir, `${slug}-drafts.json`), JSON.stringify(account, null, 2));
    console.log(`Fetched ${records.length} draft records for ${socialSet.name}`);

    if (args.includeXAnalytics && socialSet.platforms?.x) {
      analyticsAccounts.push(
        await fetchXAnalytics(client, socialSet, args.analyticsStartYear, args.analyticsEndDate),
      );
    }
  }

  await fs.writeFile(
    path.join(outputDir, "all-drafts.json"),
    JSON.stringify({ fetched_at: new Date().toISOString(), accounts }, null, 2),
  );
  await fs.writeFile(path.join(outputDir, "posts.jsonl"), toJsonl(normalizedRows));
  await fs.writeFile(path.join(outputDir, "posts.csv"), toCsv(normalizedRows));

  if (args.includeXAnalytics) {
    await fs.writeFile(
      path.join(outputDir, "x-analytics.json"),
      JSON.stringify({ fetched_at: new Date().toISOString(), accounts: analyticsAccounts }, null, 2),
    );
  }

  console.log(`Wrote ${accounts.length} account exports and ${normalizedRows.length} platform-post rows to ${outputDir}`);
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
