import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  accountInitials,
  createAccountShell,
  currentOperatorFromPayload,
  localPreviewActor,
} from "../src/shell/account.js";
import { FakeDocument, FakeElement } from "./support/fake-dom.mjs";

class AccountDocument extends FakeDocument {
  constructor(...roots) {
    super(...roots);
    this.activeElement = null;
    this.listeners = new Map();
  }

  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) || [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  async emit(type, values = {}) {
    const event = {
      target: values.target || this,
      preventDefault() {},
      stopPropagation() {},
      ...values,
    };
    for (const listener of [...(this.listeners.get(type) || [])]) {
      await listener(event);
    }
  }
}

function descendants(element) {
  return element.children.flatMap((child) => [child, ...descendants(child)]);
}

function addContainment(element) {
  element.contains = (candidate) =>
    candidate === element || descendants(element).includes(candidate);
  for (const child of element.children) addContainment(child);
}

function createElement(id, tagName = "div") {
  const value = new FakeElement(tagName);
  value.id = id;
  value.setAttribute("id", id);
  return value;
}

function dataElement(attribute) {
  const value = new FakeElement("span");
  value.setAttribute(attribute, "");
  return value;
}

function createAccountHarness(options = {}) {
  const body = createElement("body", "body");
  const settingsButton = createElement("settings-button", "button");
  const mobileSettingsButton = createElement(
    "mobile-settings-button",
    "button",
  );
  const settingsMenu = createElement("settings-menu");
  settingsMenu.hidden = true;
  const settingsMenuClose = createElement("settings-menu-close", "button");
  const settingsAdminButton = createElement("settings-admin-button", "button");
  const settingsUsersButton = createElement("settings-users-button", "button");
  const settingsSignOutButton = createElement(
    "settings-sign-out-button",
    "button",
  );
  settingsSignOutButton.append(new FakeElement("span"));
  const accountIdentity = createElement("account-identity");
  const accountWorkScopeList = createElement("account-work-scope-list");
  const menuAvatar = dataElement("data-account-menu-avatar");
  const menuName = dataElement("data-account-menu-name");
  const actorAvatar = dataElement("data-account-actor-avatar");
  const actorName = dataElement("data-account-actor-name");
  const accountMeta = dataElement("data-account-meta");
  const themeToggleButton = createElement("theme-toggle-button", "button");
  const gitPullButton = createElement("git-pull-button", "button");
  const gitCommitButton = createElement("git-commit-button", "button");
  settingsMenu.append(
    settingsMenuClose,
    settingsAdminButton,
    settingsUsersButton,
    settingsSignOutButton,
    accountIdentity,
    accountWorkScopeList,
    menuAvatar,
    menuName,
    actorAvatar,
    actorName,
    accountMeta,
    themeToggleButton,
    gitPullButton,
    gitCommitButton,
  );
  body.append(settingsButton, mobileSettingsButton, settingsMenu);
  addContainment(body);
  const document = new AccountDocument(body);
  for (const node of [body, ...descendants(body)]) {
    node.ownerDocument = document;
    node.focus = function focus() {
      this.focused = true;
      document.activeElement = this;
    };
  }
  const refreshes = [];
  const shown = [];
  const assigned = [];
  const fetchCalls = [];
  const locationRef = {
    hostname: options.hostname || "ops.dtcdev.click",
    assign: (path) => assigned.push(path),
  };
  let allowLeave = options.allowLeave ?? true;
  const shell = createAccountShell({
    canLeaveCurrentDocument: async () => allowLeave,
    closeNotifications: () => {},
    documentRef: document,
    fetchImpl: async (url, requestOptions) => {
      fetchCalls.push({ url, options: requestOptions });
      if (options.fetchError) throw new Error("offline");
      return {
        ok: options.fetchOk ?? true,
        json: async () => options.previewPayload || {},
      };
    },
    getActiveWorkspaceView: () => options.activeView || "home",
    gitCommitButton,
    gitPullButton,
    HTMLElementClass: FakeElement,
    isOperationsHomeVisible: () => options.homeVisible ?? true,
    locationRef,
    refreshDocuments: () => refreshes.push("refresh"),
    showWorkspaceSurface: (surface) => shown.push(surface),
    syncThemeToggleLabel: () => {},
    themeToggleButton,
  });
  return {
    accountIdentity,
    accountMeta,
    accountWorkScopeList,
    actorAvatar,
    actorName,
    assigned,
    document,
    fetchCalls,
    gitPullButton,
    menuAvatar,
    menuName,
    mobileSettingsButton,
    refreshes,
    setAllowLeave(value) {
      allowLeave = value;
    },
    settingsAdminButton,
    settingsButton,
    settingsMenu,
    settingsMenuClose,
    settingsSignOutButton,
    settingsUsersButton,
    shell,
    shown,
    themeToggleButton,
  };
}

const members = [
  { id: "alexey", name: "Alexey Grigorev", email: "alexey@datatalks.club" },
  { id: "grace", name: "Grace Young", email: "grace@datatalks.club" },
  {
    id: "valeriia",
    name: "Valeriia Tsvetkova",
    email: "valeriia@datatalks.club",
  },
];

describe("account identity and work-scope behavior", () => {
  test("normalizes initials, authenticated payloads, and local preview actors", () => {
    assert.equal(accountInitials(" Alexey   Grigorev "), "AG");
    assert.equal(accountInitials("Grace"), "G");
    assert.equal(accountInitials(""), "?");
    assert.equal(currentOperatorFromPayload({ user: members[0] }), members[0]);
    assert.equal(currentOperatorFromPayload({ actor: members[1] }), members[1]);
    assert.deepEqual(currentOperatorFromPayload({ id: "direct" }), {
      id: "direct",
    });
    assert.equal(currentOperatorFromPayload({}), null);
    assert.deepEqual(
      localPreviewActor(members, {
        actorEmail: " GRACE@DATATALKS.CLUB ",
        localPreview: true,
      }),
      { user: members[1], localPreview: true },
    );
    assert.equal(localPreviewActor(members, { actorEmail: "missing@example.com" }), null);
  });

  test("keeps signed-in identity separate from the selected teammate work scope", async () => {
    const harness = createAccountHarness();
    await harness.shell.refreshAccountIdentity({ user: members[0] }, members);
    assert.equal(harness.shell.activeWorkOwnerId(), "alexey");
    assert.equal(harness.actorName.textContent, "Alexey Grigorev");
    assert.equal(harness.accountMeta.textContent, "alexey@datatalks.club");
    assert.equal(harness.menuName.textContent, "Alexey Grigorev");
    assert.equal(harness.accountWorkScopeList.children.length, 3);

    const graceOption = harness.accountWorkScopeList.children.find((option) =>
      option.textContent.includes("Grace Young"),
    );
    await graceOption.dispatch("click");
    assert.equal(harness.shell.activeWorkOwnerId(), "grace");
    assert.equal(harness.menuName.textContent, "Grace Young");
    assert.equal(harness.menuAvatar.textContent, "GY");
    assert.equal(harness.actorName.textContent, "Alexey Grigorev");
    assert.equal(harness.actorAvatar.textContent, "AG");
    assert.match(harness.settingsButton.title, /Showing Grace Young’s work/);
    assert.match(harness.settingsButton.title, /Signed in as Alexey Grigorev/);
    assert.deepEqual(harness.refreshes, ["refresh"]);
  });

  test("preserves a valid teammate scope and drops disabled or removed scopes", async () => {
    const harness = createAccountHarness();
    await harness.shell.refreshAccountIdentity({ user: members[0] }, members);
    const graceOption = harness.accountWorkScopeList.children.find((option) =>
      option.textContent.includes("Grace Young"),
    );
    await graceOption.dispatch("click");
    await harness.shell.refreshAccountIdentity({ user: members[0] }, members);
    assert.equal(harness.shell.activeWorkOwnerId(), "grace");

    const graceDisabled = members.map((member) =>
      member.id === "grace" ? { ...member, disabled: true } : member,
    );
    await harness.shell.refreshAccountIdentity(
      { user: members[0] },
      graceDisabled,
    );
    assert.equal(harness.shell.activeWorkOwnerId(), "alexey");
    assert.equal(
      harness.accountWorkScopeList.children.some((option) =>
        option.textContent.includes("Grace Young"),
      ),
      false,
    );
  });

  test("uses local preview context only on loopback and fails closed", async () => {
    const local = createAccountHarness({
      hostname: "localhost",
      previewPayload: {
        actorEmail: "valeriia@datatalks.club",
        localPreview: true,
      },
    });
    const context = await local.shell.readLocalPreviewContext();
    assert.equal(local.fetchCalls.length, 1);
    assert.equal(local.fetchCalls[0].url, "/__dataops/dev-context");
    assert.equal(local.fetchCalls[0].options.cache, "no-store");
    await local.shell.refreshAccountIdentity(null, members, context);
    assert.equal(local.shell.activeWorkOwnerId(), "valeriia");
    assert.equal(local.shell.getAccountIdentityState().localPreview, true);

    const production = createAccountHarness();
    assert.equal(await production.shell.readLocalPreviewContext(), null);
    assert.equal(production.fetchCalls.length, 0);
    await production.shell.refreshAccountIdentity(null, members, {});
    assert.equal(production.accountIdentity.dataset.state, "unavailable");
    assert.equal(
      production.accountMeta.textContent,
      "Signed-in identity unavailable",
    );
  });

  test("opens and closes the account menu with focus and canonical navigation", async () => {
    const harness = createAccountHarness();
    await harness.shell.refreshAccountIdentity({ user: members[0] }, members);
    harness.document.activeElement = harness.settingsButton;
    await harness.settingsButton.dispatch("click");
    assert.equal(harness.shell.isSettingsMenuOpen(), true);
    assert.equal(harness.settingsButton.getAttribute("aria-expanded"), "true");
    assert.equal(harness.settingsMenuClose.focused, true);

    await harness.settingsAdminButton.dispatch("click");
    assert.deepEqual(harness.shown, ["admin"]);
    assert.equal(harness.shell.isSettingsMenuOpen(), false);
    assert.equal(harness.settingsButton.focused, true);

    await harness.mobileSettingsButton.dispatch("click");
    await harness.settingsUsersButton.dispatch("click");
    assert.deepEqual(harness.shown, ["admin", "users"]);

    await harness.settingsButton.dispatch("click");
    await harness.document.emit("click", { target: new FakeElement("div") });
    assert.equal(harness.shell.isSettingsMenuOpen(), false);
  });

  test("guards logout against dirty work and closes on account-adjacent actions", async () => {
    const harness = createAccountHarness({ allowLeave: false });
    await harness.shell.refreshAccountIdentity({ user: members[0] }, members);
    await harness.settingsButton.dispatch("click");
    await harness.settingsSignOutButton.dispatch("click");
    assert.deepEqual(harness.assigned, []);
    assert.equal(harness.settingsSignOutButton.disabled, false);

    harness.setAllowLeave(true);
    await harness.settingsSignOutButton.dispatch("click");
    assert.deepEqual(harness.assigned, ["/logout"]);
    assert.equal(harness.settingsSignOutButton.disabled, true);
    assert.equal(
      harness.settingsSignOutButton.querySelector("span").textContent,
      "Ending this browser session…",
    );

    harness.settingsSignOutButton.disabled = false;
    await harness.settingsButton.dispatch("click");
    await harness.themeToggleButton.dispatch("click", {
      stopPropagation() {},
    });
    assert.equal(harness.shell.isSettingsMenuOpen(), false);
  });
});
