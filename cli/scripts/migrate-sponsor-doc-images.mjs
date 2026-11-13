#!/usr/bin/env node
/**
 * Migrate sponsor-doc `data:image/...;base64,...` visual fields to durable
 * hosted storage (`/api/public-images/...`) through the DataOps API.
 *
 * Usage:
 *   node cli/scripts/migrate-sponsor-doc-images.mjs [--apply] [--replace <doc-id>=<path>]
 */
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { multipart } from "../src/commands/tasks.mjs";
import { apiFor } from "../src/session.mjs";
import { enc } from "../src/format.mjs";

const DATA_IMAGE_RE = /^data:image\/(?:png|jpeg|jpg|gif|webp);base64,([A-Za-z0-9+/=\s]+)$/i;

function parseCliArgs(argv) {
  let apply = false;
  const replacements = new Map();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--apply") {
      apply = true;
    } else if (arg === "--replace") {
      const pair = argv[++i] || "";
      const eq = pair.indexOf("=");
      if (eq <= 0) throw new Error(`Invalid --replace value "${pair}". Expected <doc-id>=<path>.`);
      replacements.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
    } else if (arg === "--help" || arg === "-h") {
      console.log("Usage: node cli/scripts/migrate-sponsor-doc-images.mjs [--apply] [--replace <doc-id>=<path>]");
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return { apply, replacements };
}

async function main() {
  const { apply, replacements } = parseCliArgs(process.argv.slice(2));
  const api = apiFor({});
  const listRes = await api.get("/api/sponsor-docs");
  const docs = Array.isArray(listRes?.docs) ? listRes.docs : [];
  let migrated = 0;
  let skipped = 0;
  let failed = 0;

  for (const summary of docs) {
    const detail = await api.get(`/api/sponsor-docs/${enc(summary.id)}`);
    const doc = detail?.doc;
    if (!doc || !doc.content) continue;

    const replacementPath = replacements.get(doc.id);
    const graphicsUrl = typeof doc.content.graphicsUrl === "string" ? doc.content.graphicsUrl.trim() : "";
    const isDataUri = /^data:image\//i.test(graphicsUrl);

    if (!isDataUri && !replacementPath) continue;

    let bytes;
    let filename = `${doc.id}.png`;
    if (replacementPath) {
      bytes = readFileSync(replacementPath);
      filename = basename(replacementPath);
    } else {
      const m = DATA_IMAGE_RE.exec(graphicsUrl);
      if (!m) {
        console.error(`SKIP ${doc.id} (${doc.title}): non-base64 or unsupported data URI`);
        failed++;
        continue;
      }
      bytes = Buffer.from(m[1].replace(/\s+/g, ""), "base64");
    }

    if (!apply) {
      console.log(`DRY-RUN ${doc.id} (${doc.title}): would upload ${bytes.length} bytes and update content.graphicsUrl`);
      skipped++;
      continue;
    }

    try {
      const { body, contentType } = multipart({}, { name: filename, bytes });
      const uploadRes = await api.post(`/api/sponsor-docs/${enc(doc.id)}/images`, undefined, {
        rawBody: body,
        contentType,
      });
      const hostedUrl = uploadRes?.image?.url;
      if (!hostedUrl) throw new Error("Upload did not return image.url");

      await api.put(`/api/sponsor-docs/${enc(doc.id)}`, {
        expectedVersion: doc.version,
        content: {
          ...doc.content,
          graphicsUrl: hostedUrl,
        },
      });
      console.log(`MIGRATED ${doc.id} (${doc.title}) -> ${hostedUrl}`);
      migrated++;
    } catch (err) {
      console.error(`FAILED ${doc.id} (${doc.title}): ${err.message}`);
      failed++;
    }
  }

  console.log(`Done. migrated=${migrated} dry_run=${skipped} failed=${failed}`);
  if (failed > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
