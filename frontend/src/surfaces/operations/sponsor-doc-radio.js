/**
 * Radio group control for guest/materials form fields (type: "radio").
 * Used by the podcast guest form slot picker: one choice only, each option a
 * full human datetime label, thumb-friendly on phones.
 *
 * For the slot picker (`slotChoice`) options are banded:
 *   A) confirm the proposed time
 *   B) other free Mon/Tue slots (full date + time in one label each)
 *   C) none fit — reply to the invite email (informational, no text input)
 */
export function appendSponsorDocRadioField({
  el,
  fieldWrap,
  fieldDef,
  inputId,
  currentVal,
  busy,
  draftContent,
  updateLivePreview,
  top,
}) {
  const selected = String(currentVal ?? "");
  const group = el("div", "sponsor-doc-radios");
  group.dataset.sponsorField = fieldDef.key;
  group.dataset.sponsorRadios = fieldDef.key;
  group.setAttribute("role", "radiogroup");

  const options = (Array.isArray(fieldDef.options) ? fieldDef.options : [])
    .map((opt) => ({ value: String(opt?.value ?? ""), label: String(opt?.label ?? opt?.value ?? "") }))
    .filter((opt) => opt.value);

  const isSlotChoice = fieldDef.key === "slotChoice";
  const bands = isSlotChoice
    ? [
      { id: "confirm", caption: "", items: options.filter((opt) => opt.value === "confirm_proposed") },
      {
        id: "free",
        caption: options.some((opt) => opt.value.startsWith("slot:")) ? "Or pick another free slot" : "",
        items: options.filter((opt) => opt.value.startsWith("slot:")),
      },
      { id: "none", caption: "", items: options.filter((opt) => opt.value !== "confirm_proposed" && !opt.value.startsWith("slot:")) },
    ].filter((band) => band.items.length > 0)
    : [{ id: "all", caption: "", items: options }];

  const radios = [];
  for (const band of bands) {
    const bandWrap = el("div", "sponsor-doc-radios__band");
    bandWrap.dataset.sponsorRadioBand = band.id;
    if (band.caption) bandWrap.append(el("p", "sponsor-doc-radios__caption", band.caption));
    for (const opt of band.items) {
      const label = el("label", "sponsor-doc-radio");
      label.dataset.sponsorRadioOption = opt.value;
      const input = el("input", "sponsor-doc-radio__input");
      input.type = "radio";
      input.name = inputId;
      input.value = opt.value;
      input.id = `${inputId}-${opt.value}`;
      input.disabled = busy;
      input.checked = opt.value === selected;
      if (opt.value === selected) label.classList.add("is-checked");
      input.addEventListener("change", () => {
        draftContent[fieldDef.key] = input.value;
        for (const other of radios) {
          const on = other === input;
          other.checked = on;
          if (other.parentElement?.classList) other.parentElement.classList.toggle("is-checked", on);
        }
        updateLivePreview();
      });
      const text = el("span", "sponsor-doc-radio__text", opt.label);
      label.append(input, text);
      radios.push(input);
      bandWrap.append(label);
    }
    group.append(bandWrap);
  }

  const countEl = top.querySelector(".sponsor-doc-field__count");
  if (countEl) countEl.hidden = true;
  fieldWrap.append(top, group);
  if (fieldDef.helpText) fieldWrap.append(el("p", "dk-hint", fieldDef.helpText));
}
