import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, test } from "node:test";

import { captureIo, fakePortal, isolateConfig } from "./helpers.mjs";

isolateConfig();
const realFetch = globalThis.fetch;
const { run } = await import("../src/cli.mjs");

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("newsletter image upload", () => {
  test("uploads an image via POST /api/newsletter-issues/:id/images and prints the durable https URL", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "dataops-nl-img-"));
    try {
      const imgPath = path.join(dir, "sponsor.png");
      const pngBytes = Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+X2ZkAAAAASUVORK5CYII=",
        "base64",
      );
      writeFileSync(imgPath, pngBytes);

      const calls = fakePortal({
        "POST /api/newsletter-issues/issue-303/images": (req) => {
          const ct = req.headers["content-type"] || req.headers["Content-Type"] || "";
          assert.match(ct, /^multipart\/form-data; boundary=/);
          assert.ok(Buffer.from(req.body || "").includes(pngBytes));
          return {
            status: 201,
            body: {
              issueId: "issue-303",
              image: {
                id: "11111111-1111-4111-8111-111111111111.png",
                path: "/api/public-images/11111111-1111-4111-8111-111111111111.png",
                contentType: "image/png",
                sizeBytes: pngBytes.length,
                url: "https://portal.test/api/public-images/11111111-1111-4111-8111-111111111111.png",
              },
            },
          };
        },
      });

      const io = captureIo();
      const code = await run(["newsletter", "image", "upload", "issue-303", imgPath], io);
      assert.equal(code, 0, io.errors.join("\n"));
      assert.equal(calls.length, 1);
      assert.equal(
        io.text().trim(),
        "https://portal.test/api/public-images/11111111-1111-4111-8111-111111111111.png",
      );

      const jsonIo = captureIo();
      const jsonCode = await run(["newsletter", "image", "upload", "issue-303", imgPath, "--json"], jsonIo);
      assert.equal(jsonCode, 0, jsonIo.errors.join("\n"));
      const parsed = jsonIo.json();
      assert.equal(parsed.issueId, "issue-303");
      assert.equal(
        parsed.image.url,
        "https://portal.test/api/public-images/11111111-1111-4111-8111-111111111111.png",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("fails loudly when the file is missing or empty, and prints help for --help", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "dataops-nl-img-err-"));
    try {
      fakePortal({});
      const missingIo = captureIo();
      const missingCode = await run(
        ["newsletter", "image", "upload", "issue-303", path.join(dir, "nope.png")],
        missingIo,
      );
      assert.notEqual(missingCode, 0);
      assert.match(missingIo.errors.join("\n"), /Could not read image file/);

      const emptyPath = path.join(dir, "empty.png");
      writeFileSync(emptyPath, Buffer.alloc(0));
      const emptyIo = captureIo();
      const emptyCode = await run(["newsletter", "image", "upload", "issue-303", emptyPath], emptyIo);
      assert.notEqual(emptyCode, 0);
      assert.match(emptyIo.errors.join("\n"), /empty/i);

      const helpIo = captureIo();
      const helpCode = await run(["newsletter", "image", "--help"], helpIo);
      assert.equal(helpCode, 0);
      assert.match(helpIo.text(), /dataops newsletter image upload <issue-id> <path>/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
