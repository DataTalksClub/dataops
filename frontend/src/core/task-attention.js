// Queue dates are civil days in the operator's Europe/Berlin calendar.
const dayOf = (value) => String(value || "").slice(0, 10);
const berlinDay = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Europe/Berlin", year: "numeric", month: "2-digit", day: "2-digit",
});

// Date-only follow-ups are civil days; timestamps belong to their Berlin day.
function followUpDay(value) {
  if (!value || /^\d{4}-\d{2}-\d{2}$/.test(value)) return dayOf(value);
  const instant = new Date(value);
  return Number.isFinite(instant.getTime()) ? berlinDay.format(instant) : "";
}

export function hasTaskFollowUp(task) {
  return task?.status === "waiting" || Boolean(task?.waitingFor) || Boolean(task?.followUpAt);
}

/** A waiting task's next action is its follow-up, rather than its original deadline. */
export function taskAttentionDate(task) {
  return hasTaskFollowUp(task) ? followUpDay(task?.followUpAt) : dayOf(task?.date);
}

export function isTaskSnoozed(task, today) {
  return dayOf(task?.snoozedUntil) > today;
}

/** Waiting and snooze dates resume on their calendar day; notBeforeAt is an exact moment. */
export function isTaskDeferred(task, today, now = new Date()) {
  return isTaskSnoozed(task, today) ||
    (hasTaskFollowUp(task) && taskAttentionDate(task) > today) ||
    (Boolean(task?.notBeforeAt) && Date.parse(task.notBeforeAt) > new Date(now).getTime());
}

/** Callers supply canonical tasks; completed tasks never need action. */
export function isTaskActionable(task, today, now = new Date()) {
  return (task?.status === "todo" || task?.status === "waiting") &&
    !isTaskDeferred(task, today, now);
}
