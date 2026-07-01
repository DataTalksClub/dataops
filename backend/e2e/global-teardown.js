module.exports = async function globalTeardown() {
  const child = globalThis.__testServerProcess;

  if (!child) {
    console.log('[global-teardown] No test server process found, skipping.');
    return;
  }

  await new Promise((resolve) => {
    let settled = false;

    function done() {
      if (settled) return;
      settled = true;
      clearTimeout(forceKillTimer);
      console.log('[global-teardown] Test server stopped.');
      resolve();
    }

    child.on('exit', done);

    // Kill the entire process group (negative pid) to stop tsx + child node process.
    // child.pid is the pid of the tsx process; -child.pid sends to its process group.
    try {
      process.kill(-child.pid, 'SIGTERM');
    } catch (e) {
      // Process group may already be gone
      child.kill('SIGTERM');
    }

    // Force-kill after 5 seconds if SIGTERM is not enough
    const forceKillTimer = setTimeout(() => {
      if (!settled) {
        console.warn('[global-teardown] Force-killing test server process group after timeout.');
        try {
          process.kill(-child.pid, 'SIGKILL');
        } catch (e) {
          child.kill('SIGKILL');
        }
      }
    }, 5000);
  });
};
