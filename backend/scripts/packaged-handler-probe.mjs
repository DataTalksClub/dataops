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
  DATAOPS_DOCS_DOMAIN: '1',
  DTC_OFFLINE: '1',
  DTC_CACHE_ROOT: resolve(artifactRoot, 'synthetic-doc-cache'),
  AUTH_BASE_URL: '',
  AUTH_USER_POOL_ID: '',
  AUTH_ISSUER: '',
  AUTH_JWKS_URL: '',
  AUTH_CLIENT_ID: '',
  AUTH_CALLBACK_URL: '',
  AUTH_LOGOUT_URL: '',
  AUTH_SESSION_LIFETIME_SECONDS: '',
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
const outsideModuleResolutions = [];
Module._resolveFilename = function guardedResolve(request, parent, isMain, options) {
  const result = originalResolve.call(this, request, parent, isMain, options);
  if (typeof result === 'string' && !builtins.has(result) && result !== request) {
    const absolute = resolve(result);
    if (absolute !== artifactRoot && !absolute.startsWith(artifactRoot + sep)) {
      outsideModuleResolution = true;
      outsideModuleResolutions.push(absolute);
      throw new Error(`Packaged handler attempted outside module resolution: ${absolute}`);
    }
  }
  return result;
};

const { handler } = await import(pathToFileURL(resolve(artifactRoot, 'dist/handler.js')).href);
const paths = JSON.parse(process.env.ISSUE_159_REQUEST_PATHS || '[]');
const responses = [];
for (const path of paths) {
  const response = await handler({
    httpMethod: 'GET',
    path,
    headers: {},
  }, {});
  responses.push({
    path,
    statusCode: response.statusCode,
    contentType: response.headers?.['Content-Type'] || response.headers?.['content-type'] || '',
    body: response.body || '',
    isBase64Encoded: Boolean(response.isBase64Encoded),
  });
}
const PROBE_RESULT_PREFIX = '__DATAOPS_PACKAGED_HANDLER_PROBE__';
process.stdout.write(
  `\n${PROBE_RESULT_PREFIX}${JSON.stringify({ outsideModuleResolution, outsideModuleResolutions, responses })}\n`,
  () => process.exit(0),
);
