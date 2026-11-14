import assert from "node:assert/strict";
import test from "node:test";
import { createAcademyLeadsSurface } from "../src/surfaces/academy-leads.js";

function createFakeDom() {
  class FakeNode {
    constructor(tag) {
      this.tagName = tag;
      this.children = [];
      this.dataset = {};
      this.attributes = {};
      this.listeners = {};
      this.className = "";
      this.type = "";
      this.checked = false;
      this.disabled = false;
      this.value = "";
      this.selected = false;
      this._textContent = "";
    }
    set textContent(v) {
      this._textContent = String(v);
      this.children = [];
    }
    get textContent() {
      return this._textContent || this.children.map((c) => c.textContent).join("");
    }
    set innerHTML(_v) {}
    setAttribute(k, v) {
      this.attributes[k] = String(v);
    }
    addEventListener(type, fn) {
      this.listeners[type] = fn;
    }
    append(...nodes) {
      for (const n of nodes) {
        if (n && typeof n === "object") this.children.push(n);
      }
    }
    replaceChildren(...nodes) {
      this.children = [];
      this.append(...nodes);
    }
    remove() {}
    click() {}
  }

  return {
    body: new FakeNode("body"),
    createElement: (tag) => new FakeNode(tag),
    createTextNode: (text) => ({ textContent: text }),
  };
}

test("createAcademyLeadsSurface renders summary and leads table", async () => {
  const dom = createFakeDom();
  const documentList = dom.createElement("div");
  const requests = [];
  const surface = createAcademyLeadsSurface({
    documentList,
    documentRef: dom,
    getActiveWorkspaceRoute: () => ({ view: "academy-leads", params: {} }),
    navigateCanonicalWorkspace: () => {},
    request: async (url) => {
      requests.push(url);
      return {
        leads: [
          {
            created_at: "2026-11-14T08:00:00+00:00",
            email: "ada@example.org",
            track: "agentic-engineering",
            utm_source: "meta",
            utm_medium: "paid-social",
            utm_campaign: "c1",
            utm_content: "seats",
            utm_term: "",
            referrer: "https://l.instagram.com/",
            page: "/agentic-engineering/",
            is_test: false,
            answers: { location: "berlin" },
          },
        ],
        summary: {
          total: 1,
          testCount: 1,
          byTrack: { "agentic-engineering": 1, "ai-engineering": 0 },
          firstChoice: { "agentic only": 1, "AI only": 0, both: 0 },
          byUtm: [{ utm_source: "meta", utm_content: "seats", agentic: 1, ai: 0, total: 1 }],
        },
      };
    },
    setRouteTitle: () => {},
    workApiUrl: (path, query = {}) => {
      const qs = new URLSearchParams(query).toString();
      return qs ? `${path}?${qs}` : path;
    },
  });

  surface.renderAcademyLeads();
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(requests.length, 1);
  assert.equal(requests[0], "/api/academy-leads");
  assert.match(documentList.textContent, /Academy Leads/);
  assert.match(documentList.textContent, /ada@example\.org/);
  assert.match(documentList.textContent, /agentic-engineering: 1/);
});

test("createAcademyLeadsSurface reads URLSearchParams filters (includeTests and track)", async () => {
  const dom = createFakeDom();
  const documentList = dom.createElement("div");
  const requests = [];

  const surface = createAcademyLeadsSurface({
    documentList,
    documentRef: dom,
    getActiveWorkspaceRoute: () => ({
      view: "academy-leads",
      params: new URLSearchParams("includeTests=true&track=agentic-engineering"),
    }),
    navigateCanonicalWorkspace: () => {},
    request: async (url) => {
      requests.push(url);
      return {
        leads: [],
        summary: {
          total: 0,
          testCount: 0,
          byTrack: { "agentic-engineering": 0, "ai-engineering": 0 },
          firstChoice: { "agentic only": 0, "AI only": 0, both: 0 },
          byUtm: [],
        },
      };
    },
    setRouteTitle: () => {},
    workApiUrl: (path, query = {}) => {
      const qs = new URLSearchParams(query).toString();
      return qs ? `${path}?${qs}` : path;
    },
  });

  surface.renderAcademyLeads();
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(requests.length, 1);
  assert.equal(requests[0], "/api/academy-leads?includeTests=true&track=agentic-engineering");
});
