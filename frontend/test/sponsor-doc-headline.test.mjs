import assert from "node:assert/strict";
import { test } from "node:test";
import { validateSponsorDocDraft } from "../src/surfaces/operations/sponsor-doc-email-card.js";

const template = {
  sections: [{ id: "speaker", fields: [
    { key: "jobTitle", label: "Job title", type: "text", required: true, format: "headline" },
    { key: "company", label: "Company", type: "text", required: true, format: "headline" },
  ] }],
};

test("guest form job title and company are required, short, plain text", () => {
  assert.deepEqual(validateSponsorDocDraft(template, {}), {
    jobTitle: "Job title is required.",
    company: "Company is required.",
  });
  assert.deepEqual(validateSponsorDocDraft(template, { jobTitle: "x".repeat(81), company: "https://ibm.com" }), {
    jobTitle: "Job title must be at most 80 characters.",
    company: "Company must be plain text, not a link.",
  });
  assert.deepEqual(validateSponsorDocDraft(template, { jobTitle: "AI Engineer", company: "Booking.com" }), {});
});
