/**
 * Shared error type for the docs-domain seam.
 *
 * This is the SEAM/STUB layer for the single-TypeScript-backend consolidation
 * (epic #83). The typed interfaces in this directory compile today; the real
 * implementations land in the follow-up issues (#85 search, #86 SOP engine,
 * #87 content backend). Until then the stubs throw {@link NotImplementedError}.
 */

/** Thrown by docs-domain stubs that are not implemented yet. */
export class NotImplementedError extends Error {
  /** GitHub issue that will provide the real implementation, when known. */
  readonly issue?: string;

  constructor(what: string, issue?: string) {
    const suffix = issue ? ` (see ${issue})` : '';
    super(`Not implemented: ${what}${suffix}`);
    this.name = 'NotImplementedError';
    this.issue = issue;
  }
}
