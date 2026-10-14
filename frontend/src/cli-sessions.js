export async function renderCliSessions({ documentRef, request }) {
  const card = documentRef.querySelector("#device-card");
  card.className = "dk-stack";
  const make = (tag, className, text) => {
    const node = documentRef.createElement(tag);
    node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  };
  const heading = make("h1", "dk-page-header__title", "CLI sessions");
  const identity = documentRef.querySelector("#device-identity");
  try {
    const [me, data] = await Promise.all([
      request("/api/me"),
      request("/api/tokens"),
    ]);
    identity.textContent = (me.user || me).email || "";
    card.replaceChildren(heading);
    const sessions = data.tokens || [];
    if (!sessions.length) {
      card.append(
        make(
          "p",
          "dk-empty",
          "No CLI sessions. Run dataops login to create one.",
        ),
      );
      return;
    }
    const list = make("div", "dk-session-list");
    for (const session of sessions) {
      const row = make("div", "dk-session-list__row");
      const main = make("div", "dk-stack dk-stack--tight");
      main.append(make("strong", "", session.label || "CLI session"));
      main.append(
        make(
          "p",
          "dk-mono dk-hint",
          [
            session.requestIp,
            `Created ${new Date(session.createdAt).toLocaleDateString()}`,
            `Last used ${session.lastUsedAt ? new Date(session.lastUsedAt).toLocaleDateString() : "Never"}`,
            `Expires ${new Date(session.expiresAt).toLocaleDateString()}`,
          ]
            .filter(Boolean)
            .join(" · "),
        ),
      );
      const signout = make(
        "button",
        "dk-button dk-button--sm dk-button--danger",
        "Sign out",
      );
      signout.type = "button";
      signout.addEventListener("click", () => {
        const dialog = make("dialog", "dk-dialog");
        const head = make(
          "div",
          "dk-dialog__head",
          "Sign out this CLI session?",
        );
        const body = make(
          "div",
          "dk-dialog__body",
          `This will revoke access for ${session.label || "this machine"}.`,
        );
        const foot = make("div", "dk-dialog__foot");
        const cancel = make(
          "button",
          "dk-button dk-button--secondary",
          "Cancel",
        );
        cancel.addEventListener("click", () => dialog.close());
        const confirm = make(
          "button",
          "dk-button dk-button--danger",
          "Sign out",
        );
        confirm.addEventListener("click", async () => {
          confirm.disabled = true;
          try {
            await request(`/api/tokens/${encodeURIComponent(session.id)}`, {
              method: "DELETE",
            });
            dialog.close();
            await renderCliSessions({ documentRef, request });
          } catch {
            body.textContent = "Could not sign out this session. Try again.";
            confirm.disabled = false;
          }
        });
        foot.append(cancel, confirm);
        dialog.append(head, body, foot);
        documentRef.body.append(dialog);
        dialog.addEventListener("close", () => {
          dialog.remove();
          if (signout.isConnected) signout.focus();
        });
        dialog.showModal();
      });
      row.append(main, signout);
      list.append(row);
    }
    card.append(list);
  } catch {
    card.replaceChildren(
      heading,
      make(
        "p",
        "dk-callout dk-callout--danger",
        "Could not load CLI sessions. Try again.",
      ),
    );
    const retry = make("button", "dk-button dk-button--secondary", "Retry");
    retry.addEventListener("click", () =>
      renderCliSessions({ documentRef, request }),
    );
    card.append(retry);
  }
}
