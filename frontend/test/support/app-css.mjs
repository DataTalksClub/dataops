import { readFileSync } from "node:fs";
import path from "node:path";

const IMPORT_RE = /@import\s+(?:url\()?(["'])([^"']+)\1\)?\s*;/g;

export function importedStyleSheets(stylesCssPath) {
  const source = readFileSync(stylesCssPath, "utf8");
  return [...source.matchAll(IMPORT_RE)].map((match) => match[2]);
}

export function readAppCss(repoRoot) {
  const indexPath = path.join(repoRoot, "frontend/src/styles.css");
  const imports = importedStyleSheets(indexPath);
  if (imports.length === 0) return readFileSync(indexPath, "utf8");
  const dir = path.dirname(indexPath);
  return imports
    .map((rel) => readFileSync(path.resolve(dir, rel), "utf8"))
    .join("");
}
