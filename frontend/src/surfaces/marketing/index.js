import { escapeHtml } from "../../core/html.js";
import { goalDetailMarkup, stepDetailMarkup } from "./detail.js";
import { planDetailMarkup, planListMarkup } from "./plans.js";
import { weeklyReviewMarkup } from "./review.js";
import {
  berlinToday,
  html,
  normalizeGoalPayload,
  normalizePlanPayload,
  normalizePlansPayload,
  normalizeSnapshotsPayload,
  normalizeStepPayload,
  normalizeStepsPayload,
  seriesKeyForGoal,
} from "./shared.js";

function isPlainLeftClick(event) {
  return (
    event.button === 0 &&
    !event.metaKey &&
    !event.ctrlKey &&
    !event.shiftKey &&
    !event.altKey
  );
}

function formatApiError(error, fallback) {
  if (error?.status === 404) {
    return "Marketing API is not available yet (404).";
  }
  return error?.message || fallback;
}

export function createMarketingSurface(context) {
  const {
    documentList,
    documentRef,
    getActiveWorkspaceRoute,
    navigateCanonicalWorkspace,
    request,
    setRouteTitle,
    todayIsoDate,
    workApiUrl,
  } = context;

  let generation = 0;

  async function renderMarketingSurface() {
    const doc = documentRef || globalThis.document;
    const route = getActiveWorkspaceRoute?.() || { path: "/marketing", params: new URLSearchParams() };
    const path = route.path || "/marketing";
    const params = route.pathParams || {};
    const query = route.params || new URLSearchParams();
    const today = typeof todayIsoDate === "function" ? todayIsoDate() : berlinToday();
    const mine = ++generation;

    documentList.replaceChildren();
    const surface = doc.createElement("section");
    surface.className = "mkt-surface";
    const body = doc.createElement("div");
    body.className = "mkt-body";
    body.setAttribute("aria-live", "polite");
    body.innerHTML = html`<p class="mkt-muted">Loading…</p>`;
    const tooltip = doc.createElement("div");
    tooltip.className = "mkt-tooltip";
    tooltip.setAttribute("role", "status");
    tooltip.hidden = true;
    surface.append(body, tooltip);
    documentList.append(surface);

    let currentPlan = null;
    let currentSteps = [];
    let currentGoalSeriesMap = new Map();
    let activeStepTab = "all";
    let currentStep = null;
    let currentUtmResult = "";

    async function fetchSeriesForGoal(goal) {
      if (!goal?.metricKey || !goal?.scope) return [];
      try {
        const payload = await request(
          workApiUrl("/api/marketing/metrics", {
            metricKey: goal.metricKey,
            scope: goal.scope,
            ...(goal.source ? { source: goal.source } : {}),
          }),
        );
        return normalizeSnapshotsPayload(payload);
      } catch {
        return [];
      }
    }

    async function loadPlanList() {
      setRouteTitle("Marketing");
      try {
        const payload = await request(workApiUrl("/api/marketing/plans"));
        if (mine !== generation) return;
        const plans = normalizePlansPayload(payload);
        body.innerHTML = planListMarkup(plans, today);
      } catch (error) {
        if (mine !== generation) return;
        body.innerHTML = planListMarkup([], today, formatApiError(error, "Could not load marketing plans."));
      }
    }

    async function loadPlanDetail(planId) {
      setRouteTitle(`Marketing · ${planId}`);
      try {
        const payload = await request(
          workApiUrl(`/api/marketing/plans/${encodeURIComponent(planId)}`),
        );
        if (mine !== generation) return;
        const plan = normalizePlanPayload(payload);
        if (!plan) {
          body.innerHTML = html`<p class="dk-callout dk-callout--warning">Plan not found.</p>`;
          return;
        }
        setRouteTitle(`Marketing · ${plan.title || plan.id}`);

        let steps = Array.isArray(plan.steps) ? plan.steps : null;
        if (!steps) {
          try {
            const stepsPayload = await request(
              workApiUrl("/api/marketing/steps", { plan: plan.id }),
            );
            steps = normalizeStepsPayload(stepsPayload);
          } catch {
            steps = [];
          }
        }
        if (mine !== generation) return;

        const seriesMap = new Map();
        const goalsNeedingSeries = (plan.goals || []).filter(
          (g) => !Array.isArray(g.snapshots) && !Array.isArray(g.series),
        );
        if (goalsNeedingSeries.length) {
          const results = await Promise.all(
            goalsNeedingSeries.map(async (g) => [seriesKeyForGoal(g), await fetchSeriesForGoal(g)]),
          );
          for (const [key, series] of results) seriesMap.set(key, series);
        }
        if (mine !== generation) return;

        currentPlan = plan;
        currentSteps = steps;
        currentGoalSeriesMap = seriesMap;
        body.innerHTML = planDetailMarkup(plan, steps, seriesMap, activeStepTab);
      } catch (error) {
        if (mine !== generation) return;
        body.innerHTML = html`<div class="dk-callout dk-callout--warning" role="status">
          ${escapeHtml(formatApiError(error, "Could not load plan."))}
          <button type="button" class="dk-button dk-button--secondary dk-button--sm" data-mkt-retry>Retry</button>
        </div>`;
      }
    }

    async function loadGoalDetail(planId, goalRef) {
      setRouteTitle(`Marketing · ${goalRef}`);
      try {
        const [goalResult, planResult, stepsResult] = await Promise.allSettled([
          request(
            workApiUrl(
              `/api/marketing/plans/${encodeURIComponent(planId)}/goals/${encodeURIComponent(goalRef)}`,
            ),
          ),
          request(workApiUrl(`/api/marketing/plans/${encodeURIComponent(planId)}`)),
          request(workApiUrl("/api/marketing/steps", { plan: planId })),
        ]);
        if (mine !== generation) return;

        const plan =
          planResult.status === "fulfilled" ? normalizePlanPayload(planResult.value) : null;
        let goal = null;
        let snapshots = [];

        if (goalResult.status === "fulfilled") {
          const normalized = normalizeGoalPayload(goalResult.value);
          goal = normalized?.goal || null;
          snapshots = normalized?.snapshots || [];
        } else if (plan) {
          goal = (plan.goals || []).find((g) => g.ref === goalRef) || null;
        }

        if (!goal) {
          const msg =
            goalResult.status === "rejected"
              ? formatApiError(goalResult.reason, "Goal not found.")
              : "Goal not found.";
          body.innerHTML = html`<div class="dk-callout dk-callout--warning" role="status">${escapeHtml(msg)}</div>`;
          return;
        }

        if (!snapshots.length) {
          snapshots = await fetchSeriesForGoal(goal);
          if (mine !== generation) return;
        }

        const allSteps =
          stepsResult.status === "fulfilled" ? normalizeStepsPayload(stepsResult.value) : [];
        const publishedSteps = allSteps.filter((s) => {
          const isPublished = s.status === "published" || s.status === "done" || Boolean(s.publishedAt);
          if (!isPublished) return false;
          if (Array.isArray(s.goalRefs) && s.goalRefs.length) {
            return s.goalRefs.includes(goalRef);
          }
          return true;
        });

        setRouteTitle(`Marketing · ${goal.title || goal.ref}`);
        body.innerHTML = goalDetailMarkup(plan, goal, snapshots, publishedSteps);
      } catch (error) {
        if (mine !== generation) return;
        body.innerHTML = html`<div class="dk-callout dk-callout--warning" role="status">
          ${escapeHtml(formatApiError(error, "Could not load goal."))}
          <button type="button" class="dk-button dk-button--secondary dk-button--sm" data-mkt-retry>Retry</button>
        </div>`;
      }
    }

    async function loadStepDetail(stepId) {
      setRouteTitle(`Marketing · ${stepId}`);
      try {
        const payload = await request(
          workApiUrl(`/api/marketing/steps/${encodeURIComponent(stepId)}`),
        );
        if (mine !== generation) return;
        const step = normalizeStepPayload(payload);
        if (!step) {
          body.innerHTML = html`<p class="dk-callout dk-callout--warning">Step not found.</p>`;
          return;
        }
        currentStep = step;
        let plan = payload?.plan || null;
        if (!plan && step.planId) {
          try {
            plan = normalizePlanPayload(
              await request(workApiUrl(`/api/marketing/plans/${encodeURIComponent(step.planId)}`)),
            );
          } catch {
            plan = null;
          }
        }
        if (mine !== generation) return;
        setRouteTitle(`Marketing · ${step.title || step.id}`);
        body.innerHTML = stepDetailMarkup(step, plan, currentUtmResult);
      } catch (error) {
        if (mine !== generation) return;
        body.innerHTML = html`<div class="dk-callout dk-callout--warning" role="status">
          ${escapeHtml(formatApiError(error, "Could not load step."))}
          <button type="button" class="dk-button dk-button--secondary dk-button--sm" data-mkt-retry>Retry</button>
        </div>`;
      }
    }

    async function loadWeeklyReview() {
      setRouteTitle("Marketing · Weekly Review");
      const week = query?.get?.("week") || "";
      try {
        const [reviewResult, capacityResult] = await Promise.allSettled([
          request(workApiUrl("/api/marketing/review", week ? { week } : {})),
          request(workApiUrl("/api/marketing/capacity", { weeks: 2 })),
        ]);
        if (mine !== generation) return;
        if (reviewResult.status === "rejected") {
          body.innerHTML = weeklyReviewMarkup(
            null,
            null,
            formatApiError(reviewResult.reason, "Could not load weekly review."),
          );
          return;
        }
        const capacity = capacityResult.status === "fulfilled" ? capacityResult.value : null;
        body.innerHTML = weeklyReviewMarkup(reviewResult.value, capacity);
      } catch (error) {
        if (mine !== generation) return;
        body.innerHTML = weeklyReviewMarkup(
          null,
          null,
          formatApiError(error, "Could not load weekly review."),
        );
      }
    }

    async function loadCurrentRoute() {
      if (path === "/marketing/review") return loadWeeklyReview();
      const planId = query?.get?.("planId") || params.planId;
      const goalRef = query?.get?.("goalRef") || params.goalRef;
      const stepId = query?.get?.("stepId") || params.stepId;
      if (planId && goalRef) return loadGoalDetail(planId, goalRef);
      if (planId) return loadPlanDetail(planId);
      if (stepId) return loadStepDetail(stepId);
      return loadPlanList();
    }

    surface.addEventListener("click", (event) => {
      const link = event.target.closest?.("a[data-mkt-nav]");
      if (link && isPlainLeftClick(event)) {
        event.preventDefault();
        navigateCanonicalWorkspace(link.getAttribute("href"));
        return;
      }

      const stepTab = event.target.closest?.("[data-mkt-step-tab]");
      if (stepTab && currentPlan) {
        activeStepTab = stepTab.getAttribute("data-mkt-step-tab") || "all";
        body.innerHTML = planDetailMarkup(
          currentPlan,
          currentSteps,
          currentGoalSeriesMap,
          activeStepTab,
        );
        return;
      }

      if (event.target.closest?.("[data-mkt-open-new-plan]")) {
        surface.querySelector("[data-mkt-new-plan-dialog]")?.showModal?.();
        return;
      }

      if (event.target.closest?.("[data-mkt-open-add-step]")) {
        surface.querySelector("[data-mkt-add-step-dialog]")?.showModal?.();
        return;
      }

      if (event.target.closest?.("[data-mkt-close-dialog]")) {
        event.target.closest("dialog")?.close?.();
        return;
      }

      if (event.target.closest?.("[data-mkt-retry]")) {
        loadCurrentRoute();
        return;
      }

      const decisionBtn = event.target.closest?.("[data-mkt-decision]");
      if (decisionBtn) {
        const planId = decisionBtn.getAttribute("data-plan-id");
        const goalRef = decisionBtn.getAttribute("data-goal-ref");
        if (planId) {
          request(workApiUrl(`/api/marketing/plans/${encodeURIComponent(planId)}/notes`), {
            method: "POST",
            body: JSON.stringify({
              text: `Review decision: ignore ${goalRef || "goal"} for 2 weeks.`,
              ref: "review",
            }),
          })
            .then(() => loadCurrentRoute())
            .catch(() => {});
        }
      }
    });

    surface.addEventListener("submit", async (event) => {
      const form = event.target;
      if (form.matches?.("[data-mkt-new-plan-form]")) {
        event.preventDefault();
        const data = new FormData(form);
        const tagsRaw = String(data.get("tags") || "");
        const tags = tagsRaw
          .split(",")
          .map((t) => t.trim())
          .filter(Boolean);
        await request(workApiUrl("/api/marketing/plans"), {
          method: "POST",
          body: JSON.stringify({
            id: String(data.get("id") || "").trim(),
            title: String(data.get("title") || "").trim(),
            objective: String(data.get("objective") || "").trim() || undefined,
            startDate: String(data.get("startDate") || "").trim() || undefined,
            endDate: String(data.get("endDate") || "").trim() || undefined,
            tags,
          }),
        });
        form.closest("dialog")?.close?.();
        await loadCurrentRoute();
        return;
      }

      if (form.matches?.("[data-mkt-add-step-form]") && currentPlan) {
        event.preventDefault();
        const data = new FormData(form);
        await request(
          workApiUrl(`/api/marketing/plans/${encodeURIComponent(currentPlan.id)}/steps`),
          {
            method: "POST",
            body: JSON.stringify({
              title: String(data.get("title") || "").trim(),
              kind: String(data.get("kind") || "content"),
              size: String(data.get("size") || "S"),
              targetUrl: String(data.get("targetUrl") || "").trim() || undefined,
              primaryKeyword: String(data.get("primaryKeyword") || "").trim() || undefined,
              doneCriteria: String(data.get("doneCriteria") || "").trim(),
              brief: String(data.get("brief") || "").trim() || undefined,
            }),
          },
        );
        form.closest("dialog")?.close?.();
        await loadCurrentRoute();
        return;
      }

      if (form.matches?.("[data-mkt-note-form]") && currentPlan) {
        event.preventDefault();
        const data = new FormData(form);
        const text = String(data.get("text") || "").trim();
        if (!text) return;
        const ref = String(data.get("ref") || "").trim() || undefined;
        await request(
          workApiUrl(`/api/marketing/plans/${encodeURIComponent(currentPlan.id)}/notes`),
          {
            method: "POST",
            body: JSON.stringify({ text, ref }),
          },
        );
        await loadCurrentRoute();
        return;
      }

      if (form.matches?.("[data-mkt-schedule-form]") && currentStep) {
        event.preventDefault();
        const data = new FormData(form);
        await request(
          workApiUrl(`/api/marketing/steps/${encodeURIComponent(currentStep.id)}/schedule`),
          {
            method: "POST",
            body: JSON.stringify({
              publishDate: String(data.get("publishDate") || ""),
              mode: String(data.get("mode") || "card"),
            }),
          },
        );
        await loadCurrentRoute();
        return;
      }

      if (form.matches?.("[data-mkt-live-form]") && currentStep) {
        event.preventDefault();
        const data = new FormData(form);
        await request(
          workApiUrl(`/api/marketing/steps/${encodeURIComponent(currentStep.id)}/live`),
          {
            method: "POST",
            body: JSON.stringify({
              url: String(data.get("url") || "").trim() || undefined,
              date: String(data.get("date") || "").trim() || undefined,
            }),
          },
        );
        await loadCurrentRoute();
        return;
      }

      if (form.matches?.("[data-mkt-drop-form]") && currentStep) {
        event.preventDefault();
        const data = new FormData(form);
        await request(
          workApiUrl(`/api/marketing/steps/${encodeURIComponent(currentStep.id)}/drop`),
          {
            method: "POST",
            body: JSON.stringify({
              reason: String(data.get("reason") || "").trim(),
            }),
          },
        );
        await loadCurrentRoute();
        return;
      }

      if (form.matches?.("[data-mkt-utm-form]") && currentStep) {
        event.preventDefault();
        const data = new FormData(form);
        const source = String(data.get("source") || "linkedin");
        const payload = await request(
          workApiUrl(`/api/marketing/steps/${encodeURIComponent(currentStep.id)}/utm`, { source }),
        );
        currentUtmResult = payload?.url || payload?.utmUrl || "";
        await loadCurrentRoute();
      }
    });

    surface.addEventListener("pointerover", (event) => {
      const mark = event.target.closest?.("[data-mkt-hover]");
      if (!mark) return;
      tooltip.textContent = mark.getAttribute("data-mkt-hover");
      tooltip.hidden = false;
    });

    surface.addEventListener("pointermove", (event) => {
      if (tooltip.hidden) return;
      const box = surface.getBoundingClientRect();
      tooltip.style.left = `${Math.min(event.clientX - box.left + 12, box.width - 240)}px`;
      tooltip.style.top = `${event.clientY - box.top + 12}px`;
    });

    surface.addEventListener("pointerout", (event) => {
      if (
        event.target.closest?.("[data-mkt-hover]") &&
        !event.relatedTarget?.closest?.("[data-mkt-hover]")
      ) {
        tooltip.hidden = true;
      }
    });

    await loadCurrentRoute();
  }

  return { renderMarketingSurface };
}
