import { cardKind } from "../../core/card-kind.js";

export function renderWebinarMaterialsAction({ request, workApiUrl, reload }, card, templates) {
  const kind = cardKind(card, templates);
  if ((card.sponsorDocs || []).some((doc) => doc.template === "webinar")
    || (kind && kind.type !== "webinar") || (!kind && !card.templateId)) return null;
  const section = document.createElement("div");
  section.className = "workflow-detail-section";
  section.hidden = true;

  function renderAction() {
    section.hidden = false;
    const button = document.createElement("button");
    button.type = "button";
    button.className = "dk-button dk-button--secondary dk-button--sm";
    button.textContent = "Create speaker materials form";
    const feedback = document.createElement("p");
    feedback.setAttribute("role", "status");
    button.addEventListener("click", async () => {
      button.disabled = true;
      feedback.textContent = "Creating speaker materials form…";
      try {
        await request(workApiUrl("/api/sponsor-docs"), {
          method: "POST",
          body: JSON.stringify({ cardId: card.id, template: "webinar" }),
        });
        await reload();
      } catch (error) {
        feedback.textContent = error.message || "Could not create the speaker materials form.";
        button.disabled = false;
      }
    });
    section.append(button, feedback);
  }

  if (kind) renderAction();
  else {
    // A directly opened Card can load before the workspace's Template listing.
    request(workApiUrl(`/api/templates/${encodeURIComponent(card.templateId)}`)).then((payload) => {
      if ((payload?.template || payload)?.type === "webinar") renderAction();
    }, () => {});
  }
  return section;
}
