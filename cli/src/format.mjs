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

export function isoDate(value, flag) {
  if (value === undefined) return undefined;
  const text = String(value);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text) || Number.isNaN(Date.parse(`${text}T00:00:00Z`))) {
    throw new UsageError(`--${flag} must be a date like 2026-01-31.`);
  }
  return text;
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
