import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { wireSponsorContractDialog } from "../src/surfaces/finance/sponsor-contract.js";
import { createSponsorDialogGuard } from "../src/surfaces/finance/sponsor-contacts.js";

function stubElement(tag = "div") {
  const element = {
    tag,
    textContent: "",
    innerHTML: "",
    hidden: false,
    value: "",
    open: false,
    listeners: new Map(),
    addEventListener(type, listener) {
      const list = element.listeners.get(type) || [];
      list.push(listener);
      element.listeners.set(type, list);
    },
    async click(event = {}) {
      for (const listener of element.listeners.get("click") || []) {
        await listener({ preventDefault() {}, ...event });
      }
    },
    reset() {
      for (const input of Object.values(element.elements || {})) input.value = "";
    },
    showModal() {
      element.open = true;
    },
  };
  return element;
}

function stubForm() {
  const form = stubElement("form");
  const named = new Map();
  form.elements = new Proxy(
    {},
    {
      get(_target, property) {
        if (typeof property !== "string") return undefined;
        if (!named.has(property)) named.set(property, stubElement("input"));
        return named.get(property);
      },
    },
  );
  return form;
}

function stubDialog() {
  const dialog = stubElement("dialog");
  const queries = new Map();
  dialog.setQuery = (selector, element) => queries.set(selector, element);
  dialog.querySelector = (selector) => queries.get(selector) || null;
  return dialog;
}

const flush = async (rounds = 12) => {
  for (let i = 0; i < rounds; i += 1) await new Promise((resolve) => setImmediate(resolve));
};

function harness({ deal, contracts = {}, dealResponses = null }) {
  const dialog = stubDialog();
  const summary = stubElement("p");
  const links = stubElement("p");
  links.hidden = true;
  const createButton = stubElement("button");
  const sendButton = stubElement("button");
  sendButton.hidden = true;
  const form = stubForm();
  const alert = stubElement("p");
  dialog.setQuery("[data-contract-summary]", summary);
  dialog.setQuery("[data-contract-links]", links);
  dialog.setQuery("[data-contract-create]", createButton);
  dialog.setQuery("[data-contract-send]", sendButton);
  dialog.setQuery("form", form);
  dialog.setQuery("[role=alert]", alert);
  const openButton = stubElement("button");
  const dealForm = stubForm();
  dealForm.elements.dealId.value = deal.id;
  const surface = {
    querySelector: (selector) =>
      (
        {
          "[data-contract-dialog]": dialog,
          "[data-contract-open]": openButton,
          "[data-deal-dialog] form": dealForm,
        }
      )[selector] || null,
  };
  const calls = [];
  let dealCalls = 0;
  const api = async (path, options = {}) => {
    calls.push({ path, ...options });
    if (options.method === "POST" && path === "/contracts") {
      return { id: "contract-new", status: "draft", version: 1 };
    }
    if (options.method === "POST" && path.endsWith("/send")) {
      return {
        contract: { id: "contract-new", status: "sent" },
        emailDelivery: { state: "sent", to: "sponsor@example.test" },
        signingUrls: { sponsor: "https://sign.example.test/s", counter: "https://sign.example.test/c" },
      };
    }
    if (path.startsWith("/contracts/")) return contracts[path.slice("/contracts/".length)];
    if (path.startsWith("/deals/")) {
      if (dealResponses) return dealResponses[Math.min(dealCalls++, dealResponses.length - 1)];
      return deal;
    }
    throw new Error("unexpected api call " + path);
  };
  let deals = [deal];
  const safe = (fn, fallback) =>
    Promise.resolve()
      .then(fn)
      .catch((error) => {
        alert.textContent = fallback + ": " + error.message;
      });
  wireSponsorContractDialog({
    surface,
    api,
    safe,
    getDeals: () => deals,
    setDeals: (items) => {
      deals = items;
    },
  });
  return { summary, links, createButton, sendButton, form, alert, openButton, calls, getDeals: () => deals };
}

const terms = {
  company: "Acme GmbH",
  legalPayer: "Acme Holding GmbH",
  payerCountry: "DE",
  scope: "One newsletter slot",
  priceEur: 2500,
  startDate: "2026-05-01",
  endDate: "2026-06-01",
  signingOrder: "sponsor-first",
};

function contractWith(status) {
  return { id: "dealcontract-9", status, version: 2, terms, signedPdf: status === "signed" ? { sha256: "abc123def456" } : undefined };
}

describe("sponsor contract dialog", () => {
  test("names every lifecycle status in the summary", async () => {
    for (const status of ["draft", "sent", "viewed", "signed", "declined"]) {
      const contract = contractWith(status);
      const deal = { id: "deal-1", organizationName: "Acme", amountEur: 2500, contract };
      const h = harness({ deal, contracts: { "dealcontract-9": contract } });
      await h.openButton.click();
      await flush();
      assert.match(h.summary.textContent, new RegExp(`dealcont.*${status}`, "i"), status);
    }
  });

  test("send is offered for draft, sent and viewed; downloads only for signed", async () => {
    for (const status of ["draft", "sent", "viewed", "signed", "declined"]) {
      const contract = contractWith(status);
      const deal = { id: "deal-1", organizationName: "Acme", amountEur: 2500, contract };
      const h = harness({ deal, contracts: { "dealcontract-9": contract } });
      await h.openButton.click();
      await flush();
      assert.equal(h.sendButton.hidden, !(status === "draft" || status === "sent" || status === "viewed"), status);
      if (status === "signed") {
        assert.equal(h.links.hidden, false);
        assert.match(h.links.innerHTML, /\/api\/sponsor-crm\/contracts\/dealcontract-9\/pdf/);
        assert.match(h.links.innerHTML, /\/api\/sponsor-crm\/contracts\/dealcontract-9\/audit/);
      } else {
        assert.equal(h.links.hidden, true, status);
      }
    }
  });

  test("a deal without a contract invites creation and hides send", async () => {
    const h = harness({ deal: { id: "deal-1", organizationName: "Acme", amountEur: 2500, contract: null } });
    await h.openButton.click();
    await flush();
    assert.match(h.summary.textContent, /No contract yet/);
    assert.equal(h.sendButton.hidden, true);
    assert.equal(h.links.hidden, true);
  });

  test("create posts deal terms, then send mints the signing links", async () => {
    const draft = { id: "contract-new", status: "draft" };
    const sent = { id: "contract-new", status: "sent" };
    const h = harness({
      deal: { id: "deal-1", organizationName: "Acme", amountEur: 2500, contract: null },
      dealResponses: [
        { id: "deal-1", contract: draft },
        { id: "deal-1", contract: sent },
      ],
    });
    await h.openButton.click();
    await flush();
    for (const [name, value] of Object.entries({ ...terms, priceEur: String(terms.priceEur) })) {
      h.form.elements[name].value = value;
    }
    await h.createButton.click();
    await flush();
    const created = h.calls.find((call) => call.path === "/contracts" && call.method === "POST");
    assert.deepEqual(JSON.parse(created.body), {
      dealId: "deal-1",
      terms: { ...terms, priceEur: 2500 },
    });
    assert.match(h.alert.textContent, /Contract created/);
    assert.equal(h.sendButton.hidden, false);
    await h.sendButton.click();
    await flush();
    const send = h.calls.find((call) => call.path === "/contracts/contract-new/send");
    assert.equal(send.method, "POST");
    assert.match(h.links.innerHTML, /https:\/\/sign\.example\.test\/s/);
    assert.match(h.summary.textContent, /sent/);
  });
});

describe("deal agreed gate", () => {
  test("the server refusal message lands in the dialog alert", () => {
    const alert = stubElement("p");
    const dialog = stubDialog();
    dialog.setQuery('[role="alert"]', alert);
    const guard = createSponsorDialogGuard({ dialog });
    const save = guard.beginSave();
    assert.ok(save);
    const refused = new Error("A signed contract is required before this deal can be marked agreed");
    refused.status = 422;
    refused.code = "signed_contract_required";
    assert.equal(save.fail(refused, "Could not save deal"), true);
    assert.equal(alert.textContent, "A signed contract is required before this deal can be marked agreed");
  });
});
