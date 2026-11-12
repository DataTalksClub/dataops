// Markdown tables as data: parse a table block's markdown into cells, edit
// the cells, write them back. Cell text stays inline markdown source (with
// "\|" for a literal pipe), so links and formatting survive untouched. A
// table that is not edited keeps its original markdown byte for byte; only
// an edit rewrites it in the canonical "| a | b |" form.

const SEPARATOR_CELL = /^:?-+:?$/;

/** Split one table line into trimmed cells, honouring "\|". */
export function splitTableRow(line) {
  let text = line.trim();
  if (text.startsWith("|")) text = text.slice(1);
  if (text.endsWith("|") && !text.endsWith("\\|")) text = text.slice(0, -1);
  const cells = [];
  let current = "";
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] === "\\" && text[i + 1] === "|") {
      current += "\\|";
      i += 1;
    } else if (text[i] === "|") {
      cells.push(current.trim());
      current = "";
    } else {
      current += text[i];
    }
  }
  cells.push(current.trim());
  return cells;
}

/** True when `line` is a delimiter row ("| --- | :-: |") for `columns` columns. */
export function isSeparatorRow(line, columns) {
  if (!line || !line.includes("|")) return false;
  const cells = splitTableRow(line);
  return cells.length === columns && cells.every((cell) => SEPARATOR_CELL.test(cell));
}

/** True when `lines[index]` starts a table: a piped header over a delimiter row. */
export function startsTable(lines, index) {
  const header = lines[index];
  if (!header || !header.includes("|")) return false;
  return isSeparatorRow(lines[index + 1], splitTableRow(header).length);
}

/** Index just past the table that starts at `index`. */
export function tableEnd(lines, index) {
  let end = index + 2;
  while (end < lines.length && lines[end].trim() && lines[end].includes("|")) end += 1;
  return end;
}

/** `{ header, aligns, rows }` for a table's markdown, normalised to one width. */
export function parseTable(raw) {
  const lines = String(raw || "").split("\n").filter((line) => line.trim());
  const header = splitTableRow(lines[0] || "");
  const aligns = splitTableRow(lines[1] || "").map((cell) => {
    const left = cell.startsWith(":");
    const right = cell.endsWith(":");
    return left && right ? "center" : right ? "right" : left ? "left" : "";
  });
  const rows = lines.slice(2).map(splitTableRow);
  const width = Math.max(1, header.length, ...rows.map((row) => row.length));
  const fit = (cells) => Array.from({ length: width }, (_, i) => cells[i] ?? "");
  return {
    header: fit(header),
    aligns: Array.from({ length: width }, (_, i) => aligns[i] || ""),
    rows: rows.map(fit),
  };
}

const DELIMITER = { "": "---", left: ":---", right: "---:", center: ":---:" };

/** Escape a cell value for a table line: one line, literal pipes escaped. */
export function tableCell(value) {
  return String(value ?? "").replace(/\s*\n+\s*/g, " ").replace(/(?<!\\)\|/g, "\\|").trim();
}

export function serializeTable({ header, aligns, rows }) {
  const line = (cells) => `| ${cells.map(tableCell).join(" | ")} |`;
  return [
    line(header),
    `| ${aligns.map((align) => DELIMITER[align] || "---").join(" | ")} |`,
    ...rows.map(line),
  ].join("\n");
}

/** A blank table, `rows` body rows by `columns` columns. */
export function blankTable(columns = 3, rows = 2) {
  const cells = () => Array.from({ length: columns }, () => "");
  return {
    header: cells(),
    aligns: cells(),
    rows: Array.from({ length: rows }, cells),
  };
}

// ---------- structural edits (each returns a new table) ----------

const clone = (table) => ({
  header: [...table.header],
  aligns: [...table.aligns],
  rows: table.rows.map((row) => [...row]),
});

/** Insert a blank body row at body index `at` (0 = directly under the header). */
export function insertRow(table, at) {
  const next = clone(table);
  next.rows.splice(Math.max(0, Math.min(at, next.rows.length)), 0, table.header.map(() => ""));
  return next;
}

export function deleteRow(table, at) {
  const next = clone(table);
  next.rows.splice(at, 1);
  return next;
}

/** Move body row `from` to body index `to`. */
export function moveRow(table, from, to) {
  const next = clone(table);
  if (from < 0 || from >= next.rows.length || to < 0 || to >= next.rows.length) return next;
  const [row] = next.rows.splice(from, 1);
  next.rows.splice(to, 0, row);
  return next;
}

export function insertColumn(table, at) {
  const next = clone(table);
  const index = Math.max(0, Math.min(at, next.header.length));
  next.header.splice(index, 0, "");
  next.aligns.splice(index, 0, "");
  for (const row of next.rows) row.splice(index, 0, "");
  return next;
}

export function deleteColumn(table, at) {
  const next = clone(table);
  if (next.header.length <= 1) return next;
  next.header.splice(at, 1);
  next.aligns.splice(at, 1);
  for (const row of next.rows) row.splice(at, 1);
  return next;
}

export function moveColumn(table, from, to) {
  const next = clone(table);
  const width = next.header.length;
  if (from < 0 || from >= width || to < 0 || to >= width) return next;
  const shift = (cells) => {
    const [cell] = cells.splice(from, 1);
    cells.splice(to, 0, cell);
  };
  shift(next.header);
  shift(next.aligns);
  next.rows.forEach(shift);
  return next;
}

export function setCell(table, row, column, value) {
  const next = clone(table);
  if (row < 0) next.header[column] = value;
  else next.rows[row][column] = value;
  return next;
}
