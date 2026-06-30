/**
 * Docs domain barrel.
 *
 * Seam/stub layer for the single-TypeScript-backend consolidation (epic #83).
 * New docs code lands under `work-engine/src/docs/`; the package rename to
 * `backend/` happens later in issue #88's cutover. These exports are the typed
 * contract other agents implement in parallel:
 *
 * - search index   -> issue #85 (`zerosearch-node`)
 * - SOP engine      -> issue #86 (`work-engine/src/docs/sop/`)
 * - GitHub store    -> issue #87
 * - content API     -> issue #87
 */

export * from './errors';
export * from './searchIndex';
export * from './search/extract';
export * from './sopEngine';
export * from './githubStore';
export * from './contentApi';
