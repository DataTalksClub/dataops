import { existsSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';

import { buildRegistry, type DocumentRegistry } from '../../src/docs/docRegistry';

/**
 * Locate the process document corpus.
 *
 * The corpus lives in the private knowledge repository, not in this one, so it
 * is only present when something has checked it out. `DATAOPS_CONTENT_ROOT`
 * points at that checkout; CI sets it, and a local checkout beside this repo is
 * found automatically.
 *
 * Tests that assert against real documents should skip when it is absent rather
 * than fail, so a checkout of this repo alone stays green.
 */
export function findContentRoot(): string | null {
  const configured = process.env.DATAOPS_CONTENT_ROOT;
  const candidates = [
    ...(configured ? [isAbsolute(configured) ? configured : resolve(configured)] : []),
    join(__dirname, '..', '..', '..', 'content'),
    join(__dirname, '..', '..', '..', '.knowledge', 'content'),
    join(__dirname, '..', '..', '..', '..', 'dataops-knowledge', 'content'),
  ];
  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

/** Build a registry over the corpus, or null when no corpus is available. */
export function findDocumentRegistry(): DocumentRegistry | null {
  const root = findContentRoot();
  return root ? buildRegistry(root, false) : null;
}

/** Known document IDs, or null when no corpus is available. */
export function findKnownDocIds(): Set<string> | null {
  const registry = findDocumentRegistry();
  return registry ? new Set(registry.documents.map((doc) => doc.id)) : null;
}
