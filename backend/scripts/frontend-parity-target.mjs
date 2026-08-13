import http from 'node:http';
import { PutCommand } from '@aws-sdk/lib-dynamodb';
import Module, { builtinModules } from 'node:module';
import { resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

function argumentsFrom(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 2) values[argv[index]] = argv[index + 1];
  for (const required of ['--mode', '--root', '--port', '--dynamo', '--cache']) {
    if (!values[required]) throw new Error(`Missing ${required}`);
  }
  return values;
}

const args = argumentsFrom(process.argv.slice(2));
const mode = args['--mode'];
const moduleRoot = resolve(args['--root']);
const port = Number(args['--port']);
const fixedNow = '2026-08-12T10:15:00.000Z';
const adminId = '15900000-0000-4000-8000-000000000001';
const operatorId = '15900000-0000-4000-8000-000000000002';

delete process.env.NODE_PATH;
Object.assign(process.env, {
  NODE_ENV: 'test',
  IS_LOCAL: 'false',
  SKIP_AUTH: 'false',
  DYNAMODB_ENDPOINT: args['--dynamo'],
  DATAOPS_DOCS_DOMAIN: '1',
  WORK_ENGINE_AUTH_MODE: 'portal',
  DTC_OFFLINE: '1',
  DTC_CACHE_ROOT: resolve(args['--cache']),
  FRONTEND_ROOT: mode === 'source' ? resolve(moduleRoot, '..', 'frontend') : '',
  AUTH_BASE_URL: 'https://auth.example.test',
  AUTH_USER_POOL_ID: 'synthetic-pool',
  AUTH_ISSUER: 'https://issuer.example.test/synthetic-pool',
  AUTH_JWKS_URL: 'https://issuer.example.test/synthetic-pool/jwks.json',
  AUTH_CLIENT_ID: 'synthetic-client',
  AUTH_CALLBACK_URL: 'https://portal.example.test/auth/callback',
  AUTH_LOGOUT_URL: 'https://portal.example.test/',
  AUTH_SESSION_LIFETIME_SECONDS: '3600',
  SPONSOR_FINANCE_ENABLED: 'true',
  MAILING_EXPORTS_CONFIG: JSON.stringify([{ id: 'parity-mailing', account: 'Synthetic audience', provider: 'mailchimp', scopeLabel: 'Synthetic members', enabled: true }]),
  CONVERSATIONAL_TELEGRAM_INGRESS_ENABLED: 'false',
  CONVERSATIONAL_EXECUTION_ENABLED: 'false',
  CONVERSATIONAL_ENABLED_PLUGINS: 'none',
  CONVERSATIONAL_TYPEFULLY_EXTERNAL_EXECUTION_ENABLED: 'false',
  CONVERSATIONAL_TELEGRAM_VOICE_ENABLED: 'false',
  CONVERSATIONAL_TELEGRAM_PHOTO_ENABLED: 'false',
});
if (mode === 'sam') delete process.env.FRONTEND_ROOT;

if (mode === 'sam') {
  const builtins = new Set([...builtinModules, ...builtinModules.map((name) => `node:${name}`)]);
  const originalResolve = Module._resolveFilename;
  Module._resolveFilename = function guardedResolve(request, parent, isMain, options) {
    const result = originalResolve.call(this, request, parent, isMain, options);
    if (typeof result === 'string' && !builtins.has(result) && result !== request) {
      const absolute = resolve(result);
      if (absolute !== moduleRoot && !absolute.startsWith(moduleRoot + sep)) {
        throw new Error(`Isolated SAM parity target attempted outside module resolution: ${absolute}`);
      }
    }
    return result;
  };
}

const modulePath = (sourcePath, samPath) => pathToFileURL(resolve(moduleRoot, mode === 'source' ? sourcePath : samPath)).href;
const [handlerModule, clientModule, tablesModule, users, sessions] = await Promise.all([
  import(modulePath('src/handler.ts', 'dist/handler.js')),
  import(modulePath('src/db/client.ts', 'dist/db/client.js')),
  import(modulePath('src/db/tableNames.ts', 'dist/db/tableNames.js')),
  import(modulePath('src/db/users.ts', 'dist/db/users.js')),
  import(modulePath('src/db/sessions.ts', 'dist/db/sessions.js')),
]);
const client = await clientModule.getClient();
await users.createUserWithId(client, adminId, { name: 'Synthetic parity admin', email: 'parity-admin@example.test', role: 'admin' });
await users.createUserWithId(client, operatorId, { name: 'Synthetic parity operator', email: 'parity-operator@example.test', role: 'operator' });
const adminSession = await sessions.createBrowserSession(client, adminId, { lifetimeSeconds: 3600 });
const operatorSession = await sessions.createBrowserSession(client, operatorId, { lifetimeSeconds: 3600 });

const tables = {
  tasks: tablesModule.TABLE_TASKS,
  cards: tablesModule.TABLE_CARDS,
  templates: tablesModule.TABLE_TEMPLATES,
  artifacts: tablesModule.TABLE_ARTIFACTS,
  assistants: tablesModule.TABLE_ASSISTANT_JOBS,
  intake: tablesModule.TABLE_INTAKE,
  notifications: tablesModule.TABLE_NOTIFICATIONS,
  sponsor: tablesModule.TABLE_SPONSOR_CRM,
};

async function put(tableName, item) {
  await client.send(new PutCommand({ TableName: tableName, Item: item }));
}

async function resetFixtures() {
  const card = {
    PK: 'CARD#parity-workflow', SK: 'CARD#parity-workflow', id: 'parity-workflow', title: 'Synthetic publication workflow',
    description: 'Public-safe parity workflow', anchorDate: '2026-08-12', stage: 'preparation', createdAt: fixedNow, updatedAt: fixedNow,
  };
  const returnCard = {
    PK: 'CARD#parity-return', SK: 'CARD#parity-return', id: 'parity-return', title: 'Synthetic return workflow',
    anchorDate: '2026-08-13', stage: 'preparation', createdAt: fixedNow, updatedAt: fixedNow,
  };
  const task = {
    PK: 'TASK#parity-task', SK: 'TASK#parity-task', id: 'parity-task', description: 'Verify synthetic publication proof',
    version: 1, taskHistory: [],
    date: '2026-08-12', status: 'waiting', waitingFor: 'Synthetic reviewer', followUpAt: '2026-08-13T09:00:00.000Z',
    cardId: card.id, proofRequirement: { required: true, type: 'comment', label: 'Synthetic completion note' },
    instructionDocId: 'sop.synthetic.parity', createdAt: fixedNow, updatedAt: fixedNow,
  };
  const intake = {
    PK: 'INTAKE#parity-intake', SK: 'INTAKE#parity-intake', id: 'parity-intake', source: 'manual', status: 'blocked',
    title: 'Synthetic blocked intake', summary: 'Waiting for a public-safe synthetic response.', waitingFor: 'Synthetic partner',
    followUpAt: '2026-08-13T09:00:00.000Z', taskIds: [], cardIds: [], assistantJobIds: [], linkRefs: [], fileRefs: [], artifactRefs: [],
    tags: ['synthetic'], priority: 'normal', dataClass: 'internal', createdAt: fixedNow, updatedAt: fixedNow,
    history: [{ id: 'parity-history', action: 'blocked', actorId: adminId, reason: 'Awaiting synthetic response', createdAt: fixedNow }],
  };
  const assistant = {
    PK: 'ASSISTANT_JOB#parity-assistant', SK: 'ASSISTANT_JOB#parity-assistant', id: 'parity-assistant', assistantType: 'podcast',
    title: 'Synthetic assistant baseline', status: 'draft', cardId: card.id, inputRefs: [{ type: 'card', id: card.id }],
    outputArtifactIds: [], approvalRequired: true, attempt: 0, maxAttempts: 2, createdAt: fixedNow, updatedAt: fixedNow,
  };
  const artifact = {
    PK: 'ARTIFACT#parity-artifact', SK: 'ARTIFACT#parity-artifact', id: 'parity-artifact', title: 'Synthetic proof artifact',
    type: 'evidence', status: 'approved', taskId: task.id, cardId: card.id, storageProvider: 'local-test',
    storageUri: 'https://example.test/synthetic-proof', createdAt: fixedNow, updatedAt: fixedNow,
  };
  const template = {
    PK: 'TEMPLATE#parity-template', SK: 'TEMPLATE#parity-template', id: 'parity-template', name: 'Synthetic runtime template',
    description: 'Public-safe deterministic template', type: 'manual', triggerType: 'manual', version: 1, defaultAssigneeId: adminId,
    sourcePath: 'workflow-templates/parity-template.yaml', sourceRevision: '0123456789abcdef0123456789abcdef01234567',
    sourceDocIds: ['sop.synthetic.parity'], taskDefinitions: [{ refId: '1', description: 'Verify synthetic proof', offsetDays: 0, proofRequirement: { required: true, type: 'comment', label: 'Synthetic note' } }],
    createdAt: fixedNow, updatedAt: fixedNow,
  };
  const notification = {
    PK: 'NOTIFICATION#parity-notification', SK: 'NOTIFICATION#parity-notification', id: 'parity-notification', type: 'follow-up-due',
    message: 'Synthetic task follow-up is due', taskId: task.id, cardId: card.id, dueAt: fixedNow, dismissed: false, createdAt: fixedNow,
  };
  const organization = {
    PK: 'ORGANIZATION#parity-organization', SK: 'ORGANIZATION#parity-organization', id: 'parity-organization', displayName: 'Synthetic Learning Co',
    sourceKey: 'issue-159-parity-organization', version: 1, createdAt: fixedNow, updatedAt: fixedNow,
  };
  const booking = {
    PK: 'BOOKING#parity-booking', SK: 'BOOKING#parity-booking', id: 'parity-booking', organizationId: organization.id,
    slotType: 'main', status: 'confirmed', plannedPublicationDate: '2026-08-20', materialDeadline: '2026-08-16',
    notes: 'Synthetic role-safe booking', version: 1, createdAt: fixedNow, updatedAt: fixedNow,
  };
  await Promise.all([
    put(tables.cards, card), put(tables.cards, returnCard), put(tables.tasks, task), put(tables.intake, intake),
    put(tables.assistants, assistant), put(tables.artifacts, artifact), put(tables.templates, template),
    put(tables.notifications, notification), put(tables.sponsor, organization), put(tables.sponsor, booking),
  ]);
}
await resetFixtures();

function sessionFor(url) {
  return url.searchParams.get('role') === 'operator' ? operatorSession : adminSession;
}

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url || '/', `http://127.0.0.1:${port}`);
  if (url.pathname === '/__parity__/health') {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ target: mode }));
    return;
  }
  if (url.pathname === '/__parity__/session') {
    const session = sessionFor(url);
    response.writeHead(303, { location: '/', 'set-cookie': `dataops_session=${session.token}; Path=/; HttpOnly; SameSite=Lax` });
    response.end();
    return;
  }
  if (url.pathname === '/__parity__/reset' && request.method === 'POST') {
    await resetFixtures();
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ reset: true }));
    return;
  }
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const queryStringParameters = Object.fromEntries(url.searchParams.entries());
  const result = await handlerModule.handler({
    httpMethod: request.method || 'GET',
    path: url.pathname,
    headers: request.headers,
    body: chunks.length ? Buffer.concat(chunks).toString('utf8') : null,
    queryStringParameters: Object.keys(queryStringParameters).length ? queryStringParameters : null,
  }, {});
  for (const [name, value] of Object.entries(result.headers || {})) response.setHeader(name, value);
  response.writeHead(result.statusCode);
  response.end(result.isBase64Encoded ? Buffer.from(result.body || '', 'base64') : result.body || '');
});

server.listen(port, '127.0.0.1', () => process.stdout.write(`${JSON.stringify({ ready: true, mode, port })}\n`));
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close(() => process.exit(0)));
