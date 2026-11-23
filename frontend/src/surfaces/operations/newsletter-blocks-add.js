// "Add block" panel: pick a block type (from the Relay block-types mirror the
// server returns), fill its fields (prefilled with the type's defaults) and
// choose where it goes.

import { collectFields, failureText, fieldControl } from "./newsletter-blocks-dom.js";

export function createAddPanel({ dom, request, base, onChange, onFail }) {
  const panel = dom.el("div", "newsletter-blocks__add");
  panel.dataset.blocksAdd = "";
  let types = null;

  async function open(set) {
    panel.replaceChildren(dom.el("p", "dk-hint", "Loading block types…"));
    try {
      types ||= (await request(`${base}/types`)).types.filter((item) => item.addable);
    } catch (error) {
      panel.replaceChildren(dom.el("p", "dk-field-error", `Block types unavailable: ${error.message}`));
      return;
    }
    const form = dom.el("form", "dk-card newsletter-blocks__block");
    form.dataset.blocksAddForm = "";
    const typeLabel = dom.el("label", "dk-label", "Block type");
    const typeSelect = dom.el("select", "dk-select");
    typeSelect.name = "type";
    for (const item of types) {
      const option = dom.el("option", "", item.label);
      option.value = item.type;
      typeSelect.append(option);
    }
    typeSelect.value = types[0]?.type || "";
    typeLabel.append(typeSelect);
    const posLabel = dom.el("label", "dk-label", "Position");
    const posSelect = dom.el("select", "dk-select");
    posSelect.name = "position";
    const end = dom.el("option", "", "At the end");
    end.value = "";
    posSelect.append(end);
    const pinnedAt = set.blocks.findIndex((block) => block.pinned);
    set.blocks.forEach((block, index) => {
      if (index <= pinnedAt) return;
      const option = dom.el("option", "", `Before ${block.label}`);
      option.value = String(index);
      posSelect.append(option);
    });
    posLabel.append(posSelect);
    const fieldsBox = dom.el("div", "newsletter-blocks__fields");
    const renderFields = () => {
      const spec = types.find((item) => item.type === typeSelect.value);
      fieldsBox.replaceChildren();
      for (const field of spec?.fields || []) fieldsBox.append(fieldControl(dom, field, field.default, false));
    };
    typeSelect.addEventListener("change", renderFields);
    renderFields();
    const error = dom.el("p", "dk-field-error");
    error.hidden = true;
    error.dataset.blockError = "";
    const submit = dom.button("Add block", "primary", "add-submit");
    submit.type = "submit";
    const cancel = dom.button("Cancel", "secondary", "add-cancel");
    cancel.addEventListener("click", () => panel.replaceChildren());
    form.append(typeLabel, posLabel, fieldsBox, error, submit, cancel);
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      submit.disabled = true;
      error.hidden = true;
      const body = { type: typeSelect.value, data: collectFields(fieldsBox) };
      if (posSelect.value !== "") body.position = Number(posSelect.value);
      try {
        const result = await request(base, { method: "POST", body: JSON.stringify(body) });
        panel.replaceChildren();
        onChange(result.blocks, "Block added. Sync with Relay to create it there.");
      } catch (failure) {
        error.textContent = failureText(failure);
        error.hidden = false;
        onFail(error.textContent);
        submit.disabled = false;
      }
    });
    panel.replaceChildren(form);
  }

  return { panel, open };
}
