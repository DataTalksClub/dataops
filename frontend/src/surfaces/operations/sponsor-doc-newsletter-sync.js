// Result of the automatic newsletter sync that runs on every sponsor-doc save
// (the issue's sponsor block in DataOps and Relay). A failure is shown loudly
// on the doc page; a success or skip is one quiet line.

/** A callout for `doc.newsletterSync`, or null when the doc has no sync result. */
export function renderNewsletterSyncNote(el, sync) {
  if (!sync || !sync.status) return null;
  const failed = sync.status === "failed";
  const tone = failed ? "danger" : sync.status === "ok" ? "success" : "info";
  const note = el("div", `dk-callout dk-callout--${tone}`);
  note.setAttribute("role", failed ? "alert" : "status");
  note.dataset.newsletterSync = sync.status;
  const prefix = failed ? "Newsletter sync FAILED: " : "Newsletter sync: ";
  note.append(el("div", "dk-callout__body", `${prefix}${sync.message || sync.status}`));
  return note;
}
