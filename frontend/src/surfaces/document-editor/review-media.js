export function createEditorReviewMedia(context, services, editorState) {
  const {
    apiUrl, diffBody, diffModal, diffTitle, editorView, lightbox,
    lightboxCaption, lightboxImg, lintModal, lintModalBody,
    lintOpenButton, lintSummary, openDocument, request, storage,
  } = context;
  const { addScreenshot, draftKey, emptyNote } = services;
  let diffReturnFocus = null;
  let lightboxReturnFocus = null;
  const diffClose = diffModal?.querySelector?.("[data-diff-close]");
  const lightboxClose = lightbox?.querySelector?.("[data-lightbox-close]");
  const overlayFocusableSelector =
    'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])';

  function activeFocusTarget() {
    if (typeof document === "undefined") return null;
    const active = document.activeElement;
    return active && typeof active.focus === "function" ? active : null;
  }

  function restoreFocus(target) {
    if (
      target &&
      target.isConnected !== false &&
      typeof target.focus === "function"
    ) {
      target.focus();
    }
  }

  function focusOverlayControl(control, fallback) {
    restoreFocus(control || fallback);
  }

  diffClose?.addEventListener("click", closeDiff);
  lightboxClose?.addEventListener("click", closeLightbox);
  diffModal?.addEventListener("keydown", trapOverlayFocus);
  lightbox?.addEventListener("keydown", trapOverlayFocus);

  function trapOverlayFocus(event) {
    if (event.defaultPrevented || event.key !== "Tab") return;
    const overlay = event.currentTarget;
    const focusables = [...overlay.querySelectorAll(overlayFocusableSelector)].filter(
      (element) =>
        !element.hidden &&
        (typeof element.offsetParent === "undefined" || element.offsetParent !== null),
    );
    if (focusables.length === 0) return;
    const first = focusables[0];
    const last = focusables.at(-1);
    const active = document.activeElement;
    const activeInside = overlay.contains?.(active) || false;
    if (event.shiftKey && (active === first || !activeInside)) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && (active === last || !activeInside)) {
      event.preventDefault();
      first.focus();
    }
  }

  async function openLintReport() {
    lintModal.hidden = false;
    lintOpenButton.classList.add("is-busy");
    lintModalBody.replaceChildren(emptyNote("Running lint…"));
    try {
      const payload = await request(apiUrl("/lint"));
      const docs = payload.docs || [];
      if (docs.length === 0) {
        lintModalBody.replaceChildren(
          emptyNote("No violations across the corpus 🎉"),
        );
        lintSummary.textContent = "clean";
        return;
      }
      const total = payload.total_violations || 0;
      lintSummary.textContent = `${docs.length} docs · ${total} violations`;
      const rows = docs.map((entry) => {
        const wrap = document.createElement("div");
        wrap.className = "lint-row";
        const heading = document.createElement("button");
        heading.type = "button";
        heading.className = "lint-row-path";
        heading.textContent = entry.path;
        heading.addEventListener("click", () => {
          lintModal.hidden = true;
          openDocument(entry.path);
        });
        wrap.append(heading);
        const list = document.createElement("ul");
        list.className = "lint-row-violations";
        for (const v of entry.violations) {
          const li = document.createElement("li");
          li.textContent = v;
          list.append(li);
        }
        wrap.append(list);
        return wrap;
      });
      lintModalBody.replaceChildren(...rows);
    } catch (err) {
      lintModalBody.replaceChildren(emptyNote(`Lint failed: ${err.message}`));
    } finally {
      lintOpenButton.classList.remove("is-busy");
    }
  }

  async function showDiffForDraft(path) {
    diffReturnFocus = activeFocusTarget();
    const draft = storage.getItem(draftKey(path)) ?? "";
    let saved = "";
    try {
      const url = apiUrl("/docs");
      url.searchParams.set("path", path);
      const payload = await request(url);
      saved = payload.content || "";
    } catch (err) {
      saved = "";
    }
    diffTitle.textContent = path;
    diffBody.replaceChildren(...renderUnifiedDiff(saved, draft));
    diffModal.hidden = false;
    focusOverlayControl(diffClose, diffModal);
  }

  function closeDiff() {
    diffModal.hidden = true;
    const returnFocus = diffReturnFocus;
    diffReturnFocus = null;
    restoreFocus(returnFocus);
  }

  function renderUnifiedDiff(a, b) {
    const aLines = a.split("\n");
    const bLines = b.split("\n");
    const lcs = lcsLengths(aLines, bLines);
    const ops = [];
    let i = aLines.length,
      j = bLines.length;
    while (i > 0 && j > 0) {
      if (aLines[i - 1] === bLines[j - 1]) {
        ops.push({ type: " ", line: aLines[i - 1] });
        i--;
        j--;
      } else if (lcs[i - 1][j] >= lcs[i][j - 1]) {
        ops.push({ type: "-", line: aLines[i - 1] });
        i--;
      } else {
        ops.push({ type: "+", line: bLines[j - 1] });
        j--;
      }
    }
    while (i > 0) {
      ops.push({ type: "-", line: aLines[i - 1] });
      i--;
    }
    while (j > 0) {
      ops.push({ type: "+", line: bLines[j - 1] });
      j--;
    }
    ops.reverse();

    const nodes = [];
    for (const op of ops) {
      const span = document.createElement("div");
      span.className =
        "diff-line diff-" +
        (op.type === "+" ? "add" : op.type === "-" ? "del" : "ctx");
      span.textContent = (op.type === " " ? "  " : op.type + " ") + op.line;
      nodes.push(span);
    }
    if (nodes.length === 0) {
      const span = document.createElement("div");
      span.className = "diff-line diff-ctx";
      span.textContent = "(no changes)";
      nodes.push(span);
    }
    return nodes;
  }

  function lcsLengths(a, b) {
    const m = a.length;
    const n = b.length;
    const dp = Array.from({ length: m + 1 }, () => new Int32Array(n + 1));
    for (let i = 1; i <= m; i++) {
      for (let j = 1; j <= n; j++) {
        dp[i][j] =
          a[i - 1] === b[j - 1]
            ? dp[i - 1][j - 1] + 1
            : Math.max(dp[i - 1][j], dp[i][j - 1]);
      }
    }
    return dp;
  }

  function openLightbox(src, caption) {
    lightboxReturnFocus = activeFocusTarget();
    lightboxImg.src = src;
    lightboxImg.alt = caption || "Document image";
    lightboxCaption.textContent = caption || "";
    lightboxCaption.hidden = !caption;
    lightbox.hidden = false;
    focusOverlayControl(lightboxClose, lightboxImg);
  }

  function closeLightbox() {
    lightbox.hidden = true;
    const returnFocus = lightboxReturnFocus;
    lightboxReturnFocus = null;
    restoreFocus(returnFocus);
  }

  function handleClipboardPaste(event) {
    // Only intercept when we're in block view with a step focused or remembered.
    if (editorView.dataset.mode !== "rendered") return;
    if (!editorState.lastFocusedStep || !editorState.lastFocusedProcedure) return;
    const items = event.clipboardData && event.clipboardData.items;
    if (!items) return;
    for (const item of items) {
      if (item.kind !== "file") continue;
      const file = item.getAsFile();
      if (file && file.type.startsWith("image/")) {
        event.preventDefault();
        // Provide a default filename if the OS gave none.
        if (!file.name || file.name === "image.png") {
          const ts = new Date().toISOString().replace(/[:.]/g, "-");
          const ext = file.type.split("/")[1] || "png";
          Object.defineProperty(file, "name", { value: `paste-${ts}.${ext}` });
        }
        addScreenshot(editorState.lastFocusedStep, editorState.lastFocusedProcedure, file);
        return;
      }
    }
  }

  function fileToBase64(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const result = reader.result || "";
        const idx = String(result).indexOf(",");
        resolve(idx === -1 ? String(result) : String(result).slice(idx + 1));
      };
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(file);
    });
  }

  // Generic click-to-edit helper. `el` becomes a textarea/input when clicked.
  // `getValue` returns the current value to seed the editor;
  // `commit(value)` is called with the new value when the user confirms;
  // `restore()` rebuilds the read-only view (called whether or not committed);
  // `options` controls multi-line vs single-line and the editor class.

  return {
    closeDiff, closeLightbox, fileToBase64, handleClipboardPaste,
    openLightbox, openLintReport, showDiffForDraft,
  };
}
