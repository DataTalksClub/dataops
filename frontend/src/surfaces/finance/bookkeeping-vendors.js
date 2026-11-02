// Display normalization for bookkeeping rows. Keep raw counterparty values in
// storage; this table gives the ledger and exports one consistent vendor name
// while preserving the bank's original label for transaction detail.

export const VENDOR_ALIASES = [
  {
    canonical: "Amazon Web Services",
    aliases: [
      "aws",
      "aws emea",
      "aws emea sarl",
      "amazon web services",
      "amazon web services emea",
      "amazon web services emea sarl",
    ],
  },
  {
    canonical: "Google",
    aliases: [
      "google",
      "google cloud",
      "google cloud platform",
      "google cloud emea limited",
      "google workspace",
      "google workspace emea limited",
      "google one",
    ],
  },
  {
    canonical: "X",
    aliases: [
      "x",
      "x corp",
      "x internet unlimited company",
      "x corp paid features",
      "x corp revenue sharing",
      "twitter",
    ],
  },
  {
    canonical: "GoDaddy",
    aliases: ["go daddy", "go daddy.com", "godaddy", "godaddy.com"],
  },
  {
    canonical: "OpenAI",
    aliases: ["openai", "openai inc", "openai llc", "openai opco llc", "chatgpt"],
  },
];

const PRODUCT_PURPOSES = [
  { pattern: /\bgoogle\s+one\b/i, description: "Google One storage" },
  { pattern: /\bgoogle\s+workspace\b|\bworkspace\s+subscription\b/i, description: "Google Workspace" },
  { pattern: /\bgoogle\s+(?:cloud|cloud platform)\b/i, description: "Google Cloud" },
  { pattern: /\b(?:x\s+)?(?:creator\s+)?revenue\s+sharing\b|\brevenue\s+share\b/i, description: "X creator revenue sharing" },
  { pattern: /\b(?:x\s+)?paid\s+features\b|\bx\s+premium\b/i, description: "X Premium subscription" },
  { pattern: /\bgo\s*daddy\b|\b(?:domain|\.com)\s+(?:registration|renewal)\b/i, description: "Domain renewal" },
  { pattern: /\bchatgpt\s*plus\b/i, description: "ChatGPT Plus" },
  { pattern: /\bllm\s+zoomcamp\b/i, description: "LLM Zoomcamp workshop" },
  { pattern: /\bnewsletter\s+sponsorship\b/i, description: "Newsletter sponsorship" },
  {
    pattern: /\b(?:social\s+media|email\s+newsletter)\s+management\b|\bsocial\s+media\s+management\s+and\s+email\s+newsletter\s+creation\b/i,
    description: "Social media and newsletter management",
  },
  { pattern: /\bcloud\s+(?:hosting|services?)\b|\baws\b/i, description: "Cloud hosting" },
];

const DEFAULT_VENDOR_PURPOSES = [
  { pattern: /\bamazon\s+web\s+services\b/i, description: "Cloud hosting" },
  { pattern: /\bgoogle\b/i, description: "Google services" },
  { pattern: /\bgo\s*daddy\b/i, description: "Domain renewal" },
  { pattern: /\bopenai\b|\bchatgpt\b/i, description: "OpenAI services" },
  { pattern: /\bx\b|\btwitter\b/i, description: "X services" },
];

const MAX_SOURCE_DESCRIPTION_LENGTH = 56;

function normalizedVendorKey(value) {
  return String(value || "")
    .trim()
    .toLocaleLowerCase("en")
    .replace(/[.,]/g, "")
    .replace(/\s+/g, " ");
}

function rawCounterpartyOf(entry) {
  return String(entry?.counterparty ?? "");
}

/** Return the canonical vendor name, leaving unknown bank names untouched. */
export function canonicalCounterparty(entryOrName) {
  const raw = typeof entryOrName === "string"
    ? entryOrName
    : rawCounterpartyOf(entryOrName);
  const key = normalizedVendorKey(raw);
  const rule = VENDOR_ALIASES.find((candidate) =>
    candidate.aliases.some((alias) => normalizedVendorKey(alias) === key),
  );
  return rule?.canonical || raw.trim() || "Unknown vendor";
}

/**
 * Give a bookkeeping row a concise, non-empty purpose. Recognized services use
 * stable labels; short source descriptions stay intact; long invoice text falls
 * back to the row's category instead of being cut off mid-sentence.
 */
export function bookkeepingPurpose(entry = {}) {
  const raw = rawCounterpartyOf(entry);
  const source = String(entry.description || "").trim().replace(/\s+/g, " ");
  const identity = canonicalCounterparty(entry);
  const facts = `${raw} ${source}`;

  const productPurpose = PRODUCT_PURPOSES.find(({ pattern }) => pattern.test(facts));
  if (productPurpose) return productPurpose.description;

  if (
    source &&
    source.length <= MAX_SOURCE_DESCRIPTION_LENGTH &&
    normalizedVendorKey(source) !== normalizedVendorKey(raw)
  ) {
    return source;
  }

  const vendorPurpose = DEFAULT_VENDOR_PURPOSES.find(({ pattern }) => pattern.test(identity));
  if (vendorPurpose) return vendorPurpose.description;

  const category = String(entry.category || "").trim().replace(/\s+/g, " ");
  if (category) return category;

  return String(entry.entryType || "").toLowerCase().includes("income")
    ? "Business income"
    : "Business expense";
}

/** Presentation fields shared by the ledger, detail modal, and accountant CSV. */
export function bookkeepingVendorPresentation(entry = {}) {
  return {
    canonicalCounterparty: canonicalCounterparty(entry),
    rawCounterparty: rawCounterpartyOf(entry),
    description: bookkeepingPurpose(entry),
  };
}
