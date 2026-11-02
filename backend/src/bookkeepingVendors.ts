const aliases: Array<{ canonical: string; names: string[] }> = [
  { canonical: "Amazon Web Services", names: ["aws", "aws emea", "amazon web services", "amazon web services emea"] },
  { canonical: "Google", names: ["google", "google cloud", "google cloud platform", "google cloud emea", "google workspace", "google workspace emea", "google one"] },
  { canonical: "X", names: ["x", "twitter", "x corp", "x corp paid features", "x corp revenue sharing", "x internet unlimited company", "x internet unlimited"] },
  { canonical: "GoDaddy", names: ["go daddy", "go daddy.com", "godaddy", "godaddy.com"] },
  { canonical: "OpenAI", names: ["openai", "chatgpt"] },
];

const legalSuffixes = new Set(["ag", "bv", "company", "corp", "gmbh", "inc", "limited", "llc", "ltd", "sarl"]);

function vendorKey(value: unknown) {
  const words = String(value || "").trim().toLocaleLowerCase("en")
    .replace(/[.,]/g, "").replace(/\s+/g, " ").split(" ").filter(Boolean);
  while (words.length && legalSuffixes.has(words.at(-1)!)) words.pop();
  return words.join(" ");
}

/** Canonical display label; the original counterparty stays in `counterparty`. */
export function canonicalBookkeepingCounterparty(value: unknown) {
  const raw = String(value || "").trim();
  const key = vendorKey(raw);
  return aliases.find((rule) => rule.names.some((name) => vendorKey(name) === key))?.canonical || raw || "Unknown vendor";
}

export function bookkeepingTransactionView<T extends Record<string, unknown>>(item: T): T & { counterpartyCanonical: string } {
  return { ...item, counterpartyCanonical: canonicalBookkeepingCounterparty(item.counterparty) };
}
