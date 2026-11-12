// A table block, edited in place like a Notion table: every cell is an
// always-editable inline-markdown field; Tab, Shift+Tab, Enter and the arrow
// keys move between cells; grips and "+" strips add, move and delete rows and
// columns. The block's markdown (block.raw) is rewritten from the cells on
// every edit, so the draft is always a plain pipe table.

import { flushActiveEditable, focusEditable } from "./editable.js";
import { openBlockMenu } from "./block-menu.js";
import {
  deleteColumn,
  deleteRow,
  insertColumn,
  insertRow,
  moveColumn,
  moveRow,
  parseTable,
  serializeTable,
  setCell,
} from "./table-model.js";

const GRIP_DOTS = '<svg viewBox="0 0 16 16" aria-hidden="true">' +
  [4, 8, 12].map((v) => `<circle cx="${v}" cy="8" r="1.1"/>`).join("") + "</svg>";
const PLUS = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 3v10M3 8h10"/></svg>';

function button(className, label, html, onClick) {
  const el = document.createElement("button");
  el.type = "button";
  el.className = className;
  el.title = label;
  el.setAttribute("aria-label", label);
  el.innerHTML = html;
  el.addEventListener("click", (event) => {
    event.stopPropagation();
    onClick(el);
  });
  return el;
}

/**
 * Render a table block. `commitTable(raw, focus)` writes the new markdown to
 * the draft: `focus` is `{ row, column }` for a structural edit (the editor
 * re-renders and puts the caret there) and absent for a keystroke.
 */
export function renderTableBlock({ block, attachInlineEditor, commitTable }) {
  let table = parseTable(block.raw);
  const wrap = document.createElement("div");
  wrap.className = "notion-table";

  const grid = document.createElement("table");
  grid.className = "notion-table-grid";
  const scroller = document.createElement("div");
  scroller.className = "notion-table-scroll";
  scroller.append(grid);
  wrap.append(scroller);

  const cellAt = (row, column) => grid.querySelector(`[data-row="${row}"][data-col="${column}"]`);
  const rowCount = () => table.rows.length;
  const columnCount = () => table.header.length;

  const focusCell = (row, column, at = "end") => {
    const target = cellAt(row, column);
    if (!target) return false;
    focusEditable(target, at);
    return true;
  };

  /** Apply a structural edit: write the markdown and re-render. */
  function edit(next, focus) {
    flushActiveEditable();
    table = next;
    block.raw = serializeTable(table);
    commitTable(block.raw, focus);
  }

  /** Move to a neighbouring cell, growing the table past the last row. */
  function step(row, column, dRow, dColumn) {
    let nextRow = row + dRow;
    let nextColumn = column + dColumn;
    if (dColumn) {
      if (nextColumn >= columnCount()) { nextColumn = 0; nextRow += 1; }
      if (nextColumn < 0) { nextColumn = columnCount() - 1; nextRow -= 1; }
    }
    if (nextRow < -1) return false;
    if (nextRow >= rowCount()) {
      edit(insertRow(table, rowCount()), { row: rowCount(), column: nextColumn });
      return true;
    }
    return focusCell(nextRow, nextColumn, dColumn < 0 ? "end" : "start");
  }

  function rowMenu(anchor, row) {
    const items = [];
    if (row >= 0) {
      items.push({ label: "Insert row above", run: () => edit(insertRow(table, row), { row, column: 0 }) });
    }
    items.push({
      label: "Insert row below",
      run: () => edit(insertRow(table, row + 1), { row: row + 1, column: 0 }),
    });
    if (row > 0) items.push({ label: "Move row up", run: () => edit(moveRow(table, row, row - 1), { row: row - 1, column: 0 }) });
    if (row >= 0 && row < rowCount() - 1) {
      items.push({ label: "Move row down", run: () => edit(moveRow(table, row, row + 1), { row: row + 1, column: 0 }) });
    }
    if (row >= 0) {
      items.push("separator", {
        label: "Delete row",
        danger: true,
        run: () => edit(deleteRow(table, row), { row: Math.min(row, rowCount() - 2), column: 0 }),
      });
    }
    openBlockMenu(anchor, items, { label: "Row actions" });
  }

  function columnMenu(anchor, column) {
    const items = [
      { label: "Insert column left", run: () => edit(insertColumn(table, column), { row: -1, column }) },
      { label: "Insert column right", run: () => edit(insertColumn(table, column + 1), { row: -1, column: column + 1 }) },
    ];
    if (column > 0) items.push({ label: "Move column left", run: () => edit(moveColumn(table, column, column - 1), { row: -1, column: column - 1 }) });
    if (column < columnCount() - 1) items.push({ label: "Move column right", run: () => edit(moveColumn(table, column, column + 1), { row: -1, column: column + 1 }) });
    if (columnCount() > 1) {
      items.push("separator", {
        label: "Delete column",
        danger: true,
        run: () => edit(deleteColumn(table, column), { row: -1, column: Math.min(column, columnCount() - 2) }),
      });
    }
    openBlockMenu(anchor, items, { label: "Column actions" });
  }

  function cell(row, column) {
    const isHeader = row < 0;
    const holder = document.createElement(isHeader ? "th" : "td");
    if (isHeader) holder.scope = "col";
    if (table.aligns[column]) holder.style.textAlign = table.aligns[column];
    const field = document.createElement("div");
    field.className = "notion-table-cell";
    field.dataset.row = String(row);
    field.dataset.col = String(column);
    field.setAttribute("aria-label", isHeader ? `Header ${column + 1}` : `Row ${row + 1}, column ${column + 1}`);
    const value = () => (isHeader ? table.header[column] : table.rows[row][column]);
    field.textContent = value();
    attachInlineEditor(field, {
      getValue: value,
      commit: (text) => {
        table = setCell(table, row, column, text);
        block.raw = serializeTable(table);
        commitTable(block.raw, null);
      },
      restore: () => { field.textContent = value(); },
      multiline: false,
      singleLine: true,
      placeholder: "",
      onIndent: () => step(row, column, 0, 1),
      onOutdent: () => step(row, column, 0, -1),
      onEnterNewBlock: () => step(row, column, 1, 0),
      neighbour: (direction) => cellAt(row + direction, column),
    });
    holder.append(field);
    return holder;
  }

  let dragRow = null;

  function bodyRow(row) {
    const tr = document.createElement("tr");
    tr.dataset.rowIndex = String(row);
    const gripCell = document.createElement("td");
    gripCell.className = "notion-table-gutter";
    gripCell.contentEditable = "false";
    const grip = button("notion-table-grip notion-table-row-grip", "Row options · drag to move", GRIP_DOTS, (anchor) => rowMenu(anchor, row));
    grip.draggable = true;
    grip.addEventListener("dragstart", (event) => {
      dragRow = row;
      tr.classList.add("is-dragging");
      try { event.dataTransfer.setData("text/plain", String(row)); event.dataTransfer.effectAllowed = "move"; } catch {}
    });
    grip.addEventListener("dragend", () => {
      dragRow = null;
      grid.querySelectorAll(".is-dragging, .drop-above, .drop-below").forEach((node) => node.classList.remove("is-dragging", "drop-above", "drop-below"));
    });
    tr.addEventListener("dragover", (event) => {
      if (dragRow == null || dragRow === row) return;
      event.preventDefault();
      event.stopPropagation();
      const box = tr.getBoundingClientRect();
      const above = event.clientY - box.top < box.height / 2;
      tr.classList.toggle("drop-above", above);
      tr.classList.toggle("drop-below", !above);
    });
    tr.addEventListener("dragleave", () => tr.classList.remove("drop-above", "drop-below"));
    tr.addEventListener("drop", (event) => {
      if (dragRow == null || dragRow === row) return;
      event.preventDefault();
      event.stopPropagation();
      const box = tr.getBoundingClientRect();
      const above = event.clientY - box.top < box.height / 2;
      const from = dragRow;
      dragRow = null;
      let to = above ? row : row + 1;
      if (to > from) to -= 1;
      edit(moveRow(table, from, to), { row: to, column: 0 });
    });
    gripCell.append(grip);
    tr.append(gripCell);
    for (let column = 0; column < columnCount(); column += 1) tr.append(cell(row, column));
    return tr;
  }

  // Column grips sit above the header; the header row has its own row grip.
  const head = document.createElement("thead");
  const gripRow = document.createElement("tr");
  gripRow.className = "notion-table-grips";
  gripRow.contentEditable = "false";
  gripRow.append(document.createElement("th"));
  for (let column = 0; column < columnCount(); column += 1) {
    const holder = document.createElement("th");
    holder.className = "notion-table-grip-cell";
    holder.append(button("notion-table-grip notion-table-column-grip", "Column options", GRIP_DOTS, (anchor) => columnMenu(anchor, column)));
    gripRow.append(holder);
  }
  const headerRow = document.createElement("tr");
  const headerGutter = document.createElement("th");
  headerGutter.className = "notion-table-gutter";
  headerGutter.contentEditable = "false";
  headerGutter.append(button("notion-table-grip notion-table-row-grip", "Header row options", GRIP_DOTS, (anchor) => rowMenu(anchor, -1)));
  headerRow.append(headerGutter);
  for (let column = 0; column < columnCount(); column += 1) headerRow.append(cell(-1, column));
  head.append(gripRow, headerRow);

  const body = document.createElement("tbody");
  for (let row = 0; row < rowCount(); row += 1) body.append(bodyRow(row));
  grid.append(head, body);

  const addColumn = button("notion-table-add notion-table-add-column", "Add column", PLUS, () => {
    edit(insertColumn(table, columnCount()), { row: -1, column: columnCount() });
  });
  const addRow = button("notion-table-add notion-table-add-row", "Add row", PLUS, () => {
    edit(insertRow(table, rowCount()), { row: rowCount(), column: 0 });
  });
  scroller.after(addRow);
  wrap.append(addColumn);
  return wrap;
}
