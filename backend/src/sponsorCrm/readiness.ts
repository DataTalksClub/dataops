/** Readiness belongs to a deliverable, a material revision and one exact gate.
 * It never completes workflow Tasks or grants permission to publish/send/pay. */
export const READINESS_CRITERIA = ['materials-submitted', 'materials-approved', 'block-assembled', 'send-approved', 'payment'] as const;
export type ReadinessCriterion = typeof READINESS_CRITERIA[number];
export interface ReadinessCheck {
  id: string;
  criterion: ReadinessCriterion;
  materialVersion: number;
  checkedAt: string;
  evidence?: { link: string; date: string; reviewer: string };
  revokedAt?: string;
  sourceCheckId?: string;
}
export interface ReadinessState { materialVersion: number; checks: ReadinessCheck[] }
export function readinessState(record: Record<string, unknown>): ReadinessState {
  return (record.readiness as ReadinessState | undefined) || { materialVersion: 1, checks: [] };
}
export function readinessView(record: Record<string, unknown>) {
  const state = readinessState(record);
  return {
    materialVersion: state.materialVersion,
    checks: state.checks.map(check => {
      const current = check.materialVersion === state.materialVersion;
      const source = current && !check.revokedAt ? state.checks.find(candidate =>
        candidate.id === (check.evidence ? check.id : check.sourceCheckId) && candidate.criterion === check.criterion
        && candidate.materialVersion === state.materialVersion && candidate.evidence && !candidate.revokedAt) : undefined;
      return { ...check, status: !current ? 'invalidated' : source ? 'verified' : 'pending',
        ...(source ? { inherited: source.id !== check.id, sourceCheckId: source.id, originalEvidence: source.evidence } : {}) };
    }),
  };
}
export function hasValidMaterialConfirmation(record: Record<string, unknown>): boolean {
  if (record.archivedAt || record.active === false) return false;
  return readinessView(record).checks.some(check => check.criterion === 'materials-approved' && check.status === 'verified');
}
/** URL replacement advances the revision even when URLs later revert. Same-URL
 * content edits must be recorded with the material-change action. */
export function advanceForMaterialChange(existing: Record<string, unknown>, value: Record<string, unknown>) {
  const changed = Object.hasOwn(value, 'artifactUrls') && JSON.stringify(value.artifactUrls) !== JSON.stringify(existing.artifactUrls);
  return changed ? { ...readinessState(existing), materialVersion: readinessState(existing).materialVersion + 1 } : undefined;
}
const invalid = (message: string, statusCode = 400): never => { throw Object.assign(new Error(message), { statusCode }); };
export function changeReadiness(record: Record<string, unknown>, body: Record<string, unknown>, reviewer: string, now = new Date().toISOString()): ReadinessState {
  const previous = readinessState(record);
  if (body.materialVersion !== previous.materialVersion) invalid('Material version changed; reload and check the current materials', 409);
  const state = structuredClone(previous);
  if (body.action === 'material-change') return { ...state, materialVersion: state.materialVersion + 1 };
  if (body.action === 'revoke') {
    const check = state.checks.find(check => check.id === body.checkId);
    if (!check?.evidence || check.revokedAt) invalid('No active original confirmation found', 409);
    check!.revokedAt = now;
    return state;
  }
  if (body.action !== 'check' && body.action !== 'confirm') invalid('Invalid readiness action');
  if (!READINESS_CRITERIA.includes(body.criterion as ReadinessCriterion)) invalid('Invalid readiness criterion');
  if (typeof body.checkId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(body.checkId)) invalid('checkId is required (1–128 characters)');
  if (state.checks.some(check => check.id === body.checkId)) invalid('checkId already exists', 409);
  if (state.checks.length >= 100) invalid('Readiness check limit reached', 409);
  const check: ReadinessCheck = { id: body.checkId as string, criterion: body.criterion as ReadinessCriterion, materialVersion: state.materialVersion, checkedAt: now };
  if (body.action === 'confirm') {
    if (!reviewer) invalid('An authenticated reviewer is required');
    if (typeof body.link !== 'string' || body.link.length > 2048) invalid('An HTTPS evidence link is required');
    try { if (new URL(body.link as string).protocol !== 'https:') invalid('An HTTPS evidence link is required'); } catch { invalid('An HTTPS evidence link is required'); }
    // Server time and authenticated actor are the original evidence provenance.
    check.evidence = { link: body.link as string, date: now, reviewer };
  }
  if (body.action === 'check') {
    const source = state.checks.find(candidate => candidate.criterion === check.criterion
      && candidate.materialVersion === state.materialVersion && candidate.evidence && !candidate.revokedAt);
    if (source) check.sourceCheckId = source.id;
  }
  state.checks.push(check);
  return state;
}
