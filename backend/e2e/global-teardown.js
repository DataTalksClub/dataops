const { stopTestServerProcessGroup } = require('./helpers/test-server-process-groups');

module.exports = async function globalTeardown() {
  const child = globalThis.__testServerProcess;

  if (!child) {
    console.log('[global-teardown] No test server process found, skipping.');
    return;
  }
  if (!child.pid) {
    console.log('[global-teardown] Test server was never spawned, skipping.');
    return;
  }

  // A zero exit on the tsx controller does not prove that its detached Node
  // child is gone. Always ask the OS about the whole tracked process group.
  await stopTestServerProcessGroup(child.pid);
  console.log(
    child.exitCode !== null || child.signalCode !== null
      ? '[global-teardown] Exited controller group verified stopped.'
      : '[global-teardown] Test server stopped.',
  );
};
