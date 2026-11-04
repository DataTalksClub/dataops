/** Both first imports and replacements use the server's byte-parsed batch. */
export async function importStatementWithReview(documentId, { request, workApiUrl, confirmReplacement }) {
  const post = (body) => request(workApiUrl("/api/reconcile/statements/import"), {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ documentId, ...body }),
  });
  const result = await post({ preview: true });
  if (result.preview.requiresConfirmation && !await confirmReplacement(result.preview)) return { ...result, cancelled: true };
  return post({ replace: result.preview.requiresConfirmation, previewDigest: result.preview.digest });
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
      text.textContent = `${item.period}: ${diff.identical ? "No differences in operations, balances or coverage." : `${diff.added.reduce((n, row) => n + row.count, 0)} added and ${diff.removed.reduce((n, row) => n + row.count, 0)} removed operations. Balances ${diff.balancesChanged ? "changed" : "unchanged"}. Coverage ${diff.periodChanged ? "changed" : "unchanged"}.`} Existing issue date: ${diff.existing.map((record) => record.issueDate || "not printed").join(", ")}. Uploaded issue date: ${diff.candidate.issueDate || "not printed"}.`;
      dialog.append(text);
      for (const [label, rows] of [["Added", diff.added], ["Removed", diff.removed]]) {
        for (const entry of rows) {
          const line = document.createElement("p");
          line.textContent = `${label} ×${entry.count}: ${entry.row.date} ${entry.row.amount} ${entry.row.currency} ${entry.row.counterparty} ${entry.row.reference || ""}`;
          dialog.append(line);
        }
      }
      if (diff.balancesChanged) {
        for (const [label, balances] of [["Existing balances", diff.existing.flatMap((record) => [...(record.openingBalances || []), ...(record.balances || [])])], ["Uploaded balances", [...(diff.candidate.openingBalances || []), ...(diff.candidate.balances || [])]]]) {
          const line = document.createElement("p"); line.textContent = `${label}: ${balances.map((balance) => `${balance.asOf} ${balance.amount} ${balance.currency}`).join(", ")}`; dialog.append(line);
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
