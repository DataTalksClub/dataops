import { UsageError } from "../errors.mjs";
import { positional } from "../format.mjs";
import { apiFor } from "../session.mjs";

export const summary = "Scheduled and triggered automations, and the settings they read";

export const help = `dataops automations - what runs on its own (the web Recurring > Automations view)

First the Cards that get created automatically and when, then every
automation the portal knows about: the daily job's parts (recurring
tasks, template and newsletter Cards, sponsor alerts), the nightly exports and
backups, the knowledge jobs and the GitHub workflows. Each shows when it runs,
where, its next run, and its last run where the portal can see one.
Internal plumbing is marked [system].

Usage
  dataops automations list
  dataops automations set <setting> <value>     Admin only

<setting> is a key shown by list, for example:
  dataops automations set newsletterCardLeadDays 21
  dataops automations set sponsorMaterialsReminderDays 14,10,3
  dataops automations set sponsorFollowUpDays 7
`;

function utc(iso) {
  return iso ? `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC` : "";
}

function settingValue(setting) {
  if (setting.kind === "day-list") {
    const days = Array.isArray(setting.value) ? setting.value : [];
    return days.length ? `${days.join(", ")} days` : "none";
  }
  return `${setting.value} days`;
}

export async function list(args, io) {
  const result = await apiFor(args).get("/api/automations");
  if (args.json) return result;
  for (const card of result.cards || []) {
    io.print(`${card.id}  ${card.name}`);
    const when = [card.scheduleLabel];
    if (card.nextRunAt) when.push(`next ${utc(card.nextRunAt)}`);
    if (card.lastRun) {
      const outcome = card.lastRun.ok ? "ok" : "FAILED";
      when.push(`last ${utc(card.lastRun.at)} ${outcome}: ${card.lastRun.summary}`);
    }
    io.print(`  ${when.join(" | ")}`);
    io.print(`  Lead time: ${card.leadTime}`);
    io.print(`  ${card.skipRule}`);
    if (card.templateLink) io.print(`  Template: ${card.templateLink}`);
  }
  for (const automation of result.automations || []) {
    io.print(`${automation.id}  ${automation.name}${automation.system ? " [system]" : ""}`);
    const when = [automation.scheduleLabel];
    if (automation.nextRunAt) when.push(`next ${utc(automation.nextRunAt)}`);
    if (automation.lastRun) {
      const outcome = automation.lastRun.ok ? "ok" : "FAILED";
      when.push(`last ${utc(automation.lastRun.at)} ${outcome}: ${automation.lastRun.summary}`);
    } else if (automation.link) {
      when.push(`runs: ${automation.link}`);
    }
    io.print(`  ${when.join(" | ")}`);
    io.print(`  ${automation.runsIn}`);
    for (const setting of automation.settings || []) {
      io.print(`  ${setting.label} (${setting.key}): ${settingValue(setting)}`);
    }
  }
  return result;
}

function parseDays(raw, key) {
  const days = Number(raw);
  if (!/^\d+$/.test(String(raw).trim()) || !Number.isInteger(days)) {
    throw new UsageError(`${key} takes a whole number of days, 0 or more.`);
  }
  return days;
}

export async function set(args, io) {
  const usage = "dataops automations set <setting> <value>";
  const key = positional(args, 0, usage);
  const raw = positional(args, 1, usage);
  const api = apiFor(args);
  const overview = await api.get("/api/automations");
  const setting = (overview.automations || [])
    .flatMap((automation) => automation.settings || [])
    .find((candidate) => candidate.key === key);
  if (!setting) {
    const keys = [...new Set((overview.automations || []).flatMap((automation) => (automation.settings || []).map((s) => s.key)))];
    throw new UsageError(`${key} is not an automation setting. Settings: ${keys.join(", ")}.`);
  }
  const value = setting.kind === "day-list"
    ? String(raw).split(",").map((part) => part.trim()).filter(Boolean).map((part) => parseDays(part, key))
    : parseDays(raw, key);
  const result = await api.put("/api/workspace-settings", {
    [key]: value,
    expectedVersion: overview.settingsVersion,
  });
  if (!args.json) io.print(`${setting.label} (${key}) is now ${settingValue({ ...setting, value: result[key] })}.`);
  return result;
}

export const commands = { list, set };
