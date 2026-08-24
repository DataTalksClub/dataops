const { createRequire } = require('node:module');
const path = require('node:path');

const BACKEND_ROOT = path.resolve(__dirname, '..', '..');

function resolveTestServerCommand() {
  const requireFromBackend = createRequire(path.join(BACKEND_ROOT, 'package.json'));

  try {
    const tsxCliPath = requireFromBackend.resolve('tsx/cli');
    return [
      process.execPath,
      [tsxCliPath, path.join(BACKEND_ROOT, 'scripts', 'test-server.ts')],
    ];
  } catch (error) {
    throw new Error(
      `Unable to resolve the installed TSX CLI from ${BACKEND_ROOT}: ${error.message}`,
      { cause: error },
    );
  }
}

module.exports = { resolveTestServerCommand };
