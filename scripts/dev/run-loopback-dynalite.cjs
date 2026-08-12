'use strict';

const dynalite = require('dynalite');

const port = Number(process.argv[2]);
const databasePath = process.argv[3];
if (!Number.isInteger(port) || port < 1 || port > 65535 || !databasePath) {
  throw new Error('Usage: run-loopback-dynalite.cjs <port> <database-path>');
}

const server = dynalite({ path: databasePath, createTableMs: 0 });
server.listen(port, '127.0.0.1', () => {
  process.stdout.write(`Representative Dynalite ready on http://127.0.0.1:${port}\n`);
});

for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(signal, () => {
    server.close(() => {
      process.exitCode = signal === 'SIGINT' ? 130 : 143;
    });
  });
}
