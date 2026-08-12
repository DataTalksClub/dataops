import Module, { builtinModules } from 'node:module';
import { resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

function artifactArgument(argv) {
  if (argv.length !== 2 || argv[0] !== '--artifact' || !argv[1]) throw new Error('Usage: packaged-handler-probe.mjs --artifact <root>');
  return resolve(argv[1]);
}

const artifactRoot = artifactArgument(process.argv.slice(2));
delete process.env.FRONTEND_ROOT;
delete process.env.NODE_PATH;
Object.assign(process.env, {
  NODE_ENV: 'test',
  IS_LOCAL: 'false',
  SKIP_AUTH: 'false',
  DATAOPS_AUTO_CREATE_TABLES: 'true',
  DATAOPS_DOCS_DOMAIN: '1',
  DTC_OFFLINE: '1',
  DTC_CACHE_ROOT: resolve(artifactRoot, 'synthetic-doc-cache'),
  AUTH_BASE_URL: 'https://auth.example.test',
  AUTH_USER_POOL_ID: 'synthetic-pool',
  AUTH_ISSUER: 'https://issuer.example.test/synthetic-pool',
  AUTH_JWKS_URL: 'https://issuer.example.test/synthetic-pool/jwks.json',
  AUTH_CLIENT_ID: 'synthetic-client',
  AUTH_CALLBACK_URL: 'https://portal.example.test/auth/callback',
  AUTH_LOGOUT_URL: 'https://portal.example.test/',
  AUTH_SESSION_LIFETIME_SECONDS: '3600',
  CONVERSATIONAL_TELEGRAM_INGRESS_ENABLED: 'false',
  CONVERSATIONAL_EXECUTION_ENABLED: 'false',
  CONVERSATIONAL_ENABLED_PLUGINS: 'none',
  CONVERSATIONAL_TYPEFULLY_EXTERNAL_EXECUTION_ENABLED: 'false',
  CONVERSATIONAL_TELEGRAM_VOICE_ENABLED: 'false',
  CONVERSATIONAL_TELEGRAM_PHOTO_ENABLED: 'false',
});

const builtins = new Set([...builtinModules, ...builtinModules.map((name) => `node:${name}`)]);
const originalResolve = Module._resolveFilename;
let outsideModuleResolution = false;
Module._resolveFilename = function guardedResolve(request, parent, isMain, options) {
  const result = originalResolve.call(this, request, parent, isMain, options);
  if (typeof result === 'string' && !builtins.has(result) && result !== request) {
    const absolute = resolve(result);
    if (absolute !== artifactRoot && !absolute.startsWith(artifactRoot + sep)) {
      outsideModuleResolution = true;
      throw new Error(`Packaged handler attempted outside module resolution: ${absolute}`);
    }
  }
  return result;
};

const [{ handler }, { getClient }, { createTables }, { createUserWithId }, { createBrowserSession }] = await Promise.all([
  import(pathToFileURL(resolve(artifactRoot, 'dist/handler.js')).href),
  import(pathToFileURL(resolve(artifactRoot, 'dist/db/client.js')).href),
  import(pathToFileURL(resolve(artifactRoot, 'dist/db/setup.js')).href),
  import(pathToFileURL(resolve(artifactRoot, 'dist/db/users.js')).href),
  import(pathToFileURL(resolve(artifactRoot, 'dist/db/sessions.js')).href),
]);

const client = await getClient();
await createTables(client);
const userId = '15900000-0000-4000-8000-000000000001';
await createUserWithId(client, userId, {
  name: 'Synthetic parity admin',
  email: 'parity-admin@example.test',
  role: 'admin',
});
const session = await createBrowserSession(client, userId, { lifetimeSeconds: 3600 });
const paths = JSON.parse(process.env.ISSUE_159_REQUEST_PATHS || '[]');
const responses = [];
for (const path of paths) {
  const response = await handler({
    httpMethod: 'GET',
    path,
    headers: { cookie: `dataops_session=${session.token}` },
  }, {});
  responses.push({
    path,
    statusCode: response.statusCode,
    contentType: response.headers?.['Content-Type'] || response.headers?.['content-type'] || '',
    body: response.body || '',
    isBase64Encoded: Boolean(response.isBase64Encoded),
  });
}
process.stdout.write(JSON.stringify({ outsideModuleResolution, responses }), () => process.exit(0));
