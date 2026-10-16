import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";

import { captureIo, fakePortal, isolateConfig } from "./helpers.mjs";

isolateConfig();
const realFetch = globalThis.fetch;
const { run } = await import("../src/cli.mjs");
const { parseAuthors } = await import("../src/commands/books.mjs");

afterEach(() => {
  globalThis.fetch = realFetch;
});

const speaker = (fields) => ({
  id: "p-1",
  name: "Ada Example",
  slug: "adaexample",
  version: 2,
  ...fields,
});

const book = (fields) => ({
  id: "b-1",
  title: "Synthetic Book",
  authors: [{ name: "Ada Example", slug: "adaexample" }],
  version: 3,
  ...fields,
});

describe("speakers", () => {
  test("list prints one row per profile", async () => {
    const calls = fakePortal({ "GET /api/people": { items: [speaker({})] } });
    const io = captureIo();
    assert.equal(await run(["speakers", "list"], io), 0);
    assert.match(io.text(), /adaexample\s+Ada Example/);
    assert.equal(calls.length, 1);
  });

  test("create sends public fields; update merges links and clears with none", async () => {
    const calls = fakePortal({
      "POST /api/people": ({ body }) => ({ status: 201, body: speaker({ ...body, version: 1 }) }),
      "GET /api/people/p-1": speaker({ links: { github: "ada", website: "https://example.com" } }),
      "PUT /api/people/p-1": ({ body }) => speaker({ ...body }),
    });
    assert.equal(
      await run(["speakers", "create", "--name", "Ada Example", "--slug", "adaexample", "--github", "ada"], captureIo()),
      0,
    );
    assert.deepEqual(calls[0].body, { name: "Ada Example", slug: "adaexample", links: { github: "ada" } });
    assert.equal(await run(["speakers", "create", "--name", "No Slug"], captureIo()), 2);

    const io = captureIo();
    assert.equal(
      await run(["speakers", "update", "p-1", "--twitter", "ada_t", "--website", "none"], io),
      0,
    );
    assert.deepEqual(calls.at(-1).body, {
      links: { github: "ada", twitter: "ada_t" },
      version: 2,
    });
  });
});

describe("books", () => {
  test("parses authors with optional slugs", () => {
    assert.deepEqual(parseAuthors("Jane Doe:jane-doe, Bob"), [
      { name: "Jane Doe", slug: "jane-doe" },
      { name: "Bob" },
    ]);
  });

  test("list prints the week and authors", async () => {
    fakePortal({ "GET /api/books": { items: [book({ startDate: "2027-01-18" })] } });
    const io = captureIo();
    assert.equal(await run(["books", "list"], io), 0);
    assert.match(io.text(), /2027-01-18/);
    assert.match(io.text(), /Ada Example - Synthetic Book/);
  });

  test("create sends authors, dates and links; update upserts links by text", async () => {
    const calls = fakePortal({
      "POST /api/books": ({ body }) => ({ status: 201, body: book({ ...body, version: 1 }) }),
      "GET /api/books/b-1": book({ links: [{ text: "Publisher", url: "https://example.com/p" }] }),
      "PUT /api/books/b-1": ({ body }) => book({ ...body }),
    });
    assert.equal(
      await run(
        ["books", "create", "--title", "Synthetic Book", "--authors", "Ada Example:adaexample",
          "--start-date", "2027-01-18", "--link", "Publisher=https://example.com/p"],
        captureIo(),
      ),
      0,
    );
    assert.deepEqual(calls[0].body, {
      title: "Synthetic Book",
      authors: [{ name: "Ada Example", slug: "adaexample" }],
      startDate: "2027-01-18",
      links: [{ text: "Publisher", url: "https://example.com/p" }],
    });
    assert.equal(await run(["books", "create"], captureIo()), 2);

    assert.equal(
      await run(
        ["books", "update", "b-1", "--link", "Publisher=none", "--link", "GitHub=https://example.com/g"],
        captureIo(),
      ),
      0,
    );
    assert.deepEqual(calls.at(-1).body, {
      links: [{ text: "GitHub", url: "https://example.com/g" }],
      version: 3,
    });
    assert.equal(await run(["books", "update", "b-1", "--link", "Broken"], captureIo()), 2);
  });
});
