import { html } from "./shared.js";

export function sponsorOwnerOptions(teamMembers, selectedId, escapeHtml) {
  const members = teamMembers.filter((member) => member.active || member.id === selectedId);
  if (selectedId && !members.some((member) => member.id === selectedId)) {
    members.push({ id: selectedId, name: "Unavailable assignee", active: false });
  }
  return html`<option value="">Select an assignee</option>${members.map((member) => {
    const id = escapeHtml(member.id).replaceAll('"', "&quot;");
    const selected = member.id === selectedId ? " selected" : "";
    const disabled = member.active ? "" : " disabled";
    return html`<option value="${id}"${selected}${disabled}>${escapeHtml(member.name)}</option>`;
  }).join("")}`;
}


export function createSponsorOwnerDirectory({ request, workApiUrl, escapeHtml }) {
  let teamMembers = [], defaultAssigneeId = "";
  return {
    async load() {
      const directory = await request(workApiUrl("/api/team-members"));
      teamMembers = directory.teamMembers;
      defaultAssigneeId = teamMembers.some((member) =>
        member.id === directory.defaultAssigneeId && member.active
      ) ? directory.defaultAssigneeId : "";
    },
    fillFilter(select) {
      select.innerHTML = '<option value="">All owners</option>' + sponsorOwnerOptions(teamMembers, '', escapeHtml)
        .replace('<option value="">Select an assignee</option>', '');
    },
    name(id) { return teamMembers.find((member) => member.id === id)?.name || (id ? "Unavailable assignee" : "Unassigned"); },
    fill(select, currentOwner) {
      select.innerHTML = sponsorOwnerOptions(teamMembers, currentOwner || defaultAssigneeId, escapeHtml);
    },
  };
}

export function populateSponsorDealForm(form, item, ownerDirectory, fillContacts) {
  form.reset();
  ownerDirectory.fill(form.elements.taskAssignee, "");
  form.elements.dealId.value = item?.id || "";
  if (item?.version) form.elements.version.value = item.version;
  if (item?.organizationId) form.elements.organizationId.value = item.organizationId;
  if (item?.status) form.elements.status.value = item.status;
  if (item?.productKind) form.elements.productKind.value = item.productKind;
  if (item?.amountEur != null) form.elements.amountEur.value = item.amountEur;
  if (item?.lostReason) form.elements.lostReason.value = item.lostReason;
  const slot = item?.deliverables?.[0];
  if (slot) {
    if (form.elements.deliverableId) form.elements.deliverableId.value = slot.id || "";
    if (form.elements.deliverableVersion) form.elements.deliverableVersion.value = slot.version || "";
    if (slot.channel) form.elements.channel.value = slot.channel;
    if (slot.plannedPublicationDate) form.elements.plannedPublicationDate.value = slot.plannedPublicationDate;
    if (slot.materialDeadline) form.elements.materialDeadline.value = slot.materialDeadline;
    if (slot.title && form.elements.title) form.elements.title.value = slot.title;
    if (slot.requiredLinkUrl && form.elements.requiredLinkUrl) form.elements.requiredLinkUrl.value = slot.requiredLinkUrl;
    if (slot.contentType && form.elements.contentType) form.elements.contentType.value = slot.contentType;
    if (slot.promotionSource && form.elements.promotionSource) form.elements.promotionSource.value = slot.promotionSource;
    if (slot.relevancy && form.elements.relevancy) form.elements.relevancy.value = slot.relevancy;
    if (slot.influencerHandle && form.elements.influencerHandle) form.elements.influencerHandle.value = slot.influencerHandle;
    if (slot.publishedAt && form.elements.publishedAt) {
      // datetime-local wants local wall time without Z
      const d = new Date(slot.publishedAt);
      if (!Number.isNaN(d.getTime())) {
        const pad = (n) => String(n).padStart(2, "0");
        form.elements.publishedAt.value = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
      }
    }
  }
  const orgId = item?.organizationId || form.elements.organizationId.value;
  fillContacts(form, orgId, item?.primaryContactId);
}
