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
    transformIndexHtml(html) {
      if (!config.representative) return html;
      return {
        html,
        tags: [
          {
            tag: 'style',
            attrs: { id: 'dataops-local-mode-style' },
            children: '#dataops-local-mode-banner{position:fixed;right:16px;bottom:16px;z-index:2147483647;padding:7px 11px;border:1px solid #9d6d00;border-radius:6px;background:#fff4c2;color:#553800;font:600 12px/1.35 ui-sans-serif,system-ui,sans-serif;box-shadow:0 4px 18px rgb(0 0 0 / 15%)}',
            injectTo: 'head',
          },
          {
            tag: 'div',
            attrs: { id: 'dataops-local-mode-banner', role: 'status' },
            children: 'Local representative replica · changes stay on this computer',
            injectTo: 'body',
          },
        ],
      };
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
        '^/(?:api|work)(?:/|$)': proxyOptions(config),
        '^/(?:docs|images|folders|lint|parse|health|search|git|content)(?:/|$)': proxyOptions(config),
        '^/(?:login|logout|auth)(?:/|$)': proxyOptions(config),
      },
    },
  };
});
