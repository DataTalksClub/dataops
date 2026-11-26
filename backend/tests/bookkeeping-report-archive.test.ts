import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { after, before, describe, it } from "node:test";
import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { fromBuffer } from "yauzl";
import { getClient } from "../src/db/client";
import { createDocumentLink, getBookkeepingItem, listBookkeepingItems, putBookkeepingItem } from "../src/db/bookkeeping";
import { createTables, startLocal, stopLocal } from "../scripts/local-dynamodb";
import { attachProof } from "../src/reconcile/monthService";
import { handleBookkeepingReportRoutes } from "../src/routes/bookkeepingReports";
import * as storage from "../src/routes/bookkeepingShared";

const COLUMNS = ["transactionDate", "paidDate", "counterparty", "description", "amount", "currency", "amountEur",
  "vatAmount", "vatCurrency", "category", "entryType", "statementRef"];
const QUOTED_ROW = /^(?:"(?:[^"]|"")*")(?:,"(?:[^"]|"")*")*$/;

// Minimal RFC 4180 reader: quoted cells may hold commas, doubled quotes and line breaks.
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [], cell = "", quoted = false;
  for (let index = 0; index < text.length; index++) {
    const character = text[index];
    if (quoted) {
      if (character === '"' && text[index + 1] === '"') { cell += '"'; index++; }
      else if (character === '"') quoted = false;
      else cell += character;
    } else if (character === '"') quoted = true;
    else if (character === ",") { row.push(cell); cell = ""; }
    else if (character === "\n") { row.push(cell); rows.push(row); row = []; cell = ""; }
    else if (character !== "\r") cell += character;
  }
  if (cell !== "" || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

function unzip(bytes: Buffer): Promise<Record<string, Buffer>> {
  return new Promise((resolve, reject) => fromBuffer(bytes, { lazyEntries: true }, (error, zip) => {
    if (error || !zip) return reject(error);
    const files: Record<string, Buffer> = {};
    zip.on("error", reject);
    zip.on("end", () => resolve(files));
    zip.on("entry", (entry) => zip.openReadStream(entry, (streamError, stream) => {
      if (streamError || !stream) return reject(streamError);
      const chunks: Buffer[] = [];
      stream.on("error", reject);
      stream.on("data", (chunk: Buffer) => chunks.push(chunk));
      stream.on("end", () => {
        files[entry.fileName] = Buffer.concat(chunks);
        zip.readEntry();
      });
    }));
    zip.readEntry();
  }));
}

describe("portal monthly archive", () => {
  let client: DynamoDBDocumentClient;
  let writes = 0, signs = 0, uploads = 0, objectReads = 0;
  const objects = new Map<string, Buffer>();
  let archiveBytes: Buffer | undefined;
  const originalStorage = { s3: storage.s3, signUrl: storage.signUrl, uploadStream: storage.uploadStream };
  const originalBucket = process.env.BOOKKEEPING_DOCUMENTS_BUCKET;
  before(async () => {
    process.env.BOOKKEEPING_DOCUMENTS_BUCKET = "synthetic-bookkeeping-documents";
    const underlying = await getClient(await startLocal());
    await createTables(underlying);
    client = { send: async (command: any) => {
      if (["PutCommand", "UpdateCommand", "DeleteCommand", "TransactWriteCommand"].includes(command.constructor.name)) writes++;
      return underlying.send(command);
    } } as unknown as DynamoDBDocumentClient;
    storage.setBookkeepingStorageForTests({ send: async (command: any) => {
      if (command.constructor.name !== "GetObjectCommand") return {};
      objectReads++;
      const bytes = objects.get(String(command.input.Key));
      if (!bytes) throw new Error(`synthetic object missing: ${command.input.Key}`);
      return { Body: Readable.from([bytes]), VersionId: "synthetic-version" };
    } } as never, async () => { signs++; return "https://invented.example.test/archive"; });
    storage.setBookkeepingArchiveUploaderForTests(async (params: any) => {
      uploads++;
      const chunks: Buffer[] = [];
      for await (const chunk of params.Body) chunks.push(Buffer.from(chunk));
      archiveBytes = Buffer.concat(chunks);
      return { VersionId: "synthetic-version" };
    });
  });
  after(async () => {
    storage.setBookkeepingStorageForTests(originalStorage.s3, originalStorage.signUrl);
    storage.setBookkeepingArchiveUploaderForTests(originalStorage.uploadStream);
    if (originalBucket === undefined) delete process.env.BOOKKEEPING_DOCUMENTS_BUCKET;
    else process.env.BOOKKEEPING_DOCUMENTS_BUCKET = originalBucket;
    await stopLocal();
  });
  const invoke = (path: string, body: unknown = {}) => handleBookkeepingReportRoutes(path, "POST", {
    httpMethod: "POST", path, body: JSON.stringify(body), headers: {},
  }, client);
  const document = async (id: string, fields: Record<string, unknown> = {}) => {
    const bytes = Buffer.from(`%PDF-synthetic-${id}`);
    objects.set(`documents/${id}`, bytes);
    await putBookkeepingItem(client, "document", {
      id, documentType: "invoice", status: "active", originalFilename: `${id}.pdf`, contentType: "application/pdf",
      byteSize: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex"), s3Key: `documents/${id}`, ...fields,
    });
    return { id, bytes };
  };
  const payment = (id: string, row: Record<string, unknown>) =>
    putBookkeepingItem(client, "bookkeeping", { id, currency: "EUR", entryType: "expense", ...row });
  // The readiness gate only exports payments whose source is verified.
  const verify = async (transactionId: string, month: string) => {
    const proof = await document(`arch-proof-${transactionId}`, { documentType: "receipt" });
    await createDocumentLink(client, { documentId: proof.id, transactionId, coverageType: "evidence" });
    await attachProof(client, month, "invented-operator", transactionId, proof.id);
    return proof;
  };
  const statements = async (month: string) => {
    const ids: string[] = [];
    for (const [index, id] of ["invented-archive-business-one", "invented-archive-business-two"].entries()) {
      if (!await getBookkeepingItem(client, "account", id)) await putBookkeepingItem(client, "account", { id, kind: "business", active: true });
      ids.push((await document(`arch-statement-${index}-${month}`, { documentType: "bank-statement", accountId: id, statementMonth: month })).id);
    }
    return ids;
  };
  const reset = () => { writes = signs = uploads = objectReads = 0; archiveBytes = undefined; };
  const counters = () => ({ writes, signs, uploads, objectReads });
  const untouched = { writes: 0, signs: 0, uploads: 0, objectReads: 0 };
  // The ledger and its evidence documents are the financial records an archive must never change.
  const financialRecords = async () => ({
    ledger: await listBookkeepingItems(client, "bookkeeping"),
    documents: (await listBookkeepingItems(client, "document")).filter((item) => item.documentType !== "monthly-report"),
  });
  async function archive(reportId: string, month: string) {
    reset();
    const response = await invoke(`/api/bookkeeping/reports/${reportId}/archive`);
    const files = archiveBytes ? await unzip(archiveBytes) : {};
    return { response, body: JSON.parse(response!.body), files, csv: files[`datatalksclub-${month}.csv`]?.toString("utf8") || "" };
  }
  const byCounterparty = (left: string[], right: string[]) => left[2].localeCompare(right[2]);

  it("archives reportable allocation children with their totals, labels and evidence instead of the parent payment", async () => {
    const month = "2037-03";
    const statementIds = await statements(month);
    const [a1, taxA, a3, taxB, b, plainReceipt] = await Promise.all([
      document("arch-a1"), document("arch-tax-a"), document("arch-a3"), document("arch-tax-b"), document("arch-b"),
      document("arch-plain-receipt", { documentType: "receipt" }),
    ]);
    const parentA = (await payment("invented-archive-parent-a", {
      transactionDate: `${month}-02`, paidDate: `${month}-03`, counterparty: "Synthetic combined payee A", description: "Synthetic tax settlement",
      amount: "60.00", amountEur: "60.00", category: "Taxes", mandatoryKind: "tax_debit", statementRef: "BANK-A 0001",
      allocations: [
        { id: "a1", documentId: a1.id, counterparty: "Synthetic service A1", description: "Service A1", amount: "10.00", amountEur: "10.00", currency: "EUR", category: "Software" },
        { id: "tax-a", documentId: taxA.id, counterparty: "Synthetic tax A", description: "Tax A", amount: "21.00", amountEur: "21.00", currency: "EUR", category: "Taxes" },
        { id: "a3", documentId: a3.id, counterparty: "Synthetic service A3", description: "Service A3", amount: "29.00", amountEur: "29.00", currency: "EUR", category: "Consulting" },
      ],
    })).item;
    const parentB = (await payment("invented-archive-parent-b", {
      transactionDate: `${month}-04`, paidDate: `${month}-04`, counterparty: "Synthetic combined payee B", description: "Synthetic owner draw",
      amount: "70.00", amountEur: "70.00", category: "Owner pay", ownerPayType: "draw", statementRef: "BANK-A 0002",
      allocations: [
        { id: "tax-b", documentId: taxB.id, counterparty: "Synthetic tax B", description: "Tax B", amount: "31.00", amountEur: "31.00", currency: "EUR", category: "Taxes" },
        { id: "b", documentId: b.id, counterparty: "Synthetic service B", description: "Service B", amount: "39.00", amountEur: "39.00", currency: "EUR", category: "Software" },
      ],
    })).item;
    const plain = (await payment("invented-archive-plain", {
      transactionDate: `${month}-05`, paidDate: `${month}-05`, counterparty: "Synthetic plain vendor", description: "Plain service",
      amount: "5.00", category: "Software", statementRef: "BANK-A 0003",
    })).item;
    // Parent-level evidence is the payment's verification; it belongs to no child.
    const parentProofA = await verify(parentA.id, month);
    // A payment booked from its bank statement is verified by the bank row alone
    // and has no parent-level evidence link at all.
    await putBookkeepingItem(client, "statement", {
      recordType: "reconcile-statement", accountId: "finom", period: month, filename: "synthetic-statement.csv",
      from: `${month}-01`, to: `${month}-31`,
      rows: [{ date: `${month}-04`, amount: "-70.00", currency: "EUR", counterparty: "Synthetic combined payee B", reference: "BANK-A 0002" }],
    });
    await createDocumentLink(client, { documentId: plainReceipt.id, transactionId: plain.id, coverageType: "evidence" });
    await attachProof(client, month, "invented-operator", plain.id, plainReceipt.id);

    const snapshot = await invoke("/api/bookkeeping/reports/snapshot", {
      month, privateDocumentIds: [taxA.id, taxB.id, parentProofA.id],
    });
    assert.equal(snapshot.statusCode, 201, snapshot.body);
    const report = JSON.parse(snapshot.body).report;
    assert.equal(report.snapshotVersion, 2, "the snapshot stays an ID list; nothing is migrated");
    assert.deepEqual([...report.transactionIds].sort(), [parentA.id, parentB.id, plain.id].sort(), "transaction references stay the three ledger payments");
    assert.deepEqual([...report.documentIds].sort(), [a1.id, a3.id, b.id, plainReceipt.id, ...statementIds].sort(),
      "document references are the reportable children's own documents, the plain receipt and the statements");
    assert.equal(report.reconciliation.transactionCount, 4, "the snapshot counts the rows the archive lists");
    assert.equal(report.reconciliation.excludedTransactionCount, 2);
    assert.equal(JSON.parse(snapshot.body).warnings.missingEvidence, 0, "each reportable child is evidenced by its own allocation document");

    const before = await financialRecords();
    const result = await archive(report.id, month);
    assert.equal(result.response.statusCode, 201, result.response.body);
    assert.equal(uploads, 1);
    assert.deepEqual(Object.keys(result.files).sort(), [
      `datatalksclub-${month}.csv`,
      ...[a1, a3, b, plainReceipt, ...statementIds.map((id) => ({ id }))].map(({ id }) => `documents/${id}.pdf`),
    ].sort(), "evidence is the reportable children's own documents, the plain receipt and the statements");
    for (const { id, bytes } of [a1, a3, b, plainReceipt])
      assert.equal(result.files[`documents/${id}.pdf`]?.toString(), bytes.toString(), `${id} keeps its own bytes`);

    const rows = parseCsv(result.csv);
    assert.deepEqual(rows[0], COLUMNS, "the archive keeps the twelve-column ledger format and its header line");
    assert.ok(result.csv.split("\n").filter(Boolean).slice(1).every((line) => QUOTED_ROW.test(line)), "every data cell stays quoted");
    const listed = rows.slice(1);
    assert.equal(listed.length, 4);
    assert.equal(listed.reduce((sum, row) => sum + Math.round(Number(row[4]) * 100), 0) / 100, 83,
      "10 + 29 + 39 + 5: the parent totals never reach the accountant");
    assert.deepEqual([...listed].sort(byCounterparty), [
      [`${month}-05`, `${month}-05`, "Synthetic plain vendor", "Plain service", "5.00", "EUR", "", "", "", "Software", "expense", "BANK-A 0003"],
      [`${month}-02`, `${month}-03`, "Synthetic service A1", "Service A1", "10.00", "EUR", "10.00", "", "", "Software", "expense", "BANK-A 0001"],
      [`${month}-02`, `${month}-03`, "Synthetic service A3", "Service A3", "29.00", "EUR", "29.00", "", "", "Consulting", "expense", "BANK-A 0001"],
      [`${month}-04`, `${month}-04`, "Synthetic service B", "Service B", "39.00", "EUR", "39.00", "", "", "Software", "expense", "BANK-A 0002"],
    ].sort(byCounterparty), "child rows carry the payment's dates, direction and bank reference with each child's own label, amount and category");
    assert.ok(listed.findIndex((row) => row[2] === "Synthetic service A1") < listed.findIndex((row) => row[2] === "Synthetic service A3"),
      "children of one payment keep their saved allocation order");
    for (const withheld of ["Synthetic combined payee", "Synthetic tax settlement", "Synthetic owner draw", "Synthetic tax A", "Synthetic tax B",
      "60.00", "70.00", "21.00", "31.00", '"Taxes"', '"Owner pay"'])
      assert.equal(result.csv.includes(withheld), false, `the archive leaves out ${withheld}`);
    assert.deepEqual(await financialRecords(), before, "generating the archive changes no ledger row and no evidence document");

    const stored = await getBookkeepingItem(client, "report", report.id);
    assert.equal(stored?.status, "generated");
    assert.equal(stored?.snapshotVersion, 2);
    assert.deepEqual(stored?.transactionIds, report.transactionIds, "the report keeps its transaction references");
    assert.deepEqual(stored?.documentIds, report.documentIds, "the report keeps its document references");
    assert.equal((await getBookkeepingItem(client, "document", String(stored?.archiveDocumentId)))?.documentType, "monthly-report");

    const cached = await archive(report.id, month);
    assert.equal(cached.response.statusCode, 200);
    assert.equal(cached.body.duplicate, true);
    assert.deepEqual(counters(), { ...untouched, signs: 1 }, "an archived report is served as stored and never rebuilt");
  });

  it("keeps payment direction, cash dates and cell format on children of a converted foreign-currency payment", async () => {
    const month = "2037-05";
    await statements(month);
    // The third child's invoice upload never completed, so it is not an active document.
    const [first, second, pending] = await Promise.all([
      document("arch-usd-first"), document("arch-usd-second"), document("arch-usd-pending", { status: "pending" }),
    ]);
    const parent = (await payment("invented-archive-usd", {
      transactionDate: `${month}-10`, paidDate: `${month}-11`, counterparty: "Synthetic card settlement", description: "Combined synthetic income",
      entryType: "income", amount: "100.00", amountEur: "90.00", currency: "USD", vatAmount: "19.00", vatCurrency: "USD", statementRef: "CARD 77",
      allocations: [
        { id: "first", documentId: first.id, counterparty: 'Synthetic client "one"', description: 'Talk "Q1",\nretainer', amount: "60.00", currency: "USD", amountEur: "54.00",
          vatAmount: "11.40", vatCurrency: "USD", category: "Work-related", transactionDate: "2037-04-20", paidDate: "2037-04-28" },
        { id: "second", documentId: second.id, counterparty: "Synthetic client two", description: "Workshop two", amount: "25.00", currency: "USD", amountEur: "22.50", category: "Work-related" },
        { id: "third", documentId: pending.id, counterparty: "Synthetic client three", description: "Workshop three", amount: "15.00", currency: "USD", amountEur: "13.50", category: "Work-related" },
      ],
    })).item;
    await verify(parent.id, month);
    const snapshot = await invoke("/api/bookkeeping/reports/snapshot", { month });
    assert.equal(snapshot.statusCode, 201, snapshot.body);
    assert.equal(JSON.parse(snapshot.body).warnings.missingEvidence, 1, "a child whose allocation document is unavailable is the one missing evidence");
    const result = await archive(JSON.parse(snapshot.body).report.id, month);
    assert.equal(result.response.statusCode, 201, result.response.body);
    assert.deepEqual(Object.keys(result.files).sort(), [
      `datatalksclub-${month}.csv`, `documents/${first.id}.pdf`, `documents/${second.id}.pdf`,
      ...[0, 1].map((index) => `documents/arch-statement-${index}-${month}.pdf`),
    ].sort(), "only active allocation documents ship");
    assert.deepEqual(parseCsv(result.csv).slice(1), [
      [`${month}-10`, `${month}-11`, 'Synthetic client "one"', 'Talk "Q1",\nretainer', "60.00", "USD", "54.00", "11.40", "USD", "Work-related", "income", "CARD 77"],
      [`${month}-10`, `${month}-11`, "Synthetic client two", "Workshop two", "25.00", "USD", "22.50", "", "", "Work-related", "income", "CARD 77"],
      [`${month}-10`, `${month}-11`, "Synthetic client three", "Workshop three", "15.00", "USD", "13.50", "", "", "Work-related", "income", "CARD 77"],
    ], "children use the payment's cash dates, unsigned amounts with the payment's entry type, their own EUR value and VAT, and the payment's bank reference");
    assert.equal(result.csv.includes("2037-04"), false, "invoice-level allocation dates never replace the payment date");
    assert.equal(result.csv.includes("19.00"), false, "the parent's VAT total is not copied onto a child");
    assert.equal(result.csv.includes("100.00") || result.csv.includes("90.00"), false, "the parent total is not listed beside its children");
    assert.match(result.csv, /"Synthetic client ""one""","Talk ""Q1"",\nretainer","60.00"/, "cells stay quoted with doubled quotes and kept line breaks");
    assert.ok(result.csv.endsWith("\n") && !result.csv.includes("\r"), "line endings stay as contracted");
  });

  it("renders an older ID-list report by child without rewriting the snapshot or the ledger", async () => {
    const month = "2037-06";
    await statements(month);
    const [reportable, exempt] = await Promise.all([document("arch-old-reportable"), document("arch-old-exempt")]);
    // A snapshot prepared while classification ran on the parent: the payment was
    // selected and counted as one ordinary transaction.
    await payment("invented-archive-old-parent", {
      transactionDate: `${month}-07`, paidDate: `${month}-07`, counterparty: "Synthetic old payee", description: "Old combined payment",
      amount: "50.00", category: "Software", statementRef: "BANK-A 0007",
      allocations: [
        { id: "old-reportable", documentId: reportable.id, counterparty: "Synthetic old service", description: "Old service", amount: "18.00", amountEur: "18.00", currency: "EUR", category: "Software" },
        { id: "old-exempt", documentId: exempt.id, counterparty: "Synthetic old tax", description: "Old tax", amount: "32.00", amountEur: "32.00", currency: "EUR", category: "Taxes" },
      ],
    });
    await verify("invented-archive-old-parent", month);
    const storedBefore = (await putBookkeepingItem(client, "report", {
      id: "invented-archive-old-report", month, status: "ready", snapshotVersion: 2,
      transactionIds: ["invented-archive-old-parent"], documentIds: [reportable.id, exempt.id],
      reconciliation: { transactionCount: 1, excludedTransactionCount: 0, documentCount: 2, businessStatementCount: 2 },
    })).item;
    const before = await financialRecords();
    const result = await archive(storedBefore.id, month);
    assert.equal(result.response.statusCode, 201, result.response.body);
    assert.deepEqual(parseCsv(result.csv).slice(1), [
      [`${month}-07`, `${month}-07`, "Synthetic old service", "Old service", "18.00", "EUR", "18.00", "", "", "Software", "expense", "BANK-A 0007"],
    ], "the exempt child's share is no longer shipped inside a parent total");
    assert.ok(Object.keys(result.files).includes(`documents/${exempt.id}.pdf`), "the documents a stored snapshot selected are served as stored");
    assert.deepEqual(await financialRecords(), before);
    const stored = await getBookkeepingItem(client, "report", storedBefore.id);
    assert.equal(stored?.status, "generated");
    assert.equal(stored?.snapshotVersion, 2, "the stored snapshot is not migrated or re-versioned");
    assert.deepEqual(stored?.transactionIds, storedBefore.transactionIds);
    assert.deepEqual(stored?.documentIds, storedBefore.documentIds);
    assert.deepEqual(stored?.reconciliation, storedBefore.reconciliation, "the recorded counts stay the historical record");
  });

  it("refuses to archive a snapshot whose payment has no reportable child left, before any write", async () => {
    const month = "2037-07";
    await statements(month);
    const exempt = await document("arch-stale-exempt");
    await payment("invented-archive-stale-parent", {
      transactionDate: `${month}-08`, paidDate: `${month}-08`, counterparty: "Synthetic stale payee", description: "Stale combined payment",
      amount: "12.00", category: "Software",
      allocations: [{ id: "stale-exempt", documentId: exempt.id, counterparty: "Synthetic stale tax", description: "Stale tax", amount: "12.00", amountEur: "12.00", currency: "EUR", category: "Taxes" }],
    });
    await verify("invented-archive-stale-parent", month);
    const stored = (await putBookkeepingItem(client, "report", {
      id: "invented-archive-stale-report", month, status: "ready", snapshotVersion: 2,
      transactionIds: ["invented-archive-stale-parent"], documentIds: [exempt.id],
      reconciliation: { transactionCount: 1, excludedTransactionCount: 0, documentCount: 1, businessStatementCount: 2 },
    })).item;
    const before = await financialRecords();
    const result = await archive(stored.id, month);
    assert.equal(result.response.statusCode, 409, result.response.body);
    assert.equal(result.body.reportPeriod, month);
    assert.deepEqual(result.body.staleTransactionIds, ["invented-archive-stale-parent"]);
    assert.match(result.body.error, /reportable invoice allocation/i);
    assert.deepEqual(counters(), untouched);
    assert.deepEqual(await getBookkeepingItem(client, "report", stored.id), stored);
    assert.deepEqual(await financialRecords(), before);
  });

  it("refuses to archive a snapshot with a foreign-currency child that has no EUR value, before any write", async () => {
    const month = "2037-08";
    await statements(month);
    const child = await document("arch-unconverted-child");
    await payment("invented-archive-unconverted-parent", {
      transactionDate: `${month}-09`, paidDate: `${month}-09`, counterparty: "Synthetic unconverted payee", description: "Unconverted combined payment",
      amount: "20.00", amountEur: "18.00", currency: "USD",
      allocations: [{ id: "unconverted-child", documentId: child.id, counterparty: "Synthetic unconverted service", description: "Unconverted service", amount: "20.00", currency: "USD", category: "Software" }],
    });
    await verify("invented-archive-unconverted-parent", month);
    const stored = (await putBookkeepingItem(client, "report", {
      id: "invented-archive-unconverted-report", month, status: "ready", snapshotVersion: 2,
      transactionIds: ["invented-archive-unconverted-parent"], documentIds: [child.id],
      reconciliation: { transactionCount: 1, excludedTransactionCount: 0, documentCount: 1, businessStatementCount: 2 },
    })).item;
    const result = await archive(stored.id, month);
    assert.equal(result.response.statusCode, 409, result.response.body);
    assert.equal(result.body.reportPeriod, month);
    assert.deepEqual(result.body.unconvertedTransactionIds, ["invented-archive-unconverted-parent"]);
    assert.match(result.body.error, /no EUR value; convert them before preparing the package/);
    assert.deepEqual(counters(), untouched);
    assert.equal((await getBookkeepingItem(client, "report", stored.id))?.status, "ready");
  });
});
