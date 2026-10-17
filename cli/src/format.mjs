import { readFileSync } from "node:fs";

import { UsageError } from "./errors.mjs";

/** Print rows as aligned columns. `columns` is [[header, (row) => value], ...]. */
export function table(io, rows, columns, empty = "Nothing to show.") {
  if (!rows.length) {
    io.print(empty);
    return;
  }
  const cells = rows.map((row) => columns.map(([, value]) => clean(value(row))));
  const widths = columns.map(([header], index) =>
    Math.min(60, Math.max(header.length, ...cells.map((line) => line[index].length))),
  );
  const render = (values) =>
    values
      .map((value, index) => (index === values.length - 1 ? value : pad(value, widths[index])))
      .join("  ")
      .trimEnd();
  io.print(render(columns.map(([header]) => header)));
  for (const line of cells) io.print(render(line));
}

/** Print `key: value` lines, skipping empty values. */
export function fields(io, pairs) {
  const shown = pairs.filter(([, value]) => !isEmpty(value));
  const width = Math.max(0, ...shown.map(([key]) => key.length));
  for (const [key, value] of shown) {
    io.print(`${`${key}:`.padEnd(width + 1)} ${Array.isArray(value) ? value.join(", ") : clean(value, 400)}`);
  }
}

function isEmpty(value) {
  return value === undefined || value === null || value === "" || (Array.isArray(value) && !value.length);
}

function clean(value, max = 60) {
  const text = value === undefined || value === null ? "" : String(value).replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function pad(value, width) {
  return value.length >= width ? value.slice(0, width) : value.padEnd(width);
}

/** Positional argument `index`, or a usage error naming what is missing. */
export function positional(args, index, usage) {
  const value = args._[index];
  if (value === undefined || value === "") throw new UsageError(`Usage: ${usage}`);
  return String(value);
}

export function required(args, name, flag) {
  const value = args[name];
  if (value === undefined || value === true || value === "") {
    throw new UsageError(`--${flag} is required.`);
  }
  return String(value);
}

export function optionalString(args, name) {
  const value = args[name];
  if (value === undefined) return undefined;
  if (value === true) throw new UsageError(`--${kebab(name)} needs a value.`);
  return String(value);
}

export function list(value) {
  if (value === undefined) return undefined;
  if (value === true) return [];
  return String(value).split(",").map((item) => item.trim()).filter(Boolean);
}

const WEEKDAY_INDEX = {
  mon: 0, monday: 0,
  tue: 1, tues: 1, tuesday: 1,
  wed: 2, weds: 2, wednesday: 2,
  thu: 3, thur: 3, thurs: 3, thursday: 3,
  fri: 4, friday: 4,
  sat: 5, saturday: 5,
  sun: 6, sunday: 6,
};

/** Civil date (YYYY-MM-DD) in Europe/Berlin for `now` (default: this instant). */
export function berlinToday(now = new Date()) {
  return todayIn("Europe/Berlin", now);
}

/** Civil date (YYYY-MM-DD) in `tz` for `now` (default: this instant). */
export function todayIn(tz, now = new Date()) {
  if (process.env.DATAOPS_TODAY && /^\d{4}-\d{2}-\d{2}$/.test(process.env.DATAOPS_TODAY)) {
    return process.env.DATAOPS_TODAY;
  }
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

/** Add `days` to a YYYY-MM-DD civil date. */
export function addDays(day, days) {
  const date = new Date(`${day}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

/**
 * Resolve a relative date word against `today` (YYYY-MM-DD, Europe/Berlin):
 * `+Nd`/`+N` days ahead, `today`/`tomorrow`/`yesterday`, or a weekday name
 * (`mon` -> the next Monday, strictly after today). Returns undefined when the
 * word is not relative.
 */
export function relativeDate(value, today) {
  const text = String(value).trim().toLowerCase();
  const plus = /^\+(\d+)\s*d(ays?)?$/.exec(text) || /^\+(\d+)$/.exec(text);
  if (plus) return addDays(today, Number(plus[1]));
  if (text === "today") return today;
  if (text === "tomorrow") return addDays(today, 1);
  if (text === "yesterday") return addDays(today, -1);
  if (Object.hasOwn(WEEKDAY_INDEX, text)) {
    const todayDate = new Date(`${today}T00:00:00Z`);
    const todayIndex = (todayDate.getUTCDay() + 6) % 7;
    const delta = ((WEEKDAY_INDEX[text] - todayIndex + 7) % 7) || 7;
    return addDays(today, delta);
  }
  return undefined;
}

function isCalendarDate(text) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (!match) return false;
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  return date.getUTCFullYear() === Number(match[1]) && date.getUTCMonth() === Number(match[2]) - 1 && date.getUTCDate() === Number(match[3]);
}

/** True when `tz` names a real IANA timezone. */
export function isValidTimezone(tz) {
  try {
    new Intl.DateTimeFormat("en-CA", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

function tzOffsetMs(tz, utcMs) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
  }).formatToParts(new Date(utcMs));
  const get = (type) => Number(parts.find((part) => part.type === type)?.value);
  return Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second")) - utcMs;
}

/** A civil `YYYY-MM-DD` + `HH:mm[:ss]` in `tz` as a UTC ISO instant. */
export function civilToUtc(day, time, tz) {
  const [year, month, date] = day.split("-").map(Number);
  const [hour, minute, second] = time.split(":").map(Number);
  const civilAsUtc = Date.UTC(year, month - 1, date, hour, minute, second || 0);
  let guess = civilAsUtc - tzOffsetMs(tz, civilAsUtc);
  for (let round = 0; round < 3; round += 1) {
    const next = civilAsUtc - tzOffsetMs(tz, guess);
    if (next === guess) break;
    guess = next;
  }
  return new Date(guess).toISOString();
}

const CIVIL_DATETIME = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?$/;
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:?\d{2})$/;

function validTime(hour, minute, second) {
  return hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59 && (second === undefined || (second >= 0 && second <= 59));
}

/**
 * Resolve a "not before" moment: an ISO instant with an offset (kept as UTC),
 * a civil `YYYY-MM-DD HH:mm` in `tz`, a plain date (midnight in `tz`), or a
 * relative word (`+7d`, `tomorrow`, `mon` — midnight that day in `tz`).
 * Returns the UTC ISO instant, or undefined when the value has no reading.
 */
export function resolveDateTime(value, tz = "Europe/Berlin", today = todayIn(tz)) {
  const text = String(value).trim();
  if (ISO_INSTANT.test(text)) {
    const ms = Date.parse(text);
    return Number.isNaN(ms) ? undefined : new Date(ms).toISOString();
  }
  const civil = CIVIL_DATETIME.exec(text);
  if (civil) {
    const [, day, hour, minute, second] = civil;
    if (!isCalendarDate(day) || !validTime(Number(hour), Number(minute), second === undefined ? undefined : Number(second))) return undefined;
    return civilToUtc(day, `${hour}:${minute}:${second || "00"}`, tz);
  }
  if (isCalendarDate(text)) return civilToUtc(text, "00:00:00", tz);
  const relative = isCalendarDate(today) ? relativeDate(text, today) : undefined;
  if (relative) return civilToUtc(relative, "00:00:00", tz);
  return undefined;
}

export function isoDate(value, flag, options = {}) {
  if (value === undefined) return undefined;
  const text = String(value).trim();
  if (isCalendarDate(text)) return text;
  const today = options.today || process.env.DATAOPS_TODAY || berlinToday();
  const resolved = isCalendarDate(today) ? relativeDate(text, today) : undefined;
  if (resolved) return resolved;
  throw new UsageError(`--${flag} must be a date like 2026-01-31, +7d, tomorrow, or a weekday like mon.`);
}

export function integer(value, flag) {
  if (value === undefined) return undefined;
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1) throw new UsageError(`--${flag} must be a positive integer.`);
  return number;
}

/**
 * A JSON object from `--data '{...}'`, `--data @file.json`, or `--data -`
 * (stdin). The API validates the contents; this only checks it is an object.
 */
export function jsonData(args, { required: isRequired = true } = {}) {
  const raw = args.data;
  if (raw === undefined || raw === true) {
    if (isRequired) throw new UsageError("--data is required: a JSON object, @file.json, or - for stdin.");
    return undefined;
  }
  const text = raw === "-" ? readFileSync(0, "utf8") : raw.startsWith("@") ? readFileSync(raw.slice(1), "utf8") : raw;
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new UsageError(`--data is not valid JSON: ${error.message}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new UsageError("--data must be a JSON object.");
  }
  return parsed;
}

function kebab(name) {
  return name.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
}

export function enc(value) {
  return encodeURIComponent(value);
}
