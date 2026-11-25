import { createHash, randomUUID } from "crypto";
import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import type { LambdaEvent, LambdaResponse } from "../types";
import { json, parseJsonObjectEventOrEmpty } from "../http";
import { resolveInteractiveActor } from "../identity/actor";
import * as db from "../db/marketing";
import * as service from "../marketing/service";
import {
  MarketingError,
  requireThat,
  validatePlan,
  validateGoal,
  validateStep,
  validSeries,
  vocabulary,
  normalizeTarget,
  type Plan,
  type Step,
  type Snapshot,
  type Dict,
} from "../marketing/model";
import { realDate } from "../sponsorCrm/model";

const planFields = [
  "id",
  "title",
  "objective",
  "status",
  "ownerId",
  "tags",
  "startDate",
  "endDate",
  "sources",
];
const goalFields = [
  "ref",
  "title",
  "metricKey",
  "scope",
  "source",
  "baseline",
  "target",
  "window",
];
const stepFields = [
  "key",
  "title",
  "kind",
  "size",
  "ownerId",
  "goalRefs",
  "tags",
  "targetUrl",
  "targetType",
  "primaryKeyword",
  "doneCriteria",
  "prompts",
  "brief",
  "links",
  "publishDate",
  "requestRef",
];
function allowed(body: Dict, fields: string[]) {
  const bad = Object.keys(body).find(
    (k) => ![...fields, "version"].includes(k),
  );
  requireThat(!bad, `Unknown field: ${bad}`);
}
function version(body: Dict, record: Dict) {
  if (body.version !== record.version)
    throw new MarketingError(
      "Record changed; reload and retry with version",
      409,
    );
}
function found<T>(value: T | null): T {
  if (!value) throw new MarketingError("Not found", 404);
  return value;
}
function makePlan(body: Dict, actorId: string): Plan {
  const p = {
    ...db.newRecord(),
    status: "draft",
    ownerId: actorId,
    tags: [],
    goals: [],
    notesLog: [],
    ...body,
  } as unknown as Plan;
  validatePlan(p);
  return p;
}
function makeStep(body: Dict, plan: Plan): Step {
  const s = {
    ...db.newRecord(),
    id: body.key
      ? `s-${createHash("sha256").update(`${plan.id}:${body.key}`).digest("hex").slice(0, 8)}`
      : db.newStepId(),
    planId: plan.id,
    ownerId: plan.ownerId,
    size: "S",
    tags: [],
    goalRefs: [],
    ...body,
  } as unknown as Step;
  validateStep(s, plan);
  return s;
}
export async function handleMarketingRoutes(
  path: string,
  method: string,
  event: LambdaEvent,
  c: DynamoDBDocumentClient,
): Promise<LambdaResponse> {
  const auth = await resolveInteractiveActor(
    c,
    event,
    method === "GET" ? "work-read" : "work-write",
  );
  if (!auth.ok) return auth.response;
  const actor = auth.actor;
  const q = event.queryStringParameters || {};
  const parts = path
    .replace(/^\/api\/marketing\/?/, "")
    .split("/")
    .filter(Boolean)
    .map(decodeURIComponent);
  const [family, id, action, ref] = parts;
  try {
    const b = method === "GET" ? {} : parseJsonObjectEventOrEmpty(event);
    requireThat(b, "Invalid JSON");
    if (family === "vocabulary" && method === "GET")
      return json(200, vocabulary);
    if (family === "capacity" && method === "GET")
      return json(
        200,
        await service.capacity(c, q.weeks ? Number(q.weeks) : 6),
      );
    if (family === "review" && method === "GET")
      return json(200, await service.weeklyReview(c, q.week));
    if (family === "metrics") {
      if (method === "POST" && (!id || id === "batch")) {
        const input =
          id === "batch"
            ? b.snapshots
            : [
                Object.fromEntries(
                  Object.entries(b).filter(
                    ([k]) => !["replace", "dryRun"].includes(k),
                  ),
                ),
              ];
        return json(
          200,
          await db.pushSnapshots(
            c,
            input,
            { replace: b.replace === true, dryRun: b.dryRun === true },
            actor.id,
          ),
        );
      }
      if (method === "GET" && id === "missing") {
        const plans = await Promise.all(
          (await db.listPlans(c))
            .filter((p) => p.status === "active")
            .map((p) => service.projectPlan(c, p)),
        );
        return json(200, {
          items: plans.flatMap((p) =>
            p.goals
              .filter((g) => g.status === "no-data")
              .map((g) => ({ planId: p.id, ...g })),
          ),
        });
      }
      if (method === "GET" && !id) {
        if (q.metricKey && q.scope && q.source) {
          const series = {
            metricKey: q.metricKey,
            scope: q.scope,
            source: q.source,
          };
          validSeries(series);
          return json(200, {
            items: await service.seriesSnapshots(c, series, q.from, q.to),
          });
        }
        // Discover series through the latest-value registry, never a table scan.
        const known = await db.listSnapshots(c);
        const derived = (await db.listPlans(c)).flatMap((p) =>
          p.goals.filter((g) => g.source === "dataops"),
        );
        const series = new Map(
          [...known, ...derived]
            .filter(
              (s) =>
                (!q.metricKey || s.metricKey === q.metricKey) &&
                (!q.scope || s.scope === q.scope) &&
                (!q.source || s.source === q.source),
            )
            .map((s) => [db.seriesKey(s), s]),
        );
        const items = (
          await Promise.all(
            [...series.values()].map((s) =>
              service.seriesSnapshots(c, s, q.from, q.to),
            ),
          )
        ).flat();
        return json(200, { items });
      }
    }
    if (family === "plans") {
      if (!id && method === "GET") {
        const plans = (await db.listPlans(c)).filter(
          (p) =>
            (!q.status || p.status === q.status) &&
            (!q.tag || p.tags.includes(q.tag)),
        );
        return json(200, {
          items: await Promise.all(plans.map((p) => service.projectPlan(c, p))),
        });
      }
      if (!id && method === "POST") {
        allowed(b, planFields);
        requireThat(
          b.version === undefined,
          "version is system-owned on creation",
        );
        return json(201, await db.createPlan(c, makePlan(b, actor.id)));
      }
      const p = found(await db.getPlan(c, id));
      if (!action && method === "GET")
        return json(200, await service.projectPlan(c, p, true));
      if (!action && method === "PATCH") {
        allowed(
          b,
          planFields.filter((k) => k !== "id"),
        );
        version(b, p);
        const { version: _, ...changes } = b;
        validatePlan({ ...p, ...changes });
        const next = await db.savePlan(c, p, changes);
        for (const step of await db.listPlanSteps(c, p.id))
          await service.pushStepFacts(c, step, next, actor.id);
        return json(200, next);
      }
      if (action === "notes" && method === "POST") {
        allowed(b, ["text", "ref"]);
        version(b, p);
        requireThat(
          typeof b.text === "string" &&
            !!b.text.trim() &&
            b.text.length <= 4000,
          "Invalid note text",
        );
        return json(
          200,
          await db.savePlan(c, p, {
            notesLog: [
              ...p.notesLog,
              {
                id: randomUUID(),
                text: b.text,
                ...(b.ref ? { ref: b.ref } : {}),
                authorId: actor.id,
                createdAt: new Date().toISOString(),
              },
            ],
          }),
        );
      }
      if (action === "goals") {
        if (ref && method === "GET") {
          const goal = found(p.goals.find((g) => g.ref === ref) || null);
          const view = await service.projectGoal(c, goal);
          if (q.from || q.to)
            view.snapshots = await service.seriesSnapshots(
              c,
              goal,
              q.from,
              q.to,
            );
          return json(200, { ...view, version: p.version, planId: p.id });
        }
        version(b, p);
        let goals = [...p.goals];
        if (!ref && method === "POST") {
          allowed(b, goalFields);
          const { version: _, ...goal } = b;
          validateGoal(goal as any);
          requireThat(
            !goals.some((g) => g.ref === goal.ref),
            "Goal ref already exists",
          );
          goals.push(goal as any);
        } else {
          const existing = found(goals.find((g) => g.ref === ref) || null);
          if (method === "DELETE") {
            requireThat(
              !(await db.listPlanSteps(c, p.id)).some((s) =>
                s.goalRefs.includes(ref),
              ),
              "Goal is referenced by steps",
            );
            goals = goals.filter((g) => g.ref !== ref);
          } else if (method === "PATCH") {
            allowed(
              b,
              goalFields.filter((k) => k !== "ref"),
            );
            const { version: _, ...changes } = b;
            const next = { ...existing, ...changes };
            validateGoal(next);
            goals = goals.map((g) => (g.ref === ref ? next : g));
          } else return json(405, { error: "Method not allowed" });
        }
        validatePlan({ ...p, goals });
        const next = await db.savePlan(c, p, { goals });
        return json(method === "POST" ? 201 : 200, next);
      }
      if (action === "steps" && method === "POST") {
        allowed(b, stepFields);
        version(b, p);
        const { version: _, ...input } = b;
        return json(201, await db.createStep(c, makeStep(input, p), p));
      }
    }
    if (family === "steps") {
      if (!id && method === "GET")
        return json(200, {
          items: service.filterSteps(
            await Promise.all(
              (await db.listSteps(c, q.plan)).map((s) =>
                service.projectStep(c, s),
              ),
            ),
            q,
          ),
        });
      const s = found(await db.getStep(c, id));
      const p = found(await db.getPlan(c, s.planId));
      if (!action && method === "GET")
        return json(200, await service.projectStep(c, s));
      if (action === "utm" && method === "GET") {
        requireThat(s.targetUrl, "Step has no targetUrl");
        const source = q.source || "";
        const mediums: Dict = {
          newsletter: "email",
          linkedin: "social",
          x: "social",
          slack: "community",
          youtube: "video",
          podcast: "audio",
          aishippingblog: "referral",
          reddit: "community",
          hackernews: "community",
          devto: "referral",
          github: "referral",
          outreach: "email",
          test: "test",
        };
        const medium =
          mediums[source] ||
          (/^partner-[a-z0-9-]+$/.test(source) ? "referral" : null);
        requireThat(medium, "Unknown UTM source");
        requireThat(
          !q.placement || /^[a-z0-9-]{1,40}$/.test(q.placement),
          "Invalid placement",
        );
        const u = new URL(s.targetUrl);
        u.search = new URLSearchParams({
          utm_source: source,
          utm_medium: medium,
          utm_campaign: p.id,
          utm_content: s.id + (q.placement ? `-${q.placement}` : ""),
        }).toString();
        return json(200, { url: u.href });
      }
      if (action === "schedule" && method === "POST") {
        allowed(b, [
          "publishDate",
          "mode",
          "template",
          "assignee",
          "linkCardId",
          "publishTaskId",
          "campaignRowId",
          "dryRun",
        ]);
        const next = await service.scheduleStep(c, s, p, b, actor);
        return json(200, {
          ...(await service.projectStep(c, next)),
          capacity: await service.capacity(c, 1, requireWeek(b.publishDate)),
        });
      }
      version(b, s);
      if (!action && method === "PATCH") {
        allowed(
          b,
          stepFields.filter((k) => k !== "key"),
        );
        const { version: _, ...changes } = b;
        const next = { ...s, ...changes };
        validateStep(next, p);
        const saved = await db.saveStep(c, s, changes);
        await service.pushStepFacts(c, saved, p, actor.id);
        return json(200, await service.projectStep(c, saved));
      }
      if (action === "live" && method === "POST") {
        allowed(b, ["url", "date"]);
        requireThat(
          s.kind === "technical" && !s.dropped,
          "Only active technical steps use live",
        );
        requireThat(realDate(b.date), "Invalid date");
        return json(
          200,
          await db.saveStep(c, s, {
            live: { url: normalizeTarget(b.url), date: b.date, by: actor.id },
          }),
        );
      }
      if (action === "drop" && method === "POST") {
        allowed(b, ["reason"]);
        requireThat(
          typeof b.reason === "string" &&
            !!b.reason.trim() &&
            b.reason.length <= 1000,
          "reason is required",
        );
        return json(
          200,
          await db.saveStep(c, s, {
            dropped: {
              at: new Date().toISOString(),
              by: actor.id,
              reason: b.reason,
            },
          }),
        );
      }
    }
    if (family === "import" && method === "POST") {
      allowed(b, ["plan", "goals", "steps", "dryRun"]);
      requireThat(
        b.plan && Array.isArray(b.goals || []) && Array.isArray(b.steps || []),
        "Import needs plan, goals and steps",
      );
      allowed(b.plan, planFields);
      requireThat(
        b.plan.version === undefined,
        "Use the top-level plan version",
      );
      const previous = await db.getPlan(c, b.plan.id);
      const candidate = makePlan({ ...b.plan, goals: b.goals || [] }, actor.id);
      const steps = (b.steps || []).map((input: Dict) => {
        allowed(input, [...stepFields, "id"]);
        requireThat(
          typeof input.key === "string" && /^[a-z0-9-]{1,80}$/.test(input.key),
          "Import steps require a key",
        );
        const { id: importedId, ...fields } = input;
        const step = makeStep(fields, candidate);
        requireThat(
          !importedId || importedId === step.id,
          "Imported id does not match its stable key",
        );
        return step;
      });
      requireThat(
        new Set(steps.map((s: Step) => s.key)).size === steps.length,
        "Duplicate import step key",
      );
      if (previous) version(b, previous);
      if (b.dryRun) return json(200, { plan: candidate, steps, dryRun: true });
      const plan = previous
        ? await db.savePlan(c, previous, { ...b.plan, goals: candidate.goals })
        : await db.createPlan(c, candidate);
      const current = await db.listPlanSteps(c, plan.id);
      const saved = [];
      for (const step of steps) {
        const existing = current.find((s) => s.key === step.key);
        if (existing) {
          const {
            version: _,
            id: __,
            createdAt: ___,
            updatedAt: ____,
            ...fields
          } = step;
          const next = await db.saveStep(c, existing, fields);
          await service.pushStepFacts(c, next, plan, actor.id);
          saved.push(next);
        } else saved.push(await db.createStep(c, step, plan));
      }
      return json(200, { plan, steps: saved });
    }
    return json(404, { error: "Not found" });
  } catch (error) {
    if (error instanceof MarketingError)
      return json(error.status, { error: error.message });
    if (
      [
        "ConditionalCheckFailedException",
        "TransactionCanceledException",
        "TemplateVersionConflictError",
      ].includes((error as Error).name)
    )
      return json(409, { error: "Concurrent change; reload and retry" });
    throw error;
  }
}
import { isoWeek } from "../marketing/model";
function requireWeek(date: string) {
  requireThat(realDate(date), "Invalid publishDate");
  return isoWeek(date);
}
