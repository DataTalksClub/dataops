import { cardKind } from "../../core/card-kind.js";

// Webinar and workshop Cards each get their own speaker form type.
const SPEAKER_DOC_TYPES = {
  webinar: "Create speaker materials form",
  workshop: "Create workshop document",
};

export function renderWebinarMaterialsAction({ request, workApiUrl, reload }, card, templates) {
  const kind = cardKind(card, templates);
  if ((card.sponsorDocs || []).some((doc) => SPEAKER_DOC_TYPES[doc.template])
    || (kind && !SPEAKER_DOC_TYPES[kind.type]) || (!kind && !card.templateId)) return null;
  const section = document.createElement("div");
  section.className = "workflow-detail-section";
  section.hidden = true;

  function renderAction(type) {
    section.hidden = false;
    const button = document.createElement("button");
    button.type = "button";
    button.className = "dk-button dk-button--secondary dk-button--sm";
    button.textContent = SPEAKER_DOC_TYPES[type];
    const feedback = document.createElement("p");
    feedback.setAttribute("role", "status");
    button.addEventListener("click", async () => {
      button.disabled = true;
      feedback.textContent = "Creating…";
      try {
        await request(workApiUrl("/api/sponsor-docs"), {
          method: "POST",
          body: JSON.stringify({ cardId: card.id, template: type }),
        });
        await reload();
      } catch (error) {
        feedback.textContent = error.message || "Could not create the form.";
        button.disabled = false;
      }
    });
    section.append(button, feedback);
  }

  if (kind) renderAction(kind.type);
  else {
    // A directly opened Card can load before the workspace's Template listing.
    request(workApiUrl(`/api/templates/${encodeURIComponent(card.templateId)}`)).then((payload) => {
      const type = (payload?.template || payload)?.type;
      if (SPEAKER_DOC_TYPES[type]) renderAction(type);
    }, () => {});
  }
  return section;
}
