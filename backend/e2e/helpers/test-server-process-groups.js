const trackedGroups = new Set();
let exitHandlerInstalled = false;

function testServerProcessGroupExists(pid) {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    if (error.code === 'ESRCH') return false;
    // Permission still proves that some process group owns that PGID. The
    // subsequent signal attempt will surface the operational failure.
    return true;
  }
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForTestServerProcessGroupExit(pid, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!testServerProcessGroupExists(pid)) return true;
    await wait(Math.min(50, Math.max(1, deadline - Date.now())));
  }
  return !testServerProcessGroupExists(pid);
}

async function stopTestServerProcessGroup(
  pid,
  { termTimeoutMs = 5_000, killTimeoutMs = 1_000 } = {},
) {
  if (!Number.isInteger(pid) || pid <= 0) {
    throw new Error(`Cannot stop an invalid test-server process group: ${String(pid)}`);
  }

  if (!testServerProcessGroupExists(pid)) {
    untrackTestServerProcessGroup(pid);
    return;
  }

  let signaled = false;
  try {
    process.kill(-pid, 'SIGTERM');
    signaled = true;
  } catch {}

  let stopped = signaled && await waitForTestServerProcessGroupExit(pid, termTimeoutMs);
  if (!stopped) {
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {}
    stopped = await waitForTestServerProcessGroupExit(pid, killTimeoutMs);
  }

  if (!stopped) {
    throw new Error(`Test-server process group ${pid} did not stop`);
  }

  untrackTestServerProcessGroup(pid);
}

function killRemainingGroups() {
  for (const pid of trackedGroups) {
    try { process.kill(-pid, 'SIGKILL'); } catch {}
  }
}

function trackTestServerProcessGroup(child) {
  if (!child.pid) return null;
  trackedGroups.add(child.pid);
  if (!exitHandlerInstalled) {
    process.once('exit', killRemainingGroups);
    exitHandlerInstalled = true;
  }
  return child.pid;
}

function untrackTestServerProcessGroup(pid) {
  if (typeof pid === 'number') trackedGroups.delete(pid);
}

module.exports = {
  stopTestServerProcessGroup,
  waitForTestServerProcessGroupExit,
  trackTestServerProcessGroup,
  untrackTestServerProcessGroup,
};
