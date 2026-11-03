import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { listTransactions } from "../db/bookkeeping";
import {
  accountantCashDate,
  accountantReportRows,
  accountantReportRowsForPeriod,
  formatAccountantCsv,
  formatAccountantTsv,
  isAccountantReportRowIncluded,
} from "../finance/accountantReport";
import type { LambdaEvent, LambdaResponse } from "../types";
import { json } from "./bookkeepingShared";

export { accountantReportRows, formatAccountantCsv, formatAccountantTsv };

/**
 * The native accountant Copy/CSV formatter, also available to the generic
 * `dataops api` CLI. This is separate from the reconciliation package CSV.
 */
export async function handleBookkeepingAccountantReportRoutes(
  path: string,
  method: string,
  event: LambdaEvent,
  client: DynamoDBDocumentClient,
): Promise<LambdaResponse | null> {
  if (path !== "/api/bookkeeping/reports/accountant" || method !== "GET") return null;
  const period = String(event.queryStringParameters?.period || "all");
  const format = String(event.queryStringParameters?.format || "csv");
  if (!/^(all|\d{4}|\d{4}-(0[1-9]|1[0-2]))$/.test(period))
    return json(400, { error: "Invalid period" });
  if (format !== "csv" && format !== "tsv")
    return json(400, { error: "Invalid format" });

  const transactions = await listTransactions(client);
  const reportRows = accountantReportRowsForPeriod(transactions, period === "all" ? "" : period);
  const included = reportRows.filter(isAccountantReportRowIncluded);
  return json(200, {
    period,
    format,
    count: included.length,
    excludedCount: reportRows.length - included.length,
    content: format === "csv" ? formatAccountantCsv(included) : formatAccountantTsv(included),
  });
}
