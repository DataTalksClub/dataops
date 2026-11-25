import { randomUUID } from "crypto";
import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { getTask, listTasksByCard, updateTask } from "../db/tasks";
import { getCard } from "../db/cards";
import { listTemplates } from "../db/templates";
import { getCampaignCalendarRow } from "../db/campaignCalendar";
import { createCardFromInput } from "../cards/createCard";
import { pushFieldsToCard } from "../cards/recordCardLink";
import { redateCardTemplateTasks } from "../cards/redateTemplateTasks";
import { putNew } from "../db/plannedWrite";
import { TABLE_TASKS } from "../db/tableNames";
import {
  nextRecord,
  saveStep,
  stepPlannedWrite,
  listSnapshots,
  listPlans,
  listSteps,
} from "../db/marketing";
import { normalizePageview } from "../academyLeads/pageviews";
import { scanAcademySignups } from "../academyLeads/service";
import { listNewsletterIssues } from "../db/newsletterIssues";
import { berlinToday } from "../calendar/ownerCalendarOverlay";
import { TeamDirectory } from "../identity/directory";
import type { VerifiedActor } from "../identity/actor";
import {
  MarketingError,
  requireThat,
  periodRange,
  isoWeek,
  goalProgress,
  WEEKLY_LIMIT,
  type Dict,
  type Plan,
  type Step,
  type Snapshot,
  type Goal,
} from "./model";
import { realDate } from "../sponsorCrm/model";

export const stepTags = (s: Step, p: Plan) => [
  ...new Set([...p.tags, ...s.tags, "marketing", `plan:${p.id}`]),
];
export const stepDescription = (s: Step) =>
  [
    s.brief || "",
    `Done when: ${s.doneCriteria}`,
    s.primaryKeyword ? `Primary keyword: ${s.primaryKeyword}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");
export async function projectStep(
  c: DynamoDBDocumentClient,
  s: Step,
): Promise<Step & { status: string }> {
  if (s.dropped) return { ...s, status: "dropped" };
  if (s.live)
    return {
      ...s,
      status: "published",
      publishedAt: s.live.date,
      publishedUrl: s.live.url,
    };
  if (s.campaignRowId) {
    const row = await getCampaignCalendarRow(c, s.campaignRowId);
    const published = !!row && /^(published|sent|done)$/i.test(row.status);
    return {
      ...s,
      status: published ? "published" : "scheduled",
      ...(published
        ? { publishedAt: row.updatedAt, publishedUrl: s.targetUrl }
        : {}),
    };
  }
  if (s.taskId) {
    const task = await getTask(c, s.taskId);
    return {
      ...s,
      status:
        task?.status === "done" || task?.status === "skipped"
          ? "done"
          : "scheduled",
      ...(task?.status === "done"
        ? {
            publishedAt: task.completedAt,
            publishedUrl: task.link || s.targetUrl,
          }
        : {}),
      task,
    };
  }
  if (!s.cardId) return { ...s, status: "planned" };
  const [card, tasks] = await Promise.all([
    getCard(c, s.cardId),
    listTasksByCard(c, s.cardId),
  ]);
  const publish = tasks.find((t) =>
    s.publishTaskId
      ? t.id === s.publishTaskId
      : t.templateTaskRef === "publish",
  );
  const done =
    tasks.length > 0 &&
    tasks.every((t) => ["done", "skipped"].includes(t.status));
  return {
    ...s,
    publishTaskId: publish?.id,
    status: done
      ? "done"
      : publish?.status === "done"
        ? "published"
        : tasks.some((t) => t.status === "done")
          ? "in-progress"
          : "scheduled",
    ...(publish?.status === "done"
      ? {
          publishedAt: publish.completedAt,
          publishedUrl: publish.link || s.targetUrl,
        }
      : {}),
    card,
  };
}
export async function pushStepFacts(
  c: DynamoDBDocumentClient,
  s: Step,
  p: Plan,
  actorId: string,
) {
  if (s.cardId && s.mode === "card") {
    const card = await pushFieldsToCard(
      c,
      s.cardId,
      {
        title: s.title,
        description: stepDescription(s),
        targetUrl: s.targetUrl || "",
        tags: stepTags(s, p),
        anchorDate: s.publishDate,
      },
      {},
    );
    if (card) await redateCardTemplateTasks(c, card, { actorId });
  }
  if (s.taskId) {
    const task = await getTask(c, s.taskId);
    if (task)
      await updateTask(c, task.id, {
        expectedVersion: task.version,
        currentTask: task,
        patch: {
          description: s.title,
          date: s.publishDate,
          assigneeId: s.ownerId,
          tags: stepTags(s, p),
          comment: stepDescription(s),
          link: s.targetUrl || null,
        },
        actorId,
      });
  }
}
export async function scheduleStep(
  c: DynamoDBDocumentClient,
  s: Step,
  p: Plan,
  b: Dict,
  actor: VerifiedActor,
) {
  requireThat(realDate(b.publishDate), "publishDate is required");
  const mode =
    b.mode ||
    (s.kind === "social" || ["newsletter", "podcast"].includes(s.kind)
      ? "link"
      : ["content", "refresh"].includes(s.kind)
        ? "card"
        : "task");
  requireThat(["card", "task", "link"].includes(mode), "Invalid mode");
  requireThat(s.kind !== "technical", "Technical steps use live");
  if (s.cardId || s.taskId || s.campaignRowId) {
    requireThat(
      s.publishDate === b.publishDate &&
        s.mode === mode &&
        (!b.campaignRowId || b.campaignRowId === s.campaignRowId) &&
        (!b.linkCardId || b.linkCardId === s.cardId),
      "Already scheduled differently",
    );
    return s;
  }
  if (b.version !== s.version)
    throw new MarketingError("Step changed; reload and retry", 409);
  requireThat(!s.dropped, "Cannot schedule a dropped step");
  const changes: Dict = {
    publishDate: b.publishDate,
    mode,
    ownerId: b.assignee || s.ownerId,
  };
  if (!actor.testBypass) {
    const owner = await new TeamDirectory(c).project(changes.ownerId);
    requireThat(owner.active, "assignee must reference an active team member");
    requireThat(
      actor.isAdmin || changes.ownerId === actor.id,
      "Only an admin may assign work to another team member",
    );
  }
  const preview = () => ({ ...s, proposed: b, dryRun: true });
  if (s.kind === "social") {
    requireThat(
      mode === "link" && typeof b.campaignRowId === "string",
      "Social steps must link an existing campaignRowId",
    );
    requireThat(
      await getCampaignCalendarRow(c, b.campaignRowId),
      "Campaign calendar row not found",
    );
    if (b.dryRun) return preview();
    return saveStep(c, s, { ...changes, campaignRowId: b.campaignRowId });
  }
  if (mode === "link") {
    requireThat(
      typeof b.linkCardId === "string" && typeof b.publishTaskId === "string",
      "linkCardId and publishTaskId are required",
    );
    const [card, task] = await Promise.all([
      getCard(c, b.linkCardId),
      getTask(c, b.publishTaskId),
    ]);
    requireThat(
      card && task && task.cardId === card.id,
      "Publish task must belong to the linked Card",
    );
    if (b.dryRun) return preview();
    return saveStep(c, s, {
      ...changes,
      cardId: card.id,
      publishTaskId: task.id,
    });
  }
  if (mode === "task") {
    if (b.dryRun) return preview();
    const id = randomUUID();
    const now = new Date().toISOString();
    return saveStep(c, s, { ...changes, taskId: id, publishTaskId: id }, [
      putNew(
        TABLE_TASKS,
        { PK: `TASK#${id}`, SK: `TASK#${id}` },
        {
          id,
          description: s.title,
          date: b.publishDate,
          assigneeId: changes.ownerId,
          status: "todo",
          subject: { type: "marketing-step", id: `${s.planId}:${s.id}` },
          proofRequirement: s.kind === "outreach" ? "comment" : "url",
          comment: stepDescription(s),
          ...(s.targetUrl ? { link: s.targetUrl } : {}),
          tags: stepTags(s, p),
          createdBy: actor.id,
          version: 1,
          taskHistory: [],
          createdAt: now,
          updatedAt: now,
        },
      ).item,
    ]);
  }
  const type =
    b.template ||
    (s.size === "L" ? "marketing-content-large" : "marketing-content");
  const template = (await listTemplates(c)).find(
    (t) => t.type === type || t.id === type,
  );
  requireThat(template, `No ${type} Template is available`);
  // A research-to-verify chain must be instantiated together inside one Card.
  const refs = (template.taskDefinitions || []).map((t) => t.refId);
  requireThat(
    ["research", "draft", "review", "publish", "verify"].every((r) =>
      refs.includes(r),
    ),
    "Marketing content Template must include research, draft, review, publish and verify",
  );
  if (b.dryRun) return preview();
  let next = s;
  const result = await createCardFromInput(
    c,
    actor,
    {
      templateId: template.id,
      title: s.title,
      description: stepDescription(s),
      anchorDate: b.publishDate,
      ownerId: changes.ownerId,
      tags: stepTags(s, p),
      cardLinks: s.targetUrl ? [{ name: "Target URL", url: s.targetUrl }] : [],
    },
    {
      companions: (card) => {
        next = nextRecord(s, { ...changes, cardId: card.id });
        return [stepPlannedWrite(s, next)];
      },
    },
  );
  if (!result.ok)
    throw new MarketingError(
      JSON.parse(result.response.body).error,
      result.response.statusCode,
    );
  return next;
}

/** Aggregate only existing non-test pageview counters; never read signup records. */
export function accumulateAcademyVisits(
  items: Record<string, unknown>[],
  scopeText: string,
  start: string,
  end: string,
  values = new Map<string, number>(),
) {
  const rows = items
    .map(normalizePageview)
    .filter((r) => r && !r.is_test && r.date >= start && r.date <= end);
  const [kind, ...rest] = scopeText.split(":");
  const scope = rest.join(":");
  for (const r of rows) {
    if (!r) continue;
    const match =
      kind === "site" ||
      (kind === "track" && r.track === scope) ||
      (kind === "page" && r.page === scope) ||
      (kind === "prefix" && r.page.startsWith(scope)) ||
      (kind === "utm_content" && r.utm_content === scope) ||
      (kind === "utm_campaign" && r.utm_campaign === scope);
    if (match)
      values.set(isoWeek(r.date), (values.get(isoWeek(r.date)) || 0) + r.count);
  }
  return values;
}

export async function seriesSnapshots(
  c: DynamoDBDocumentClient,
  series: Pick<Snapshot, "metricKey" | "scope" | "source">,
  from?: string,
  to?: string,
) {
  if (series.source !== "dataops")
    return (await listSnapshots(c, series)).filter(
      (s) =>
        (!from || periodRange(s.period).to >= from) &&
        (!to || periodRange(s.period).from <= to),
    );
  const end = to || berlinToday();
  const start =
    from ||
    new Date(+new Date(end) - 365 * 86400000).toISOString().slice(0, 10);
  const values = new Map<string, number>();
  // Complete empty weeks are known zeros, not missing observations.
  for (let d = +new Date(start); d <= +new Date(end); d += 7 * 86400000)
    values.set(isoWeek(new Date(d).toISOString()), 0);
  values.set(isoWeek(end), 0);
  if (series.metricKey === "academy_visits") {
    accumulateAcademyVisits(
      await scanAcademySignups({ prefix: "PV#" }),
      series.scope,
      start,
      end,
      values,
    );
  } else if (series.metricKey === "newsletter_clicks") {
    for (const issue of await listNewsletterIssues(c, start, end)) {
      if (
        series.scope !== "site" &&
        series.scope !== `issue:${issue.id}` &&
        series.scope !== `card:${issue.cardId}`
      )
        continue;
      if (issue.stats?.clicks !== undefined)
        values.set(
          isoWeek(issue.publicationDate),
          (values.get(isoWeek(issue.publicationDate)) || 0) +
            issue.stats.clicks,
        );
    }
  } else throw new MarketingError("Unknown derived metric");
  return [...values]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(
      ([period, value]) =>
        ({
          ...series,
          period,
          periodStart: periodRange(period).from,
          periodEnd: periodRange(period).to,
          value,
          unit: "count",
          version: 1,
          derived: true,
        }) as Snapshot,
    );
}
export async function projectGoal(
  c: DynamoDBDocumentClient,
  g: Goal,
  now?: Date,
) {
  const snapshots = await seriesSnapshots(c, g);
  return { ...g, ...goalProgress(g, snapshots, now), snapshots };
}
export async function projectPlan(
  c: DynamoDBDocumentClient,
  p: Plan,
  withSteps = false,
) {
  return {
    ...p,
    goals: await Promise.all(p.goals.map((g) => projectGoal(c, g))),
    ...(withSteps
      ? {
          steps: await Promise.all(
            (await listSteps(c, p.id)).map((s) => projectStep(c, s)),
          ),
        }
      : {}),
  };
}
export function filterSteps(steps: Dict[], q: Dict) {
  return steps.filter(
    (s) =>
      ["status", "kind", "size"].every((k) => !q[k] || s[k] === q[k]) &&
      (!q.owner || s.ownerId === q.owner) &&
      (!q.tag || s.tags.includes(q.tag)) &&
      (!q.week || (s.publishDate && isoWeek(s.publishDate) === q.week)) &&
      (!q.published || (q.published === "true") === !!s.publishedAt) &&
      (!q.overdue ||
        (q.overdue === "true") ===
          !!(
            s.publishDate &&
            s.publishDate < berlinToday() &&
            !["done", "published", "dropped"].includes(s.status)
          )) &&
      ["target_url", "primary_keyword", "done_criteria"].every(
        (k) =>
          !q[k] ||
          String(
            s[
              (
                {
                  target_url: "targetUrl",
                  primary_keyword: "primaryKeyword",
                  done_criteria: "doneCriteria",
                } as Dict
              )[k]
            ] || "",
          )
            .toLowerCase()
            .includes(String(q[k]).toLowerCase()),
      ),
  );
}
export async function capacity(
  c: DynamoDBDocumentClient,
  weeks = 6,
  first = isoWeek(berlinToday()),
) {
  requireThat(
    Number.isInteger(weeks) && weeks > 0 && weeks <= 52,
    "weeks must be 1 to 52",
  );
  const steps = await Promise.all(
    (await listSteps(c)).map((s) => projectStep(c, s)),
  );
  const reviewCards = [
    ...new Set(
      steps
        .filter((s) => s.mode === "card" && s.cardId && !s.dropped)
        .map((s) => String(s.cardId)),
    ),
  ];
  const reviewTasks = (
    await Promise.all(reviewCards.map((id) => listTasksByCard(c, id)))
  )
    .flat()
    .filter((t) => t.templateTaskRef === "review" && t.status !== "skipped");
  const start = periodRange(first).from;
  const items = Array.from({ length: weeks }, (_, i) => {
    const week = isoWeek(
      new Date(+new Date(start) + i * 7 * 86400000).toISOString(),
    );
    const scheduled = steps.filter(
      (s) =>
        s.publishDate &&
        isoWeek(s.publishDate) === week &&
        !["planned", "dropped"].includes(s.status),
    );
    return {
      week,
      small: scheduled.filter((s) => s.size === "S").length,
      large: scheduled.filter((s) => s.size === "L").length,
      count: scheduled.length,
      reviews: reviewTasks.filter((t) => t.date && isoWeek(t.date) === week)
        .length,
      limit: WEEKLY_LIMIT,
      warning:
        reviewTasks.filter((t) => t.date && isoWeek(t.date) === week).length >
        WEEKLY_LIMIT,
    };
  });
  return { items, weeklyLimit: WEEKLY_LIMIT };
}
export async function weeklyReview(
  c: DynamoDBDocumentClient,
  week = isoWeek(berlinToday()),
) {
  const range = periodRange(week);
  const plans = await Promise.all(
    (await listPlans(c))
      .filter((p) => p.status === "active")
      .map((p) => projectPlan(c, p, true)),
  );
  const steps = plans.flatMap((p) => p.steps || []);
  return {
    week,
    ...range,
    plans,
    missing: plans.flatMap((p) =>
      p.goals
        .filter((g) => g.status === "no-data")
        .map((g) => ({ planId: p.id, ...g })),
    ),
    due: steps.filter(
      (s) =>
        s.publishDate &&
        s.publishDate >= range.from &&
        s.publishDate <= range.to,
    ),
    overdue: filterSteps(steps, { overdue: "true" }),
    shipped: steps.filter(
      (s) =>
        s.publishedAt &&
        isoWeek(s.publishedAt) ===
          isoWeek(new Date(+new Date(range.from) - 7 * 86400000).toISOString()),
    ),
    idle: plans
      .filter(
        (p) =>
          !p.steps?.some(
            (s) =>
              s.publishDate &&
              s.publishDate >= range.from &&
              s.publishDate <=
                new Date(+new Date(range.from) + 14 * 86400000)
                  .toISOString()
                  .slice(0, 10),
          ),
      )
      .map((p) => p.id),
    stale: steps.filter(
      (s) =>
        s.status === "planned" &&
        +new Date(range.from) - +new Date(s.createdAt) > 42 * 86400000,
    ),
    capacity: await capacity(c, 2, week),
  };
}
