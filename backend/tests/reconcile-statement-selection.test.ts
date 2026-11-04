import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { GetCommand, ScanCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { createTables, startLocal, stopLocal } from "../scripts/local-dynamodb";
import { getClient } from "../src/db/client";
import { getMonth } from "../src/reconcile/monthService";
import { listStatementHistory, listStatements, saveStatement, type StatementRecord } from "../src/reconcile/service";
import { prepareStatementImport, statementPackageSources, verifiedStatementRecord } from "../src/reconcile/statementImport";
import { defaultStatementSelection, selectedStatementRecords, statementDifferences } from "../src/reconcile/statementSelection";
import { setStatementSourceReaderForTests } from "../src/reconcile/statementSource";
import { setStatementPdfTextForTests } from "../src/reconcile/statementIntake";
import type { ParsedStatement } from "../src/reconcile/parsers";
import { parseRevolutPdfText } from "../src/reconcile/pdfLayouts";

const HEADER_ACCOUNT = createHash("sha256").update("EX0000000000").digest("hex").slice(0, 24);
const parsed = (period = "2028-03", account = HEADER_ACCOUNT): ParsedStatement => ({
  rows: [{ date: `${period}-12`, amount: "-23.50", currency: "EUR", counterparty: "Example Hosting" }],
  period: { from: `${period}-01`, to: `${period}-31` }, issueDate: "2028-04-05", bankAccounts: { "main|EUR": account },
  openingBalances: [{ asOf: `${period}-01`, amount: "100.00", currency: "EUR" }],
  balances: [{ asOf: `${period}-31`, amount: "76.50", currency: "EUR" }], warnings: [],
});
const source = (id: string) => ({ documentId: id, contentType: "text/plain", filename: "invented-source.txt" });
const record = (id: string, account: string, from = "2028-03-01", to = "2028-03-31"): StatementRecord => ({
  ...parsed("2028-03", account), id, recordType: "reconcile-statement", accountId: "finom", period: "2028-03", from, to,
  createdAt: id, updatedAt: id,
});

describe("statement selection and counted differences", () => {
  it("retains the first source, separate actual accounts, and nonoverlapping parts", () => {
    const records = [record("a", "one"), record("b", "one"), record("c", "two"), record("d", "three", "2028-03-01", "2028-03-15"), record("e", "three", "2028-03-16", "2028-03-31")];
    assert.deepEqual(selectedStatementRecords(records, defaultStatementSelection(records)).map((item) => item.id), ["a", "c", "d", "e"]);
    const selected = defaultStatementSelection([records[1]]);
    assert.deepEqual(selectedStatementRecords(records, selected).map((item) => item.id), ["b"], "explicit selection outranks earliest issue/source");
  });
  it("compares a multiset of operations and balances independently of issue date and source bytes", () => {
    const old = record("a", "one"), next = record("b", "one");
    next.issueDate = "2028-04-09";
    assert.equal(statementDifferences([old], next).identical, true);
    next.rows = [...next.rows, { ...next.rows[0] }];
    assert.equal(statementDifferences([old], next).added[0].count, 1);
    next.rows = [...old.rows]; next.balances![0] = { ...next.balances![0], amount: "75.50" };
    assert.equal(statementDifferences([old], next).balancesChanged, true);
  });
});

describe("atomic statement import preview", () => {
  let client: DynamoDBDocumentClient;
  before(async () => { client = await getClient(await startLocal()); await createTables(client); });
  after(async () => { setStatementSourceReaderForTests(); setStatementPdfTextForTests(); await stopLocal(); });
  it("warns for identical uploads, changes nothing by default, and requires a fresh digest to replace", async () => {
    await prepareStatementImport(client, source("first"), "finom", parsed(), {});
    const preview = await prepareStatementImport(client, source("second"), "finom", { ...parsed(), issueDate: "2028-04-08" }, {});
    assert.equal(preview.committed, false);
    assert.equal(preview.preview.replacements[0].difference.identical, true);
    assert.equal((await listStatementHistory(client)).length, 1);
    await assert.rejects(prepareStatementImport(client, source("second"), "finom", parsed(), { replace: true, previewDigest: "stale" }), /stale|changed/);
    const result = await prepareStatementImport(client, source("second"), "finom", { ...parsed(), issueDate: "2028-04-08" }, { replace: true, previewDigest: preview.preview.digest });
    assert.equal(result.committed, true);
    assert.equal((await listStatementHistory(client)).length, 2, "raw source references retained in historical records");
    assert.equal((await listStatements(client)).length, 1);
    assert.equal((await listStatements(client))[0].documentId, "second");
  });
  it("keeps different actual accounts and atomically imports multiple wallets as one source batch", async () => {
    const next = parsed("2028-05"); next.period!.to = "2028-05-31";
    next.rows.push({ date: "2028-05-12", amount: "8.00", currency: "USD", wallet: "USD", counterparty: "Example Client" });
    next.bankAccounts!["USD|USD"] = "invented-usd-wallet";
    next.balances.push({ currency: "USD", wallet: "USD", amount: "18.00", asOf: "2028-05-31" });
    const result = await prepareStatementImport(client, source("multi-wallet"), "revolut", next, {});
    assert.equal(result.statements.length, 1);
    assert.equal(Object.keys((await getMonth(client, "2028-05")).statementSelection!).length, 2);
    const repeat = await prepareStatementImport(client, source("multi-wallet-again"), "revolut", next, { preview: true });
    assert.equal(repeat.preview.replacements.length, 1);
    assert.equal(repeat.preview.replacements[0].difference.identical, true);
    const before = await getMonth(client, "2028-03");
    const historyCount = (await listStatementHistory(client)).length;
    await assert.rejects(prepareStatementImport(client, source("different-account"), "finom", parsed("2028-03", "invented-independent-account"), {}), (error: any) => error.statusCode === 409 && error.identityConflicts.some((item: any) => item.kind === "operation"));
    const differentOperations = parsed("2028-03", "invented-independent-account");
    differentOperations.rows[0] = { ...differentOperations.rows[0], amount: "-24.50", counterparty: "Example Other Hosting" };
    differentOperations.balances[0] = { ...differentOperations.balances[0], amount: "75.50" };
    await assert.rejects(prepareStatementImport(client, source("different-account-balances"), "finom", differentOperations, { preview: true }), (error: any) => error.statusCode === 409 && error.identityConflicts.every((item: any) => item.kind === "balance"));
    assert.deepEqual(await getMonth(client, "2028-03"), before);
    assert.equal((await listStatementHistory(client)).length, historyCount, "collision must not persist another source or selection");
  });
  it("rejects missing account identity and uses the actual PDF header over historical metadata", async () => {
    await assert.rejects(prepareStatementImport(client, source("unidentified"), "finom", { ...parsed(), bankAccounts: {} }, {}), /identifier/);
    const text = `Example Widgets GmbH   Statement of account
Issue date:   05.04.2028
From:   01.03.2028
To:   31.03.2028
Opening balance:   100,00 €
Closing balance:   76,50 €
IBAN: EX00 0000 0000
Completed   Description   Pay in/out
12.03.2028   Example Hosting
- 23,50 €
FINOM, a limited liability company registered with the Netherlands Chamber of Commerce.`;
    setStatementSourceReaderForTests(async () => ({ bytes: Buffer.from("%PDF-synthetic"), contentType: "application/pdf", filename: "invented.pdf" }));
    setStatementPdfTextForTests(async () => text);
    const verified = await verifiedStatementRecord(client, { ...record("old-header", "invented"), filename: "invented.pdf", documentId: "invented", to: "2028-03-30" });
    assert.equal(verified.to, "2028-03-31"); assert.equal(verified.issueDate, "2028-04-05");
    setStatementSourceReaderForTests(); setStatementPdfTextForTests();
  });
  it("retains unaffected wallets when only one wallet is explicitly replaced", async () => {
    const original = parsed("2028-07");
    original.rows.push({ date: "2028-07-13", amount: "8.00", currency: "USD", wallet: "USD", counterparty: "Example Client" });
    original.bankAccounts!["USD|USD"] = "invented-usd-wallet";
    original.balances.push({ currency: "USD", wallet: "USD", amount: "18.00", asOf: "2028-07-31" });
    await prepareStatementImport(client, source("wallet-original"), "revolut", original, {});
    const candidate = parsed("2028-07");
    const review = await prepareStatementImport(client, source("wallet-eur-replacement"), "revolut", candidate, { preview: true });
    assert.equal(review.preview.replacements[0].difference.identical, true);
    await prepareStatementImport(client, source("wallet-eur-replacement"), "revolut", candidate, { replace: true, previewDigest: review.preview.digest });
    const active = (await listStatements(client)).filter((item) => item.period === "2028-07");
    assert.equal(active.length, 2);
    assert.deepEqual(active.flatMap((item) => item.rows.map((row) => [item.documentId, row.currency])).sort(), [["wallet-eur-replacement", "EUR"], ["wallet-original", "USD"]]);
  });
  it("does not validate an inactive malformed historical PDF against a confirmed good selection", async () => {
    await saveStatement(client, { accountId: "finom", period: "2028-03", documentId: "inactive-malformed", filename: "invented-malformed.pdf", contentType: "application/pdf", rows: parsed().rows, bankAccounts: parsed().bankAccounts });
    setStatementSourceReaderForTests(async () => { throw new Error("inactive malformed source must not be read"); });
    const result = await statementPackageSources(client, "2028-03");
    assert.deepEqual(result.problems, []);
    assert.ok(result.statements.every((item) => item.documentId !== "inactive-malformed"));
    setStatementSourceReaderForTests();
  });
  it("checks monthly coverage against actual header day 31, preserving valid partial coverage semantics", async () => {
    let text = `Example Widgets GmbH   Statement of account
Issue date:   05.09.2028
From:   01.08.2028
To:   31.08.2028
Opening balance:   100,00 €
Closing balance:   76,50 €
IBAN: EX00 0000 0000
Completed   Description   Pay in/out
12.08.2028   Example Hosting
- 23,50 €
FINOM, a limited liability company registered with the Netherlands Chamber of Commerce.`;
    await saveStatement(client, { accountId: "finom", period: "2028-08", documentId: "header-month-end", filename: "invented-header.pdf", contentType: "application/pdf", rows: parsed("2028-08").rows, from: "2028-08-01", to: "2028-08-30" });
    setStatementSourceReaderForTests(async () => ({ bytes: Buffer.from("%PDF-synthetic"), contentType: "application/pdf", filename: "invented-header.pdf" }));
    setStatementPdfTextForTests(async () => text);
    const complete = await statementPackageSources(client, "2028-08");
    assert.deepEqual(complete.problems, []); assert.equal(complete.statements[0].to, "2028-08-31");
    text = text.replace("To:   31.08.2028", "To:   30.08.2028");
    const partial = await statementPackageSources(client, "2028-08");
    assert.equal(partial.statements[0].to, "2028-08-30");
    assert.ok(partial.problems.some((problem) => /every calendar day/.test(problem.reason)));
    setStatementSourceReaderForTests(); setStatementPdfTextForTests();
  });
  it("blocks colliding accounts and migrates historical metadata only on confirmed same-account replacement", async () => {
    const text = `Example Widgets GmbH   Statement of account
Issue date:   05.01.2029
From:   01.12.2028
To:   31.12.2028
Opening balance:   100,00 €
Closing balance:   76,50 €
IBAN: EX00 0000 0000
Completed   Description   Pay in/out
12.12.2028   Example Hosting
- 23,50 €
FINOM, a limited liability company registered with the Netherlands Chamber of Commerce.`;
    const previous = await saveStatement(client, { accountId: "finom", period: "2028-12", documentId: "legacy-identity-source", filename: "invented-legacy.pdf", contentType: "application/pdf", rows: parsed("2028-12").rows, balances: [{ currency: "EUR", amount: "76.50", asOf: "2028-12-30" }], from: "2028-12-01", to: "2028-12-30" });
    setStatementSourceReaderForTests(async () => ({ bytes: Buffer.from("%PDF-synthetic"), contentType: "application/pdf", filename: "invented-legacy.pdf" }));
    setStatementPdfTextForTests(async () => text);
    await assert.rejects(prepareStatementImport(client, source("new-separate-account"), "finom", parsed("2028-12", "invented-other-account"), {}), (error: any) => error.statusCode === 409);
    assert.equal((await listStatementHistory(client)).filter((item) => item.period === "2028-12").length, 1);
    const candidate = parsed("2028-12");
    const review = await prepareStatementImport(client, source("same-account-replacement"), "finom", candidate, { preview: true });
    await prepareStatementImport(client, source("same-account-replacement"), "finom", candidate, { replace: true, previewDigest: review.preview.digest });
    const retained = (await listStatementHistory(client)).find((item) => item.id === previous.id)!;
    assert.ok(retained.bankAccounts?.["main|EUR"]);
    assert.equal(retained.to, "2028-12-31"); assert.equal(retained.balances![0].asOf, "2028-12-31");
    assert.deepEqual(retained.rows, previous.rows, "monetary rows and historical source identity are retained");
    assert.equal((await statementPackageSources(client, "2028-12")).statements.length, 1);
    setStatementSourceReaderForTests(); setStatementPdfTextForTests();
  });
  it("migrates unverified keys retained by another bank import before comparing a replacement", async () => {
    const text = `© 2029 Revolut Bank UAB
Account name   Euro
Currency   EUR
IBAN   EX00 0000 0000
Generated on the April 5, 2029
Balance summary
Opening balance   €100.00
Money in   €0.00
Money out   - €23.50
Closing balance   €76.50
Transactions from March 1, 2029 to March 31, 2029
Date (UTC)   Description   Money out   Money in   Balance
12 Mar 2029   CAR   Example Hosting   €23.50   €76.50
Transaction types`;
    const candidate = parseRevolutPdfText(text);
    const original = await saveStatement(client, { accountId: "revolut", period: "2029-03", documentId: "legacy-revolut", filename: "invented-revolut.pdf", contentType: "application/pdf", rows: candidate.rows, balances: candidate.balances, ...candidate.period });
    await prepareStatementImport(client, source("separate-finom"), "finom", parsed("2029-03"), {});
    assert.ok(Object.keys((await getMonth(client, "2029-03")).statementSelection!).some((key) => key.includes(`unverified:${original.id}`)));
    setStatementSourceReaderForTests(async () => ({ bytes: Buffer.from("%PDF-synthetic"), contentType: "application/pdf", filename: "invented-revolut.pdf" }));
    setStatementPdfTextForTests(async () => text);
    const review = await prepareStatementImport(client, source("replacement-revolut"), "revolut", candidate, {});
    assert.equal(review.committed, false); assert.equal(review.preview.requiresConfirmation, true);
    assert.equal(review.preview.replacements[0].difference.identical, true, "comparison uses the original verified headers, including missing historical metadata");
    assert.ok((await listStatements(client)).some((item) => item.id === original.id), "preview preserves the old active source");
    await prepareStatementImport(client, source("replacement-revolut"), "revolut", candidate, { replace: true, previewDigest: review.preview.digest });
    const active = (await listStatements(client)).filter((item) => item.period === "2029-03");
    assert.equal(active.length, 2); assert.ok(active.some((item) => item.documentId === "separate-finom"));
    assert.ok(active.some((item) => item.documentId === "replacement-revolut"));
    assert.ok(!Object.keys((await getMonth(client, "2029-03")).statementSelection!).some((key) => key.includes("unverified:")));
    setStatementSourceReaderForTests(); setStatementPdfTextForTests();
  });
  it("strongly reloads selected sources missing from a history scan and refuses unavailable references", async () => {
    const value = parsed("2029-05");
    await prepareStatementImport(client, source("strong-selected"), "finom", value, {});
    const before = await getMonth(client, "2029-05");
    const send = client.send.bind(client);
    let loseSelectedGet = false, writes = 0;
    const lagging = { send: async (command: any) => {
      if (command instanceof ScanCommand && command.input.ExpressionAttributeValues?.[":prefix"] === "STATEMENT#") return { Items: [] };
      if (command instanceof GetCommand && String(command.input.Key?.PK).startsWith("STATEMENT#")) {
        assert.equal(command.input.ConsistentRead, true);
        if (loseSelectedGet) return {};
      }
      if (command instanceof TransactWriteCommand) writes++;
      return send(command);
    } } as unknown as DynamoDBDocumentClient;
    const review = await prepareStatementImport(lagging, source("strong-candidate"), "finom", value, {});
    assert.equal(review.committed, false); assert.equal(review.preview.requiresConfirmation, true);
    loseSelectedGet = true;
    await assert.rejects(prepareStatementImport(lagging, source("missing-selected-candidate"), "finom", value, {}), (error: any) => error.statusCode === 409 && /Selected statement source is unavailable/.test(error.message));
    assert.equal(writes, 0); assert.deepEqual(await getMonth(client, "2029-05"), before);
  });
});
