import { createHash, randomUUID } from "crypto";
import {
  GetCommand,
  QueryCommand,
  type DynamoDBDocumentClient,
} from "@aws-sdk/lib-dynamodb";
import { TABLE_MARKETING } from "./tableNames";
import {
  compact,
  putNew,
  putAtVersion,
  type TransactionItem,
} from "./plannedWrite";
import { transactWrite } from "./transactWrite";
import {
  MarketingError,
  requireThat,
  validateSnapshot,
  metric,
  periodRange,
  type Dict,
  type Plan,
  type Step,
  type Snapshot,
} from "../marketing/model";

const table = TABLE_MARKETING;
export const planKey = (id: string) => ({ PK: `PLAN#${id}`, SK: "PLAN" });
export const stepKey = (s: Pick<Step, "planId" | "id">) => ({
  PK: `PLAN#${s.planId}`,
  SK: `STEP#${s.id}`,
});
export const seriesKey = (
  s: Pick<Snapshot, "metricKey" | "scope" | "source">,
) =>
  `SERIES.${createHash("sha256")
    .update(JSON.stringify([s.metricKey, s.scope, s.source]))
    .digest("base64url")}`;
export const snapshotKey = (s: Snapshot) => ({
  PK: seriesKey(s),
  SK: periodRange(s.period).to,
});
const latestKey = (s: Snapshot) => ({ PK: "METRICS", SK: seriesKey(s) });
function clean<T>(row?: Dict): T | null {
  if (!row) return null;
  const { PK, SK, stepId, ...rest } = row;
  return rest as T;
}
export async function getMarketingRow(
  client: DynamoDBDocumentClient,
  key: Dict,
) {
  return (
    await client.send(
      new GetCommand({ TableName: table, Key: key, ConsistentRead: true }),
    )
  ).Item as Dict | undefined;
}
async function query<T>(
  client: DynamoDBDocumentClient,
  pk: string,
  prefix?: string,
  index = false,
) {
  const rows: T[] = [];
  let cursor: Dict | undefined;
  do {
    const result = await client.send(
      new QueryCommand({
        TableName: table,
        ...(index ? { IndexName: "GSI-StepId" } : { ConsistentRead: true }),
        KeyConditionExpression: `${index ? "stepId" : "PK"}=:pk${prefix ? " AND begins_with(SK,:prefix)" : ""}`,
        ExpressionAttributeValues: {
          ":pk": pk,
          ...(prefix ? { ":prefix": prefix } : {}),
        },
        ...(cursor ? { ExclusiveStartKey: cursor } : {}),
      }),
    );
    rows.push(...(result.Items || []).map((r) => clean<T>(r)!));
    cursor = result.LastEvaluatedKey;
  } while (cursor);
  return rows;
}
export const getPlan = async (c: DynamoDBDocumentClient, id: string) =>
  clean<Plan>(await getMarketingRow(c, planKey(id)));
export async function listPlans(c: DynamoDBDocumentClient) {
  const refs = await query<{ id: string }>(c, "PLANS");
  return (await Promise.all(refs.map((r) => getPlan(c, r.id)))).filter(
    (p): p is Plan => !!p,
  );
}
const row = (value: Dict, key: Dict) => compact({ ...value, ...key }) as Dict;
export function nextRecord<T extends Plan | Step>(old: T, changes: Dict): T {
  return {
    ...old,
    ...changes,
    id: old.id,
    version: old.version + 1,
    createdAt: old.createdAt,
    updatedAt: new Date().toISOString(),
  };
}
export async function createPlan(c: DynamoDBDocumentClient, p: Plan) {
  await transactWrite(c, [
    putNew(table, planKey(p.id), row(p, planKey(p.id))).item,
    putNew(table, { PK: "PLANS", SK: p.id }, { id: p.id }).item,
  ]);
  return p;
}
export async function savePlan(
  c: DynamoDBDocumentClient,
  old: Plan,
  changes: Dict,
) {
  const next = nextRecord(old, changes);
  await transactWrite(c, [
    putAtVersion(
      table,
      planKey(old.id),
      row(next, planKey(old.id)),
      old.version,
    ).item,
  ]);
  return next;
}
export async function getStep(c: DynamoDBDocumentClient, id: string) {
  const refs = await query<Step>(c, id, undefined, true);
  return refs.length
    ? clean<Step>(await getMarketingRow(c, stepKey(refs[0])))
    : null;
}
export const listPlanSteps = (c: DynamoDBDocumentClient, id: string) =>
  query<Step>(c, `PLAN#${id}`, "STEP#");
export async function listSteps(c: DynamoDBDocumentClient, plan?: string) {
  return (
    await Promise.all(
      (plan ? [{ id: plan }] : await listPlans(c)).map((p) =>
        listPlanSteps(c, p.id),
      ),
    )
  ).flat();
}
export async function createStep(
  c: DynamoDBDocumentClient,
  s: Step,
  plan: Plan,
) {
  // Touch the plan at its version as a guard against a concurrent goal edit/deletion.
  await transactWrite(c, [
    putAtVersion(
      table,
      planKey(plan.id),
      row(plan, planKey(plan.id)),
      plan.version,
    ).item,
    putNew(table, stepKey(s), row({ ...s, stepId: s.id }, stepKey(s))).item,
    putNew(table, { PK: "STEPIDS", SK: s.id }, { id: s.id, planId: s.planId })
      .item,
  ]);
  return s;
}
export function stepPlannedWrite(old: Step, next: Step) {
  return putAtVersion(
    table,
    stepKey(old),
    row({ ...next, stepId: next.id }, stepKey(old)),
    old.version,
  );
}
export async function saveStep(
  c: DynamoDBDocumentClient,
  old: Step,
  changes: Dict,
  companions: TransactionItem[] = [],
) {
  const next = nextRecord(old, changes);
  await transactWrite(c, [stepPlannedWrite(old, next).item, ...companions]);
  return next;
}
export function newRecord() {
  const now = new Date().toISOString();
  return { version: 1, createdAt: now, updatedAt: now };
}
export const newStepId = () => `s-${randomUUID().slice(0, 8)}`;
export async function listSnapshots(
  c: DynamoDBDocumentClient,
  series?: Pick<Snapshot, "metricKey" | "scope" | "source">,
) {
  return query<Snapshot>(c, series ? seriesKey(series) : "METRICS");
}
export async function pushSnapshots(
  c: DynamoDBDocumentClient,
  inputs: Snapshot[],
  options: { replace?: boolean; dryRun?: boolean },
  actorId: string,
  attempt = 0,
): Promise<{
  items: Snapshot[];
  inserted: number;
  unchanged: number;
  dryRun: boolean;
}> {
  requireThat(
    Array.isArray(inputs) && inputs.length > 0 && inputs.length <= 40,
    "Batch must contain 1 to 40 snapshots (one atomic transaction)",
  );
  inputs = inputs.map(
    (input) =>
      input &&
      ({
        ...input,
        unit: input.unit ?? metric(input.metricKey)?.unit,
      } as Snapshot),
  );
  inputs.forEach(validateSnapshot);
  const keys = inputs.map((s) => JSON.stringify(snapshotKey(s)));
  requireThat(
    new Set(keys).size === keys.length,
    "Duplicate snapshot keys in batch",
  );
  const writes: TransactionItem[] = [];
  const items: Snapshot[] = [];
  let unchanged = 0;
  const latest = new Map<
    string,
    { old?: Dict; next: Snapshot; changed: boolean }
  >();
  for (const input of inputs) {
    const old = await getMarketingRow(c, snapshotKey(input));
    const same =
      old &&
      old.value === input.value &&
      !!old.provisional === !!input.provisional;
    if (old && !same && !options.replace && !old.provisional)
      throw new MarketingError(
        `Snapshot exists with a different value: ${input.metricKey} ${input.period}`,
        409,
      );
    const next = same
      ? clean<Snapshot>(old)!
      : ({
          ...input,
          periodStart: periodRange(input.period).from,
          periodEnd: periodRange(input.period).to,
          version: (old?.version || 0) + 1,
          pushedBy: actorId,
          pushedAt: new Date().toISOString(),
          ...(old
            ? {
                history: [
                  ...(old.history || []),
                  {
                    value: old.value,
                    pushedAt: old.pushedAt,
                    pushedBy: old.pushedBy,
                    note: old.note,
                    provisional: !!old.provisional,
                  },
                ],
              }
            : {}),
        } as Snapshot);
    const item = row(next, snapshotKey(input));
    // Guard unchanged rows too: a concurrent replacement must not be reported as unchanged.
    writes.push(
      (old
        ? putAtVersion(table, snapshotKey(input), item, old.version)
        : putNew(table, snapshotKey(input), item)
      ).item,
    );
    if (same) unchanged++;
    items.push(next);
    const k = seriesKey(input);
    if (!latest.has(k)) {
      const previous = await getMarketingRow(c, latestKey(input));
      latest.set(k, {
        old: previous,
        next: clean<Snapshot>(previous) || next,
        changed: !previous,
      });
    }
    const entry = latest.get(k)!;
    if (
      periodRange(next.period).to >= periodRange(entry.next.period).to &&
      (!same || !entry.old)
    ) {
      entry.next = next;
      entry.changed = true;
    }
  }
  for (const entry of latest.values()) {
    const k = latestKey(entry.next);
    // Index versions are independent of per-period snapshot versions.
    const value = row(
      {
        ...entry.next,
        version: (entry.old?.version || 0) + (entry.changed ? 1 : 0),
      },
      k,
    );
    writes.push(
      (entry.old
        ? putAtVersion(table, k, value, entry.old.version)
        : putNew(table, k, value)
      ).item,
    );
  }
  if (!options.dryRun) {
    try {
      await transactWrite(c, writes);
    } catch (error) {
      // Re-read conditional losers: identical concurrent pushes converge to unchanged.
      if (
        (error as Error).name === "TransactionCanceledException" &&
        attempt < 2
      )
        return pushSnapshots(c, inputs, options, actorId, attempt + 1);
      throw error;
    }
  }
  return {
    items,
    inserted: inputs.length - unchanged,
    unchanged,
    dryRun: !!options.dryRun,
  };
}
