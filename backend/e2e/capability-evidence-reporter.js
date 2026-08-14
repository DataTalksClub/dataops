const fs = require('node:fs');
const path = require('node:path');

const matrix = require('./frontend-capabilities.json');
const { collectCapabilityEvidence } = require('./capability-evidence');

class CapabilityEvidenceReporter {
  constructor() {
    this.results = new Map();
    this.outputDir = path.resolve(__dirname, '..', 'test-results');
  }

  onTestEnd(test, result) {
    this.results.set(test.id, {
      id: test.id,
      title: test.titlePath().join(' > '),
      status: result.status,
      annotations: result.annotations,
    });
  }

  onEnd() {
    const summary = collectCapabilityEvidence(matrix, [...this.results.values()]);
    fs.mkdirSync(this.outputDir, { recursive: true });
    fs.writeFileSync(
      path.join(this.outputDir, 'frontend-capability-evidence.json'),
      `${JSON.stringify(summary, null, 2)}\n`,
      'utf8',
    );
    if (summary.ok) {
      console.log(`Frontend capability evidence complete: ${summary.evidence.length} stable states.`);
      return undefined;
    }
    console.error(summary.errors.join('\n'));
    return { status: 'failed' };
  }
}

module.exports = CapabilityEvidenceReporter;
