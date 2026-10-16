import "../../dakit/collection.js";
import { setControlPending } from "../operations-overview.js";

// What runs on its own, next to the recurring schedules: the daily job's
// parts, exports and backups, knowledge jobs and GitHub workflows. The server
// owns the list, the schedules and the run history; this only renders them
// and lets an admin change the settings an automation reads.

const ICONS = Object.freeze({
  ok: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="m9.5 12 1.8 1.8 3.4-3.6"/></svg>',
  failed:
    '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 7.5v5.5M12 16.5v.01"/></svg>',
  idle: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M8.5 12h7"/></svg>',
  cadence:
    '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>',
  next: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="5" width="18" height="16" rx="2"/><path d="M8 3v4M16 3v4M3 10h18"/></svg>',
  last: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 12a8 8 0 1 0 2.4-5.7"/><path d="M4 4v4h4"/></svg>',
  where:
    '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="4" y="4" width="16" height="7" rx="1.5"/><rect x="4" y="13" width="16" height="7" rx="1.5"/></svg>',
});

const BERLIN_TIME = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Europe/Berlin",
  hour: "2-digit",
  minute: "2-digit",
  timeZoneName: "short",
});
const BERLIN_DAY = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Europe/Berlin",
  weekday: "short",
  day: "numeric",
  month: "short",
});

function icon(name) {
  const span = document.createElement("span");
  span.className = "recurring-icon";
  span.setAttribute("aria-hidden", "true");
  span.innerHTML = ICONS[name];
  return span;
}

function text(tag, className, value) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  node.textContent = value;
  return node;
}

/** `Sat 17 Oct, 10:00 CEST` in the workspace zone. */
export function berlinMoment(iso) {
  const instant = new Date(iso);
  if (Number.isNaN(instant.getTime())) return "";
  return `${BERLIN_DAY.format(instant)}, ${BERLIN_TIME.format(instant)}`;
}

/** A daily schedule reads in Berlin time like the rest of the page; anything else as the server says it. */
export function automationCadence(automation) {
  const label = String(automation.scheduleLabel || "");
  if (/^Daily at \d{2}:\d{2} UTC$/.test(label) && automation.nextRunAt) {
    return `Daily at ${BERLIN_TIME.format(new Date(automation.nextRunAt))}`;
  }
  return label;
}

export function automationLastRun(automation) {
  const run = automation.lastRun;
  if (!run) return "";
  const when = berlinMoment(run.at);
  if (run.source === "knowledge-checkpoint") return `Last success ${when}`;
  return run.ok ? `Last run ${when}: ${run.summary}` : `Failed ${when}: ${run.summary}`;
}

export function settingValueLabel(setting) {
  if (setting.kind === "day-list") {
    const days = Array.isArray(setting.value) ? setting.value : [];
    return days.length ? `${days.join(", ")} days` : "None";
  }
  const days = Number(setting.value);
  return `${days} ${days === 1 ? "day" : "days"}`;
}

/** The value to send for what was typed, or an error message. */
export function parseSettingInput(setting, raw) {
  const parts = String(raw).split(",").map((part) => part.trim()).filter(Boolean);
  if (setting.kind !== "day-list" && parts.length !== 1) return { error: "Enter a whole number of days." };
  if (!parts.every((part) => /^\d+$/.test(part))) return { error: "Use whole numbers of days, 0 or more." };
  const days = parts.map(Number);
  return { value: setting.kind === "day-list" ? days : days[0] };
}

export function createAutomations(context) {
  const { request, workApiUrl } = context;
  const state = { loaded: false, loading: null, error: "", data: null, editing: "", editError: "" };
  const section = document.createElement("section");
  section.className = "ops-section ops-recurring-section ops-automations-section";
  section.setAttribute("aria-label", "Automations");

  async function load() {
    state.loading = (async () => {
      try {
        state.data = await request(workApiUrl("/api/automations"));
        state.error = "";
      } catch (error) {
        state.error = error?.message || "Automations could not be loaded.";
      }
      state.loaded = true;
      state.loading = null;
      paint();
    })();
    return state.loading;
  }

  function renderAutomationsSection() {
    if (!state.loaded && !state.loading) load();
    paint();
    return section;
  }

  function paint() {
    const automations = Array.isArray(state.data?.automations) ? state.data.automations : [];
    section.replaceChildren(globalThis.dakitCollection.header({
      title: "Automations",
      level: "h3",
      className: "recurring-section-header",
      meta: state.loaded && !state.error
        ? `${automations.length} ${automations.length === 1 ? "automation" : "automations"}`
        : state.error ? "Not loaded" : "Loading…",
    }));
    if (state.error) {
      section.append(text("p", "ops-empty", `Automations could not be loaded: ${state.error}`));
      return;
    }
    if (!state.loaded) {
      section.append(text("p", "ops-empty", "Loading automations…"));
      return;
    }
    const list = document.createElement("ul");
    list.className = "ops-recurring-list";
    for (const automation of automations) list.append(renderItem(automation));
    section.append(list);
    section.append(text(
      "footer",
      "recurring-section-footer",
      "Times are Europe/Berlin. Settings are the values the jobs read; only admins can change them.",
    ));
  }

  function renderItem(automation) {
    const item = document.createElement("li");
    item.className = "ops-recurring-item automation-item";
    item.dataset.automationId = automation.id;
    const outcome = !automation.lastRun ? "idle" : automation.lastRun.ok ? "ok" : "failed";
    item.classList.add(`is-${outcome}`);

    const status = document.createElement("span");
    status.className = "recurring-status automation-status";
    const statusLabel = { ok: "Last run succeeded", failed: "Last run failed", idle: "No run recorded" }[outcome];
    status.title = statusLabel;
    status.append(icon(outcome), text("span", "visually-hidden", statusLabel));

    const body = document.createElement("div");
    body.className = "recurring-item-text";
    body.append(text("strong", "", automation.name));
    body.append(text("p", "automation-description", automation.description));

    const facts = document.createElement("div");
    facts.className = "recurring-item-facts";
    const factList = [
      ["cadence", automationCadence(automation)],
      ["next", automation.nextRunAt ? `Next ${berlinMoment(automation.nextRunAt)}` : ""],
      ["last", automationLastRun(automation)],
      ["where", automation.runsIn],
    ];
    for (const [name, value] of factList) {
      if (!value) continue;
      const fact = document.createElement("span");
      fact.className = `recurring-fact recurring-fact-${name}`;
      fact.append(icon(name), text("span", "", value));
      facts.append(fact);
    }
    if (automation.link) {
      const link = text("a", "recurring-fact automation-link", "Runs on GitHub");
      link.href = automation.link;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      facts.append(link);
    }
    body.append(facts);

    if (automation.settings?.length) {
      const settings = document.createElement("div");
      settings.className = "automation-settings";
      for (const setting of automation.settings) settings.append(renderSetting(automation, setting));
      body.append(settings);
    }
    item.append(status, body);
    return item;
  }

  function renderSetting(automation, setting) {
    const editKey = `${automation.id}:${setting.key}`;
    const row = document.createElement("div");
    row.className = "automation-setting";
    row.title = setting.description;
    if (state.editing !== editKey) {
      row.append(text("span", "automation-setting-label", `${setting.label}:`));
      row.append(text("span", "automation-setting-value", settingValueLabel(setting)));
      if (state.data?.canEdit) {
        const edit = text("button", "task-action-btn", "Edit");
        edit.type = "button";
        edit.setAttribute("aria-label", `Edit ${setting.label} of ${automation.name}`);
        edit.addEventListener("click", () => {
          state.editing = editKey;
          state.editError = "";
          paint();
          section.querySelector(".automation-setting-form input")?.focus();
        });
        row.append(edit);
      }
      return row;
    }

    const form = document.createElement("form");
    form.className = "automation-setting-form";
    const label = text("label", "automation-setting-label", `${setting.label}:`);
    const input = document.createElement("input");
    input.className = "dk-input";
    input.id = `automation-setting-${automation.id}-${setting.key}`;
    label.htmlFor = input.id;
    input.value = Array.isArray(setting.value) ? setting.value.join(", ") : String(setting.value ?? "");
    input.inputMode = "numeric";
    input.setAttribute("aria-describedby", `${input.id}-hint`);
    const hint = text(
      "span",
      "automation-setting-hint",
      setting.kind === "day-list" ? `${setting.description} Comma-separated.` : setting.description,
    );
    hint.id = `${input.id}-hint`;
    const save = text("button", "task-action-btn is-primary", "Save");
    save.type = "submit";
    const cancel = text("button", "task-action-btn", "Cancel");
    cancel.type = "button";
    cancel.addEventListener("click", () => {
      state.editing = "";
      state.editError = "";
      paint();
    });
    form.addEventListener("submit", (event) => {
      event?.preventDefault?.();
      saveSetting(setting, input.value, save);
    });
    form.append(label, input, save, cancel, hint);
    if (state.editError) {
      const error = text("p", "recurring-row-error automation-setting-error", state.editError);
      error.setAttribute("role", "alert");
      form.append(error);
    }
    row.append(form);
    return row;
  }

  async function saveSetting(setting, raw, button) {
    const parsed = parseSettingInput(setting, raw);
    if (parsed.error) {
      state.editError = parsed.error;
      paint();
      return;
    }
    setControlPending(button, { pending: true, pendingLabel: "Saving…" });
    try {
      await request(workApiUrl("/api/workspace-settings"), {
        method: "PUT",
        body: JSON.stringify({ [setting.key]: parsed.value, expectedVersion: state.data?.settingsVersion ?? 0 }),
      });
      state.editing = "";
      state.editError = "";
      await load();
    } catch (error) {
      state.editError = error?.status === 409
        ? "Someone changed the settings since this page loaded. Cancel, then try again."
        : `Could not save: ${error?.message || "request failed"}`;
      if (error?.status === 409) await load();
      else paint();
    }
  }

  return { renderAutomationsSection, reloadAutomations: load };
}
