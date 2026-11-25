import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, test } from "node:test";

import { captureIo, fakePortal, isolateConfig } from "./helpers.mjs";

isolateConfig();
const { run } = await import("../src/cli.mjs");
const { EXIT } = await import("../src/errors.mjs");

describe("CLI crm deal attachments", () => {
  beforeEach(() => {
    isolateConfig();
  });

  test("crm --help documents deal attachment commands", async () => {
    const io = captureIo();
    assert.equal(await run(["crm", "--help"], io), EXIT.ok);
    const out = io.text();
    assert.match(out, /dataops crm deals attach <deal-id> <file>/);
    assert.match(out, /dataops crm deals attachments <deal-id>/);
    assert.match(out, /dataops crm deals attachment-download <deal-id> <attachment-id>/);
    assert.match(out, /dataops crm deals attachment-delete <deal-id> <attachment-id>/);
    assert.match(out, /dataops crm deals attachment-audit <deal-id>/);
  });

  test("attach, list, download, audit, and delete work end-to-end", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dataops-crm-attach-"));
    const pdfPath = join(dir, "signed-vivix.pdf");
    const outPath = join(dir, "downloaded.pdf");
    const pdfBytes = Buffer.from("%PDF-1.4\nSigned Vivix Agreement\n%%EOF\n");
    const checksum = `sha256:${createHash("sha256").update(pdfBytes).digest("hex")}`;
    writeFileSync(pdfPath, pdfBytes);

    const dealId = "d1000000-0000-4000-8000-000000000001";
    const attachmentId = "att-1";
    const io = captureIo();

    const calls = fakePortal({
      [`POST /api/sponsor-crm/deals/${dealId}/attachments`]: {
        status: 201,
        body: {
          attachment: {
            id: attachmentId,
            dealId,
            filename: "signed-vivix.pdf",
            contentType: "application/pdf",
            sizeBytes: pdfBytes.length,
            checksum,
            uploadedBy: "alexey",
            createdAt: "2026-11-25T10:00:00.000Z",
            note: "DocuSign",
          },
        },
      },
      [`GET /api/sponsor-crm/deals/${dealId}/attachments`]: {
        status: 200,
        body: {
          items: [
            {
              id: attachmentId,
              dealId,
              filename: "signed-vivix.pdf",
              sizeBytes: pdfBytes.length,
              createdAt: "2026-11-25T10:00:00.000Z",
              note: "DocuSign",
            },
          ],
        },
      },
      [`GET /api/sponsor-crm/deals/${dealId}/attachments/${attachmentId}/download`]: {
        status: 200,
        body: {
          downloadUrl: "https://storage.example/signed?X-Amz-Expires=300",
          expiresIn: 300,
          filename: "signed-vivix.pdf",
          contentType: "application/pdf",
          sizeBytes: pdfBytes.length,
          checksum,
        },
      },
      [`GET /api/sponsor-crm/deals/${dealId}/attachments/audit`]: {
        status: 200,
        body: {
          items: [
            { at: "2026-11-25T10:01:00.000Z", action: "downloaded", actorId: "alexey", attachmentId, filename: "signed-vivix.pdf" },
            { at: "2026-11-25T10:00:00.000Z", action: "uploaded", actorId: "alexey", attachmentId, filename: "signed-vivix.pdf" },
          ],
        },
      },
      [`DELETE /api/sponsor-crm/deals/${dealId}/attachments/${attachmentId}`]: {
        status: 204,
      },
    });

    const portalFetch = globalThis.fetch;
    globalThis.fetch = async (url, init) => {
      if (String(url).startsWith("https://storage.example/signed")) {
        return new Response(pdfBytes, { status: 200, headers: { "content-type": "application/pdf" } });
      }
      return portalFetch(url, init);
    };

    try {
      assert.equal(await run(["crm", "deals", "attach", dealId, pdfPath, "--note", "DocuSign", "--json"], io), EXIT.ok);
      assert.equal(io.json().attachment.id, attachmentId);
      assert.match(calls[0].headers["content-type"] || calls[0].headers["Content-Type"] || "", /^multipart\/form-data; boundary=/);

      io.out.length = 0;
      assert.equal(await run(["crm", "deals", "attachments", dealId, "--json"], io), EXIT.ok);
      assert.equal(io.json().items.length, 1);

      io.out.length = 0;
      assert.equal(await run(["crm", "deals", "attachment-download", dealId, attachmentId, "--output", outPath, "--json"], io), EXIT.ok);
      assert.deepEqual(readFileSync(outPath), pdfBytes);

      io.out.length = 0;
      assert.equal(await run(["crm", "deals", "attachment-audit", dealId, "--json"], io), EXIT.ok);
      assert.equal(io.json().items.length, 2);

      io.out.length = 0;
      assert.equal(await run(["crm", "deals", "attachment-delete", dealId, attachmentId, "--json"], io), EXIT.ok);
      assert.equal(io.json().status, "deleted");
    } finally {
      delete globalThis.fetch;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
