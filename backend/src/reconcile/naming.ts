/**
 * Deterministic file names for the month package sent to the accountant:
 *
 *   YYYY-MM/
 *     YYYY-MM_reconciliation_datatalksclub.<csv|xlsx>
 *     statements/YYYY-MM_<bank>-<account>.<ext>
 *     income/YYYY-MM-DD_<counterparty>_<doc-number>_<amount><CUR>.pdf
 *     expenses/YYYY-MM-DD_<counterparty>_<doc-number>_<amount><CUR>.pdf
 *     proofs/YYYY-MM-DD_<counterparty>_<ledger-row>.pdf
 *     taxes/YYYY-MM-DD_<kind>_<period>.pdf
 *
 * The folder carries the type, so names inside it do not repeat it. Names
 * sort by date, never collide (-2, -3 …) and are derived from data only, so
 * the same month always yields the same package. Originals keep their own
 * filename in document metadata.
 */

export type PackageFolder = "statements" | "income" | "expenses" | "proofs" | "taxes";

export type NamingConfig = {
  reportBaseName: string;
  slugMax: number;
  folders: Record<PackageFolder, string>;
};

export const DEFAULT_NAMING: NamingConfig = {
  reportBaseName: "reconciliation_datatalksclub",
  slugMax: 40,
  folders: { statements: "statements", income: "income", expenses: "expenses", proofs: "proofs", taxes: "taxes" },
};

export const TAX_DOCUMENT_KINDS = ["ust-va", "est", "gewst", "bescheid", "tk"] as const;
export type TaxDocumentKind = (typeof TAX_DOCUMENT_KINDS)[number];

const TRANSLITERATE: Record<string, string> = { ä: "ae", ö: "oe", ü: "ue", ß: "ss", æ: "ae", ø: "o", å: "a", œ: "oe", ł: "l", đ: "d" };

/** Lowercase ASCII words joined by hyphens, at most `max` characters, never empty. */
export function slug(value: string | undefined, max = DEFAULT_NAMING.slugMax): string {
  const ascii = String(value || "")
    .toLowerCase()
    .replace(/[äöüßæøåœłđ]/g, (char) => TRANSLITERATE[char] || char)
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  const cut = ascii.length > max ? ascii.slice(0, max).replace(/-[^-]*$/, "") || ascii.slice(0, max) : ascii;
  return cut.replace(/-+$/, "") || "unknown";
}

/** A document number as it may appear in a name: keeps case, letters, digits and hyphens. */
export function docToken(value: string | undefined): string {
  return String(value || "").trim().replace(/[\/\\\s]+/g, "-").replace(/[^A-Za-z0-9._-]/g, "").replace(/^[-.]+|[-.]+$/g, "").slice(0, 40);
}

const amountToken = (amount: string | number, currency: string) => `${Math.abs(Number(amount)).toFixed(2)}${currency.toUpperCase()}`;
const extension = (filename: string | undefined, fallback: string) => (String(filename || "").match(/\.([a-z0-9]{2,5})$/i)?.[1] || fallback).toLowerCase();

export function statementName(period: string, bank: string, account: string, filename?: string): string {
  return `${period}_${slug(bank, 20)}-${slug(account, 20)}.${extension(filename, "pdf")}`;
}

export function documentName(input: { date: string; counterparty?: string; documentNumber?: string; amount: string | number; currency: string; filename?: string }, config = DEFAULT_NAMING): string {
  const parts = [input.date.slice(0, 10), slug(input.counterparty, config.slugMax)];
  const number = docToken(input.documentNumber);
  if (number) parts.push(number);
  parts.push(amountToken(input.amount, input.currency));
  return `${parts.join("_")}.${extension(input.filename, "pdf")}`;
}

export function proofName(input: { date: string; counterparty?: string; ledgerId: string; filename?: string }, config = DEFAULT_NAMING): string {
  return `${input.date.slice(0, 10)}_${slug(input.counterparty, config.slugMax)}_${input.ledgerId.slice(0, 12)}.${extension(input.filename, "pdf")}`;
}

export function taxName(input: { date: string; kind: TaxDocumentKind; period: string; filename?: string }): string {
  return `${input.date.slice(0, 10)}_${input.kind}_${slug(input.period, 20)}.${extension(input.filename, "pdf")}`;
}

export function reportName(period: string, format: "csv" | "xlsx" | "pdf", config = DEFAULT_NAMING): string {
  return `${period}_${config.reportBaseName}.${format}`;
}

/** Package-relative paths, made unique in order of appearance with -2, -3 … before the extension. */
export function uniquePaths(paths: string[]): string[] {
  const taken = new Set<string>();
  return paths.map((path) => {
    if (!taken.has(path)) { taken.add(path); return path; }
    const dot = path.lastIndexOf(".");
    const [stem, ext] = dot > path.lastIndexOf("/") ? [path.slice(0, dot), path.slice(dot)] : [path, ""];
    let counter = 2;
    while (taken.has(`${stem}-${counter}${ext}`)) counter++;
    const unique = `${stem}-${counter}${ext}`;
    taken.add(unique);
    return unique;
  });
}

export function packagePath(period: string, folder: PackageFolder | null, name: string, config = DEFAULT_NAMING): string {
  return folder ? `${period}/${config.folders[folder]}/${name}` : `${period}/${name}`;
}
