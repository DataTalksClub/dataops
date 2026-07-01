import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import path from 'path';
import fs from 'fs';
import type { DynaliteServer } from 'dynalite';
// eslint-disable-next-line @typescript-eslint/no-var-requires -- dynalite is a devDependency loaded via dynamic require

let dynaliteServer: DynaliteServer | null = null;

const DATA_DIR = path.join(__dirname, '..', '..', '.data');

function isLocal(): boolean {
  return (
    process.env.IS_LOCAL === 'true' ||
    process.env.IS_LOCAL === '1' ||
    process.env.NODE_ENV === 'test' ||
    process.env.NODE_ENV === 'local'
  );
}

function isTest(): boolean {
  return process.env.NODE_ENV === 'test';
}

/**
 * Start a dynalite server in-process and return the port it is listening on.
 * If the server is already running, return the existing port.
 *
 * In test mode: uses in-memory storage (memdown).
 * In dev mode: uses persistent LevelDB storage in .data/ directory.
 */
async function startLocal(port: number = 0): Promise<number> {
  if (dynaliteServer) {
    const addr = dynaliteServer.address();
    return addr.port;
  }

  const dynalite = require('dynalite');
  const opts: { createTableMs: number; path?: string } = { createTableMs: 0 };

  if (!isTest()) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    opts.path = DATA_DIR;
  }

  dynaliteServer = dynalite(opts);

  return new Promise<number>((resolve, reject) => {
    dynaliteServer!.listen(port, (err?: Error) => {
      if (err) return reject(err);
      resolve(dynaliteServer!.address().port);
    });
  });
}

/**
 * Stop the dynalite server if it is running.
 */
async function stopLocal(): Promise<void> {
  if (!dynaliteServer) return;
  return new Promise<void>((resolve, reject) => {
    dynaliteServer!.close((err?: Error) => {
      dynaliteServer = null;
      if (err) return reject(err);
      resolve();
    });
  });
}

/**
 * Get a DynamoDB Document Client.
 *
 * Priority:
 * 1. If DYNAMODB_ENDPOINT is set, use it (Docker DynamoDB Local).
 * 2. If IS_LOCAL/NODE_ENV=test, use dynalite (existing behavior).
 * 3. Otherwise, use default AWS SDK config (production).
 */
async function getClient(localPort?: number): Promise<DynamoDBDocumentClient> {
  // If DYNAMODB_ENDPOINT is set, use it (Docker DynamoDB Local)
  if (process.env.DYNAMODB_ENDPOINT) {
    const raw = new DynamoDBClient({
      region: process.env.AWS_REGION || 'us-east-1',
      endpoint: process.env.DYNAMODB_ENDPOINT,
      credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID || 'local',
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || 'local',
      },
    });
    return DynamoDBDocumentClient.from(raw);
  }

  // If IS_LOCAL/NODE_ENV=test, use dynalite (existing behavior)
  if (isLocal()) {
    const port = localPort || (await startLocal());
    const raw = new DynamoDBClient({
      region: 'us-east-1',
      endpoint: `http://localhost:${port}`,
      credentials: { accessKeyId: 'fake', secretAccessKey: 'fake' },
    });
    return DynamoDBDocumentClient.from(raw);
  }

  // Otherwise, use default AWS SDK config
  const raw = new DynamoDBClient({});
  return DynamoDBDocumentClient.from(raw);
}

export { getClient, startLocal, stopLocal };
