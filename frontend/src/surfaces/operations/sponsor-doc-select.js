/**
 * Select control for sponsor/guest materials form fields (type: "select").
 * Used by the podcast guest form slot picker (confirm / free slots / none-fit).
 */
export function appendSponsorDocSelectField({
  el,
  fieldWrap,
  fieldDef,
  inputId,
  currentVal,
  busy,
  draftContent,
  updateCount,
  updateLivePreview,
  top,
}) {
  const control = el("select", "dk-input sponsor-doc-select");
  control.id = inputId;
  control.dataset.sponsorField = fieldDef.key;
  const options = Array.isArray(fieldDef.options) ? fieldDef.options : [];
  const blank = el("option");
  blank.value = "";
  blank.textContent = fieldDef.placeholder || "Choose one";
  if (!currentVal) blank.selected = true;
  control.append(blank);
  for (const opt of options) {
    const value = String(opt?.value ?? "");
    const labelText = String(opt?.label ?? value);
    if (!value) continue;
    const option = el("option");
    option.value = value;
    option.textContent = labelText;
    if (value === currentVal) option.selected = true;
    control.append(option);
  }
  control.disabled = busy;
  control.addEventListener("change", () => {
    draftContent[fieldDef.key] = control.value;
    updateCount(control.value);
    updateLivePreview();
  });
  fieldWrap.append(top, control);
  if (fieldDef.helpText) fieldWrap.append(el("p", "dk-hint", fieldDef.helpText));
}
