import net from 'node:net';
import path from 'node:path';

export const DEV_HOST = '127.0.0.1';
export const DEFAULT_FRONTEND_PORT = 3000;
export const DEFAULT_BACKEND_PORT = 3001;

export const PROXY_FAMILIES = Object.freeze([
  '/api',
  '/work',
  '/docs',
  '/images',
  '/folders',
  '/lint',
  '/parse',
  '/health',
  '/search',
  '/git',
  '/content',
  '/login',
  '/logout',
  '/auth',
]);

export const FORBIDDEN_BROWSER_NAMESPACES = Object.freeze([
  'assets',
  'frontend',
  'pages',
  'public',
  'static',
  'ui',
]);

const LOCAL_CREDENTIAL_MARKER = /^(?:fake|local|test|dummy|offline|dynalite)(?:[-_.][a-z0-9.-]+)?$/i;

export class DevPortalConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'DevPortalConfigError';
  }
}

export function parsePort(value, name, fallback) {
  if (value === undefined || value === '') return fallback;
  if (!/^\d+$/.test(value)) {
    throw new DevPortalConfigError(`${name} must be a numeric TCP port`);
  }
  const port = Number(value);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) {
    throw new DevPortalConfigError(`${name} must be between 1 and 65535`);
  }
  return port;
}

export function isLoopbackHostname(hostname) {
  return hostname === 'localhost'
    || hostname === '127.0.0.1'
    || hostname === '::1'
    || hostname === '[::1]';
}

function validateLocalCredentials(env) {
  const accessKey = env.AWS_ACCESS_KEY_ID || '';
  const secretKey = env.AWS_SECRET_ACCESS_KEY || '';
  if (!accessKey || !secretKey) {
    throw new DevPortalConfigError(
      'DYNAMODB_ENDPOINT requires explicit local AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY values',
    );
  }
  if (env.AWS_SESSION_TOKEN) {
    throw new DevPortalConfigError('DYNAMODB_ENDPOINT rejects AWS_SESSION_TOKEN; use local-only credentials');
  }
  if (/^(?:AKIA|ASIA)[A-Z0-9]+$/.test(accessKey)) {
    throw new DevPortalConfigError('DYNAMODB_ENDPOINT rejects credentials that look like live AWS credentials');
  }
  if (!LOCAL_CREDENTIAL_MARKER.test(accessKey) || !LOCAL_CREDENTIAL_MARKER.test(secretKey)) {
    throw new DevPortalConfigError(
      'DYNAMODB_ENDPOINT credentials must use an explicit local marker (local, fake, test, dummy, offline, or dynalite)',
    );
  }
}

export function validateDynamoEndpoint(rawEndpoint, env) {
  if (!rawEndpoint) return null;
  let endpoint;
  try {
    endpoint = new URL(rawEndpoint);
  } catch {
    throw new DevPortalConfigError('DYNAMODB_ENDPOINT must be a valid http: loopback URL');
  }
  if (endpoint.protocol !== 'http:' || !isLoopbackHostname(endpoint.hostname)) {
    throw new DevPortalConfigError('DYNAMODB_ENDPOINT must be an http: loopback URL');
  }
  if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
    throw new DevPortalConfigError('DYNAMODB_ENDPOINT must not contain credentials, a query, or a fragment');
  }
  validateLocalCredentials(env);
  return endpoint;
}

function parseSeedMode(value) {
  const mode = value || 'default';
  if (mode !== 'default' && mode !== 'none') {
    throw new DevPortalConfigError('DATAOPS_DEV_SEED_MODE must be default or none');
  }
  return mode;
}

export function readDevConfig(env = process.env, cwd = process.cwd()) {
  const frontendPort = parsePort(
    env.DATAOPS_DEV_FRONTEND_PORT,
    'DATAOPS_DEV_FRONTEND_PORT',
    DEFAULT_FRONTEND_PORT,
  );
  const backendPort = parsePort(
    env.DATAOPS_DEV_BACKEND_PORT,
    'DATAOPS_DEV_BACKEND_PORT',
    DEFAULT_BACKEND_PORT,
  );
  if (frontendPort === backendPort) {
    throw new DevPortalConfigError('DATAOPS_DEV_FRONTEND_PORT and DATAOPS_DEV_BACKEND_PORT must be distinct');
  }

  const dynamoEndpoint = validateDynamoEndpoint(env.DYNAMODB_ENDPOINT, env);
  const seedMode = parseSeedMode(env.DATAOPS_DEV_SEED_MODE);
  if (dynamoEndpoint && env.IS_LOCAL !== 'true' && env.IS_LOCAL !== '1') {
    throw new DevPortalConfigError('DYNAMODB_ENDPOINT requires IS_LOCAL=true');
  }
  if (dynamoEndpoint && seedMode !== 'none') {
    throw new DevPortalConfigError('DYNAMODB_ENDPOINT requires DATAOPS_DEV_SEED_MODE=none');
  }
  if (seedMode === 'none' && !dynamoEndpoint) {
    throw new DevPortalConfigError('DATAOPS_DEV_SEED_MODE=none requires DYNAMODB_ENDPOINT');
  }

  const representative = Boolean(dynamoEndpoint);
  const actorEmail = String(env.DATAOPS_DEV_ACTOR_EMAIL || '').trim();
  if (actorEmail && !representative) {
    throw new DevPortalConfigError('DATAOPS_DEV_ACTOR_EMAIL requires a local representative replica');
  }
  if (actorEmail && (!actorEmail.includes('@') || /[\r\n]/.test(actorEmail))) {
    throw new DevPortalConfigError('DATAOPS_DEV_ACTOR_EMAIL must be a single email address');
  }
  const frontendRoot = path.resolve(cwd, env.DATAOPS_DEV_FRONTEND_ROOT || 'frontend');
  const stateRoot = path.resolve(cwd, env.DATAOPS_DEV_STATE_ROOT || '.tmp/dev-portal');
  const cacheRoot = path.resolve(env.DTC_CACHE_ROOT || stateRoot);
  const uploadRoot = path.resolve(env.UPLOAD_DIR || path.join(stateRoot, 'uploads'));
  const exportRoot = path.resolve(
    env.DATAOPS_EXPORT_ARCHIVE_LOCAL_DIR || path.join(stateRoot, 'exports'),
  );

  return Object.freeze({
    host: DEV_HOST,
    frontendPort,
    backendPort,
    frontendUrl: `http://localhost:${frontendPort}`,
    backendUrl: `http://${DEV_HOST}:${backendPort}`,
    frontendRoot,
    stateRoot,
    cacheRoot,
    uploadRoot,
    exportRoot,
    dynamoEndpoint: dynamoEndpoint?.toString() || '',
    seedMode,
    representative,
    actorEmail,
    modeLabel: representative ? 'local representative replica' : 'local seeded data',
  });
}

export function isProxyPath(pathname) {
  return PROXY_FAMILIES.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`));
}

function extensionOf(pathname) {
  const name = pathname.split('/').pop() || '';
  const dot = name.lastIndexOf('.');
  return dot >= 0 ? name.slice(dot).toLowerCase() : '';
}

export function classifyBrowserPath(pathname, method = 'GET') {
  const normalizedMethod = method.toUpperCase();
  if (isProxyPath(pathname)) return 'proxy';
  if (normalizedMethod !== 'GET' && normalizedMethod !== 'HEAD') return 'not-found';
  if (pathname === '/' || pathname === '/index.html') return 'frontend';
  if (pathname === '/src/app.js' || pathname === '/src/styles.css') return 'frontend';
  if (
    pathname.startsWith('/@vite/')
    || pathname.startsWith('/@id/')
    || pathname.startsWith('/@fs/')
    || pathname.startsWith('/node_modules/.vite/')
  ) return 'vite-internal';

  const firstSegment = pathname.replace(/^\/+/, '').split('/')[0].toLowerCase();
  if (FORBIDDEN_BROWSER_NAMESPACES.includes(firstSegment)) return 'not-found';
  if (pathname.startsWith('/src/')) return 'not-found';
  const extension = extensionOf(pathname);
  if (extension === '.md' || extension === '') return 'app-shell';
  return 'not-found';
}

export function rewriteInternalLocation(location, config) {
  if (!location) return location;
  let parsed;
  try {
    parsed = new URL(location, config.frontendUrl);
  } catch {
    return location;
  }
  const internalHosts = new Set([
    `${DEV_HOST}:${config.backendPort}`,
    `localhost:${config.backendPort}`,
    `[::1]:${config.backendPort}`,
  ]);
  if (!internalHosts.has(parsed.host)) return location;
  return `${parsed.pathname}${parsed.search}${parsed.hash}`;
}

export async function probePort(host, port) {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once('error', (error) => {
      if (error && (error.code === 'EADDRINUSE' || error.code === 'EACCES')) {
        resolve(false);
      } else {
        reject(error);
      }
    });
    server.listen({ host, port, exclusive: true }, () => {
      server.close((error) => (error ? reject(error) : resolve(true)));
    });
  });
}

export async function assertPortsAvailable(config) {
  const frontendFree = await probePort(config.host, config.frontendPort);
  const backendFree = await probePort(config.host, config.backendPort);
  if (!frontendFree) {
    throw new DevPortalConfigError(`Port ${config.frontendPort} is occupied`);
  }
  if (!backendFree) {
    throw new DevPortalConfigError(`Port ${config.backendPort} is occupied`);
  }
}

const EXTERNAL_ENV_KEYS = Object.freeze([
  'AUTH_BASE_URL',
  'AUTH_CALLBACK_URL',
  'AUTH_CLIENT_ID',
  'AUTH_ISSUER',
  'AUTH_JWKS_URL',
  'AUTH_LOGOUT_URL',
  'BOOKKEEPING_DOCUMENTS_BUCKET',
  'BOOKKEEPING_DOCUMENTS_KMS_KEY',
  'BOOKKEEPING_INGESTION_SECRET',
  'BOOKKEEPING_INGESTION_SECRET_NAME',
  'DATAOPS_MAILING_EXPORTS_BUCKET',
  'DATAOPS_MAILING_EXPORTS_CONFIG',
  'EMAIL_DOCUMENTS_BUCKET',
  'EMAIL_DOCUMENTS_KMS_KEY',
  'EMAIL_DOCUMENT_INTAKE_SECRET',
  'EMAIL_DOCUMENT_INTAKE_SECRET_NAME',
  'GITHUB_TOKEN',
  'GITHUB_TOKEN_SECRET_NAME',
  'GROQ_TRANSCRIPTION_API_KEY_SECRET_ARN',
  'SPONSOR_COMMUNICATION_HMAC_SECRET_ARN',
  'SPONSOR_COMMUNICATION_PRIVATE_ARCHIVE_BUCKET',
  'SPONSOR_COMMUNICATION_PRIVATE_ARCHIVE_KMS_KEY',
  'SPONSOR_COMMUNICATION_TEMPLATE_SECRET_ARN',
  'TELEGRAM_BOT_TOKEN',
  'TELEGRAM_INTEGRATION_SECRET_NAME',
  'TELEGRAM_WEBHOOK_SECRET',
  'TYPEFULLY_API_KEY',
  'WEBHOOK_EMAIL_SECRET',
  'WORK_ENGINE_PORTAL_SECRET',
  'WORK_ENGINE_PORTAL_SECRET_NAME',
  'ZAI_CONVERSATIONAL_API_KEY_SECRET_ARN',
  'ZAI_CONVERSATIONAL_BASE_URL',
  'ZAI_VISION_API_KEY_SECRET_ARN',
  'ZAI_VISION_BASE_URL',
]);

export function buildChildEnvironment(config, parentEnv = process.env) {
  const env = { ...parentEnv };
  Object.assign(env, {
    PORT: String(config.backendPort),
    DATAOPS_DEV_BACKEND_HOST: config.host,
    DATAOPS_DEV_FRONTEND_PORT: String(config.frontendPort),
    DATAOPS_DEV_BACKEND_PORT: String(config.backendPort),
    DATAOPS_DEV_FRONTEND_ROOT: config.frontendRoot,
    DATAOPS_DEV_STATE_ROOT: config.stateRoot,
    DATAOPS_DEV_SEED_MODE: config.seedMode,
    DATAOPS_DEV_REPRESENTATIVE_MODE: config.representative ? 'true' : 'false',
    DATAOPS_LOCAL_MODE_LABEL: config.modeLabel,
    IS_LOCAL: 'true',
    DTC_OFFLINE: '1',
    DATAOPS_DOCS_DOMAIN: '1',
    DTC_CACHE_ROOT: config.cacheRoot,
    FRONTEND_ROOT: config.frontendRoot,
    UPLOAD_DIR: config.uploadRoot,
    DATAOPS_EXPORT_ARCHIVE_LOCAL_DIR: config.exportRoot,
    DATAOPS_FILE_STORAGE_PROVIDER: 'local-dev',
    SKIP_AUTH: 'true',
    AWS_EC2_METADATA_DISABLED: 'true',
    CONVERSATIONAL_TELEGRAM_INGRESS_ENABLED: 'false',
    CONVERSATIONAL_EXECUTION_ENABLED: 'false',
    CONVERSATIONAL_ENABLED_PLUGINS: 'none',
    CONVERSATIONAL_TYPEFULLY_EXTERNAL_EXECUTION_ENABLED: 'false',
    CONVERSATIONAL_TELEGRAM_VOICE_ENABLED: 'false',
    CONVERSATIONAL_TELEGRAM_PHOTO_ENABLED: 'false',
    CONVERSATIONAL_FAKE_EXECUTOR_ENABLED: 'false',
    SPONSOR_COMMUNICATION_SEND_ENABLED: 'false',
    SPONSOR_FINANCE_ENABLED: 'false',
  });
  if (config.representative) {
    env.DATAOPS_AUTO_CREATE_TABLES = 'false';
    env.WORK_ENGINE_AUTH_MODE = 'portal';
    for (const key of EXTERNAL_ENV_KEYS) delete env[key];
  }
  return env;
}
