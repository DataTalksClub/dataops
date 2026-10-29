/** Threaded discussion shared by task editors and the external reviewer page. */
export function createDocumentReviewPanel({ documentRef: doc, request, documentId, reviewToken = "", staff = true }) {
  const root = doc.createElement("section");
  root.className = "document-reviews dk-stack";
  root.setAttribute("aria-label", "Document comments and reviewers");
  const heading = node("h2", "Comments");
  const status = node("p", "Loading comments…");
  status.setAttribute("role", "status");
  const threads = node("div");
  const reviewers = node("div");
  root.append(heading, status, threads);
  const base = `/api/documents/${encodeURIComponent(documentId)}`;
  const call = (suffix, options = {}) => request(`${base}${suffix}`, { ...options, headers: { ...(options.headers || {}), ...(reviewToken ? { "x-document-review-token": reviewToken } : {}) } });
  function node(tag, text = "") { const el = doc.createElement(tag); el.textContent = text; return el; }
  function button(label, run) {
    const el = node("button", label); el.type = "button"; el.className = "dk-btn dk-btn--secondary";
    el.addEventListener("click", async () => {
      el.disabled = true;
      try { await run(); } catch (error) { status.textContent = error.message; } finally { el.disabled = false; }
    });
    return el;
  }
  function form(label, submit, { quote = false } = {}) {
    const el = node("form"); el.className = "dk-stack";
    const input = node("textarea"); input.required = true; input.maxLength = 2000; input.setAttribute("aria-label", label);
    let quoteInput;
    if (quote) { quoteInput = node("input"); quoteInput.maxLength = 1000; quoteInput.placeholder = "Quoted text (optional)"; quoteInput.setAttribute("aria-label", "Quoted text (optional)"); el.append(quoteInput); }
    const send = node("button", label); send.type = "submit"; send.className = "dk-btn dk-btn--primary";
    el.append(input, send);
    el.addEventListener("submit", async event => {
      event.preventDefault(); send.disabled = true;
      try { await submit(input.value, quoteInput?.value || ""); input.value = ""; if (quoteInput) quoteInput.value = ""; }
      catch (error) { status.textContent = error.message; }
      finally { send.disabled = false; }
    });
    return el;
  }
  async function refresh() {
    const data = await call("/comments");
    threads.replaceChildren();
    for (const thread of data.threads || []) {
      const article = node("article"); article.className = "dk-stack";
      article.append(node("h3", thread.resolved ? "Resolved thread" : "Open thread"));
      if (thread.quote) article.append(node("blockquote", thread.quote));
      for (const post of thread.posts) {
        const entry = node("div");
        entry.append(node("strong", post.author.name), node("time", post.createdAt), node("p", post.body)); article.append(entry);
      }
      article.append(button(thread.resolved ? "Reopen thread" : "Resolve thread", async () => {
        await call(`/comments/${encodeURIComponent(thread.id)}/resolve`, { method: "POST", body: JSON.stringify({ resolved: !thread.resolved, version: thread.version }) }); await refresh();
      }));
      if (!thread.resolved) article.append(form("Reply", async body => {
        await call(`/comments/${encodeURIComponent(thread.id)}/reply`, { method: "POST", body: JSON.stringify({ body, version: thread.version }) }); await refresh();
      }));
      threads.append(article);
    }
    status.textContent = data.threads?.length ? "Comments up to date." : "No comments yet.";
  }
  root.append(form("Add comment", async (body, quote) => { await call("/comments", { method: "POST", body: JSON.stringify({ body, quote }) }); await refresh(); }, { quote: true }));
  root.append(button("Refresh comments", refresh));
  if (staff && !reviewToken) {
    root.append(node("h2", "Reviewers"), node("p", "Review links allow reading this document and commenting for 30 days."), reviewers);
    const invite = node("form");
    const name = node("input"); name.required = true; name.maxLength = 120; name.placeholder = "Reviewer name"; name.setAttribute("aria-label", "Reviewer name");
    const send = node("button", "Create review link"); send.type = "submit"; send.className = "dk-btn dk-btn--secondary";
    const link = node("input"); link.readOnly = true; link.hidden = true; link.setAttribute("aria-label", "New review link");
    invite.append(name, send, link); root.append(invite);
    invite.addEventListener("submit", async event => {
      event.preventDefault(); send.disabled = true;
      try {
        const result = await call("/reviewers", { method: "POST", body: JSON.stringify({ name: name.value }) });
        link.value = new URL(result.reviewPath, doc.location?.origin || globalThis.location?.origin || "http://localhost").href;
        link.hidden = false; link.focus(); link.select(); status.textContent = "Review link created. Copy it now; it is shown only once."; await refreshReviewers();
      } catch (error) { status.textContent = error.message; } finally { send.disabled = false; }
    });
    async function refreshReviewers() {
      const data = await call("/reviewers"); reviewers.replaceChildren();
      for (const reviewer of data.reviewers || []) {
        const row = node("p", `${reviewer.name} · expires ${reviewer.expiresAt} `);
        row.append(button("Revoke access", async () => { await call(`/reviewers/${encodeURIComponent(reviewer.id)}`, { method: "DELETE" }); await refreshReviewers(); status.textContent = "Reviewer access revoked."; })); reviewers.append(row);
      }
    }
    refreshReviewers().catch(error => { status.textContent = error.message; });
  }
  refresh().catch(error => { status.textContent = error.message; });
  return root;
}
