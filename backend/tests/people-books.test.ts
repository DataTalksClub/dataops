import { before, after, describe, it } from "node:test";
import assert from "node:assert";
import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { handler } from "../src/handler";
import { createTables, startLocal, stopLocal } from "../scripts/local-dynamodb";
import { getClient } from "../src/db/client";

const invoke = (method: string, path: string, body?: unknown) =>
  handler(
    { httpMethod: method, path, headers: {}, queryStringParameters: {}, body: body === undefined ? null : JSON.stringify(body) },
    {},
  );
const data = (response: any) => JSON.parse(response.body);

describe("people and books registers", () => {
  let client: DynamoDBDocumentClient;
  before(async () => {
    client = await getClient(await startLocal());
    await createTables(client);
  });
  after(stopLocal);

  it("creates, reads, updates with versions, and deletes speaker profiles", async () => {
    const created = await invoke("POST", "/api/people", {
      name: "Ada Example",
      slug: "adaexample",
      bioShort: "A synthetic speaker.",
      bio: "A synthetic speaker bio.",
      photoUrl: "https://example.com/ada.jpg",
      links: { github: "adaexample", website: "https://example.com" },
    });
    assert.equal(created.statusCode, 201, created.body);
    assert.equal(data(created).version, 1);

    const read = data(await invoke("GET", `/api/people/${data(created).id}`));
    assert.equal(read.name, "Ada Example");
    assert.equal((await invoke("GET", "/api/people/nope")).statusCode, 404);

    const listed = data(await invoke("GET", "/api/people"));
    assert.equal(listed.items.length, 1);

    const clash = await invoke("POST", "/api/people", { name: "Ada Clone", slug: "adaexample" });
    assert.equal(clash.statusCode, 409);

    const bad = await invoke("POST", "/api/people", { name: "No Slug" });
    assert.equal(bad.statusCode, 400);
    const badLink = await invoke("POST", "/api/people", {
      name: "Bad Link",
      slug: "badlink",
      links: { myspace: "https://example.com" },
    });
    assert.equal(badLink.statusCode, 400);

    const updated = data(
      await invoke("PUT", `/api/people/${read.id}`, {
        version: 1,
        links: { github: "ada-example", website: "https://example.com" },
      }),
    );
    assert.equal(updated.version, 2, JSON.stringify(updated));
    assert.equal(updated.links.github, "ada-example", "PUT replaces links wholesale; the CLI merges");
    const stale = await invoke("PUT", `/api/people/${read.id}`, { version: 1, bio: "stale" });
    assert.equal(stale.statusCode, 409);

    const cleared = data(
      await invoke("PUT", `/api/people/${read.id}`, { version: 2, photoUrl: null, bio: null }),
    );
    assert.equal(cleared.photoUrl, undefined);
    assert.equal(
      (await invoke("DELETE", `/api/people/${read.id}`, { version: 1 })).statusCode,
      409,
    );
    assert.equal((await invoke("DELETE", `/api/people/${read.id}`, { version: 3 })).statusCode, 204);
    assert.equal((await invoke("GET", `/api/people/${read.id}`)).statusCode, 404);
  });

  it("creates, reads, updates with versions, and deletes books", async () => {
    const created = await invoke("POST", "/api/books", {
      title: "Synthetic Book",
      slug: "synthetic-book",
      authors: [{ name: "Ada Example", slug: "adaexample" }],
      description: "A synthetic book description.",
      startDate: "2027-01-18",
      endDate: "2027-01-22",
      links: [{ text: "Publisher", url: "https://example.com/book" }],
      coverUrl: "https://example.com/cover.jpg",
    });
    assert.equal(created.statusCode, 201, created.body);
    assert.equal(data(created).version, 1);

    const read = data(await invoke("GET", `/api/books/${data(created).id}`));
    assert.equal(read.title, "Synthetic Book");
    assert.equal((await invoke("GET", "/api/books/nope")).statusCode, 404);
    assert.equal(data(await invoke("GET", "/api/books")).items.length, 1);

    const clash = await invoke("POST", "/api/books", { title: "Clone", authors: [{ name: "Clone" }], slug: "synthetic-book" });
    assert.equal(clash.statusCode, 409);

    for (const [body, message] of [
      [{ title: "No Authors" }, /authors/],
      [{ title: "Bad Date", authors: [{ name: "A" }], startDate: "2027-13-01" }, /startDate/],
      [{ title: "Bad Range", authors: [{ name: "A" }], startDate: "2027-02-01", endDate: "2027-01-01" }, /range/],
      [{ title: "Bad Link", authors: [{ name: "A" }], links: [{ text: "X", url: "http://insecure.example" }] }, /links/],
      [{ title: "Bad Cover", authors: [{ name: "A" }], coverUrl: "notaurl" }, /coverUrl/],
    ] as Array<[Record<string, unknown>, RegExp]>) {
      const response = await invoke("POST", "/api/books", body);
      assert.equal(response.statusCode, 400, JSON.stringify(body));
      assert.match(data(response).error, message);
    }

    const updated = data(
      await invoke("PUT", `/api/books/${read.id}`, { version: 1, endDate: "2027-01-23" }),
    );
    assert.equal(updated.endDate, "2027-01-23");
    assert.equal((await invoke("PUT", `/api/books/${read.id}`, { version: 1, title: "stale" })).statusCode, 409);
    assert.equal((await invoke("DELETE", `/api/books/${read.id}`, { version: 2 })).statusCode, 204);
    assert.equal(data(await invoke("GET", "/api/books")).items.length, 0);
  });
});
