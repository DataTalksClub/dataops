/** Both first imports and replacements use the server's byte-parsed batch. */
export async function importStatementWithReview(documentId, { period, request, workApiUrl, confirmReplacement }) {
  const post = (body) => request(workApiUrl("/api/reconcile/statements/import"), {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ documentId, period, ...body }),
  });
  const result = await post({ preview: true });
  if (result.preview.requiresConfirmation && !await confirmReplacement(result.preview)) return { ...result, cancelled: true };
  return post({ replace: result.preview.requiresConfirmation, previewDigest: result.preview.digest });
}

export function statementHeaderReviewLines(preview) {
  const balances = (values) => (values || [])
    .map((value) => `${value.asOf} ${value.wallet || "main"} ${value.amount} ${value.currency}`)
    .join(", ") || "not printed";
  const summary = (label, value) => [
    `${label}: Issue date ${value.issueDate || "not printed"}`,
    `From ${value.from || "not printed"}`,
    `To ${value.to || "not printed"}`,
    `Opening ${balances(value.openingBalances)}`,
    `Closing ${balances(value.balances)}.`,
  ].join("; ");
  return preview.replacements.flatMap((item) => [
    ...item.difference.existing.map((value) => summary("Existing", value)),
    summary("Incoming", item.difference.candidate),
  ]);
}

export function confirmStatementReplacement(preview, { document, openDialog }) {
  return new Promise((resolve) => {
    const dialog = document.createElement("dialog");
    const heading = document.createElement("h2"); heading.textContent = "Replace existing statement?";
    const message = document.createElement("p"); message.textContent = preview.message;
    dialog.append(heading, message);
    for (const item of preview.replacements) {
      const text = document.createElement("p");
      const diff = item.difference;
      const added = diff.added.reduce((n, row) => n + row.count, 0);
      const removed = diff.removed.reduce((n, row) => n + row.count, 0);
      text.textContent = diff.identical
        ? `${item.period}: No differences in operations, balances or coverage.`
        : [
          `${item.period}: ${added} added and ${removed} removed operations.`,
          `Balances ${diff.balancesChanged ? "changed" : "unchanged"}.`,
          `Coverage ${diff.periodChanged ? "changed" : "unchanged"}.`,
        ].join(" ");
      dialog.append(text);
      for (const value of statementHeaderReviewLines({ replacements: [item] })) {
        const line = document.createElement("p"); line.textContent = value; dialog.append(line);
      }
      for (const [label, rows] of [["Added", diff.added], ["Removed", diff.removed]]) {
        for (const entry of rows) {
          const line = document.createElement("p");
          line.textContent = `${label} ×${entry.count}: ${entry.row.date} ${entry.row.amount} ${entry.row.currency} ${entry.row.counterparty} ${entry.row.reference || ""}`;
          dialog.append(line);
        }
      }
    }
    const cancel = document.createElement("button"); cancel.type = "button"; cancel.textContent = "Keep existing statement";
    const replace = document.createElement("button"); replace.type = "button"; replace.textContent = "Replace statement";
    let confirmed = false;
    cancel.addEventListener("click", () => dialog.close());
    replace.addEventListener("click", () => { confirmed = true; dialog.close(); });
    dialog.addEventListener("close", () => { dialog.remove(); resolve(confirmed); }, { once: true });
    dialog.append(cancel, replace); document.body.append(dialog); openDialog(dialog);
  });
}
