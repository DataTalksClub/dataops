import fs from "node:fs/promises";
import { isIP } from "node:net";
import path from "node:path";

const DEFAULT_INPUT = ".tmp/typefully-export/all-drafts.json";
const DEFAULT_OUTPUT = ".tmp/typefully-analysis";
const PRIVATE_LINK_OMISSION = "[private provider link omitted]";
const ANALYZED_PLATFORMS = ["x", "linkedin"];
const MAX_URL_SUFFIX_CODE_UNITS = 8_192;

function parseArgs(argv) {
  const args = {
    input: DEFAULT_INPUT,
    output: DEFAULT_OUTPUT,
    publishedOnly: true,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--input") {
      args.input = argv[++index];
    } else if (arg === "--output") {
      args.output = argv[++index];
    } else if (arg === "--include-unpublished") {
      args.publishedOnly = false;
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
  node scripts/typefully/analyze-posts.mjs [options]

Options:
  --input <file>          Typefully all-drafts.json export, default ${DEFAULT_INPUT}
  --output <dir>          Output directory, default ${DEFAULT_OUTPUT}
  --include-unpublished   Analyze all statuses, not only published posts
`;
}

function isProviderLinkField(key) {
  const normalized = key.replaceAll("_", "").replaceAll("-", "").toLowerCase();
  return /^(private|share|edit)(url|link)$/.test(normalized);
}

function hasValidPercentEncoding(value) {
  return !/%(?![0-9a-f]{2})/i.test(value);
}

function rawHostDetails(value) {
  const schemeEnd = value.indexOf("://");
  if (schemeEnd === -1) {
    return null;
  }

  const authorityEnd = value.slice(schemeEnd + 3).search(/[/?#]/);
  const authority = authorityEnd === -1
    ? value.slice(schemeEnd + 3)
    : value.slice(schemeEnd + 3, schemeEnd + 3 + authorityEnd);
  const hostAndPort = authority.slice(authority.lastIndexOf("@") + 1);
  if (hostAndPort.startsWith("[")) {
    const bracketEnd = hostAndPort.indexOf("]");
    if (bracketEnd === -1) {
      return null;
    }
    const remainder = hostAndPort.slice(bracketEnd + 1);
    return {
      hostname: hostAndPort.slice(0, bracketEnd + 1),
      port: remainder.startsWith(":") ? remainder.slice(1) : null,
    };
  }
  const portSeparator = hostAndPort.lastIndexOf(":");
  return {
    hostname: portSeparator === -1 ? hostAndPort : hostAndPort.slice(0, portSeparator),
    port: portSeparator === -1 ? null : hostAndPort.slice(portSeparator + 1),
  };
}

function parseStrictHttpUrl(value) {
  if (
    value !== value.trim()
    || /[\p{White_Space}\p{Cc}]/u.test(value)
    || value.includes("\\")
    || !hasValidPercentEncoding(value)
  ) {
    return null;
  }

  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    return null;
  }
  if (!["http:", "https:"].includes(parsed.protocol) || !parsed.hostname) {
    return null;
  }

  const hostDetails = rawHostDetails(value);
  if (
    !hostDetails
    || (
      hostDetails.port !== null
      && (
        !/^[0-9]+$/.test(hostDetails.port)
        || Number(hostDetails.port) > 65_535
      )
    )
  ) {
    return null;
  }

  const hostname = parsed.hostname;
  if (hostname.startsWith("[") || hostname.endsWith("]")) {
    if (
      !hostname.startsWith("[")
      || !hostname.endsWith("]")
      || isIP(hostname.slice(1, -1)) !== 6
    ) {
      return null;
    }
    return parsed;
  }

  if (isIP(hostname) === 4) {
    return hostDetails.hostname === hostname ? parsed : null;
  }
  const dnsHostname = hostname.endsWith(".") ? hostname.slice(0, -1) : hostname;
  if (dnsHostname.length > 253) {
    return null;
  }

  const labels = dnsHostname.split(".");
  if (
    labels.some(
      (label) => (
        label.length < 1
        || label.length > 63
        || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i.test(label)
      ),
    )
  ) {
    return null;
  }
  return parsed;
}

function replacementCandidateKind(value) {
  if (parseStrictHttpUrl(value)) {
    return "url";
  }

  const codePoints = [...value];
  const informationLength = codePoints.filter((character) => /[\p{L}\p{N}]/u.test(character)).length;
  return codePoints.length >= 16 && informationLength >= 12 ? "opaque" : null;
}

function collectProviderLinkValues(value, found = new Map()) {
  if (Array.isArray(value)) {
    for (const item of value) {
      collectProviderLinkValues(item, found);
    }
    return found;
  }
  if (!value || typeof value !== "object") {
    return found;
  }

  for (const [key, nestedValue] of Object.entries(value)) {
    if (isProviderLinkField(key) && typeof nestedValue === "string") {
      const kind = replacementCandidateKind(nestedValue);
      if (kind) {
        found.set(nestedValue, kind);
      }
    }
    collectProviderLinkValues(nestedValue, found);
  }
  return found;
}

function startsAtUrlTokenBoundary(value, matchIndex) {
  if (matchIndex === 0) {
    return true;
  }

  let previousStart = matchIndex - 1;
  const previousCodeUnit = value.charCodeAt(previousStart);
  if (
    previousCodeUnit >= 0xdc00
    && previousCodeUnit <= 0xdfff
    && previousStart > 0
  ) {
    previousStart -= 1;
  }
  const previousCharacter = value.slice(previousStart, matchIndex);
  return !/[\p{L}\p{N}._~-]/u.test(previousCharacter);
}

function hasDistinctLongerUrlToken(value, candidate, matchIndex) {
  if (!startsAtUrlTokenBoundary(value, matchIndex)) {
    return false;
  }

  const continuationStart = matchIndex + candidate.length;
  let continuationEnd = continuationStart;
  let ipv6BracketOpen = false;
  while (
    continuationEnd < value.length
    && continuationEnd - continuationStart < MAX_URL_SUFFIX_CODE_UNITS
  ) {
    const remaining = value.slice(continuationEnd);
    if (/^https?:\/\//i.test(remaining)) {
      break;
    }

    const character = String.fromCodePoint(value.codePointAt(continuationEnd));
    const continuationSoFar = value.slice(continuationStart, continuationEnd);
    if (character === "[") {
      if (ipv6BracketOpen || !continuationSoFar.endsWith("@")) {
        break;
      }
      ipv6BracketOpen = true;
      continuationEnd += character.length;
      continue;
    }
    if (character === "]") {
      if (!ipv6BracketOpen) {
        break;
      }
      ipv6BracketOpen = false;
      continuationEnd += character.length;
      continue;
    }
    if (
      /[\p{White_Space}\p{Cc}]/u.test(character)
      || ["<", ">", "\"", "'", "`", "\\", ")", "}", ",", "!", "*", "$", "{"].includes(character)
      || (character === "(" && continuationEnd === continuationStart)
    ) {
      break;
    }
    continuationEnd += character.length;
  }

  const continuation = value.slice(continuationStart, continuationEnd);
  if (
    !continuation
    || ipv6BracketOpen
    || !/[\p{L}\p{N}]/u.test(continuation)
    || !hasValidPercentEncoding(continuation)
  ) {
    return false;
  }

  return Boolean(parseStrictHttpUrl(`${candidate}${continuation}`));
}

function overlapsOmissionMarker(value, start, end) {
  const markerStart = value.lastIndexOf(PRIVATE_LINK_OMISSION, end - 1);
  return markerStart !== -1
    && markerStart < end
    && markerStart + PRIVATE_LINK_OMISSION.length > start;
}

function redactionIntervals(value, candidates) {
  const intervals = [];
  for (const [candidate, kind] of candidates) {
    let searchFrom = 0;
    while (searchFrom < value.length) {
      const matchIndex = value.indexOf(candidate, searchFrom);
      if (matchIndex === -1) {
        break;
      }
      if (
        !overlapsOmissionMarker(value, matchIndex, matchIndex + candidate.length)
        && (
          kind === "opaque"
          || !hasDistinctLongerUrlToken(value, candidate, matchIndex)
        )
      ) {
        intervals.push([matchIndex, matchIndex + candidate.length]);
      }
      searchFrom = matchIndex + 1;
    }
  }

  intervals.sort(([leftStart, leftEnd], [rightStart, rightEnd]) => (
    leftStart - rightStart || rightEnd - leftEnd
  ));
  const merged = [];
  for (const interval of intervals) {
    const previous = merged.at(-1);
    if (previous && interval[0] < previous[1]) {
      previous[1] = Math.max(previous[1], interval[1]);
    } else {
      merged.push(interval);
    }
  }
  return merged;
}

function buildPrivateLinkOmitter(exportData) {
  const candidates = [...collectProviderLinkValues(exportData)].sort(
    ([left], [right]) => right.length - left.length,
  );

  return (value) => {
    if (typeof value !== "string") {
      return "";
    }

    // Complexity is O(C*N + M*L): bounded indexOf scans over the original text,
    // plus at most MAX_URL_SUFFIX_CODE_UNITS of token inspection per URL match.
    // Intervals are merged once, and inserted markers are never scanned again.
    const intervals = redactionIntervals(value, candidates);
    let result = "";
    let cursor = 0;
    for (const [start, end] of intervals) {
      result += `${value.slice(cursor, start)}${PRIVATE_LINK_OMISSION}`;
      cursor = end;
    }
    return `${result}${value.slice(cursor)}`;
  };
}

function stringValue(value, omitPrivateLinks) {
  return typeof value === "string" ? omitPrivateLinks(value) : "";
}

function stringList(value, omitPrivateLinks) {
  return Array.isArray(value)
    ? value
      .filter((item) => typeof item === "string")
      .map((item) => omitPrivateLinks(item))
    : [];
}

function analyticalDetail(detail, omitPrivateLinks) {
  const source = detail && typeof detail === "object" ? detail : {};
  const platforms = {};

  for (const platform of ANALYZED_PLATFORMS) {
    const sourcePlatform = source.platforms?.[platform];
    const posts = Array.isArray(sourcePlatform?.posts)
      ? sourcePlatform.posts
        .filter((post) => post && typeof post === "object" && typeof post.text === "string")
        .map((post) => ({ text: omitPrivateLinks(post.text) }))
      : [];
    platforms[platform] = {
      enabled: sourcePlatform?.enabled === true,
      posts,
    };
  }

  return {
    status: stringValue(source.status, omitPrivateLinks),
    draftTitle: stringValue(source.draft_title, omitPrivateLinks),
    tags: stringList(source.tags, omitPrivateLinks),
    preview: stringValue(source.preview, omitPrivateLinks),
    publishedAt: stringValue(source.published_at, omitPrivateLinks),
    createdAt: stringValue(source.created_at, omitPrivateLinks),
    platforms,
  };
}

function analyticalAccount(account, publishedOnly, omitPrivateLinks) {
  const source = account && typeof account === "object" ? account : {};
  const rawName = source.social_set?.platforms?.x?.username
    ?? source.social_set?.name
    ?? source.target?.label
    ?? source.social_set?.id;
  const name = typeof rawName === "number"
    ? String(rawName)
    : stringValue(rawName, omitPrivateLinks);
  const sourceDetails = Array.isArray(source.details)
    ? source.details.filter((detail) => detail && typeof detail === "object")
    : [];
  const details = sourceDetails.map((detail) => analyticalDetail(detail, omitPrivateLinks));

  return {
    name: omitPrivateLinks(name),
    details: publishedOnly ? details.filter((detail) => detail.status === "published") : details,
  };
}

function enabledPlatforms(detail) {
  return ANALYZED_PLATFORMS.filter((platform) => detail.platforms[platform].enabled);
}

function postText(detail, platform) {
  return detail.platforms[platform].posts
    .map((post) => post.text)
    .join("\n\n---\n\n")
    .trim();
}

function classify(detail) {
  const haystack = `${detail.draftTitle} ${detail.tags.join(" ")} ${detail.preview}`.toLowerCase();
  const tests = [
    ["course-launch-or-reminder", /(zoomcamp|course|cohort|module|homework|project|certificate|leaderboard)/],
    ["workshop-or-webinar", /(workshop|webinar|live|register|lu\.ma|event|q&a|qa)/],
    ["sponsored-or-partner", /(sponsor|sponsored|partner|doublecloud|qwak|snowplow|clickhouse|microsoft|netflix|data engineer things)/],
    ["podcast-or-follow-up", /(podcast|episode|guest|after)/],
    ["newsletter-or-resource", /(newsletter|resource|read|article|guide|link roundup)/],
    ["community-or-giveaway", /(community|giveaway|book-of-the-week|free copies|hacktoberfest|conference)/],
  ];
  const found = tests.filter(([, regex]) => regex.test(haystack)).map(([name]) => name);
  return found.length ? found : ["general"];
}

function addProcessDoc(docs, filename, title, tags, body) {
  docs.set(filename, `---
title: "${title}"
doc_type: process
status: draft
owner: "DataTalks.Club"
source: "Typefully export"
converted: ${new Date().toISOString().slice(0, 10)}
tags:
${tags.map((tag) => `  - ${tag}`).join("\n")}
systems:
  - typefully
  - x
  - linkedin
related_docs:
  - task-template.tasks.social-media
---

# ${title}

${body.trim()}
`);
}

function buildProcessDocs(summary) {
  const docs = new Map();

  addProcessDoc(
    docs,
    "social-post-patterns-from-typefully.md",
    "Social Post Patterns from Typefully",
    ["social-media", "typefully", "analysis"],
    `
## Summary

- Purpose: turn historical Typefully posts into reusable drafting patterns for DataOps assistant workflows.
- Outcome: a social post draft that matches existing DataTalks.Club and Alexey Grigorev posting style.
- Trigger: a course, workshop, event, newsletter, sponsorship, podcast, or community item needs social distribution.
- Frequency: weekly social-media planning, plus campaign-specific posts around launches and deadlines.

## Source Coverage

${summary.coverage.map((row) => `- ${row.account}: ${row.count} analyzed draft records from ${row.earliest || "unknown"} to ${row.latest || "unknown"}.`).join("\n")}

## Drafting Principles

1. Start with the concrete news, deadline, or question.
2. Add one short context paragraph that explains why the audience should care.
3. Use bullets for curriculum, topics, or reasons.
4. Put the registration, course, article, or resource link near the end unless the post is a short deadline reminder.
5. Keep the X version concise. Use a thread only when the idea naturally has multiple steps or a list that needs space.
6. Let LinkedIn be slightly more complete: more context, full bullet list, fewer thread markers.
7. Include a human review step before scheduling, especially for sponsored posts, course dates, partner claims, and external links.

## Validation

- The post has exactly one main call to action.
- Dates and deadlines are absolute and match the event/course source.
- X and LinkedIn versions can stand alone.
- Sponsored or partner posts preserve required claims and avoid unsupported claims.
- The Typefully draft is unscheduled unless the operator explicitly schedules it later.
`,
  );

  addProcessDoc(
    docs,
    "create-course-promotion-posts.md",
    "Create Course Promotion Posts",
    ["social-media", "courses", "typefully"],
    `
## Summary

- Purpose: promote DataTalks.Club courses and cohort milestones using historical Typefully patterns.
- Outcome: reviewed X and LinkedIn drafts for a course launch, module release, deadline, Q&A, or project reminder.
- Trigger: a course cohort starts soon, a module goes live, an assignment deadline approaches, or a course-related event needs promotion.

## Procedure

1. Choose the course milestone: cohort announcement, Q&A registration, module release, homework/project reminder, tool/curriculum explanation, or learner story.
2. Write the opening around the milestone: exact deadline, start date, module skill, or practical question.
3. Add 3 to 5 topics, tools, or outcomes.
4. Add the primary call to action: registration link, course page, submission link, or event link.
5. Adapt by platform: concise X post or short thread; fuller LinkedIn paragraph plus bullets.
6. Save the result as a Typefully draft and record a safe creation receipt in DataOps.

## Validation

- Course name, cohort year, and dates are correct.
- The post tells the reader what to do next.
- The post does not promise outcomes beyond the course source material.
`,
  );

  addProcessDoc(
    docs,
    "create-workshop-event-posts.md",
    "Create Workshop and Event Posts",
    ["social-media", "events", "workshops", "typefully"],
    `
## Summary

- Purpose: create announcement and reminder posts for workshops, webinars, live podcasts, and Q&A sessions.
- Outcome: reviewed Typefully drafts for X and LinkedIn with a clear registration CTA.

## Procedure

1. Identify the event angle: practical skill, guest expertise, course Q&A, live podcast, or partner event.
2. Write a hook around the practical question, speaker credibility, or event date.
3. Add 3 to 5 bullets covering what attendees will learn.
4. Add the registration link and make the CTA explicit.
5. Use a shorter X version and a more contextual LinkedIn version.
6. Save as a Typefully draft and route to human review before scheduling.

## Validation

- Event date/time and URL are correct.
- Speaker names and titles are spelled correctly.
- The audience can tell whether the event is live, recorded, course-related, or partner-led.
`,
  );

  addProcessDoc(
    docs,
    "create-sponsored-partner-posts.md",
    "Create Sponsored and Partner Posts",
    ["social-media", "sponsorship", "partners", "typefully"],
    `
## Summary

- Purpose: create accurate social posts for sponsor, partner, and cross-promotion commitments.
- Outcome: a reviewed Typefully draft that satisfies the sponsor/partner requirement without unsupported claims.

## Procedure

1. Read the sponsor or partner source before drafting.
2. Extract required brand name, approved link, exact claim or offer, event date, disclosure, and visual asset.
3. Draft around the audience benefit, not only the sponsor name.
4. Keep claims bounded to what the source says.
5. Add the approved CTA link.
6. Create separate X and LinkedIn versions when LinkedIn needs more context.
7. Save as a Typefully draft and route for human review before scheduling.

## Validation

- Required sponsor/partner wording is present.
- Brand names, URLs, and event dates are correct.
- No unverified performance, pricing, or endorsement claim was invented.
`,
  );

  addProcessDoc(
    docs,
    "create-newsletter-resource-posts.md",
    "Create Newsletter and Resource Posts",
    ["social-media", "newsletter", "resources", "typefully"],
    `
## Summary

- Purpose: turn newsletters, guides, articles, and curated resources into social posts.
- Outcome: a Typefully draft that gives readers a clear reason to open the resource.

## Procedure

1. Read the source resource or newsletter summary.
2. Pick the strongest angle: checklist, contrarian point, common mistake, tool comparison, or community learning.
3. Write a hook that names the problem or question.
4. Add 3 to 5 bullets summarizing what readers get.
5. Add the resource link.
6. Compress the X version and make the LinkedIn version useful even before the click.
7. Save as a Typefully draft.

## Validation

- The post accurately represents the source.
- The reader can understand the value before clicking.
- The post does not copy long source passages verbatim.
`,
  );

  addProcessDoc(
    docs,
    "create-podcast-follow-up-posts.md",
    "Create Podcast and Follow-Up Posts",
    ["social-media", "podcast", "follow-up", "typefully"],
    `
## Summary

- Purpose: announce live podcast sessions and published podcast episodes, then share follow-up takeaways.
- Outcome: X and LinkedIn Typefully drafts that connect the guest/topic to a clear listener benefit.

## Procedure

1. Determine the post type: live announcement, reminder, new episode, or post-event takeaway.
2. For live sessions, name the guest and topic. For published episodes, name the practical lesson.
3. Add guest credibility only if it helps the audience understand why to attend or listen.
4. Add 3 to 5 bullets for topics or takeaways.
5. Add the registration or episode link.
6. Save as a Typefully draft and record a safe creation receipt.

## Validation

- Guest name, role, and company are correct.
- The post distinguishes live registration from published episode listening.
- The link points to the right event or episode.
`,
  );

  return docs;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(usage());
    return;
  }

  const inputPath = path.resolve(process.cwd(), args.input);
  const outputDir = path.resolve(process.cwd(), args.output);
  const processDocDir = path.join(outputDir, "process-doc-drafts");
  const exportData = JSON.parse(await fs.readFile(inputPath, "utf8"));
  const omitPrivateLinks = buildPrivateLinkOmitter(exportData);
  const accounts = Array.isArray(exportData.accounts)
    ? exportData.accounts.map((account) => analyticalAccount(account, args.publishedOnly, omitPrivateLinks))
    : [];

  await fs.mkdir(processDocDir, { recursive: true });

  const summary = { coverage: [] };
  const lines = [];
  lines.push("# Typefully Post Analysis");
  lines.push("");
  lines.push(`Generated: ${new Date().toISOString()}`);
  lines.push(`Input: ${args.input}`);
  lines.push(`Status filter: ${args.publishedOnly ? "published only" : "all statuses"}`);
  lines.push("");
  lines.push("## Coverage");
  lines.push("");
  lines.push("| Account | Draft records | Earliest | Latest |");
  lines.push("| - | -: | - | - |");

  for (const account of accounts) {
    const dates = account.details.map((detail) => detail.publishedAt || detail.createdAt).filter(Boolean).sort();
    const row = {
      account: account.name,
      count: account.details.length,
      earliest: dates[0] || "",
      latest: dates.at(-1) || "",
    };
    summary.coverage.push(row);
    lines.push(`| ${row.account} | ${row.count} | ${row.earliest} | ${row.latest} |`);
  }

  lines.push("");
  lines.push("## Platform Mix");
  lines.push("");
  lines.push("| Account | Platform mix | Count |");
  lines.push("| - | - | -: |");

  for (const account of accounts) {
    const counts = new Map();
    for (const detail of account.details) {
      const key = enabledPlatforms(detail).join("+") || "none";
      counts.set(key, (counts.get(key) || 0) + 1);
    }
    for (const [key, count] of [...counts.entries()].sort((a, b) => b[1] - a[1])) {
      lines.push(`| ${account.name} | ${key} | ${count} |`);
    }
  }

  lines.push("");
  lines.push("## Common Tags");
  lines.push("");
  lines.push("| Account | Tag | Count |");
  lines.push("| - | - | -: |");

  for (const account of accounts) {
    const counts = new Map();
    for (const detail of account.details) {
      for (const tag of detail.tags) {
        counts.set(tag, (counts.get(tag) || 0) + 1);
      }
    }
    for (const [tag, count] of [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 40)) {
      lines.push(`| ${account.name} | ${tag} | ${count} |`);
    }
  }

  lines.push("");
  lines.push("## Content Categories");
  lines.push("");
  lines.push("| Account | Category | Count |");
  lines.push("| - | - | -: |");

  const examples = new Map();
  for (const account of accounts) {
    const counts = new Map();
    for (const detail of account.details) {
      for (const category of classify(detail)) {
        counts.set(category, (counts.get(category) || 0) + 1);
        const key = `${account.name}:${category}`;
        if (!examples.has(key)) {
          examples.set(key, {
            title: detail.draftTitle,
            tags: detail.tags,
            preview: detail.preview,
            x: postText(detail, "x"),
            linkedin: postText(detail, "linkedin"),
          });
        }
      }
    }
    for (const [category, count] of [...counts.entries()].sort((a, b) => b[1] - a[1])) {
      lines.push(`| ${account.name} | ${category} | ${count} |`);
    }
  }

  lines.push("");
  lines.push("## Representative Examples");
  for (const [key, example] of examples.entries()) {
    lines.push("");
    lines.push(`### ${key}`);
    lines.push("");
    lines.push(`- Title: ${example.title || ""}`);
    lines.push(`- Tags: ${example.tags.join(", ")}`);
    lines.push(`- Preview: ${example.preview || ""}`);
    if (example.x) {
      lines.push("");
      lines.push("X text:");
      lines.push("```text");
      lines.push(example.x.slice(0, 1200));
      lines.push("```");
    }
    if (example.linkedin) {
      lines.push("");
      lines.push("LinkedIn text:");
      lines.push("```text");
      lines.push(example.linkedin.slice(0, 1200));
      lines.push("```");
    }
  }

  await fs.writeFile(path.join(outputDir, "analysis.md"), omitPrivateLinks(`${lines.join("\n")}\n`));

  const docs = buildProcessDocs(summary);
  for (const [filename, content] of docs.entries()) {
    await fs.writeFile(path.join(processDocDir, filename), omitPrivateLinks(content));
  }

  console.log(`Wrote analysis and ${docs.size} process-doc drafts to ${outputDir}`);
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
