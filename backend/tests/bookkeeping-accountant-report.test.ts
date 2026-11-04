import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { handleBookkeepingRoutes } from "../src/routes/bookkeeping";
import { formatAccountantCsv, selectAccountantReportRows } from "../src/finance/accountantReport";
import { monthPackage } from "../src/reconcile/monthService";

const entries = [
  {
    PK: "BOOKKEEPING#synthetic-edited",
    SK: "BOOKKEEPING#synthetic-edited",
    id: "synthetic-edited",
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-03T00:00:00.000Z",
    transactionDate: "2026-10-01",
    counterparty: "Edited Workshop Company",
    counterpartyCanonical: "Stale Alias",
    description: "Edited consulting service",
    amount: "100.00",
    currency: "EUR",
    entryType: "expense",
    category: "Consulting",
  },
  {
    PK: "BOOKKEEPING#synthetic-owner",
    SK: "BOOKKEEPING#synthetic-owner",
    id: "synthetic-owner",
    createdAt: "2026-10-02T00:00:00.000Z",
    updatedAt: "2026-10-02T00:00:00.000Z",
    transactionDate: "2026-10-02",
    counterparty: "Synthetic Owner",
    description: "Synthetic owner withdrawal",
    amount: "25.00",
    currency: "EUR",
    entryType: "expense",
    category: "Owner pay",
    ownerPayType: "draw",
  },
  {
    PK: "BOOKKEEPING#synthetic-tax",
    SK: "BOOKKEEPING#synthetic-tax",
    id: "synthetic-tax",
    createdAt: "2026-10-03T00:00:00.000Z",
    updatedAt: "2026-10-03T00:00:00.000Z",
    transactionDate: "2026-10-03",
    counterparty: "Synthetic Tax Office",
    description: "Synthetic tax payment",
    amount: "10.00",
    currency: "EUR",
    entryType: "expense",
    category: "Taxes",
  },
  {
    PK: "BOOKKEEPING#synthetic-out-of-period",
    SK: "BOOKKEEPING#synthetic-out-of-period",
    id: "synthetic-out-of-period",
    createdAt: "2026-09-30T00:00:00.000Z",
    updatedAt: "2026-09-30T00:00:00.000Z",
    transactionDate: "2026-09-30",
    counterparty: "Synthetic Prior Service",
    description: "Synthetic prior month consulting",
    amount: "5.00",
    currency: "EUR",
    entryType: "expense",
    category: "Consulting",
  },
  {
    PK: "BOOKKEEPING#synthetic-invoice-paid-current",
    SK: "BOOKKEEPING#synthetic-invoice-paid-current",
    id: "synthetic-invoice-paid-current",
    createdAt: "2026-09-30T00:00:00.000Z",
    updatedAt: "2026-10-02T00:00:00.000Z",
    transactionDate: "2026-09-30",
    paidDate: "2026-10-02",
    counterparty: "Synthetic Invoice Vendor",
    description: "Invoice paid in October",
    amount: "15.00",
    currency: "EUR",
    entryType: "expense",
    category: "Consulting",
  },
];

// These formatter consumers use real reconciliation source shapes: invoice links,
// active documents and explicitly attached personal payment proofs.
function verifiedClient(rows: Array<Record<string, any>>): DynamoDBDocumentClient {
  const documents = rows.map((row) => ({ PK: `DOCUMENT#proof-${row.id}`, SK: `DOCUMENT#proof-${row.id}`, id: `proof-${row.id}`, recordType: "document", status: "active", documentType: "receipt" }));
  const months = [...new Set(rows.map((row) => String(row.paidDate || row.transactionDate).slice(0, 7)))].map((period) => ({
    PK: `RECONCILE-MONTH#${period}`, SK: `RECONCILE-MONTH#${period}`, id: period, period, state: "open", version: 1, log: [],
    decisions: { pairs: [], rejected: [], exceptions: {}, proofs: Object.fromEntries(rows.filter((row) => String(row.paidDate || row.transactionDate).startsWith(period)).map((row) => [row.id, { documentId: `proof-${row.id}`, by: "synthetic-operator", at: "2026-01-01T00:00:00Z" }])) },
  }));
  const links = rows.map((row) => ({ PK: `LINK#${row.id}`, SK: `LINK#${row.id}`, id: `link-${row.id}`, documentId: `proof-${row.id}`, transactionId: row.id, coverageType: "evidence" }));
  return { send: async (command: any) => {
    const input = command.input;
    if (input.Key) return { Item: [...documents, ...months].find((row) => row.PK === input.Key.PK) };
    const values = input.ExpressionAttributeValues || {};
    if (values[":transaction"]) return { Items: rows };
    const prefix = values[":prefix"];
    return { Items: [...documents, ...months, ...links].filter((row) => prefix && row.PK.startsWith(prefix)) };
  } } as unknown as DynamoDBDocumentClient;
}
const client = verifiedClient(entries);

describe("native accountant report API", () => {
  it("orders native CSV, copied TSV and package CSV by cash date with deterministic parents and saved allocation order", async () => {
    const period = "2033-10";
    const payment = (id: string, paidDate: string, counterparty: string) => ({
      id, transactionDate: "2033-09-30", paidDate, counterparty, description: "Invented service",
      amount: "23.00", currency: "EUR", entryType: "expense",
    });
    const rows = [
      payment("invented-late", "2033-10-31", "Invented Late"),
      payment("invented-tie-z", "2033-10-16", "Invented Tie Z"),
      { ...payment("invented-tie-m", "2033-10-16", "Invented Parent"), allocations: [
        { documentId: "invented-doc-z", counterparty: "Invented Allocation First", description: "Invented first", amount: "5.00", currency: "EUR" },
        { documentId: "invented-doc-a", counterparty: "Invented Allocation Second", description: "Invented second", amount: "7.00", currency: "EUR" },
        { documentId: "invented-doc-m", counterparty: "Invented Allocation Third", description: "Invented third", amount: "11.00", currency: "EUR" },
      ] },
      payment("invented-early", "2033-10-01", "Invented Early"),
      payment("invented-tie-a", "2033-10-16", "Invented Tie A"),
    ];
    const before = JSON.stringify(rows), source = verifiedClient(rows);
    const expectedCompanies = ["Invented Early", "Invented Tie A", "Invented Allocation First", "Invented Allocation Second",
      "Invented Allocation Third", "Invented Tie Z", "Invented Late"];
    let csv = "";
    for (const format of ["csv", "tsv"] as const) {
      const response = await handleBookkeepingRoutes("/api/bookkeeping/reports/accountant", "GET", {
        httpMethod: "GET", path: "/api/bookkeeping/reports/accountant", headers: {},
        queryStringParameters: { period, format },
      }, source, true);
      assert.equal(response.statusCode, 200, response.body);
      const report = JSON.parse(response.body);
      assert.equal(report.count, 7);
      const cells = report.content.trim().split(/\r?\n/).slice(1).map((line: string) =>
        format === "csv" ? line.split(",").map((value) => value.slice(1, -1)) : line.split("\t"));
      assert.deepEqual(cells.map((row: string[]) => row[1]), expectedCompanies);
      assert.deepEqual(cells.map((row: string[]) => row[0]), ["2033-10-01", ...Array(5).fill("2033-10-16"), "2033-10-31"]);
      assert.deepEqual(cells.slice(2, 5).map((row: string[]) => row[3]), ["-5.00", "-7.00", "-11.00"]);
      if (format === "csv") csv = report.content;
    }
    const pack = await monthPackage(source, period, { draft: true });
    assert.equal(pack.csv, csv, "native and package CSV use the same ordering and formatter");
    assert.equal(JSON.stringify(rows), before, "formatting preserves source dates, amounts and allocation order");
  });

  it("selects the cash period before applying allocation projection and report exclusions", () => {
    const rows = selectAccountantReportRows([
      { id: "moved", transactionDate: "2026-10-31", paidDate: "2026-11-02", amount: "30.00", currency: "EUR", entryType: "income", counterparty: "Synthetic Company", description: "Combined payment", allocations: [
        { documentId: "synthetic-a", counterparty: "Synthetic A", description: "Consulting", amount: "10.00", currency: "EUR" },
        { documentId: "synthetic-b", counterparty: "Synthetic B", description: "Hosting", amount: "20.00", currency: "EUR" },
      ] },
      { id: "owner", paidDate: "2026-11-03", amount: "4.00", currency: "EUR", entryType: "expense", category: "Owner pay", ownerPayType: "draw" },
      { id: "tax", paidDate: "2026-11-04", amount: "5.00", currency: "EUR", entryType: "expense", category: "Taxes" },
      { id: "tk", paidDate: "2026-11-05", amount: "6.00", currency: "EUR", entryType: "expense", category: "Health Insurance" },
      { id: "tk-vendor", paidDate: "2026-11-05", amount: "7.00", currency: "EUR", entryType: "expense", counterparty: "Techniker Krankenkasse", description: "Health contribution" },
      { id: "consulting", paidDate: "2026-11-06", amount: "9.00", currency: "EUR", entryType: "expense", category: "Consulting", counterparty: "Synthetic Consulting", description: "Monthly service" },
    ], "2026-11");
    assert.deepEqual(rows.map((row) => [row.id, row.counterparty, row.description, row.amount]), [
      ["moved", "Synthetic A", "Consulting", "10.00"],
      ["moved", "Synthetic B", "Hosting", "20.00"],
      ["consulting", "Synthetic Consulting", "Monthly service", "9.00"],
    ]);
    assert.equal(selectAccountantReportRows([
      { id: "moved", transactionDate: "2026-10-31", paidDate: "2026-11-02", amount: "30.00", currency: "EUR", entryType: "income" },
    ], "2026-10").length, 0);
    assert.equal(formatAccountantCsv([
      { paidDate: "2026-11-07", transactionDate: "2026-10-30", counterparty: "Synthetic USD Vendor", description: "Converted service", amount: "10.00", amountEur: "9.25", currency: "USD", entryType: "expense" },
    ]), '"Date","Company","What","Amount, EUR"\r\n"2026-11-07","Synthetic USD Vendor","Converted service","-9.25"\r\n');
  });

  it("serves persisted Company/What through the native CLI path and excludes owner draws and taxes", async () => {
    const response = await handleBookkeepingRoutes(
      "/api/bookkeeping/reports/accountant",
      "GET",
      {
        httpMethod: "GET",
        path: "/api/bookkeeping/reports/accountant",
        headers: {},
        queryStringParameters: { period: "2026-10", format: "csv" },
      },
      client,
      true,
    );
    assert.equal(response.statusCode, 200);
    const report = JSON.parse(response.body);
    assert.equal(report.count, 2);
    assert.equal(report.excludedCount, 2);
    assert.equal(report.content,
      '"Date","Company","What","Amount, EUR"\r\n'
      + '"2026-10-01","Edited Workshop Company","Edited consulting service","-100.00"\r\n'
      + '"2026-10-02","Synthetic Invoice Vendor","Invoice paid in October","-15.00"\r\n');
    assert.match(report.content, /"2026-10-02","Synthetic Invoice Vendor","Invoice paid in October","-15.00"/);
    assert.doesNotMatch(report.content, /Stale Alias|Synthetic Owner|Synthetic Tax Office|Synthetic Prior Service/);
  });

  it("uses normalized EUR currency for validation and the native accountant amount", async () => {
    const normalizedEuroRows = [
      {
        PK: "BOOKKEEPING#synthetic-missing-currency-eur",
        SK: "BOOKKEEPING#synthetic-missing-currency-eur",
        id: "synthetic-missing-currency-eur",
        transactionDate: "2026-10-08",
        counterparty: "Synthetic Missing Currency Vendor",
        description: "Missing currency service",
        amount: "10.00",
        entryType: "expense",
      },
      {
        PK: "BOOKKEEPING#synthetic-lowercase-currency-eur",
        SK: "BOOKKEEPING#synthetic-lowercase-currency-eur",
        id: "synthetic-lowercase-currency-eur",
        transactionDate: "2026-10-09",
        counterparty: "Synthetic Lowercase Currency Vendor",
        description: "Lowercase currency service",
        amount: "20.00",
        amountEur: "19.00",
        currency: "eur",
        entryType: "expense",
      },
      {
        PK: "BOOKKEEPING#synthetic-padded-currency-eur",
        SK: "BOOKKEEPING#synthetic-padded-currency-eur",
        id: "synthetic-padded-currency-eur",
        transactionDate: "2026-10-10",
        counterparty: "Synthetic Padded Currency Vendor",
        description: "Padded currency service",
        amount: "30.00",
        amountEur: "29.00",
        currency: " EUR ",
        entryType: "expense",
      },
    ];
    const response = await handleBookkeepingRoutes(
      "/api/bookkeeping/reports/accountant",
      "GET",
      {
        httpMethod: "GET",
        path: "/api/bookkeeping/reports/accountant",
        headers: {},
        queryStringParameters: { period: "2026-10", format: "csv" },
      },
      verifiedClient(normalizedEuroRows),
      true,
    );

    assert.equal(response.statusCode, 200);
    const report = JSON.parse(response.body);
    assert.equal(report.count, 3);
    assert.equal(report.content,
      '"Date","Company","What","Amount, EUR"\r\n'
      + '"2026-10-08","Synthetic Missing Currency Vendor","Missing currency service","-10.00"\r\n'
      + '"2026-10-09","Synthetic Lowercase Currency Vendor","Lowercase currency service","-20.00"\r\n'
      + '"2026-10-10","Synthetic Padded Currency Vendor","Padded currency service","-30.00"\r\n');
  });

  it("uses the same accountant inclusion rules for copied TSV", async () => {
    const response = await handleBookkeepingRoutes(
      "/api/bookkeeping/reports/accountant",
      "GET",
      {
        httpMethod: "GET",
        path: "/api/bookkeeping/reports/accountant",
        headers: {},
        queryStringParameters: { period: "2026-10", format: "tsv" },
      },
      client,
      true,
    );
    const report = JSON.parse(response.body);
    assert.equal(report.count, 2);
    assert.match(report.content, /Edited Workshop Company\tEdited consulting service/);
    assert.doesNotMatch(report.content, /Synthetic Owner|Synthetic Tax Office/);
  });

  it("refuses a foreign-currency accountant report row without a booked EUR value", async () => {
    const unconverted = {
      id: "synthetic-unconverted-usd",
      transactionDate: "2026-10-08",
      counterparty: "Synthetic USD Vendor",
      description: "Unconverted service",
      amount: "12.00",
      currency: "USD",
      entryType: "expense",
    };
    const response = await handleBookkeepingRoutes(
      "/api/bookkeeping/reports/accountant",
      "GET",
      {
        httpMethod: "GET",
        path: "/api/bookkeeping/reports/accountant",
        headers: {},
        queryStringParameters: { period: "2026-10", format: "csv" },
      },
      verifiedClient([...entries, unconverted]),
      true,
    );
    assert.equal(response.statusCode, 409);
    const body = JSON.parse(response.body);
    assert.match(body.error, /1 transaction\(s\) have no EUR value; convert them before preparing the package/);
    assert.deepEqual(body.unconvertedTransactionIds, [unconverted.id]);
  });

  it("expands one paid payment into the persisted invoice Company/What rows in native CSV and TSV", async () => {
    const allocatedPayment = {
      id: "synthetic-bundled-payment",
      transactionDate: "2026-09-30",
      paidDate: "2026-10-04",
      counterparty: "Synthetic Card Settlement",
      description: "Combined payment",
      amount: "123.00",
      currency: "EUR",
      entryType: "expense",
      category: "Tools",
      statementRef: "Synthetic bank statement",
      allocations: [
        { id: "alloc-100", documentId: "synthetic-doc-100", transactionDate: "2026-09-30", paidDate: "2026-09-30", counterparty: "Synthetic Compute GmbH", description: "Dedicated cluster", amount: "100.00", currency: "EUR", amountEur: "100.00", category: "Infrastructure" },
        { id: "alloc-20", documentId: "synthetic-doc-20", transactionDate: "2026-09-30", paidDate: "2026-09-30", counterparty: "Synthetic Domain Ltd", description: "Domain renewal", amount: "20.00", currency: "EUR", amountEur: "20.00", category: "Domains" },
        { id: "alloc-3", documentId: "synthetic-doc-3", transactionDate: "2026-09-30", paidDate: "2026-09-30", counterparty: "Synthetic Mail BV", description: "Email service", amount: "3.00", currency: "EUR", amountEur: "3.00", category: "Services" },
      ],
    };
    const sourceAllocations = JSON.stringify(allocatedPayment.allocations);
    const allocationClient = verifiedClient([...entries, allocatedPayment]);
    for (const format of ["csv", "tsv"] as const) {
      const response = await handleBookkeepingRoutes(
        "/api/bookkeeping/reports/accountant",
        "GET",
        {
          httpMethod: "GET",
          path: "/api/bookkeeping/reports/accountant",
          headers: {},
          queryStringParameters: { period: "2026-10", format },
        },
        allocationClient,
        true,
      );
      const report = JSON.parse(response.body);
      assert.equal(report.count, 5, "the two existing reportable payments plus three invoice rows are report rows");
      assert.equal(report.excludedCount, 2, "owner and tax rows remain excluded");
      const lines = report.content.trim().split(/\r?\n/);
      assert.equal(lines.length, 6, "one header, two existing rows, and three allocated invoice rows");
      const expectedCashDatePrefix = format === "csv" ? '"2026-10-04"' : "2026-10-04";
      for (const [company, what, amount] of [
        ["Synthetic Compute GmbH", "Dedicated cluster", "100.00"],
        ["Synthetic Domain Ltd", "Domain renewal", "20.00"],
        ["Synthetic Mail BV", "Email service", "3.00"],
      ]) {
        assert.ok(report.content.includes(company), `${format} includes ${company}`);
        assert.ok(report.content.includes(what), `${format} includes ${what}`);
        assert.ok(report.content.includes(format === "csv" ? `"-${amount}"` : `-${amount}`), `${format} includes amount -${amount}`);
        assert.ok(lines.some((line) => line.includes(company) && line.startsWith(expectedCashDatePrefix)),
          `${format} shows the payment cash date for ${company}`);
      }
      assert.doesNotMatch(report.content, /Synthetic Card Settlement|Combined payment|Synthetic Owner|Synthetic Tax Office/);
    }
    assert.equal(JSON.stringify(allocatedPayment.allocations), sourceAllocations,
      "cash-date projection leaves stored invoice dates unchanged");

    const septemberResponse = await handleBookkeepingRoutes(
      "/api/bookkeeping/reports/accountant",
      "GET",
      {
        httpMethod: "GET",
        path: "/api/bookkeeping/reports/accountant",
        headers: {},
        queryStringParameters: { period: "2026-09", format: "csv" },
      },
      allocationClient,
      true,
    );
    const september = JSON.parse(septemberResponse.body);
    assert.doesNotMatch(september.content, /Synthetic Compute GmbH|Dedicated cluster/,
      "a September invoice date is reported in October when it was paid in October");
  });

  it("keeps excluded owner and tax rows in the ordinary transaction list", async () => {
    const response = await handleBookkeepingRoutes(
      "/api/bookkeeping/transactions",
      "GET",
      { httpMethod: "GET", path: "/api/bookkeeping/transactions", headers: {} },
      client,
      true,
    );
    const listed = JSON.parse(response.body).items;
    assert.equal(listed.length, 5);
    assert.ok(listed.some((entry: Record<string, unknown>) => entry.id === "synthetic-owner"));
    assert.ok(listed.some((entry: Record<string, unknown>) => entry.id === "synthetic-tax"));
  });

  it("uses paidDate instead of also matching an older transactionDate", async () => {
    const response = await handleBookkeepingRoutes(
      "/api/bookkeeping/reports/accountant",
      "GET",
      {
        httpMethod: "GET",
        path: "/api/bookkeeping/reports/accountant",
        headers: {},
        queryStringParameters: { period: "2026-09", format: "csv" },
      },
      client,
      true,
    );
    const report = JSON.parse(response.body);
    assert.equal(report.count, 1);
    assert.match(report.content, /Synthetic Prior Service/);
    assert.doesNotMatch(report.content, /Synthetic Invoice Vendor/);
  });
});
