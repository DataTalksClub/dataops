import { defineConfig } from 'vite';

import {
  classifyBrowserPath,
  readDevConfig,
  rewriteInternalLocation,
} from './scripts/dev-portal-lib.mjs';

function portalRoutingPlugin(config) {
  return {
    name: 'dataops-development-routing',
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        let url;
        try {
          url = new URL(request.url || '/', config.frontendUrl);
        } catch {
          response.writeHead(400, { 'content-type': 'application/json; charset=utf-8' });
          response.end(JSON.stringify({ error: 'Bad request' }));
          return;
        }

        if (url.pathname === '/__dataops/dev-context' && request.method === 'GET') {
          if (!config.actorEmail) {
            response.writeHead(404, { 'content-type': 'application/json; charset=utf-8' });
            response.end(JSON.stringify({ error: 'Not found' }));
            return;
          }
          response.writeHead(200, {
            'content-type': 'application/json; charset=utf-8',
            'cache-control': 'no-store',
          });
          response.end(JSON.stringify({ actorEmail: config.actorEmail, localPreview: true }));
          return;
        }

        const classification = classifyBrowserPath(url.pathname, request.method);
        if (classification === 'not-found') {
          response.writeHead(404, {
            'content-type': 'application/json; charset=utf-8',
            'cache-control': 'no-store',
          });
          response.end(JSON.stringify({ error: 'Not found' }));
          return;
        }
        if (classification === 'app-shell') {
          request.url = `/index.html${url.search}`;
        }
        next();
      });
    },
  };
}

function proxyOptions(config) {
  return {
    target: config.backendUrl,
    changeOrigin: false,
    secure: false,
    configure(proxy) {
      proxy.on('proxyRes', (proxyResponse) => {
        const rewritten = rewriteInternalLocation(proxyResponse.headers.location, config);
        if (rewritten) proxyResponse.headers.location = rewritten;
      });
    },
  };
}

export default defineConfig(() => {
  const config = readDevConfig(process.env, process.cwd());
  return {
    root: config.frontendRoot,
    publicDir: false,
    clearScreen: false,
    plugins: [portalRoutingPlugin(config)],
    server: {
      host: config.host,
      port: config.frontendPort,
      strictPort: true,
      origin: config.frontendUrl,
      cors: false,
      fs: { strict: true, allow: [config.frontendRoot] },
      hmr: {
        host: 'localhost',
        clientPort: config.frontendPort,
      },
      proxy: {
        // Vite matches the complete request target, including its query
        // string. Keep query-bearing API calls (for example /docs?path=…)
        // on the backend instead of falling through to the app shell.
        '^/(?:api|work)(?:/|\\?|$)': proxyOptions(config),
        '^/(?:docs|images|folders|lint|parse|health|search|git|content)(?:/|\\?|$)': proxyOptions(config),
        '^/(?:login|logout|auth)(?:/|\\?|$)': proxyOptions(config),
      },
    },
  };
});
