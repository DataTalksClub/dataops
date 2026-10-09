// Dakit dialog dismissal: clicking an open dialog's backdrop closes it.
//
// Load once per page — either form works:
//   <script src="dakit/dist/dialogs.js"></script>
//   import "dakit/dist/dialogs.js";
// Listeners are delegated on document, so dialogs mounted later are covered.
//
// Contract: the dialog element is the whole panel and carries no padding
// (.dk-dialog sets padding: 0), so a click whose target IS the dialog
// element can only have landed on the ::backdrop. A drag that starts on
// the panel (text selection) doesn't dismiss: the click only counts when
// the press began on the same element. Escape keeps its native behavior.

if (!globalThis.__dakitDialogDismiss) {
  globalThis.__dakitDialogDismiss = true;

  let pressed = null;

  document.addEventListener(
    "pointerdown",
    (event) => {
      pressed = event.target;
    },
    true,
  );

  document.addEventListener("click", (event) => {
    if (event.target !== pressed) return;
    if (event.target instanceof HTMLDialogElement && event.target.open) {
      event.target.close();
    }
  });
}
