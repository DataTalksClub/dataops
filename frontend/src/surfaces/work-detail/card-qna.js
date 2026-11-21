import { opensInNewTab } from "../../core/links.js";

// The audience Q&A of an event Card (podcast, webinar, workshop): the public
// room link, the presenter view, and the audience questions — live while the
// room is open, the saved copy once the "Close Q&A and save all audience
// questions" step has run. Cards without a room render nothing.
function linkRow(label, href) {
  const row = document.createElement("p");
  row.append(`${label}: `);
  const link = document.createElement("a");
  link.href = href;
  link.textContent = href;
  opensInNewTab(link);
  row.append(link);
  return row;
}

export function renderCardQna({ request, workApiUrl }, card) {
  const qna = card?.qna;
  if (!qna?.url) return null;
  const section = document.createElement("section");
  section.className = "workflow-detail-section card-qna";
  section.dataset.cardQna = "";
  const heading = document.createElement("strong");
  heading.textContent = qna.questionsSavedAt ? "Audience Q&A (closed, questions saved)" : "Audience Q&A";
  section.append(heading, linkRow("Audience link", qna.url));
  if (qna.presentUrl && !qna.questionsSavedAt) section.append(linkRow("Presenter view", qna.presentUrl));

  const toggle = document.createElement("button");
  toggle.type = "button";
  toggle.className = "btn btn-secondary";
  toggle.dataset.cardQnaQuestions = "";
  const label = qna.questionsSavedAt && qna.questions ? `Show saved questions (${qna.questions.length})` : "Show audience questions";
  toggle.textContent = label;
  const list = document.createElement("ol");
  list.className = "card-qna__questions";
  list.hidden = true;
  const status = document.createElement("p");
  status.hidden = true;
  toggle.addEventListener("click", async () => {
    if (!list.hidden) {
      list.hidden = true;
      toggle.textContent = label;
      return;
    }
    toggle.disabled = true;
    try {
      const data = await request(workApiUrl(`/api/cards/${encodeURIComponent(card.id)}/qna/questions`));
      list.replaceChildren(...data.questions.map((question) => {
        const item = document.createElement("li");
        item.textContent = `${question.text} — ${question.authorName || "Anonymous"}${question.score > 1 ? ` (+${question.score})` : ""}${question.status === "answered" ? " ✓ answered" : ""}`;
        return item;
      }));
      status.hidden = data.questions.length > 0;
      status.textContent = data.questions.length ? "" : "No questions yet.";
      list.hidden = false;
      toggle.textContent = "Hide audience questions";
    } catch (error) {
      status.hidden = false;
      status.textContent = `Could not load questions: ${error?.message || error}`;
    } finally {
      toggle.disabled = false;
    }
  });
  section.append(toggle, status, list);
  return section;
}
