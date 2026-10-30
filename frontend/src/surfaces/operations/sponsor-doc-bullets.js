export function stripBulletPrefix(line) {
  return String(line || "").trim().replace(/^(?:[-*•→🔸▪▸]|\d+[.)])\s*/, "").trim();
}

export function parseSponsorBulletItems(rawValue, minItems = 3) {
  const cleaned = String(rawValue || "").replace(/\r\n/g, "\n").split("\n").map((line) => stripBulletPrefix(line));
  while (cleaned.length > minItems && cleaned.at(-1) === "") cleaned.pop();
  const items = cleaned.some((item) => item.length > 0) ? cleaned : [];
  while (items.length < minItems) items.push("");
  return items;
}

export function serializeSponsorBulletItems(items, bulletPrefix = "-") {
  if (!Array.isArray(items)) return "";
  const nonEmpty = items.map((item) => stripBulletPrefix(item)).filter((item) => item.length > 0);
  return nonEmpty.length === 0 ? "" : nonEmpty.map((item) => `${bulletPrefix} ${item}`).join("\n");
}

export function appendSponsorDocBulletsField({
  el,
  actionBtn,
  fieldWrap,
  fieldDef,
  inputId,
  currentVal,
  busy,
  draftContent,
  updateLivePreview,
  top,
  label,
  countEl,
}) {
  const minItems = fieldDef.minItems || 3;
  const maxItems = fieldDef.maxItems || 6;
  const marker = fieldDef.bulletMarker || "•";
  const basePlaceholder = (fieldDef.placeholder || "Bullet point")
    .split("\n")[0]
    .replace(/^(?:[-*•→🔸▪▸]|\d+[.)])\s*/, "")
    .replace(/\s+\d+$/, "")
    .trim() || "Bullet point";

  const bulletItems = parseSponsorBulletItems(currentVal, minItems);
  const updateBulletsCount = () => {
    const filled = bulletItems.filter((item) => item.trim().length > 0).length;
    countEl.textContent = `${filled} / ${minItems} bullets`;
    countEl.classList.toggle("is-over", filled > maxItems);
  };

  label.setAttribute("for", `${inputId}-0`);
  updateBulletsCount();
  top.append(label, countEl);

  const bulletsContainer = el("div", "sponsor-doc-bullets");
  bulletsContainer.id = inputId;
  bulletsContainer.dataset.sponsorField = fieldDef.key;
  bulletsContainer.dataset.sponsorBullets = fieldDef.key;

  const bulletList = el("div", "sponsor-doc-bullets__list");
  bulletList.dataset.sponsorBulletList = "";
  const actionsRow = el("div", "sponsor-doc-bullets__actions");
  const addBulletBtn = actionBtn("dk-button dk-button--secondary dk-button--sm", "+ Add bullet", "add-bullet", () => {
    if (bulletItems.length >= maxItems) return;
    bulletItems.push("");
    renderBulletRows(bulletItems.length - 1);
    syncBulletsState();
  });
  addBulletBtn.id = "add-sponsor-bullet";

  function syncBulletsState() {
    draftContent[fieldDef.key] = serializeSponsorBulletItems(bulletItems);
    updateBulletsCount();
    addBulletBtn.disabled = busy || bulletItems.length >= maxItems;
    updateLivePreview();
  }

  function renderBulletRows(focusIndex = null) {
    bulletList.replaceChildren();
    bulletItems.forEach((itemVal, idx) => {
      const row = el("div", "sponsor-doc-bullets__row");
      row.dataset.sponsorBulletRow = String(idx);
      const markerSpan = el("span", "sponsor-doc-bullets__marker", marker);
      markerSpan.setAttribute("aria-hidden", "true");

      const bulletInput = el("input", "dk-input sponsor-doc-bullets__input");
      bulletInput.type = "text";
      bulletInput.id = `${inputId}-${idx}`;
      bulletInput.name = `${fieldDef.key}[]`;
      bulletInput.dataset.sponsorBulletInput = String(idx);
      bulletInput.placeholder = `${basePlaceholder} ${idx + 1}`;
      bulletInput.value = itemVal;
      bulletInput.disabled = busy;
      if (fieldDef.required && idx < minItems) bulletInput.setAttribute("aria-required", "true");
      bulletInput.addEventListener("input", () => {
        const rawInput = String(bulletInput.value || "");
        if (rawInput.includes("\n")) {
          const splitLines = rawInput.replace(/\r\n/g, "\n").split("\n").map((l) => stripBulletPrefix(l)).filter(Boolean);
          if (splitLines.length > 0) {
            bulletItems[idx] = splitLines[0];
            for (let s = 1; s < splitLines.length; s += 1) {
              const targetIdx = idx + s;
              if (targetIdx < bulletItems.length && !bulletItems[targetIdx]) bulletItems[targetIdx] = splitLines[s];
              else if (bulletItems.length < maxItems) bulletItems.splice(Math.min(targetIdx, bulletItems.length), 0, splitLines[s]);
            }
            renderBulletRows(Math.min(idx + splitLines.length - 1, bulletItems.length - 1));
            syncBulletsState();
            return;
          }
        }
        bulletItems[idx] = rawInput;
        syncBulletsState();
      });

      const removeClass = "dk-button dk-button--secondary dk-button--sm sponsor-doc-bullets__remove";
      const removeBtn = actionBtn(
        removeClass,
        "Remove",
        "remove-bullet",
        () => {
          if (bulletItems.length > 1) bulletItems.splice(idx, 1);
          else bulletItems[0] = "";
          renderBulletRows(Math.max(0, Math.min(idx, bulletItems.length - 1)));
          syncBulletsState();
        },
        busy || (bulletItems.length <= 1 && !bulletItems[0]),
      );
      removeBtn.dataset.sponsorBulletRemove = String(idx);
      removeBtn.setAttribute("aria-label", `Remove bullet ${idx + 1}`);

      row.append(markerSpan, bulletInput, removeBtn);
      bulletList.append(row);
      if (focusIndex === idx) bulletInput.focus?.();
    });
    addBulletBtn.disabled = busy || bulletItems.length >= maxItems;
  }

  renderBulletRows();
  actionsRow.append(addBulletBtn);
  bulletsContainer.append(bulletList, actionsRow);
  fieldWrap.append(top, bulletsContainer);
  if (fieldDef.helpText) fieldWrap.append(el("p", "dk-hint", fieldDef.helpText));
}
