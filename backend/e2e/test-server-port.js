'use strict';

const DEFAULT_TEST_SERVER_PORT = 3001;

function resolveTestServerPort(value = process.env.DATAOPS_E2E_SERVER_PORT) {
  if (value === undefined || value === '') return DEFAULT_TEST_SERVER_PORT;
  if (!/^\d+$/.test(value)) {
    throw new Error('DATAOPS_E2E_SERVER_PORT must be a TCP port number');
  }

  const port = Number(value);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) {
    throw new Error('DATAOPS_E2E_SERVER_PORT must be between 1 and 65535');
  }
  return port;
}

module.exports = {
  DEFAULT_TEST_SERVER_PORT,
  TEST_SERVER_PORT: resolveTestServerPort(),
  resolveTestServerPort,
};
