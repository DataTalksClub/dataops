const { CAPABILITY_EVIDENCE_ANNOTATION } = require('./helpers/capability-evidence');

const ALLOWED_RESULT_STATUSES = new Set(['passed', 'failed', 'timedOut', 'skipped', 'interrupted']);

function effectiveRoles(capability, state) {
  return state.roleIds || capability.roleIds;
}

function runtimeRequirements(matrix) {
  const requirements = new Map();
  for (const capability of matrix.capabilities || []) {
    for (const state of capability.states || []) {
      if (state.coverage?.status !== 'runtime') continue;
      requirements.set(state.id, {
        stateId: state.id,
        route: capability.route,
        roleIds: effectiveRoles(capability, state),
        rolePolicy: Object.prototype.hasOwnProperty.call(state, 'roleIds') ? 'all' : 'any',
      });
    }
  }
  return requirements;
}

function parseEvidence(annotation, journey) {
  if (annotation.type !== CAPABILITY_EVIDENCE_ANNOTATION) return null;
  let evidence;
  try {
    evidence = JSON.parse(annotation.description || '');
  } catch {
    throw new Error(`${journey} emitted malformed ${CAPABILITY_EVIDENCE_ANNOTATION} JSON`);
  }
  const keys = Object.keys(evidence).sort();
  const expectedKeys = ['roleId', 'route', 'schemaVersion', 'stateId'];
  if (JSON.stringify(keys) !== JSON.stringify(expectedKeys) || evidence.schemaVersion !== 1) {
    throw new Error(`${journey} emitted an unsupported capability evidence shape`);
  }
  for (const field of ['stateId', 'route', 'roleId']) {
    if (typeof evidence[field] !== 'string' || evidence[field].trim() !== evidence[field] || !evidence[field]) {
      throw new Error(`${journey} emitted an invalid capability ${field}`);
    }
  }
  return evidence;
}

function collectCapabilityEvidence(matrix, results) {
  const requirements = runtimeRequirements(matrix);
  const passing = new Map();
  const nonPassingClaims = new Map();
  const exactClaims = new Map();
  const errors = [];

  for (const result of results) {
    const journey = result.title || result.id || '<unnamed journey>';
    if (!ALLOWED_RESULT_STATUSES.has(result.status)) {
      errors.push(`${journey} has unknown result status ${result.status}`);
      continue;
    }
    for (const annotation of result.annotations || []) {
      let evidence;
      try {
        evidence = parseEvidence(annotation, journey);
      } catch (error) {
        errors.push(error.message);
        continue;
      }
      if (!evidence) continue;
      const requirement = requirements.get(evidence.stateId);
      if (!requirement) {
        errors.push(`${journey} emitted unknown capability state ${evidence.stateId}`);
        continue;
      }
      if (evidence.route !== requirement.route) {
        errors.push(`${journey} emitted ${evidence.stateId} on ${evidence.route}; expected ${requirement.route}`);
        continue;
      }
      if (!requirement.roleIds.includes(evidence.roleId)) {
        errors.push(`${journey} emitted ${evidence.stateId} for disallowed role ${evidence.roleId}; allowed: ${requirement.roleIds.join(', ')}`);
        continue;
      }
      const exactKey = `${evidence.stateId}\u0000${evidence.roleId}\u0000${evidence.route}`;
      const previous = exactClaims.get(exactKey);
      if (previous) {
        errors.push(`${journey} emitted duplicate capability evidence for ${evidence.stateId}; already claimed by ${previous.journey}`);
        continue;
      }
      exactClaims.set(exactKey, { journey, status: result.status });
      const target = result.status === 'passed' ? passing : nonPassingClaims;
      if (!target.has(evidence.stateId)) target.set(evidence.stateId, []);
      target.get(evidence.stateId).push({ journey, roleId: evidence.roleId, route: evidence.route, status: result.status });
    }
  }

  const uncovered = [];
  for (const [stateId, requirement] of requirements) {
    const passingClaims = passing.get(stateId) || [];
    const passingRoleIds = new Set(passingClaims.map((claim) => claim.roleId));
    const missingRoleIds = requirement.rolePolicy === 'all'
      ? requirement.roleIds.filter((roleId) => !passingRoleIds.has(roleId))
      : (passingClaims.length === 0 ? requirement.roleIds : []);
    if (missingRoleIds.length === 0) continue;
    const claims = nonPassingClaims.get(stateId) || [];
    uncovered.push({ stateId, rolePolicy: requirement.rolePolicy, missingRoleIds, claims });
  }
  if (uncovered.length > 0) {
    const lines = uncovered.map(({ stateId, rolePolicy, missingRoleIds, claims }) => {
      const requirement = rolePolicy === 'all'
        ? `missing required passing role evidence: ${missingRoleIds.join(', ')}`
        : 'no passing journey emitted evidence for an allowed role';
      if (claims.length === 0) return `${stateId}: ${requirement}`;
      return `${stateId}: ${requirement}; non-passing claims (${claims.map((claim) => `${claim.journey}[${claim.roleId}]=${claim.status}`).join(', ')})`;
    });
    errors.push(`uncovered frontend capability states:\n${lines.join('\n')}`);
  }

  const evidence = [...passing.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([stateId, claims]) => ({ stateId, claims }));
  return { ok: errors.length === 0, errors, evidence, uncovered };
}

module.exports = {
  collectCapabilityEvidence,
  parseEvidence,
  runtimeRequirements,
};
