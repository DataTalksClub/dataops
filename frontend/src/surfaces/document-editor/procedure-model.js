// Lossless model of an SOP procedure section.
//
// The server parser flattens a procedure into groups/flat_steps/prose and
// loses where prose sits (inside which group, before which step). The editor
// needs an ordered tree it can edit and write back, so it parses the
// procedure section body itself. Every item keeps the exact source lines it
// came from; an item is regenerated only when it was edited, so an untouched
// procedure emits byte-for-byte what it parsed.

const GROUP_OPEN_RE = /<!--\s*sop-group-start:\s*"([^"]*)"\s*-->/;
const GROUP_CLOSE_RE = /<!--\s*sop-group-end\s*-->/;
const STEP_OPEN_RE = /<!--\s*sop-step-start(\s+[^-][^>]*?)\s*-->/;
const STEP_CLOSE_RE = /<!--\s*sop-step-end\s*-->/;
const SCREENSHOT_OPEN_RE = /<!--\s*sop-screenshot-start\s*-->/;
const SCREENSHOT_CLOSE_RE = /<!--\s*sop-screenshot-end\s*-->/;
const CAPTION_OPEN_RE = /<!--\s*sop-caption-start\s*-->/;
const CAPTION_CLOSE_RE = /<!--\s*sop-caption-end\s*-->/;
const PROSE_OPEN_RE = /<!--\s*sop-prose-start\s*-->/;
const PROSE_CLOSE_RE = /<!--\s*sop-prose-end\s*-->/;
const TODO_RE = /<!--\s*sop-todo:\s*"([^"]*)"\s*-->/;
const IMAGE_RE = /!\[([^\]]*)\]\(([^)]+)\)/;
const NUMBER_RE = /^(\s*)(\d+)\.(?:\s+|$)/;
const ATTR_RE = /(\w+)\s*=\s*(?:"([^"]*)"|(\S+))/g;

let uidCounter = 0;
const uid = (kind) => `${kind}-${++uidCounter}`;

/** Marker attribute values are double-quoted and cannot contain `"`. */
export function markerSafe(text) {
  return String(text ?? "").replace(/\s*\n\s*/g, " ").replace(/"/g, "'");
}

function parseAttrs(text) {
  const attrs = {};
  for (const match of String(text || "").matchAll(ATTR_RE)) {
    const key = match[1];
    const value = match[2] !== undefined ? match[2] : match[3];
    if (key === "id") continue;
    attrs[key] = key === "systems"
      ? value.split(",").map((v) => v.trim()).filter(Boolean)
      : value;
  }
  return attrs;
}

function formatAttrs(attrs) {
  const parts = [];
  for (const [key, value] of Object.entries(attrs || {})) {
    if (Array.isArray(value)) {
      if (value.length) parts.push(`${key}="${markerSafe(value.join(","))}"`);
    } else if (value != null && value !== "") {
      parts.push(`${key}="${markerSafe(value)}"`);
    }
  }
  return parts.length ? ` ${parts.join(" ")}` : "";
}

function trimBlankEdges(lines) {
  let start = 0;
  let end = lines.length;
  while (start < end && !lines[start].trim()) start += 1;
  while (end > start && !lines[end - 1].trim()) end -= 1;
  return lines.slice(start, end);
}

function parseScreenshot(rawLines) {
  let src = "";
  let alt = "";
  let inCaption = false;
  const captionLines = [];
  for (const line of rawLines.slice(1, -1)) {
    if (CAPTION_OPEN_RE.test(line)) {
      inCaption = true;
      continue;
    }
    if (CAPTION_CLOSE_RE.test(line)) {
      inCaption = false;
      continue;
    }
    if (inCaption) {
      captionLines.push(line.trim());
      continue;
    }
    const match = IMAGE_RE.exec(line);
    if (match && !src) {
      alt = match[1];
      src = match[2];
    }
  }
  return {
    kind: "screenshot",
    uid: uid("shot"),
    rawLines,
    dirty: false,
    src,
    alt,
    caption: trimBlankEdges(captionLines).join("\n"),
  };
}

function parseStep(rawLines) {
  const open = STEP_OPEN_RE.exec(rawLines[0]);
  const attrText = open ? open[1] : "";
  const idMatch = /\bid=(\d+)/.exec(attrText);
  const id = idMatch ? Number(idMatch[1]) : 0;
  const inner = rawLines.slice(1, -1);
  const bodyLines = [];
  const screenshots = [];
  for (let i = 0; i < inner.length; i += 1) {
    if (SCREENSHOT_OPEN_RE.test(inner[i])) {
      let j = i + 1;
      while (j < inner.length && !SCREENSHOT_CLOSE_RE.test(inner[j])) j += 1;
      screenshots.push(parseScreenshot(inner.slice(i, j + 1)));
      i = j;
    } else {
      bodyLines.push(inner[i]);
    }
  }
  const body = trimBlankEdges(bodyLines);
  let number = id;
  if (body.length) {
    const numbered = NUMBER_RE.exec(body[0]);
    if (numbered) {
      number = Number(numbered[2]);
      body[0] = body[0].slice(numbered[0].length);
    }
    body[0] = body[0].replace(/^\s+/, "");
    for (let k = 1; k < body.length; k += 1) {
      body[k] = body[k].replace(/^ {1,4}/, "");
    }
  }
  return {
    kind: "step",
    uid: uid("step"),
    rawLines,
    dirty: false,
    sourceId: id,
    sourceNumber: number,
    id,
    number,
    attrs: parseAttrs(attrText),
    attrText: attrText.replace(/\s*\bid=\d+/, ""),
    body: body.join("\n"),
    screenshots,
    sourceShotCount: screenshots.length,
  };
}

function parseProse(rawLines) {
  return {
    kind: "prose",
    uid: uid("prose"),
    rawLines,
    dirty: false,
    body: trimBlankEdges(rawLines.slice(1, -1)).join("\n"),
  };
}

/**
 * Parse the body of a `procedure` section (the text between its section
 * markers, starting with the `## Procedure` heading).
 */
export function parseProcedure(text) {
  const lines = String(text ?? "").split("\n");
  const model = { head: [], items: [], tail: [], headingDirty: false };
  let group = null;
  let gap = [];
  let seenItem = false;

  const place = (item) => {
    if (group && !group.children.length && !group.headDone) {
      group.headLines = gap;
      group.headDone = true;
      item.gapBefore = [];
    } else {
      item.gapBefore = gap;
    }
    gap = [];
    if (!seenItem) {
      model.head = item.gapBefore;
      item.gapBefore = [];
      seenItem = true;
    }
    (group ? group.children : model.items).push(item);
  };

  const collect = (start, closeRe) => {
    let end = start + 1;
    while (end < lines.length && !closeRe.test(lines[end])) end += 1;
    return lines.slice(start, Math.min(end, lines.length - 1) + 1);
  };

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const todo = TODO_RE.exec(line);
    if (todo) {
      place({
        kind: "todo", uid: uid("todo"), rawLines: [line], dirty: false, text: todo[1],
      });
      continue;
    }
    const groupOpen = GROUP_OPEN_RE.exec(line);
    if (groupOpen && !group) {
      const item = {
        kind: "group",
        uid: uid("group"),
        open: line,
        title: groupOpen[1],
        dirty: false,
        headLines: [],
        headDone: false,
        children: [],
        closeGap: [],
        close: "<!-- sop-group-end -->",
      };
      place(item);
      group = item;
      continue;
    }
    if (GROUP_CLOSE_RE.test(line) && group) {
      if (!group.headDone) {
        group.headLines = gap;
        group.headDone = true;
      } else {
        group.closeGap = gap;
      }
      group.close = line;
      gap = [];
      group = null;
      continue;
    }
    if (STEP_OPEN_RE.test(line)) {
      const raw = collect(i, STEP_CLOSE_RE);
      place(parseStep(raw));
      i += raw.length - 1;
      continue;
    }
    if (PROSE_OPEN_RE.test(line)) {
      const raw = collect(i, PROSE_CLOSE_RE);
      place(parseProse(raw));
      i += raw.length - 1;
      continue;
    }
    gap.push(line);
  }
  if (group) {
    // Unclosed group: keep its content; emission closes it.
    if (!group.headDone) group.headLines = gap;
    else group.closeGap = gap;
    gap = [];
  }
  if (!seenItem) model.head = gap;
  else model.tail = gap;
  return model;
}

export function procedureHeading(model) {
  const line = model.head.find((l) => /^#{1,6}\s+/.test(l));
  return line ? line.replace(/^#{1,6}\s+/, "").trim() : "";
}

export function setProcedureHeading(model, heading) {
  const text = String(heading || "").trim() || "Procedure";
  const idx = model.head.findIndex((l) => /^#{1,6}\s+/.test(l));
  if (idx === -1) model.head = [`## ${text}`, "", ...model.head];
  else model.head[idx] = `## ${text}`;
}

function formatStepBody(body, number) {
  const lines = String(body ?? "").split("\n");
  // An empty step keeps its "N.  " marker: the server parser needs the
  // space after the number to tell the number from the step text.
  const first = (lines[0] ?? "").replace(/\s+$/, "");
  const out = [`${number}.  ${first}`];
  for (const line of lines.slice(1)) out.push(line.trim() ? `    ${line}` : "");
  return out;
}

function emitScreenshot(shot) {
  if (!shot.dirty && shot.rawLines) return shot.rawLines;
  const lines = ["    <!-- sop-screenshot-start -->"];
  if (shot.src) lines.push(`    ![${(shot.alt || "").replace(/[\[\]\n]/g, " ")}](${shot.src})`);
  if (shot.caption && shot.caption.trim()) {
    lines.push("    <!-- sop-caption-start -->");
    for (const line of shot.caption.trim().split("\n")) lines.push(`    ${line}`);
    lines.push("    <!-- sop-caption-end -->");
  }
  lines.push("    <!-- sop-screenshot-end -->");
  return lines;
}

function renumberedSource(step) {
  if (step.id === step.sourceId && step.number === step.sourceNumber) return step.rawLines;
  const lines = [...step.rawLines];
  lines[0] = lines[0].replace(/\bid=\d+/, `id=${step.id}`);
  for (let i = 1; i < lines.length - 1; i += 1) {
    if (!lines[i].trim()) continue;
    lines[i] = lines[i].replace(NUMBER_RE, (match, indent) =>
      match.replace(/^(\s*)\d+/, `${indent}${step.number}`));
    break;
  }
  return lines;
}

function emitStep(step) {
  const kept = step.screenshots.filter((s) => s.rawLines && !s.dirty);
  const appended = step.screenshots.slice(kept.length);
  const onlyAppended = !step.shotsReordered &&
    step.screenshots.slice(0, kept.length).every((s) => s.rawLines && !s.dirty) &&
    kept.length === step.sourceShotCount &&
    appended.every((s) => !s.rawLines);
  if (!step.dirty && step.rawLines && onlyAppended) {
    const lines = renumberedSource(step);
    if (!appended.length) return lines;
    const added = appended.flatMap((shot) => ["", ...emitScreenshot(shot)]);
    return [...lines.slice(0, -1), ...added, lines.at(-1)];
  }
  const attrText = step.attrsDirty ? formatAttrs(step.attrs) : step.attrText;
  const lines = [`<!-- sop-step-start id=${step.id}${attrText} -->`];
  lines.push(...formatStepBody(step.body, step.number));
  for (const shot of step.screenshots) lines.push("", ...emitScreenshot(shot));
  lines.push("<!-- sop-step-end -->");
  return lines;
}

function emitProse(prose) {
  if (!prose.dirty && prose.rawLines) return prose.rawLines;
  return ["<!-- sop-prose-start -->", ...String(prose.body ?? "").split("\n"), "<!-- sop-prose-end -->"];
}

function emitTodo(todo) {
  if (!todo.dirty && todo.rawLines) return todo.rawLines;
  return [`<!-- sop-todo: "${markerSafe(todo.text)}" -->`];
}

function emitGroup(group) {
  const open = group.dirty || !group.open
    ? `<!-- sop-group-start: "${markerSafe(group.title)}" -->`
    : group.open;
  let headLines = group.headLines && group.headDone !== false
    ? [...group.headLines]
    : [`### ${group.title}`, ""];
  if (group.dirty) {
    const idx = headLines.findIndex((l) => /^#{1,6}\s+/.test(l));
    if (idx === -1) headLines = [`### ${group.title}`, "", ...headLines];
    else headLines[idx] = `### ${group.title}`;
  }
  const out = [open, ...headLines];
  emitItems(group.children, out);
  out.push(...(group.closeGap || []), group.close || "<!-- sop-group-end -->");
  return out;
}

function emitItem(item) {
  if (item.kind === "group") return emitGroup(item);
  if (item.kind === "step") return emitStep(item);
  if (item.kind === "prose") return emitProse(item);
  return emitTodo(item);
}

function emitItems(items, out) {
  for (const item of items) {
    if (Array.isArray(item.gapBefore)) {
      out.push(...item.gapBefore);
    } else if (out.length && out[out.length - 1].trim()) {
      // A new or moved item gets exactly one blank line before it.
      out.push("");
    }
    out.push(...emitItem(item));
  }
}

export function emitProcedure(model) {
  const out = [...model.head];
  emitItems(model.items, out);
  out.push(...model.tail);
  return out.join("\n");
}

// ---------- queries ----------

export function groupsOf(model) {
  return model.items.filter((item) => item.kind === "group");
}

export function todosOf(model) {
  return model.items.filter((item) => item.kind === "todo");
}

/** Steps in document order. */
export function stepsOf(model) {
  const steps = [];
  for (const item of model.items) {
    if (item.kind === "step") steps.push(item);
    if (item.kind === "group") {
      for (const child of item.children) if (child.kind === "step") steps.push(child);
    }
  }
  return steps;
}

/** Steps and prose (the editable flow) in document order. */
export function flowOf(model) {
  const flow = [];
  for (const item of model.items) {
    if (item.kind === "group") {
      flow.push(item);
      flow.push(...item.children);
    } else if (item.kind !== "todo") {
      flow.push(item);
    }
  }
  return flow;
}

/** The list that holds `item` and its index there. */
export function locate(model, item) {
  const top = model.items.indexOf(item);
  if (top !== -1) return { list: model.items, index: top, group: null };
  for (const group of groupsOf(model)) {
    const index = group.children.indexOf(item);
    if (index !== -1) return { list: group.children, index, group };
  }
  return null;
}

export function findStep(model, id) {
  return stepsOf(model).find((step) => step.id === Number(id)) || null;
}

// ---------- edits ----------

export function renumber(model) {
  stepsOf(model).forEach((step, index) => {
    step.id = index + 1;
    step.number = index + 1;
  });
}

export function newStep(body = "") {
  return {
    kind: "step",
    uid: uid("step"),
    rawLines: null,
    dirty: true,
    sourceId: 0,
    sourceNumber: 0,
    id: 0,
    number: 0,
    attrs: {},
    attrText: "",
    body,
    screenshots: [],
    sourceShotCount: 0,
    gapBefore: null,
  };
}

export function newScreenshot(src, alt = "", caption = "") {
  return { kind: "screenshot", uid: uid("shot"), rawLines: null, dirty: true, src, alt, caption };
}

export function newProse(body = "") {
  return { kind: "prose", uid: uid("prose"), rawLines: null, dirty: true, body, gapBefore: null };
}

export function newGroup(title, children = []) {
  for (const child of children) child.gapBefore = null;
  return {
    kind: "group",
    uid: uid("group"),
    open: null,
    title,
    dirty: true,
    headLines: [`### ${title}`, ""],
    headDone: true,
    children,
    closeGap: [],
    close: "<!-- sop-group-end -->",
    gapBefore: null,
  };
}

export function newTodo(text = "") {
  return { kind: "todo", uid: uid("todo"), rawLines: null, dirty: true, text, gapBefore: null };
}

export function setStepBody(step, body) {
  if (step.body === body) return;
  step.body = body;
  step.dirty = true;
}

export function setProseBody(prose, body) {
  if (prose.body === body) return;
  prose.body = body;
  prose.dirty = true;
}

export function setGroupTitle(group, title) {
  const next = markerSafe(title).trim();
  if (group.title === next) return;
  group.title = next;
  group.dirty = true;
}

export function setTodoText(todo, text) {
  if (todo.text === text) return;
  todo.text = text;
  todo.dirty = true;
}

export function setStepAttrs(step, attrs) {
  step.attrs = attrs;
  step.attrsDirty = true;
  step.dirty = true;
}

export function setScreenshotField(shot, field, value) {
  if (shot[field] === value) return;
  shot[field] = value;
  shot.dirty = true;
}

/** Insert `item` right after `anchor`, in the same container. */
export function insertAfter(model, anchor, item) {
  item.gapBefore = null;
  const where = anchor ? locate(model, anchor) : null;
  if (!where) {
    const groups = groupsOf(model);
    if (groups.length && item.kind !== "group") groups.at(-1).children.push(item);
    else model.items.push(item);
  } else if (item.kind === "group" && where.group) {
    const index = model.items.indexOf(where.group);
    model.items.splice(index + 1, 0, item);
  } else {
    where.list.splice(where.index + 1, 0, item);
  }
  renumber(model);
  return item;
}

/** Insert `item` right before `anchor`, in the same container. */
export function insertBefore(model, anchor, item) {
  item.gapBefore = null;
  const where = locate(model, anchor);
  if (!where) return insertAfter(model, null, item);
  where.list.splice(where.index, 0, item);
  if (where.index === 0 && where.list[1]) {
    where.list[1].gapBefore = null;
  }
  renumber(model);
  return item;
}

export function removeItem(model, item) {
  const where = locate(model, item);
  if (!where) return false;
  where.list.splice(where.index, 1);
  const next = where.list[where.index];
  if (next && where.index === 0) next.gapBefore = where.group ? [] : next.gapBefore;
  renumber(model);
  return true;
}

/** Split `step` at the caret: it keeps `before`, a new step gets `after`. */
export function splitStep(model, step, before, after) {
  setStepBody(step, before);
  return insertAfter(model, step, newStep(after));
}

/** The flow item (step or prose) before `item`, across groups. */
export function previousFlowItem(model, item) {
  const flow = flowOf(model).filter((entry) => entry.kind !== "group");
  const index = flow.indexOf(item);
  return index > 0 ? flow[index - 1] : null;
}

/**
 * Merge `item` (step or prose) into the flow item before it. Returns the
 * merged-into item and the caret offset at the join, or null at the start.
 */
export function mergeIntoPrevious(model, item, text) {
  const previous = previousFlowItem(model, item);
  if (!previous) return null;
  const head = previous.body || "";
  const tail = text ?? item.body ?? "";
  const joined = head && tail ? `${head}${/\s$/.test(head) ? "" : " "}${tail}` : head + tail;
  const caret = head && tail ? joined.length - tail.length : head.length;
  if (previous.kind === "step") {
    setStepBody(previous, joined);
    if (item.kind === "step" && item.screenshots.length) {
      previous.screenshots.push(...item.screenshots);
      previous.shotsReordered = true;
    }
  } else {
    setProseBody(previous, joined);
  }
  removeItem(model, item);
  return { target: previous, caret };
}

/**
 * Shift+Tab on a step: the step starts a new group. In a flat procedure the
 * steps before it become a "Steps" group, keeping every step grouped.
 */
export function startGroupAt(model, step, title = "New group") {
  const where = locate(model, step);
  if (!where) return null;
  if (where.group) {
    if (where.index === 0) return null;
    const moved = where.list.splice(where.index);
    const group = newGroup(title, moved);
    group.closeGap = [...(where.group.closeGap || [])];
    const groupIndex = model.items.indexOf(where.group);
    model.items.splice(groupIndex + 1, 0, group);
    renumber(model);
    return group;
  }
  const firstStepIndex = model.items.findIndex((item) => item.kind === "step");
  const startIndex = where.index;
  const before = model.items
    .slice(firstStepIndex, startIndex)
    .filter((item) => item.kind === "step" || item.kind === "prose");
  const after = model.items
    .slice(startIndex)
    .filter((item) => item.kind === "step" || item.kind === "prose");
  const keep = model.items.filter(
    (item, index) => !(index >= firstStepIndex && (item.kind === "step" || item.kind === "prose")),
  );
  const groups = [];
  if (before.length) groups.push(newGroup("Steps", before));
  const group = newGroup(title, after);
  groups.push(group);
  model.items = [...keep, ...groups];
  renumber(model);
  return group;
}

/**
 * Tab on the first step of a group: the group joins the one above it. The
 * first group of a single-group procedure dissolves into a flat procedure.
 */
export function joinGroupAbove(model, step) {
  const where = locate(model, step);
  if (!where || !where.group) return null;
  const firstStep = where.group.children.find((child) => child.kind === "step");
  if (firstStep !== step) return null;
  const groups = groupsOf(model);
  const groupIndex = groups.indexOf(where.group);
  if (groupIndex > 0) {
    const above = groups[groupIndex - 1];
    for (const child of where.group.children) child.gapBefore = null;
    above.children.push(...where.group.children);
    model.items.splice(model.items.indexOf(where.group), 1);
    renumber(model);
    return above;
  }
  if (groups.length === 1) {
    const index = model.items.indexOf(where.group);
    for (const child of where.group.children) child.gapBefore = null;
    model.items.splice(index, 1, ...where.group.children);
    renumber(model);
    return "flat";
  }
  return null;
}

/** Move `dragged` before/after `target` (both steps or both prose/steps). */
export function moveItem(model, dragged, target, above) {
  if (dragged === target) return false;
  if (dragged.kind === "group" || target.kind === "group") {
    if (dragged.kind !== "group" || target.kind !== "group") return false;
    const from = model.items.indexOf(dragged);
    model.items.splice(from, 1);
    let to = model.items.indexOf(target);
    if (!above) to += 1;
    dragged.gapBefore = null;
    model.items.splice(to, 0, dragged);
    return true;
  }
  const from = locate(model, dragged);
  if (!from) return false;
  from.list.splice(from.index, 1);
  const to = locate(model, target);
  if (!to) {
    from.list.splice(from.index, 0, dragged);
    return false;
  }
  dragged.gapBefore = null;
  to.list.splice(above ? to.index : to.index + 1, 0, dragged);
  if (above && to.index === 0 && to.group) to.list[1].gapBefore = null;
  renumber(model);
  return true;
}

/** Move a flow item one position up or down within the document flow. */
export function nudgeItem(model, item, direction) {
  const flow = flowOf(model).filter((entry) => entry.kind !== "group");
  const index = flow.indexOf(item);
  const neighbour = flow[index + direction];
  if (!neighbour) return false;
  return moveItem(model, item, neighbour, direction < 0);
}

export function duplicateStep(model, step) {
  const copy = newStep(step.body);
  copy.attrs = { ...step.attrs };
  copy.attrText = step.attrText;
  copy.screenshots = step.screenshots.map((shot) => ({
    ...shot, uid: uid("shot"), rawLines: shot.rawLines ? [...shot.rawLines] : null,
  }));
  return insertAfter(model, step, copy);
}

/** Turn a step into prose (or prose into a step) in place. */
export function convertItem(model, item, kind) {
  if (item.kind === kind) return item;
  const where = locate(model, item);
  if (!where) return null;
  const replacement = kind === "step" ? newStep(item.body) : newProse(item.body);
  replacement.gapBefore = item.gapBefore ?? null;
  where.list.splice(where.index, 1, replacement);
  renumber(model);
  return replacement;
}
