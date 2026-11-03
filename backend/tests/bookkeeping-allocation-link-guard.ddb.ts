// Run against DynamoDB Local through test-sponsor-finance-transaction.sh.
import { before, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { handleBookkeepingTransactionRoutes } from "../src/routes/bookkeepingTransactions";
import { createTables } from "../scripts/local-dynamodb";
import { getClient } from "../src/db/client";
import { putBookkeepingItem } from "../src/db/bookkeeping";
import { handler } from "../src/handler";

let client: Awaited<ReturnType<typeof getClient>>;
const invoke = (method: string, path: string, body?: unknown) =>
  handler({ httpMethod: method, path, headers: {}, body: body === undefined ? null : JSON.stringify(body),
    queryStringParameters: null }, {});

before(async () => {
  assert.ok(process.env.DYNAMODB_ENDPOINT);
  client = await getClient();
  await createTables(client);
});

async function fixture(label: string) {
  const document = (await putBookkeepingItem(client, "document", {
    documentType: "invoice", status: "active", originalFilename: "synthetic.pdf",
    contentType: "application/pdf", byteSize: 10,
    sha256: createHash("sha256").update(`synthetic-${label}`).digest("hex"),
    s3Key: `documents/synthetic-${label}`,
  })).item;
  const body = { transactionDate: "2025-01-01", counterparty: "Synthetic", description: label,
    amount: "10.00", currency: "EUR", sourceType: "manual", entryType: "expense" };
  const one = await invoke("POST", "/api/bookkeeping/transactions", body);
  const two = await invoke("POST", "/api/bookkeeping/transactions", { ...body, description: label + " other" });
  assert.equal(one.statusCode, 201, one.body);
  assert.equal(two.statusCode, 201, two.body);
  return { document, first: JSON.parse(one.body), second: JSON.parse(two.body) };
}

const allocate = (parent: any, document: any) => invoke(
  "PUT", `/api/bookkeeping/transactions/${parent.id}/allocations`,
  { expectedUpdatedAt: parent.updatedAt, reason: "synthetic test",
    allocations: [{ documentId: document.id, counterparty: "Synthetic", description: "Synthetic", amount: "10.00" }] },
);
const link = (parent: any, document: any) => invoke("POST", "/api/bookkeeping/links",
  { transactionId: parent.id, documentId: document.id, coverageType: "evidence" });

it("protects allocated evidence, permits same-parent replay and releases it on clear", async () => {
  const { document, first, second } = await fixture("allocated-link");
  const allocated = await allocate(first, document);
  assert.equal(allocated.statusCode, 200, allocated.body);
  assert.equal((await link(first, document)).statusCode, 200);
  assert.equal((await link(second, document)).statusCode, 409);
  const read = await invoke("GET", `/api/bookkeeping/transactions/${first.id}/allocations`);
  const linkId = JSON.parse(read.body).links[0].id;
  assert.equal((await invoke("DELETE", `/api/bookkeeping/links/${linkId}`)).statusCode, 409);
  const current = JSON.parse(allocated.body);
  const cleared = await invoke("DELETE", `/api/bookkeeping/transactions/${first.id}/allocations`,
    { expectedUpdatedAt: current.updatedAt, reason: "synthetic clear" });
  assert.equal(cleared.statusCode, 200, cleared.body);
  assert.equal((await link(second, document)).statusCode, 201);
});

it("prevents a normal evidence link racing an allocation on another payment", async () => {
  const { document, first, second } = await fixture("concurrent-link");
  const [allocation, evidence] = await Promise.all([allocate(first, document), link(second, document)]);
  assert.ok(
    (allocation.statusCode === 200 && evidence.statusCode === 409)
      || (allocation.statusCode === 409 && evidence.statusCode === 201),
    `unexpected statuses allocation=${allocation.statusCode}, evidence=${evidence.statusCode}`,
  );
});

it("also blocks a different document with the same invoice bytes", async () => {
  const { document, first, second } = await fixture("duplicate-bytes");
  const duplicate = (await putBookkeepingItem(client, "document", {
    documentType: "invoice", status: "active", originalFilename: "synthetic-copy.pdf",
    contentType: "application/pdf", byteSize: 10,
    sha256: createHash("sha256").update("synthetic-duplicate-bytes").digest("hex"),
    s3Key: "documents/synthetic-copy",
  })).item;
  const result = await allocate(first, document);
  assert.equal(result.statusCode, 200, result.body);
  assert.equal((await link(second, duplicate)).statusCode, 409);
});

it("preserves a manual same-parent link after allocation is cleared", async () => {
  const { document, first, second } = await fixture("manual-evidence");
  const firstLink = await link(first, document);
  assert.equal(firstLink.statusCode, 201, firstLink.body);
  const allocated = await allocate(first, document);
  assert.equal(allocated.statusCode, 200, allocated.body);
  const linkId = JSON.parse(firstLink.body).id;
  assert.equal((await invoke("DELETE", `/api/bookkeeping/links/${linkId}`)).statusCode, 409);
  const cleared = await invoke("DELETE", `/api/bookkeeping/transactions/${first.id}/allocations`,
    { expectedUpdatedAt: JSON.parse(allocated.body).updatedAt, reason: "synthetic clear" });
  assert.equal(cleared.statusCode, 200, cleared.body);
  assert.equal((await invoke("DELETE", `/api/bookkeeping/links/${linkId}`)).statusCode, 204);
  assert.equal((await link(second, document)).statusCode, 201);
});

it("serializes allocation and a concurrent link to a duplicate PDF", async () => {
  const { document, first, second } = await fixture("concurrent-duplicate");
  const duplicate = (await putBookkeepingItem(client, "document", {
    documentType: "invoice", status: "active", originalFilename: "synthetic-copy.pdf",
    contentType: "application/pdf", byteSize: 10,
    sha256: createHash("sha256").update("synthetic-concurrent-duplicate").digest("hex"),
    s3Key: "documents/synthetic-copy-concurrent",
  })).item;
  const [allocation, evidence] = await Promise.all([allocate(first, document), link(second, duplicate)]);
  assert.ok(
    (allocation.statusCode === 200 && evidence.statusCode === 409)
      || (allocation.statusCode === 409 && evidence.statusCode === 201),
    `unexpected statuses allocation=${allocation.statusCode}, evidence=${evidence.statusCode}`,
  );
});

it("rejects an allocation when a duplicate PDF is linked after its validation scan", async () => {
  const { document, first, second } = await fixture("interleaved-duplicate");
  const duplicate = (await putBookkeepingItem(client, "document", {
    documentType: "invoice", status: "active", originalFilename: "synthetic-copy.pdf",
    contentType: "application/pdf", byteSize: 10,
    sha256: createHash("sha256").update("synthetic-interleaved-duplicate").digest("hex"),
    s3Key: "documents/synthetic-interleaved-copy",
  })).item;
  let reached!: () => void;
  let release!: () => void;
  const arrived = new Promise<void>((resolve) => { reached = resolve; });
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const intercepted = new Proxy(client, {
    get(target, property) {
      if (property === "send") return async (command: any) => {
        if (command instanceof TransactWriteCommand && command.input.TransactItems?.some(
          (item: any) => String(item.Put?.Item?.PK || "").startsWith("ALLOCATION-SOURCE-CLAIM#"),
        )) {
          reached();
          await gate;
        }
        return (target as any).send(command);
      };
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const path = `/api/bookkeeping/transactions/${first.id}/allocations`;
  const body = { expectedUpdatedAt: first.updatedAt, reason: "synthetic interleaving",
    allocations: [{ documentId: document.id, counterparty: "Synthetic", description: "Synthetic", amount: "10.00" }] };
  const pending = handleBookkeepingTransactionRoutes(path, "PUT",
    { httpMethod: "PUT", path, headers: {}, body: JSON.stringify(body), queryStringParameters: null }, intercepted);
  try {
    await Promise.race([arrived, new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("allocation did not reach its atomic write")), 10000))]);
    const linked = await link(second, duplicate);
    assert.equal(linked.statusCode, 201, linked.body);
  } finally {
    release();
  }
  const result = await pending;
  assert.equal(result?.statusCode, 409, result?.body);
});
