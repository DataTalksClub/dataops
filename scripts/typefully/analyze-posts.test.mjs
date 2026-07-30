import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import test from "node:test";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "../..");
const analyzerPath = path.join(scriptDir, "analyze-posts.mjs");
const readmePath = path.join(scriptDir, "README.md");
const testTmpRoot = path.join(repoRoot, ".tmp");
const EXPECTED_OUTPUT_FILES = [
  "analysis.md",
  "process-doc-drafts/create-course-promotion-posts.md",
  "process-doc-drafts/create-newsletter-resource-posts.md",
  "process-doc-drafts/create-podcast-follow-up-posts.md",
  "process-doc-drafts/create-sponsored-partner-posts.md",
  "process-doc-drafts/create-workshop-event-posts.md",
  "process-doc-drafts/social-post-patterns-from-typefully.md",
];
const OMISSION_MARKER = "[private provider link omitted]";

async function makeWorkspace(t) {
  await fs.mkdir(testTmpRoot, { recursive: true });
  const workspace = await fs.mkdtemp(path.join(testTmpRoot, "analyze-posts-test-"));
  t.after(async () => {
    await fs.rm(workspace, { recursive: true, force: true });
  });
  return workspace;
}

async function writeNetworkGuard(workspace) {
  const guardPath = path.join(workspace, "network-guard.cjs");
  await fs.writeFile(
    guardPath,
    `
const blocked = () => {
  throw new Error("network access is forbidden in analyze-posts tests");
};

globalThis.fetch = blocked;

const http = require("node:http");
const https = require("node:https");
const net = require("node:net");
const tls = require("node:tls");
const dns = require("node:dns");

http.request = blocked;
http.get = blocked;
https.request = blocked;
https.get = blocked;
net.connect = blocked;
net.createConnection = blocked;
tls.connect = blocked;
dns.lookup = blocked;
dns.resolve = blocked;
`,
  );
  return guardPath;
}

async function runAnalyzer(workspace, exportData, options = []) {
  const inputPath = path.join(workspace, "synthetic-export.json");
  const outputName = options.includes("--include-unpublished") ? "all-output" : "published-output";
  const outputPath = path.join(workspace, outputName);
  const guardPath = await writeNetworkGuard(workspace);
  await fs.writeFile(inputPath, `${JSON.stringify(exportData, null, 2)}\n`);

  const result = spawnSync(
    process.execPath,
    [
      "--require",
      guardPath,
      analyzerPath,
      "--input",
      inputPath,
      "--output",
      outputPath,
      ...options,
    ],
    {
      cwd: repoRoot,
      encoding: "utf8",
      timeout: 5_000,
      env: {
        TYPEFULLY_API_KEY: "synthetic-secret-that-must-not-be-read",
        AWS_SECRET_ACCESS_KEY: "synthetic-aws-secret-that-must-not-be-read",
      },
    },
  );

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /Wrote analysis and 6 process-doc drafts/);
  return outputPath;
}

async function readOutputTree(root) {
  const files = new Map();

  async function visit(directory) {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const absolutePath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(absolutePath);
      } else if (entry.isFile()) {
        const relativePath = path.relative(root, absolutePath).split(path.sep).join("/");
        files.set(relativePath, await fs.readFile(absolutePath, "utf8"));
      }
    }
  }

  await visit(root);
  assert.deepEqual([...files.keys()].sort(), EXPECTED_OUTPUT_FILES);
  return files;
}

function combinedOutput(files) {
  return [...files.values()].join("\n");
}

function assertTreeOmits(files, forbiddenValues) {
  for (const [filename, content] of files) {
    for (const forbidden of forbiddenValues) {
      assert.equal(
        content.includes(forbidden),
        false,
        `${filename} leaked forbidden value or fragment: ${forbidden}`,
      );
    }
  }
}

test("omits nested provider-link aliases while preserving allowlisted evidence", async (t) => {
  const workspace = await makeWorkspace(t);
  const privateLink = "https://private.alpha.invalid/draft/path?token=alpha-secret";
  const shareLink = "https://share.beta.invalid/share/path?key=beta-secret";
  const editLink = "https://edit.gamma.invalid/edit/path?id=gamma-secret";
  const nestedPrivateLink = "https://nested.delta.invalid/private/nested-delta";
  const nestedShareLink = "https://nested.epsilon.invalid/share/nested-epsilon";
  const nestedEditLink = "https://nested.zeta.invalid/edit/nested-zeta";
  const publicCta = "https://event.example.invalid/register";
  const omittedPublishedMetadata = "https://published-metadata.example.invalid/post";
  const exportData = {
    accounts: [
      {
        social_set: {
          platforms: { x: { username: "Synthetic Evidence Account" } },
          name: "Unused synthetic account alias",
          id: "synthetic-social-set-id",
        },
        details: [
          {
            status: "published",
            draft_title: `Course campaign ${privateLink} launch`,
            tags: [
              "synthetic-tag",
              `tag-${privateLink}-tail`,
              `tag_${privateLink}_tail`,
            ],
            preview: `Preview prefix ${privateLink} suffix`,
            published_at: "2026-01-02T03:04:05.000Z",
            private_url: privateLink,
            shareUrl: shareLink,
            published_url: omittedPublishedMetadata,
            provider: {
              edit_url: editLink,
              metadata: {
                privateLink: nestedPrivateLink,
                share_link: nestedShareLink,
              },
            },
            platforms: {
              x: {
                enabled: true,
                editUrl: nestedEditLink,
                posts: [
                  {
                    text: [
                      `Useful X before ${privateLink} after.`,
                      `Hyphen wrapper prefix-${privateLink}-suffix.`,
                      `Underscore wrapper prefix_${privateLink}_suffix.`,
                      `Register: ${publicCta}`,
                    ].join(" "),
                  },
                ],
              },
              linkedin: {
                enabled: true,
                posts: [
                  { text: `Useful LinkedIn before ${privateLink} after. Register: ${publicCta}` },
                ],
              },
              unknownPlatform: {
                enabled: true,
                posts: [{ text: `Unknown platform ${shareLink}` }],
              },
            },
            unknown_extra: {
              copiedPrivateValue: privateLink,
              arbitraryObject: { shouldNeverRender: "unknown-object-sentinel" },
            },
          },
        ],
      },
    ],
  };

  const outputPath = await runAnalyzer(workspace, exportData);
  const files = await readOutputTree(outputPath);
  const output = combinedOutput(files);
  const analysis = files.get("analysis.md");

  assertTreeOmits(files, [
    privateLink,
    shareLink,
    editLink,
    nestedPrivateLink,
    nestedShareLink,
    nestedEditLink,
    omittedPublishedMetadata,
    "private.alpha.invalid",
    "draft/path",
    "alpha-secret",
    "share.beta.invalid",
    "beta-secret",
    "edit.gamma.invalid",
    "gamma-secret",
    "nested-delta",
    "nested-epsilon",
    "nested-zeta",
    "unknown-object-sentinel",
    "Unknown platform",
    "synthetic-social-set-id",
  ]);
  assert.doesNotMatch(output, /- Private URL:/);
  assert.match(analysis, /\| Synthetic Evidence Account \| 1 \| 2026-01-02T03:04:05\.000Z \| 2026-01-02T03:04:05\.000Z \|/);
  assert.match(analysis, /\| Synthetic Evidence Account \| x\+linkedin \| 1 \|/);
  assert.match(analysis, /\| Synthetic Evidence Account \| course-launch-or-reminder \| 1 \|/);
  assert.equal(analysis.includes(`- Title: Course campaign ${OMISSION_MARKER} launch`), true);
  assert.equal(analysis.includes(`- Preview: Preview prefix ${OMISSION_MARKER} suffix`), true);
  assert.equal(analysis.includes(`tag-${OMISSION_MARKER}-tail`), true);
  assert.equal(analysis.includes(`tag_${OMISSION_MARKER}_tail`), true);
  assert.match(analysis, new RegExp(`Useful X before \\${OMISSION_MARKER} after`));
  assert.equal(analysis.includes(`Hyphen wrapper prefix-${OMISSION_MARKER}-suffix`), true);
  assert.equal(analysis.includes(`Underscore wrapper prefix_${OMISSION_MARKER}_suffix`), true);
  assert.match(analysis, new RegExp(`Useful LinkedIn before \\${OMISSION_MARKER} after`));
  assert.equal(analysis.includes(publicCta), true);
  assert.match(output, /record a safe creation receipt/);
  assert.doesNotMatch(output, /record (?:the|a) private (?:Typefully )?URL/i);
});

test("handles malformed and repeated metadata in published-only and all-status modes", async (t) => {
  const workspace = await makeWorkspace(t);
  const repeatedLink = "https://repeat.private.invalid/item?token=repeated-secret";
  const unpublishedLink = "https://unpublished.share.invalid/item?token=unpublished-secret";
  const longLink = `https://long.edit.invalid/${"synthetic-segment-".repeat(100)}final-token`;
  const malformedStringValue = "malformed-private-link-sentinel";
  const ignoredObjectValue = "non-string-private-field-object-sentinel";
  const publicCta = "https://event.example.invalid/register";
  const exportData = {
    accounts: [
      {
        target: { label: "Synthetic Status Account" },
        details: [
          {
            status: "published",
            draft_title: "Published workshop evidence",
            tags: ["workshop", "published"],
            preview: `Published preview ${malformedStringValue} remains useful`,
            published_at: "2026-02-01T00:00:00.000Z",
            privateUrl: null,
            private_url: "/",
            private_link: malformedStringValue,
            share_url: { hostile: ignoredObjectValue },
            editLink: repeatedLink,
            nested: {
              share_url: repeatedLink,
              private_url: 42,
              edit_url: "https://",
              editLink: "////",
              shareLink: "   ",
              privateUrl: [{ editUrl: longLink }],
            },
            platforms: {
              x: {
                enabled: true,
                posts: [
                  {
                    text: `Useful A/B evidence ${repeatedLink} omitted. Register: ${publicCta}`,
                  },
                  { text: null },
                ],
              },
              linkedin: { enabled: false, posts: "malformed-post-list" },
            },
          },
          {
            status: "draft",
            draft_title: "Unpublished podcast evidence",
            tags: ["podcast", "unpublished"],
            preview: "Unpublished preview remains useful",
            created_at: "2026-03-01T00:00:00.000Z",
            shareUrl: unpublishedLink,
            platforms: {
              x: { enabled: false, posts: [] },
              linkedin: {
                enabled: true,
                posts: [{ text: `Unpublished LinkedIn evidence ${unpublishedLink}` }],
              },
            },
          },
          null,
        ],
      },
    ],
  };

  const publishedOutput = await runAnalyzer(workspace, exportData);
  const publishedFiles = await readOutputTree(publishedOutput);
  const publishedAnalysis = publishedFiles.get("analysis.md");
  assert.match(publishedAnalysis, /Status filter: published only/);
  assert.match(publishedAnalysis, /\| Synthetic Status Account \| 1 \|/);
  assert.match(publishedAnalysis, /Published workshop evidence/);
  assert.doesNotMatch(publishedAnalysis, /Unpublished podcast evidence/);
  assert.equal(publishedAnalysis.includes(OMISSION_MARKER), true);
  assert.equal(
    publishedAnalysis.includes(`Useful A/B evidence ${OMISSION_MARKER} omitted. Register: ${publicCta}`),
    true,
  );

  const allOutput = await runAnalyzer(workspace, exportData, ["--include-unpublished"]);
  const allFiles = await readOutputTree(allOutput);
  const allAnalysis = allFiles.get("analysis.md");
  assert.match(allAnalysis, /Status filter: all statuses/);
  assert.match(allAnalysis, /\| Synthetic Status Account \| 2 \|/);
  assert.match(allAnalysis, /Published workshop evidence/);
  assert.match(allAnalysis, /Unpublished podcast evidence/);
  assert.equal(
    allAnalysis.includes(`Published preview ${OMISSION_MARKER} remains useful`),
    true,
  );
  assert.match(allAnalysis, /Unpublished preview remains useful/);
  assert.equal(
    allAnalysis.includes(`Useful A/B evidence ${OMISSION_MARKER} omitted. Register: ${publicCta}`),
    true,
  );

  for (const files of [publishedFiles, allFiles]) {
    assertTreeOmits(files, [
      repeatedLink,
      unpublishedLink,
      longLink,
      malformedStringValue,
      "repeat.private.invalid",
      "repeated-secret",
      "unpublished.share.invalid",
      "unpublished-secret",
      "long.edit.invalid",
      "final-token",
      ignoredObjectValue,
      "synthetic-secret-that-must-not-be-read",
      "synthetic-aws-secret-that-must-not-be-read",
    ]);
  }
});

test("redacts exact URLs without corrupting distinct longer URL prefixes", async (t) => {
  const workspace = await makeWorkspace(t);
  const shortHostLink = "https://a";
  const hostOnlyLink = "https://event.example.invalid";
  const queryBoundaryLink = "https://query.example.invalid/path?draft=one";
  const fragmentBoundaryLink = "https://fragment.example.invalid/path";
  const portBoundaryLink = "https://port.example.invalid";
  const encodedBoundaryLink = "https://encoded.example.invalid/path";
  const semicolonBoundaryLink = "https://semicolon.example.invalid/path";
  const hyphenBoundaryLink = "https://hyphen.example.invalid/path";
  const underscoreBoundaryLink = "https://underscore.example.invalid/path";
  const tildeBoundaryLink = "https://tilde.example.invalid/path";
  const exactPrivateLink = "https://exact.private.invalid/draft?token=exact-synthetic";
  const opaqueSentinel = "specific-opaque-private-sentinel";
  const publicUrls = [
    "https://a.example.invalid/register",
    "https://event.example.invalid/register",
    "https://query.example.invalid/path?draft=one&campaign=public",
    "https://fragment.example.invalid/path#public",
    "https://port.example.invalid:8443/register",
    "https://encoded.example.invalid/path%20continued",
    "https://semicolon.example.invalid/path;param=public",
    "https://hyphen.example.invalid/path-continued",
    "https://underscore.example.invalid/path_continued",
    "https://tilde.example.invalid/path~continued",
  ];
  const evidenceText = [
    "Boundary-safe public links:",
    ...publicUrls,
    `Exact short-host value: ${shortHostLink} bounded`,
    `Exact host-only value: ${hostOnlyLink} bounded`,
    `Exact query value: ${queryBoundaryLink} bounded`,
    `Exact fragment value: ${fragmentBoundaryLink} bounded`,
    `Exact port value: ${portBoundaryLink} bounded`,
    `Exact encoded-prefix value: ${encodedBoundaryLink} bounded`,
    `Exact semicolon-prefix value: ${semicolonBoundaryLink} bounded`,
    `Exact hyphen-prefix value: ${hyphenBoundaryLink} bounded`,
    `Exact underscore-prefix value: ${underscoreBoundaryLink} bounded`,
    `Exact tilde-prefix value: ${tildeBoundaryLink} bounded`,
  ].join("\n");
  const exportData = {
    accounts: [
      {
        target: { label: "Synthetic URL Boundary Account" },
        details: [
          {
            status: "published",
            draft_title: "Course URL boundary evidence",
            tags: ["boundary", "synthetic"],
            preview: [
              "Distinct longer URLs remain useful.",
              `Exact private value: ${exactPrivateLink} omitted here.`,
              `Opaque value: ${opaqueSentinel} omitted here.`,
            ].join(" "),
            published_at: "2026-04-01T00:00:00.000Z",
            private_url: hostOnlyLink,
            provider: {
              editLink: shortHostLink,
              nested: {
                query: { share_url: queryBoundaryLink },
                privateLink: fragmentBoundaryLink,
                edit_url: portBoundaryLink,
                editLink: encodedBoundaryLink,
                semicolon: { share_url: semicolonBoundaryLink },
                hyphen: { edit_url: hyphenBoundaryLink },
                underscore: { privateUrl: underscoreBoundaryLink },
                tilde: { shareLink: tildeBoundaryLink },
                shareLink: exactPrivateLink,
                private_link: opaqueSentinel,
              },
            },
            platforms: {
              x: { enabled: true, posts: [{ text: evidenceText }] },
              linkedin: { enabled: false, posts: [] },
            },
          },
        ],
      },
    ],
  };

  const outputPath = await runAnalyzer(workspace, exportData);
  const files = await readOutputTree(outputPath);
  const analysis = files.get("analysis.md");

  for (const publicUrl of publicUrls) {
    assert.equal(
      analysis.includes(publicUrl),
      true,
      `distinct longer public URL was corrupted: ${publicUrl}`,
    );
  }
  for (const label of [
    "short-host",
    "host-only",
    "query",
    "fragment",
    "port",
    "encoded-prefix",
    "semicolon-prefix",
    "hyphen-prefix",
    "underscore-prefix",
    "tilde-prefix",
  ]) {
    assert.equal(
      analysis.includes(`Exact ${label} value: ${OMISSION_MARKER} bounded`),
      true,
      `bounded exact URL was not redacted: ${label}`,
    );
  }
  assert.equal(
    analysis.includes(`Exact private value: ${OMISSION_MARKER} omitted here`),
    true,
  );
  assert.equal(
    analysis.includes(`Opaque value: ${OMISSION_MARKER} omitted here`),
    true,
  );
  assert.equal(analysis.includes(exactPrivateLink), false);
  assert.equal(analysis.includes(opaqueSentinel), false);
  assert.doesNotMatch(combinedOutput(files), /- Private URL:/);
});

test("applies the strict URL token matrix in both status modes", async (t) => {
  const workspace = await makeWorkspace(t);
  const cases = [
    {
      id: "hostname",
      candidate: "https://a",
      longer: "https://a.example.invalid/register",
      preserve: true,
    },
    {
      id: "path",
      candidate: "https://path-matrix.example.invalid",
      longer: "https://path-matrix.example.invalid/register",
      preserve: true,
    },
    {
      id: "query-ampersand",
      candidate: "https://query-matrix.example.invalid/path?draft=one",
      longer: "https://query-matrix.example.invalid/path?draft=one&campaign=public",
      preserve: true,
    },
    {
      id: "query-plus",
      candidate: "https://plus-matrix.example.invalid/path?q=base",
      longer: "https://plus-matrix.example.invalid/path?q=base+public",
      preserve: true,
    },
    {
      id: "fragment",
      candidate: "https://fragment-matrix.example.invalid/path",
      longer: "https://fragment-matrix.example.invalid/path#public",
      preserve: true,
    },
    {
      id: "port",
      candidate: "https://port-matrix.example.invalid",
      longer: "https://port-matrix.example.invalid:8443/register",
      preserve: true,
    },
    {
      id: "percent",
      candidate: "https://percent-matrix.example.invalid/path",
      longer: "https://percent-matrix.example.invalid/path%20continued",
      preserve: true,
    },
    {
      id: "semicolon",
      candidate: "https://semicolon-matrix.example.invalid/path",
      longer: "https://semicolon-matrix.example.invalid/path;param=public",
      preserve: true,
    },
    {
      id: "hyphen",
      candidate: "https://hyphen-matrix.example.invalid/path",
      longer: "https://hyphen-matrix.example.invalid/path-continued",
      preserve: true,
    },
    {
      id: "underscore",
      candidate: "https://underscore-matrix.example.invalid/path",
      longer: "https://underscore-matrix.example.invalid/path_continued",
      preserve: true,
    },
    {
      id: "tilde",
      candidate: "https://tilde-matrix.example.invalid/path",
      longer: "https://tilde-matrix.example.invalid/path~continued",
      preserve: true,
    },
    {
      id: "unicode-path",
      candidate: "https://unicode-path.example.invalid/base",
      longer: "https://unicode-path.example.invalid/base/данные",
      preserve: true,
    },
    {
      id: "unicode-host",
      candidate: "https://unicode-host",
      longer: "https://unicode-host.пример.invalid/register",
      preserve: true,
    },
    {
      id: "unicode-query",
      candidate: "https://unicode-query.example.invalid/path?q=base",
      longer: "https://unicode-query.example.invalid/path?q=baseданные",
      preserve: true,
    },
    {
      id: "userinfo",
      candidate: "https://synthetic-user",
      longer: "https://synthetic-user:password@userinfo.example.invalid/path",
      preserve: true,
    },
    {
      id: "userinfo-ipv6",
      candidate: "https://synthetic-ipv6-user",
      longer: "https://synthetic-ipv6-user:password@[2001:db8::1]/path",
      preserve: true,
    },
    {
      id: "ipv6",
      candidate: "https://[2001:db8::1]",
      longer: "https://[2001:db8::1]:8443/register",
      preserve: true,
    },
    {
      id: "punycode",
      candidate: "https://xn--e1afmkfd.invalid",
      longer: "https://xn--e1afmkfd.invalid/путь",
      preserve: true,
    },
    {
      id: "canonical-ipv4",
      candidate: "https://192.0.2.1",
      longer: "https://192.0.2.1/register",
      preserve: true,
    },
    {
      id: "mixed-case",
      candidate: "HTTPS://Mixed.Example.Invalid/Path",
      longer: "HTTPS://Mixed.Example.Invalid/Path/More",
      preserve: true,
    },
    {
      id: "fqdn-root-dot",
      candidate: "https://fqdn",
      longer: "https://fqdn.example.invalid./path",
      preserve: true,
    },
    {
      id: "invalid-port",
      candidate: "https://invalid-port-matrix.example.invalid",
      longer: "https://invalid-port-matrix.example.invalid:99999/register",
      preserve: false,
    },
    {
      id: "invalid-percent",
      candidate: "https://invalid-percent-matrix.example.invalid/path",
      longer: "https://invalid-percent-matrix.example.invalid/path%GGvalue",
      preserve: false,
    },
    {
      id: "empty-label",
      candidate: "https://empty-label-matrix",
      longer: "https://empty-label-matrix.example..invalid/register",
      preserve: false,
    },
    {
      id: "leading-hyphen-label",
      candidate: "https://leading-label-matrix",
      longer: "https://leading-label-matrix.-bad.invalid/register",
      preserve: false,
    },
    {
      id: "trailing-hyphen-label",
      candidate: "https://trailing-label-matrix",
      longer: "https://trailing-label-matrix.bad-.invalid/register",
      preserve: false,
    },
    {
      id: "empty-structural-tail",
      candidate: "https://empty-tail-matrix.example.invalid/path",
      longer: "https://empty-tail-matrix.example.invalid/path?",
      preserve: false,
    },
    {
      id: "invalid-ipv6-bracket",
      candidate: "https://invalid-bracket-user",
      longer: "https://invalid-bracket-user:password@[2001:db8::1/path",
      preserve: false,
    },
    {
      id: "unmatched-ipv6-close",
      candidate: "https://invalid-close-user",
      longer: "https://invalid-close-user:password@2001:db8::1]/path",
      preserve: false,
    },
    {
      id: "invalid-ipv6-address",
      candidate: "https://invalid-ipv6-user",
      longer: "https://invalid-ipv6-user:password@[2001:db8:::1]/path",
      preserve: false,
    },
    {
      id: "multiple-root-dots",
      candidate: "https://multiple-root",
      longer: "https://multiple-root.example.invalid../path",
      preserve: false,
    },
  ];
  const wrapperLink = "https://wrapper-matrix.private.invalid/path?token=wrapper-secret";
  const wrapperTemplates = [
    "sentence URL.",
    "comma URL, next",
    "[draft](URL)",
    "'URL'",
    "\"URL\"",
    "URL!",
    "URL control",
    "URL]",
    "URL}",
    "URL; next",
    "URL: note",
    "*URL*",
    "**URL**",
    "`URL`",
    "\\*URL\\*",
    "+URL+",
    "$URL$",
    "URL(note)",
    "tag-URL-tail",
    "tag_URL_tail",
  ];
  const repeatedLink = "https://repeated-matrix.private.invalid/path?token=repeated";
  const longOpaque = "opaque-overlap-sentinel-abcdef";
  const shortOpaque = "overlap-sentinel-abcdef";
  const markerSubstringOpaque = "private provider link";
  const invalidRawValues = [
    "https://raw-invalid.example.invalid:99999/path",
    "https://raw-invalid.example.invalid/%GGvalue",
    "https://raw-invalid.example.invalid:/path",
    "https://raw..invalid/path",
    "https://-raw-edge.invalid/path",
    "https://raw-edge-.invalid/path",
    "https://192.0.2.01/path",
  ];
  const accounts = cases.map(({ id, candidate, longer }) => ({
    target: { label: `Matrix ${id}` },
    details: [
      {
        status: "published",
        draft_title: `Course matrix ${id}`,
        tags: ["matrix", id],
        preview: `Strict URL matrix ${id}`,
        published_at: "2026-07-01T00:00:00.000Z",
        provider: { nested: { private_url: candidate } },
        platforms: {
          x: {
            enabled: true,
            posts: [{ text: `EXACT ${id} ${candidate} END\nLONG ${id} ${longer} END` }],
          },
          linkedin: { enabled: false, posts: [] },
        },
      },
    ],
  }));
  accounts.push(
    {
      target: { label: "Matrix wrappers" },
      details: [
        {
          status: "published",
          draft_title: "Course matrix wrappers",
          tags: ["matrix", `tag-${wrapperLink}-tail`, `tag_${wrapperLink}_tail`],
          preview: "Strict URL wrapper matrix",
          published_at: "2026-07-02T00:00:00.000Z",
          provider: { private_url: wrapperLink },
          platforms: {
            x: {
              enabled: true,
              posts: [{
                text: wrapperTemplates
                  .map((template, index) => `WRAP ${index} ${template.replace("URL", wrapperLink)}`)
                  .join("\n"),
              }],
            },
            linkedin: { enabled: false, posts: [] },
          },
        },
      ],
    },
    {
      target: { label: "Matrix interval merging" },
      details: [
        {
          status: "published",
          draft_title: "Course matrix intervals",
          tags: ["matrix", "intervals"],
          preview: "Adjacent repeated and overlapping candidates",
          published_at: "2026-07-03T00:00:00.000Z",
          provider: {
            values: [
              { private_url: repeatedLink },
              { shareLink: longOpaque },
              { edit_url: shortOpaque },
              { privateLink: markerSubstringOpaque },
              ...invalidRawValues.map((privateUrl) => ({ privateUrl })),
            ],
          },
          platforms: {
            x: {
              enabled: true,
              posts: [{
                text: [
                  `ADJACENT ${repeatedLink}${repeatedLink} END`,
                  `REPEATED ${repeatedLink} ${repeatedLink} ${repeatedLink} END`,
                  `OVERLAP ${longOpaque} END`,
                  `MARKER-STABILITY ${markerSubstringOpaque} END`,
                  ...invalidRawValues.map((value, index) => `INVALID-RAW ${index} ${value} END`),
                ].join("\n"),
              }],
            },
            linkedin: { enabled: false, posts: [] },
          },
        },
      ],
    },
  );
  const exportData = { accounts };

  for (const options of [[], ["--include-unpublished"]]) {
    const outputPath = await runAnalyzer(workspace, exportData, options);
    const files = await readOutputTree(outputPath);
    const output = combinedOutput(files);
    const analysis = files.get("analysis.md");

    for (const { id, candidate, longer, preserve } of cases) {
      assert.equal(
        analysis.includes(`EXACT ${id} ${OMISSION_MARKER} END`),
        true,
        `bounded exact value was not redacted: ${id}`,
      );
      if (preserve) {
        assert.equal(
          analysis.includes(`LONG ${id} ${longer} END`),
          true,
          `valid longer URL was not preserved: ${id}`,
        );
      } else {
        assert.equal(
          analysis.includes(longer),
          false,
          `invalid longer URL suppressed exact redaction: ${id}`,
        );
        assert.equal(
          analysis.includes(`LONG ${id} ${OMISSION_MARKER}${longer.slice(candidate.length)} END`),
          true,
          `invalid longer URL did not redact its candidate prefix: ${id}`,
        );
      }
    }

    assert.equal(output.includes(wrapperLink), false);
    for (let index = 0; index < wrapperTemplates.length; index += 1) {
      assert.equal(
        analysis.includes(
          `WRAP ${index} ${wrapperTemplates[index].replace("URL", OMISSION_MARKER)}`,
        ),
        true,
        `wrapper did not render one neutral marker: ${index}`,
      );
    }
    assert.equal(
      analysis.includes(`ADJACENT ${OMISSION_MARKER}${OMISSION_MARKER} END`),
      true,
    );
    assert.equal(
      analysis.includes(
        `REPEATED ${OMISSION_MARKER} ${OMISSION_MARKER} ${OMISSION_MARKER} END`,
      ),
      true,
    );
    assert.equal(analysis.includes(`OVERLAP ${OMISSION_MARKER} END`), true);
    assert.equal(analysis.includes(`MARKER-STABILITY ${OMISSION_MARKER} END`), true);
    assert.equal(
      analysis.includes("MARKER-STABILITY [private [private provider link omitted] omitted] END"),
      false,
    );
    for (let index = 0; index < invalidRawValues.length; index += 1) {
      assert.equal(
        analysis.includes(`INVALID-RAW ${index} ${OMISSION_MARKER} END`),
        true,
        `strictly invalid raw value did not use opaque exact replacement: ${index}`,
      );
    }
    assertTreeOmits(files, [
      longOpaque,
      shortOpaque,
      ...invalidRawValues,
      "wrapper-secret",
    ]);
  }
});

test("redacts exact URLs beside terminal prose and Markdown punctuation", async (t) => {
  const workspace = await makeWorkspace(t);
  const exactLink = "https://punctuation.private.invalid/draft/path?token=synthetic-secret";
  const evidenceText = [
    `Sentence ending ${exactLink}.`,
    `Clause ending ${exactLink}, then useful text`,
    `Markdown destination [draft](${exactLink})`,
    `Single quote '${exactLink}'`,
    `Double quote "${exactLink}"`,
    `Exclamation ${exactLink}!`,
    `Whitespace ${exactLink} control`,
    `Closing bracket ${exactLink}]`,
    `Closing brace ${exactLink}}`,
    `Semicolon ${exactLink}; then useful text`,
    `Colon ${exactLink}: explanatory text`,
    `Single emphasis *${exactLink}*`,
    `Double emphasis **${exactLink}**`,
    `Inline code \`${exactLink}\``,
    `Escaped emphasis \\*${exactLink}\\*`,
    `Plus wrapper +${exactLink}+`,
    `Dollar wrapper $${exactLink}$`,
    `Parenthetical suffix ${exactLink}(note)`,
  ].join("\n");
  const exportData = {
    accounts: [
      {
        target: { label: "Synthetic Punctuation Account" },
        details: [
          {
            status: "published",
            draft_title: "Course punctuation evidence",
            tags: ["punctuation", "synthetic"],
            preview: "Terminal punctuation remains intact",
            published_at: "2026-05-01T00:00:00.000Z",
            private_url: exactLink,
            platforms: {
              x: { enabled: true, posts: [{ text: evidenceText }] },
              linkedin: { enabled: false, posts: [] },
            },
          },
        ],
      },
    ],
  };

  const outputPath = await runAnalyzer(workspace, exportData);
  const files = await readOutputTree(outputPath);
  const analysis = files.get("analysis.md");

  assertTreeOmits(files, [exactLink, "punctuation.private.invalid", "synthetic-secret"]);
  assert.equal(analysis.includes(`Sentence ending ${OMISSION_MARKER}.`), true);
  assert.equal(analysis.includes(`Clause ending ${OMISSION_MARKER}, then useful text`), true);
  assert.equal(analysis.includes(`Markdown destination [draft](${OMISSION_MARKER})`), true);
  assert.equal(analysis.includes(`Single quote '${OMISSION_MARKER}'`), true);
  assert.equal(analysis.includes(`Double quote "${OMISSION_MARKER}"`), true);
  assert.equal(analysis.includes(`Exclamation ${OMISSION_MARKER}!`), true);
  assert.equal(analysis.includes(`Whitespace ${OMISSION_MARKER} control`), true);
  assert.equal(analysis.includes(`Closing bracket ${OMISSION_MARKER}]`), true);
  assert.equal(analysis.includes(`Closing brace ${OMISSION_MARKER}}`), true);
  assert.equal(analysis.includes(`Semicolon ${OMISSION_MARKER}; then useful text`), true);
  assert.equal(analysis.includes(`Colon ${OMISSION_MARKER}: explanatory text`), true);
  assert.equal(analysis.includes(`Single emphasis *${OMISSION_MARKER}*`), true);
  assert.equal(analysis.includes(`Double emphasis **${OMISSION_MARKER}**`), true);
  assert.equal(analysis.includes(`Inline code \`${OMISSION_MARKER}\``), true);
  assert.equal(analysis.includes(`Escaped emphasis \\*${OMISSION_MARKER}\\*`), true);
  assert.equal(analysis.includes(`Plus wrapper +${OMISSION_MARKER}+`), true);
  assert.equal(analysis.includes(`Dollar wrapper $${OMISSION_MARKER}$`), true);
  assert.equal(analysis.includes(`Parenthetical suffix ${OMISSION_MARKER}(note)`), true);
});

test("keeps many-candidate long-text redaction bounded", async (t) => {
  const workspace = await makeWorkspace(t);
  const privateLinks = Array.from(
    { length: 180 },
    (_, index) => `https://private-${index}.perf.example.invalid/draft?token=synthetic-${index}`,
  );
  const targetLink = privateLinks.at(-1);
  const exportData = {
    accounts: [
      {
        target: { label: "Synthetic Performance Account" },
        details: [
          {
            status: "published",
            draft_title: "Course bounded performance evidence",
            tags: ["synthetic", "performance"],
            preview: "Bounded candidate scan",
            published_at: "2026-06-01T00:00:00.000Z",
            private_url: privateLinks[0],
            nested: privateLinks.map((private_url) => ({ private_url })),
            platforms: {
              x: {
                enabled: true,
                posts: [{ text: `${targetLink} bounded ${"x".repeat(100_000)}` }],
              },
              linkedin: { enabled: false, posts: [] },
            },
          },
        ],
      },
    ],
  };

  const started = performance.now();
  const outputPath = await runAnalyzer(workspace, exportData);
  const durationMs = performance.now() - started;
  const files = await readOutputTree(outputPath);
  const analysis = files.get("analysis.md");

  assert.ok(durationMs < 5_000, `bounded redaction took ${durationMs.toFixed(1)} ms`);
  assertTreeOmits(files, [targetLink, "private-179.perf.example.invalid", "synthetic-179"]);
  assert.equal(analysis.includes(`${OMISSION_MARKER} bounded`), true);
});

test("documents the private-output boundary and keeps the analyzer credential-independent", async () => {
  const [source, readme] = await Promise.all([
    fs.readFile(analyzerPath, "utf8"),
    fs.readFile(readmePath, "utf8"),
  ]);

  assert.doesNotMatch(source, /\bprocess\.env\b/);
  assert.doesNotMatch(source, /\bfetch\s*\(/);
  assert.doesNotMatch(source, /node:https?|node:tls|net\.(?:connect|createConnection)/);
  assert.match(readme, /analyzer reads only its caller-supplied local JSON file\s+and makes no credential or network request/);
  assert.match(readme, /Generated analysis and process-document drafts are also private operational\s+data/);
  assert.match(readme, /omits provider private, share, and edit link metadata/);
  assert.match(readme, /Wrapper punctuation does not suppress omission/);
  assert.match(readme, /syntactically valid longer public URL remains unchanged/);
});
