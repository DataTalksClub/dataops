import assert from "node:assert/strict";
import { test } from "node:test";

import { fetchAllWorkPages } from "../src/core/workspace.js";

test("follows nextCursor pages until the collection is exhausted", async () => {
  const pages = [
    { tasks: [{ id: "t1" }, { id: "t2" }], nextCursor: "abc" },
    { tasks: [{ id: "t3" }], nextCursor: "def" },
    { tasks: [{ id: "t4" }] },
  ];
  const requested = [];
  const request = async (url) => {
    requested.push(url);
    return pages[requested.length - 1];
  };

  const items = await fetchAllWorkPages({ request, path: "/api/tasks?status=done" });

  assert.deepEqual(items.map((task) => task.id), ["t1", "t2", "t3", "t4"]);
  assert.deepEqual(requested, [
    "/api/tasks?status=done",
    "/api/tasks?status=done&cursor=abc",
    "/api/tasks?status=done&cursor=def",
  ]);
});

test("stops at maxPages even when the server keeps returning cursors", async () => {
  let calls = 0;
  const request = async () => {
    calls += 1;
    return { tasks: [{ id: `t${calls}` }], nextCursor: `cursor-${calls}` };
  };

  const items = await fetchAllWorkPages({ request, path: "/api/tasks?status=done", maxPages: 3 });

  assert.equal(calls, 3);
  assert.deepEqual(items.map((task) => task.id), ["t1", "t2", "t3"]);
});

test("a page without tasks contributes nothing and ends pagination", async () => {
  const request = async () => ({});

  const items = await fetchAllWorkPages({ request, path: "/api/tasks?status=done" });

  assert.deepEqual(items, []);
});

test("uses workApiUrl when provided and handles paths without query strings", async () => {
  const pages = [
    { tasks: [{ id: "t1" }], nextCursor: "c1" },
    { tasks: [{ id: "t2" }] },
  ];
  const requested = [];
  const request = async (url) => {
    requested.push(String(url));
    return pages[requested.length - 1];
  };
  const workApiUrl = (p) => new URL(p, "https://portal.example");

  const items = await fetchAllWorkPages({ request, workApiUrl, path: "/api/tasks" });

  assert.deepEqual(items.map((task) => task.id), ["t1", "t2"]);
  assert.deepEqual(requested, [
    "https://portal.example/api/tasks",
    "https://portal.example/api/tasks?cursor=c1",
  ]);
});
