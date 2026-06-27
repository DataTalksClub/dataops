import http from 'http';
import { URL } from 'url';
import { handler } from '../src/handler';
import { seed as seedUsers } from './seed-users';
import { seed as seedTemplates } from './seed-templates';
import type { LambdaEvent } from '../src/types';

const PORT = parseInt(process.env.PORT || '3000', 10);

const server = http.createServer(async (req, res) => {
  const parsed = new URL(req.url!, `http://localhost:${PORT}`);

  // Collect body
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(chunk as Buffer);
  }
  // Use binary encoding for multipart requests to preserve file content
  const contentType = req.headers['content-type'] || '';
  const isMultipart = contentType.includes('multipart/form-data');
  const body = chunks.length > 0
    ? Buffer.concat(chunks).toString(isMultipart ? 'binary' : 'utf-8')
    : null;

  // Build query string parameters
  const queryStringParameters: Record<string, string> = {};
  for (const [key, value] of parsed.searchParams.entries()) {
    queryStringParameters[key] = value;
  }

  // Build Lambda-style event
  const event: LambdaEvent = {
    httpMethod: req.method!,
    path: parsed.pathname,
    headers: req.headers as Record<string, string>,
    body: body,
    queryStringParameters:
      Object.keys(queryStringParameters).length > 0
        ? queryStringParameters
        : null,
  };

  try {
    const result = await handler(event, {});

    // Set response headers
    if (result.headers) {
      for (const [key, value] of Object.entries(result.headers)) {
        res.setHeader(key, value);
      }
    }

    res.writeHead(result.statusCode);
    // If Content-Disposition is set, treat the body as binary
    const hasDownload = result.headers?.['Content-Disposition'];
    if (hasDownload && result.body) {
      res.end(Buffer.from(result.body, 'binary'));
    } else {
      res.end(result.body || '');
    }
  } catch (err: unknown) {
    console.error('Handler error:', err);
    res.writeHead(500);
    res.end(JSON.stringify({ error: 'Internal server error' }));
  }
});

// Seed users and templates before starting the server
async function runSeeds() {
  try {
    await seedUsers();
    await seedTemplates();
    console.log('Seed data initialized.');
  } catch (err) {
    console.error('Seed error (non-fatal):', err);
  }
}

runSeeds().then(() => {
  server.listen(PORT, () => {
    console.log(`Dev server listening at http://localhost:${PORT}`);
  });
});

process.on('SIGINT', () => {
  console.log('\nShutting down dev server...');
  server.close(() => {
    process.exit(0);
  });
});
