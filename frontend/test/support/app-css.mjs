import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
  "..",
);

/**
 * The app stylesheets concatenated in link order. The links come from the
 * entry HTML, so the sheet can gain a focused file under `src/styles/`
 * without every CSS contract test learning the new layout. The vendored
 * dakit bundle and tokens stay out: they are upstream build output, not app
 * CSS, and they legitimately use the primitive ramps app CSS must not.
 */
export function readAppCss() {
  const html = readFileSync(path.join(repoRoot, "frontend/index.html"), "utf8");
  const links = [...html.matchAll(/<link rel="stylesheet" href="([^"]+)">/g)]
    .map((match) => match[1]);
  return links
    .filter((href) => href.startsWith("/src/styles"))
    .map((href) =>
      readFileSync(path.join(repoRoot, "frontend", href.slice(1)), "utf8"),
    )
    .join("");
}

export function uncommentCss(styles) {
  return styles.replace(/\/\*[\s\S]*?\*\//g, "");
}
