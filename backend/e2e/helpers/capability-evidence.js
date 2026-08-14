const CAPABILITY_EVIDENCE_ANNOTATION = 'dataops-capability';

function nonEmpty(value, label) {
  if (typeof value !== 'string' || value.trim() !== value || value.length === 0) {
    throw new TypeError(`${label} must be a trimmed non-empty string`);
  }
  return value;
}

/**
 * Record stable capability evidence after a journey has asserted the relevant
 * browser state. The reporter counts these annotations only when this exact
 * Playwright result passes.
 */
function recordCapabilityEvidence(testInfo, groups) {
  if (!testInfo || !Array.isArray(testInfo.annotations)) {
    throw new TypeError('Playwright testInfo is required');
  }
  if (!Array.isArray(groups) || groups.length === 0) {
    throw new TypeError('At least one capability evidence group is required');
  }

  for (const group of groups) {
    const route = nonEmpty(group.route, 'Capability route');
    const roleId = nonEmpty(group.roleId, 'Capability role');
    if (!Array.isArray(group.stateIds) || group.stateIds.length === 0) {
      throw new TypeError('Capability evidence group needs stateIds');
    }
    for (const rawStateId of group.stateIds) {
      const stateId = nonEmpty(rawStateId, 'Capability state ID');
      testInfo.annotations.push({
        type: CAPABILITY_EVIDENCE_ANNOTATION,
        description: JSON.stringify({ schemaVersion: 1, stateId, route, roleId }),
      });
    }
  }
}

module.exports = {
  CAPABILITY_EVIDENCE_ANNOTATION,
  recordCapabilityEvidence,
};
