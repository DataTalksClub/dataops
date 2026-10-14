import { personInitials } from "../core/identity.js";

export function accountInitials(name) {
  return personInitials(name);
}

export function currentOperatorFromPayload(payload) {
  if (!payload || typeof payload !== "object") return null;
  if (payload.user && typeof payload.user === "object") return payload.user;
  if (payload.actor && typeof payload.actor === "object") return payload.actor;
  return payload.id ? payload : null;
}

export function localPreviewActor(members, payload) {
  const actorEmail = String(payload?.actorEmail || "")
    .trim()
    .toLowerCase();
  if (!actorEmail) return null;
  const user = members.find(
    (member) =>
      String(member?.email || "")
        .trim()
        .toLowerCase() === actorEmail,
  );
  return user ? { user, localPreview: payload?.localPreview === true } : null;
}

export function createAccountShell({
  canLeaveCurrentDocument,
  documentRef,
  fetchImpl,
  isOperationsWorkspaceVisible,
  locationRef,
  refreshDocuments,
  shell = globalThis.dakitShell,
}) {
  const settingsButton = documentRef.querySelector("#settings-button");
  const settingsMenu = documentRef.querySelector("#settings-menu");
  const settingsSignOutButton = documentRef.querySelector(
    "#settings-sign-out-button",
  );
  const accountIdentity = documentRef.querySelector("#account-identity");
  const accountWorkScopeList = documentRef.querySelector(
    "#account-work-scope-list",
  );
  const accountMenuAvatarNodes = [
    ...documentRef.querySelectorAll("[data-account-menu-avatar]"),
  ];
  const accountMenuNameNodes = [
    ...documentRef.querySelectorAll("[data-account-menu-name]"),
  ];
  const accountActorNameNode = documentRef.querySelector(
    "[data-account-actor-name]",
  );
  const accountMetaNode = documentRef.querySelector("[data-account-meta]");
  const settingsButtons = [settingsButton];
  let identityState = {
    loaded: false,
    localPreview: false,
    user: null,
    members: [],
    selectedOwnerId: "",
    error: "",
  };

  function getAccountIdentityState() {
    return identityState;
  }

  function activeWorkOwner() {
    const selectedId = String(identityState.selectedOwnerId || "");
    return (
      identityState.members.find(
        (member) => String(member.id || "") === selectedId,
      ) ||
      identityState.user ||
      null
    );
  }

  function activeWorkOwnerId() {
    return String(activeWorkOwner()?.id || "");
  }

  function closeSettingsMenu() {
    if (!settingsMenu.hidden) shell.closePopovers();
  }

  function renderAccountIdentity() {
    const actor = identityState.user;
    const actorName = actor?.name || "Account";
    const workOwner = activeWorkOwner();
    const menuName = workOwner?.name || actorName;
    const menuInitials = accountInitials(workOwner?.name || actor?.name);
    for (const node of accountMenuAvatarNodes) node.textContent = menuInitials;
    for (const node of accountMenuNameNodes) node.textContent = menuName;
    if (accountActorNameNode) accountActorNameNode.textContent = actorName;
    for (const button of settingsButtons) {
      const scopeDiffers =
        actor && workOwner && String(actor.id) !== String(workOwner.id);
      button.title = scopeDiffers
        ? `Showing ${menuName}’s work · Signed in as ${actorName}`
        : `Account: ${actorName}`;
      button.setAttribute(
        "aria-label",
        scopeDiffers
          ? `Showing work for ${menuName}; signed in as ${actorName}`
          : `Account for ${actorName}`,
      );
    }

    accountIdentity.dataset.state = actor
      ? "ready"
      : identityState.loaded
        ? "unavailable"
        : "loading";
    if (actor?.email) accountMetaNode.textContent = actor.email;
    else if (!identityState.loaded) {
      accountMetaNode.textContent = "Loading signed-in identity…";
    } else {
      accountMetaNode.textContent =
        identityState.error || "Signed-in identity unavailable";
    }

    if (!identityState.loaded) {
      const loading = documentRef.createElement("p");
      loading.className = "account-scope-loading";
      loading.textContent = "Loading workspace members…";
      accountWorkScopeList.replaceChildren(loading);
      return;
    }
    const members = [...identityState.members]
      .filter((member) => member && member.id && member.disabled !== true)
      .sort((left, right) => {
        if (String(left.id) === String(actor?.id || "")) return -1;
        if (String(right.id) === String(actor?.id || "")) return 1;
        return String(left.name || "").localeCompare(String(right.name || ""));
      });
    if (members.length === 0) {
      const empty = documentRef.createElement("p");
      empty.className = "account-scope-loading";
      empty.textContent = "No workspace members available.";
      accountWorkScopeList.replaceChildren(empty);
      return;
    }

    const options = members.map((member) => {
      const isSelected =
        String(member.id) === String(identityState.selectedOwnerId || "");
      const button = documentRef.createElement("button");
      button.type = "button";
      button.className = "dk-menu__item";
      button.setAttribute("role", "radio");
      button.setAttribute("aria-checked", String(isSelected));
      button.setAttribute(
        "aria-label",
        `${isSelected ? "Showing" : "Show"} work for ${
          member.name || "workspace member"
        }`,
      );
      const avatar = documentRef.createElement("span");
      avatar.className = "dk-avatar dk-avatar--xs";
      avatar.setAttribute("aria-hidden", "true");
      avatar.textContent = accountInitials(member.name);
      const copy = documentRef.createElement("span");
      copy.className = "account-scope-name";
      const name = documentRef.createElement("strong");
      name.textContent = member.name || "Workspace member";
      copy.append(name);
      const check = documentRef.createElement("span");
      check.className = "dk-menu__check";
      check.setAttribute("aria-hidden", "true");
      check.textContent = isSelected ? "✓" : "";
      button.append(avatar, copy, check);
      button.addEventListener("click", () => {
        if (String(identityState.selectedOwnerId || "") === String(member.id)) {
          closeSettingsMenu();
          return;
        }
        identityState.selectedOwnerId = String(member.id);
        renderAccountIdentity();
        closeSettingsMenu();
        if (
          isOperationsWorkspaceVisible()
        ) {
          refreshDocuments();
        }
      });
      return button;
    });
    accountWorkScopeList.replaceChildren(...options);
  }

  async function readLocalPreviewContext() {
    if (
      locationRef.hostname !== "localhost" &&
      locationRef.hostname !== "127.0.0.1"
    ) {
      return null;
    }
    try {
      const response = await fetchImpl("/__dataops/dev-context", {
        headers: { accept: "application/json" },
        cache: "no-store",
      });
      if (!response.ok) return null;
      return await response.json();
    } catch {
      return null;
    }
  }

  async function refreshAccountIdentity(mePayload, members, localContext) {
    const availableMembers = Array.isArray(members)
      ? members.filter(
          (member) => member && member.id && member.disabled !== true,
        )
      : [];
    let actor = currentOperatorFromPayload(mePayload);
    let localPreview = false;
    if (actor?.id) {
      actor =
        availableMembers.find(
          (member) => String(member.id) === String(actor.id),
        ) || actor;
    } else {
      const preview = localPreviewActor(
        availableMembers,
        localContext || (await readLocalPreviewContext()),
      );
      actor = preview?.user || null;
      localPreview = Boolean(preview?.localPreview);
    }
    const priorOwnerId = String(identityState.selectedOwnerId || "");
    const selectedOwnerId = availableMembers.some(
      (member) => String(member.id) === priorOwnerId,
    )
      ? priorOwnerId
      : String(actor?.id || "");
    identityState = {
      loaded: true,
      localPreview,
      user: actor,
      members: availableMembers,
      selectedOwnerId,
      error: actor ? "" : "Signed-in identity unavailable",
    };
    renderAccountIdentity();
  }

  settingsSignOutButton.addEventListener("click", async () => {
    if (!(await canLeaveCurrentDocument())) return;
    settingsSignOutButton.disabled = true;
    settingsSignOutButton.querySelector("span").textContent =
      "Ending this browser session…";
    locationRef.assign("/logout");
  });
  settingsButton.addEventListener("click", () => {
    renderAccountIdentity();
  });

  return {
    activeWorkOwner,
    activeWorkOwnerId,
    closeSettingsMenu,
    currentOperatorFromPayload,
    getAccountIdentityState,
    isSettingsMenuOpen: () => !settingsMenu.hidden,
    localPreviewActor,
    readLocalPreviewContext,
    refreshAccountIdentity,
    renderAccountIdentity,
  };
}
