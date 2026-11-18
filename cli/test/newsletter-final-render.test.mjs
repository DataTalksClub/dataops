import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, test } from "node:test";

import { captureIo, fakePortal, isolateConfig } from "./helpers.mjs";

isolateConfig();
const { run } = await import("../src/cli.mjs");

const ISSUE = "12407b2e83f5fbda0ed906b74bb22dcee8d4a44fe0335963c809448de39ae9ce";
const WEB_VIEW = "https://relay.datatalks.club/newsletter/view/5:U_F3fXwxFN7FqsvzDDPxA7feGtnrXwNyr78D0S8aCtM";
const SUBJECT = "🛠️ Run AI pipelines with Snowflake and Airflow | DataTalks.Club Weekly";
const PREVIEW = "Live Dec 3 with Snowflake’s Principal Partner SE.";

const previewPayload = (rendered = {}) => ({
  previewUrl: `https://portal.test/newsletter/preview/${ISSUE}`,
  shareUrl: `https://portal.test/newsletter/preview/${ISSUE}?code=abc`,
  rendered: { finalWebViewUrl: WEB_VIEW, finalSubject: SUBJECT, finalPreviewText: PREVIEW, finalHtml: "", ...rendered },
});

describe("newsletter final-render", () => {
  test("stores web-view URL, subject and preview (Weekly #303 command)", async () => {
    const calls = fakePortal({ [`PUT /api/newsletter-issues/${ISSUE}/final-render`]: () => previewPayload() });
    const io = captureIo();
    const code = await run([
      "newsletter", "final-render", ISSUE, "--web-view-url", WEB_VIEW, "--subject", SUBJECT, "--preview", PREVIEW,
    ], io);
    assert.equal(code, 0, io.errors.join("\n"));
    assert.deepEqual(calls[0].body, { webViewUrl: WEB_VIEW, subject: SUBJECT, previewText: PREVIEW });
    assert.match(io.text(), /shareUrl: https:\/\/portal\.test\/newsletter\/preview\/.*\?code=abc/);
    assert.match(io.text(), new RegExp(`webViewUrl: ${WEB_VIEW.replace(/[.?]/g, "\\$&")}`));
    assert.match(io.text(), /finalHtml: none/);
  });

  test("--html-file uploads the file contents", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "final-render-"));
    const file = path.join(dir, "email.html");
    writeFileSync(file, "<html>final</html>");
    const calls = fakePortal({
      [`PUT /api/newsletter-issues/${ISSUE}/final-render`]: () => previewPayload({ finalHtml: "<html>final</html>" }),
    });
    const io = captureIo();
    assert.equal(await run(["newsletter", "final-render", ISSUE, "--html-file", file], io), 0, io.errors.join("\n"));
    assert.deepEqual(calls[0].body, { html: "<html>final</html>" });
    assert.match(io.text(), /finalHtml: 18 chars/);
  });

  test("--clear sends clear and no flags is a usage error", async () => {
    const calls = fakePortal({ [`PUT /api/newsletter-issues/${ISSUE}/final-render`]: () => previewPayload() });
    const io = captureIo();
    assert.equal(await run(["newsletter", "final-render", ISSUE, "--clear"], io), 0, io.errors.join("\n"));
    assert.deepEqual(calls[0].body, { clear: true });
    const bare = captureIo();
    assert.notEqual(await run(["newsletter", "final-render", ISSUE], bare), 0);
    assert.match(bare.errors.join("\n"), /Provide at least one flag/);
  });

  test("show prints the stored final render", async () => {
    fakePortal({
      [`GET /api/newsletter-issues/${ISSUE}`]: () => ({
        id: ISSUE, label: "Weekly #303", publicationDate: "2026-11-16", status: "sent", slots: {},
        finalRender: { webViewUrl: WEB_VIEW, subject: SUBJECT, previewText: PREVIEW, updatedAt: "2026-11-18T10:00:00Z", updatedByName: "Orin" },
      }),
    });
    const io = captureIo();
    assert.equal(await run(["newsletter", "show", ISSUE], io), 0, io.errors.join("\n"));
    assert.ok(io.text().includes(`web view: ${WEB_VIEW}`));
    assert.ok(io.text().includes(`subject: ${SUBJECT}`));
    assert.ok(io.text().includes(`preview: ${PREVIEW}`));
    assert.match(io.text(), /html snapshot: none/);
  });
});
