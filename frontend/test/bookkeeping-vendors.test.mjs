import assert from "node:assert/strict";
import { test } from "node:test";

import {
  bookkeepingPurpose,
  bookkeepingVendorPresentation,
  canonicalCounterparty,
} from "../src/surfaces/finance/bookkeeping-vendors.js";

test("canonical vendor aliases preserve the bank name separately", () => {
  const examples = [
    ["Aws", "Amazon Web Services"],
    ["Aws Emea", "Amazon Web Services"],
    ["AWS EMEA SARL", "Amazon Web Services"],
    ["Amazon Web Services EMEA SARL", "Amazon Web Services"],
    ["Google Cloud", "Google"],
    ["Google Cloud EMEA Limited", "Google"],
    ["Google Workspace", "Google"],
    ["Google One", "Google"],
    ["X Corp", "X"],
    ["X Internet Unlimited Company", "X"],
    ["Go Daddy", "GoDaddy"],
    ["OpenAI", "OpenAI"],
  ];

  for (const [raw, expected] of examples) {
    const presentation = bookkeepingVendorPresentation({ counterparty: raw });
    assert.equal(presentation.canonicalCounterparty, expected, raw);
    assert.equal(presentation.rawCounterparty, raw, raw);
    assert.equal(canonicalCounterparty(raw), expected, raw);
  }

  assert.equal(canonicalCounterparty("Local Print Shop"), "Local Print Shop");
});

test("Google and X products have distinct short purposes", () => {
  assert.equal(bookkeepingPurpose({ counterparty: "Google", description: "Google Cloud" }), "Google Cloud");
  assert.equal(bookkeepingPurpose({ counterparty: "Google Workspace" }), "Google Workspace");
  assert.equal(bookkeepingPurpose({ counterparty: "Google One" }), "Google One storage");
  assert.equal(bookkeepingPurpose({ counterparty: "X Corp", description: "Paid Features" }), "X Premium subscription");
  assert.equal(bookkeepingPurpose({ counterparty: "X Internet Unlimited Company", description: "Revenue Sharing" }), "X creator revenue sharing");
});

test("known vendor and activity descriptions are concise", () => {
  assert.equal(bookkeepingPurpose({ counterparty: "Aws Emea", description: "Cloud services" }), "Cloud hosting");
  assert.equal(bookkeepingPurpose({ counterparty: "Go Daddy", description: ".COM Domain Registration" }), "Domain renewal");
  assert.equal(bookkeepingPurpose({ counterparty: "OpenAI", description: "ChatGPT Plus Subscription" }), "ChatGPT Plus");
  assert.equal(bookkeepingPurpose({ counterparty: "Sponsor GmbH", description: "September newsletter sponsorship" }), "Newsletter sponsorship");
  assert.equal(bookkeepingPurpose({ counterparty: "DTC", description: "LLM Zoomcamp workshop admission" }), "LLM Zoomcamp workshop");
  assert.equal(
    bookkeepingPurpose({ counterparty: "Valeriia", description: "Social Media Management and Email Newsletter Creation - invoice 123456" }),
    "Social media and newsletter management",
  );
});

test("long descriptions are replaced by category and descriptions never stay empty", () => {
  assert.equal(
    bookkeepingPurpose({ counterparty: "Local Print Shop", description: "Invoice for many pages of itemized service details and reference numbers 123456789", category: "Office expenses" }),
    "Office expenses",
  );
  assert.equal(bookkeepingPurpose({ counterparty: "Local Print Shop", description: "" }), "Business expense");
  assert.equal(bookkeepingPurpose({ counterparty: "Student", description: "", entryType: "income" }), "Business income");
  assert.equal(bookkeepingPurpose({ counterparty: "Local Print Shop", description: "Postage", category: "Office expenses" }), "Postage");
});
