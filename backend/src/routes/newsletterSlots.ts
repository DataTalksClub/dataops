import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import type { LambdaEvent, LambdaResponse } from "../types";
import {
  createNewsletterSlot,
  deleteNewsletterSlot,
  getNewsletterSlot,
  listNewsletterSlots,
  listNewsletterAlertRecords,
  putNewsletterAlertRecord,
  updateNewsletterAlertRecord,
  updateNewsletterSlot,
  type NewsletterSlot,
} from "../db/newsletterSlots";
import { createHash } from "crypto";
import { getCrmRecord } from "../db/sponsorCrm";
import { getBundle } from "../db/bundles";
const json = (statusCode: number, body: unknown): LambdaResponse => ({
    statusCode,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }),
  DATE = /^\d{4}-\d{2}-\d{2}$/,
  STATUSES = new Set([
    "open",
    "reserved",
    "drafting",
    "scheduled",
    "sent",
    "cancelled",
  ]),
  ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const WRITABLE_FIELDS = new Set([
  "publicationDate",
  "publicationTime",
  "utcOffset",
  "campaignLabel",
  "campaignNumber",
  "status",
  "bundleId",
  "bookedByUserId",
  "bookedByDisplayName",
  "sponsorBookingId",
  "publicUrl",
  "planningNote",
  "sourceType",
  "sourceKey",
  "version",
]);
const parse = (event: LambdaEvent) => {
    try {
      return event.body ? JSON.parse(String(event.body)) : null;
    } catch {
      return null;
    }
  },
  realDate = (value: unknown) =>
    typeof value === "string" &&
    DATE.test(value) &&
    new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
function validate(body: any, partial = false) {
  const unknown = Object.keys(body).find((name) => !WRITABLE_FIELDS.has(name));
  if (unknown) return `Unknown field: ${unknown}`;
  if (
    (!partial || body.publicationDate !== undefined) &&
    !realDate(body.publicationDate)
  )
    return "Invalid publicationDate";
  if (
    body.publicationTime != null &&
    !/^([01]\d|2[0-3]):[0-5]\d$/.test(body.publicationTime)
  )
    return "Invalid publicationTime";
  if (body.publicationTime?.startsWith("02:") && body.publicationDate) {
    const year = Number(body.publicationDate.slice(0, 4));
    const lastSunday = (month: number) => {
      const date = new Date(Date.UTC(year, month + 1, 0));
      date.setUTCDate(date.getUTCDate() - date.getUTCDay());
      return date.toISOString().slice(0, 10);
    };
    if (body.publicationDate === lastSunday(2))
      return "Nonexistent Europe/Berlin local time";
    if (
      body.publicationDate === lastSunday(9) &&
      !["+01:00", "+02:00"].includes(body.utcOffset)
    )
      return "Ambiguous Europe/Berlin local time requires utcOffset";
  }
  if (
    (!partial || body.status !== undefined) &&
    !STATUSES.has(String(body.status))
  )
    return "Invalid status";
  if (
    (!partial || body.campaignLabel !== undefined) &&
    (typeof body.campaignLabel !== "string" ||
      !body.campaignLabel.trim() ||
      body.campaignLabel.length > 200)
  )
    return "Invalid campaignLabel";
  if (
    body.campaignNumber != null &&
    (!Number.isSafeInteger(body.campaignNumber) || body.campaignNumber < 0)
  )
    return "Invalid campaignNumber";
  for (const name of ["bundleId", "bookedByUserId", "sponsorBookingId"])
    if (body[name] != null && !ID.test(String(body[name])))
      return `Invalid ${name}`;
  if (
    body.bookedByDisplayName != null &&
    (typeof body.bookedByDisplayName !== "string" ||
      body.bookedByDisplayName.length > 200)
  )
    return "Invalid bookedByDisplayName";
  if (body.publicUrl != null) {
    try {
      if (new URL(body.publicUrl).protocol !== "https:")
        return "Invalid publicUrl";
    } catch {
      return "Invalid publicUrl";
    }
  }
  if (
    body.planningNote != null &&
    (typeof body.planningNote !== "string" || body.planningNote.length > 1000)
  )
    return "Invalid planningNote";
  for (const name of ["sourceType", "sourceKey"])
    if (
      body[name] != null &&
      (typeof body[name] !== "string" || body[name].length > 200)
    )
      return `Invalid ${name}`;
  return "";
}
function alerts(items: NewsletterSlot[], today: string) {
  const boundedDays = (name: string, fallback: number) => {
      const parsed = Number(process.env[name]);
      return Number.isInteger(parsed) && parsed >= 0 && parsed <= 365
        ? parsed
        : fallback;
    },
    openLeadDays = boundedDays("NEWSLETTER_OPEN_ALERT_LEAD_DAYS", 14),
    workflowLeadDays = boundedDays("NEWSLETTER_WORKFLOW_ALERT_LEAD_DAYS", 10);
  const active = items.filter((item) => item.status !== "cancelled"),
    out: any[] = [];
  for (const item of active) {
    const days = Math.floor(
        (Date.parse(`${item.publicationDate}T00:00:00Z`) -
          Date.parse(`${today}T00:00:00Z`)) /
          86400000,
      ),
      add = (code: string, severity: string) =>
        out.push({
          reasonCode: code,
          severity,
          slotId: item.id,
          fingerprint: `${item.id}#${code}#${item.publicationDate}`,
        });
    if (
      days >= 0 &&
      days <= openLeadDays &&
      item.status === "open" &&
      !item.bookedByUserId &&
      !item.bookedByDisplayName
    )
      add("near-term-open-unbooked", "warning");
    if (
      item.status === "reserved" &&
      !item.bookedByUserId &&
      !item.bookedByDisplayName
    )
      add("reserved-missing-booker", "error");
    if (days >= 0 && days <= workflowLeadDays && !item.bundleId)
      add("publication-missing-workflow", "warning");
  }
  const groups = new Map<string, NewsletterSlot[]>();
  for (const item of active) {
    const key = `${item.publicationDate}#${item.campaignNumber || item.campaignLabel}`;
    groups.set(key, [...(groups.get(key) || []), item]);
  }
  for (const group of groups.values())
    if (group.length > 1)
      for (const item of group)
        out.push({
          reasonCode: "duplicate-active-slot",
          severity: "error",
          slotId: item.id,
          fingerprint: `${item.id}#duplicate-active-slot#${item.publicationDate}`,
        });
  return out;
}
export async function handleNewsletterSlotRoutes(
  path: string,
  method: string,
  event: LambdaEvent,
  client: DynamoDBDocumentClient,
) {
  const dismiss = path.match(
    /^\/api\/newsletter-slots\/alerts\/([^/]+)\/dismiss$/,
  );
  if (dismiss) {
    if (method !== "POST") return json(405, { error: "Method not allowed" });
    try {
      await updateNewsletterAlertRecord(client, dismiss[1], {
        dismissed: true,
        dismissedAt: new Date().toISOString(),
      });
      return json(200, { dismissed: true });
    } catch {
      return json(404, { error: "Alert not found" });
    }
  }
  const projection = path === "/api/newsletter-slots/projection",
    match = path.match(/^\/api\/newsletter-slots(?:\/([^/]+))?$/);
  if (!projection && !match) return json(404, { error: "Not found" });
  const query = event.queryStringParameters || {},
    from = query.from || new Date().toISOString().slice(0, 10),
    to = query.to || "9999-12-31";
  if (projection && method !== "GET")
    return json(405, { error: "Method not allowed" });
  if ((method === "GET" && !match?.[1]) || projection) {
    if (!realDate(from) || !realDate(to) || from > to)
      return json(400, { error: "Invalid range" });
    let items = await listNewsletterSlots(client, from, to);
    if (query.booked && !["true", "false"].includes(query.booked))
      return json(400, { error: "Invalid booked filter" });
    if (query.today && !realDate(query.today))
      return json(400, { error: "Invalid today" });
    if (query.status) {
      if (!STATUSES.has(query.status))
        return json(400, { error: "Invalid status" });
      items = items.filter((item) => item.status === query.status);
    }
    if (query.booked === "true")
      items = items.filter(
        (item) =>
          item.bookedByUserId ||
          item.bookedByDisplayName ||
          item.sponsorBookingId,
      );
    if (query.booked === "false")
      items = items.filter(
        (item) =>
          !item.bookedByUserId &&
          !item.bookedByDisplayName &&
          !item.sponsorBookingId,
      );
    if (projection)
      return json(200, {
        items: items.map((item) => ({
          id: item.id,
          publicationDate: item.publicationDate,
          campaignLabel: item.campaignLabel,
          status: item.status,
          timeZone: "Europe/Berlin",
          href: `#/newsletter?slotId=${item.id}`,
        })),
      });
    const current = alerts(
      items,
      query.today || new Date().toISOString().slice(0, 10),
    );
    for (const item of items.filter(
      (value) => value.bundleId && value.status !== "cancelled",
    )) {
      const bundle = await getBundle(client, String(item.bundleId));
      const links = bundle?.bundleLinks || [];
      const hasCampaign = links.some(
        (link) =>
          /campaign/i.test(String(link.name)) &&
          /^https:\/\//.test(String(link.url)),
      );
      if (
        !bundle ||
        !hasCampaign ||
        !["announced", "after-event", "done"].includes(String(bundle.stage))
      )
        current.push({
          reasonCode: "linked-workflow-incomplete",
          severity: "warning",
          slotId: item.id,
          fingerprint: `${item.id}#linked-workflow-incomplete#${item.publicationDate}`,
        });
    }
    const existing = await listNewsletterAlertRecords(client),
      active = new Set(current.map((value) => value.fingerprint)),
      visible = [] as any[];
    for (const alert of current) {
      let record = existing
        .filter((value) => value.fingerprint === alert.fingerprint)
        .sort((a, b) => b.occurrence - a.occurrence)[0];
      if (!record || record.active === false) {
        const occurrence = (record?.occurrence || 0) + 1,
          id = createHash("sha256")
            .update(`${alert.fingerprint}#${occurrence}`)
            .digest("hex");
        record = await putNewsletterAlertRecord(client, {
          ...alert,
          id,
          occurrence,
          active: true,
          dismissed: false,
          createdAt: new Date().toISOString(),
        });
      }
      if (!record.dismissed) visible.push(record);
    }
    for (const record of existing)
      if (record.active && !active.has(record.fingerprint))
        await updateNewsletterAlertRecord(client, record.id, {
          active: false,
          resolvedAt: new Date().toISOString(),
        });
    return json(200, { items, alerts: visible });
  }
  const id = match?.[1];
  if (method === "GET" && id) {
    const item = await getNewsletterSlot(client, id);
    if (!item) return json(404, { error: "Not found" });
    let sponsor = null;
    if (item.sponsorBookingId) {
      const booking = await getCrmRecord(
        client,
        "booking",
        String(item.sponsorBookingId),
      ).catch(() => null);
      if (booking)
        sponsor = {
          id: booking.id,
          organizationId: booking.organizationId,
          status: booking.status,
        };
    }
    return json(200, { ...item, sponsor });
  }
  const body = parse(event);
  if (!body) return json(400, { error: "Invalid JSON" });
  if (method === "POST" && !id) {
    const error = validate(body);
    if (error) return json(400, { error });
    if (
      body.sponsorBookingId &&
      !(await getCrmRecord(client, "booking", String(body.sponsorBookingId)))
    )
      return json(422, { error: "Sponsor booking unavailable" });
    if (body.bundleId && !(await getBundle(client, String(body.bundleId))))
      return json(422, { error: "Bundle unavailable" });
    try {
      const result = await createNewsletterSlot(client, {
        ...body,
        timeZone: "Europe/Berlin",
        sourceType: body.sourceType || "portal",
      });
      return json(result.duplicate ? 200 : 201, result.item);
    } catch (error) {
      return json((error as any).statusCode || 409, {
        error: (error as Error).message,
      });
    }
  }
  if (method === "PUT" && id) {
    const existing = await getNewsletterSlot(client, id);
    if (!existing) return json(404, { error: "Not found" });
    if (body.version !== existing.version)
      return json(409, { error: "Slot changed; reload and retry" });
    const unknownFieldError = Object.keys(body).find(
      (name) => !WRITABLE_FIELDS.has(name),
    );
    if (unknownFieldError)
      return json(400, { error: `Unknown field: ${unknownFieldError}` });
    const merged = Object.fromEntries(
      [...WRITABLE_FIELDS].map((name) => [
        name,
        Object.hasOwn(body, name) ? body[name] : existing[name],
      ]),
    );
    const error = validate(merged, true);
    if (error) return json(400, { error });
    if (
      body.sponsorBookingId &&
      !(await getCrmRecord(client, "booking", String(body.sponsorBookingId)))
    )
      return json(422, { error: "Sponsor booking unavailable" });
    try {
      return json(200, await updateNewsletterSlot(client, existing, body));
    } catch {
      return json(409, { error: "Conflicting update" });
    }
  }
  if (method === "DELETE" && id) {
    const existing = await getNewsletterSlot(client, id);
    if (!existing) return json(404, { error: "Not found" });
    if (body.version !== existing.version)
      return json(409, { error: "Slot changed; reload and retry" });
    try {
      await deleteNewsletterSlot(client, existing);
      return { statusCode: 204, headers: {}, body: "" };
    } catch {
      return json(409, { error: "Conflicting delete" });
    }
  }
  return json(405, { error: "Method not allowed" });
}
