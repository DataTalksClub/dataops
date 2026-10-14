// A one-field prompt that floats next to the text being edited, for a link
// or a video URL. It never opens a dialog: the caret's context stays visible.

export function promptInline({ anchorRect, placeholder = "Paste a link", value = "", submitLabel = "Apply" } = {}) {
  return new Promise((resolve) => {
    const doc = globalThis.document;
    const form = doc.createElement("form");
    form.className = "inline-prompt";
    form.setAttribute("role", "dialog");
    form.setAttribute("aria-label", placeholder);
    const input = doc.createElement("input");
    input.type = "url";
    input.className = "inline-prompt-input";
    input.placeholder = placeholder;
    input.value = value;
    input.setAttribute("aria-label", placeholder);
    const submit = doc.createElement("button");
    submit.type = "submit";
    submit.className = "inline-prompt-submit";
    submit.textContent = submitLabel;
    form.append(input, submit);

    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      doc.removeEventListener("mousedown", onOutside, true);
      form.remove();
      resolve(result);
    };
    const onOutside = (event) => {
      if (!form.contains(event.target)) finish(null);
    };
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      finish(input.value.trim() || null);
    });
    form.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        finish(null);
      }
    });

    doc.body.append(form);
    const rect = anchorRect || { left: 16, bottom: 16, top: 16 };
    const width = form.offsetWidth || 320;
    const left = Math.max(8, Math.min(rect.left, (globalThis.innerWidth || 1024) - width - 8));
    form.style.left = `${Math.round(left)}px`;
    form.style.top = `${Math.round(rect.bottom + 6)}px`;
    doc.addEventListener("mousedown", onOutside, true);
    input.focus();
    input.select();
  });
}

/** Open the OS file picker for images; resolves with the chosen files. */
export function pickImageFiles({ multiple = true } = {}) {
  return new Promise((resolve) => {
    const input = globalThis.document.createElement("input");
    input.type = "file";
    input.accept = "image/png,image/jpeg,image/gif,image/webp,image/svg+xml";
    input.multiple = multiple;
    input.className = "visually-hidden";
    input.addEventListener("change", () => {
      resolve([...(input.files || [])]);
      input.remove();
    }, { once: true });
    input.addEventListener("cancel", () => {
      resolve([]);
      input.remove();
    }, { once: true });
    globalThis.document.body.append(input);
    input.click();
  });
}
