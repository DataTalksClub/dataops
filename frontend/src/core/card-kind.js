// What kind of work a Card is (webinar, podcast, workshop…) and the icon its
// Template carries. A Card created from a Template names it by id; Cards that
// predate Templates (the Trello import) carry the Template type as a tag, so
// a tag equal to a known Template type identifies the kind just as well.
export function cardKind(card, templates) {
  if (!card || !Array.isArray(templates) || templates.length === 0) return null;
  const byId = card.templateId
    ? templates.find((template) => template && String(template.id) === String(card.templateId))
    : null;
  const tags = new Set(
    (Array.isArray(card.tags) ? card.tags : []).map((tag) => String(tag || "").trim().toLowerCase()),
  );
  const template =
    byId || templates.find((template) => template?.type && tags.has(String(template.type).toLowerCase()));
  if (!template) return null;
  return {
    type: String(template.type || ""),
    name: String(template.name || template.type || ""),
    icon: typeof template.icon === "string" && template.icon ? template.icon : "card",
    templateId: String(template.id || ""),
  };
}
