#!/usr/bin/env node
/**
 * Zero-dependency static file server for `dist/`.
 *
 *   node scripts/serve.mjs [dir=dist] [port=8765]
 *
 * Purpose: preview the production build (and serve it to the e2e runner)
 * without pulling a server dependency into the project.
 */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';

const root = resolve(process.argv[2] ?? 'dist');
const port = Number(process.argv[3] ?? 8765);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.map': 'application/json; charset=utf-8',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? '/', 'http://localhost');
    let pathname = decodeURIComponent(url.pathname);
    if (pathname.endsWith('/')) pathname += 'index.html';

    const target = normalize(join(root, pathname));
    if (target !== root && !target.startsWith(root + sep)) {
      res.writeHead(403).end('forbidden');
      return;
    }

    let file = target;
    try {
      await readFile(file);
    } catch {
      // SPA fallback: unknown paths without an extension render the shell.
      if (!extname(pathname)) file = join(root, 'index.html');
      else throw new Error('not found');
    }

    const body = await readFile(file);
    res.writeHead(200, {
      'Content-Type': MIME[extname(file)] ?? 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(body);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('not found');
  }
});

server.listen(port, '127.0.0.1', () => {
  console.log(`serving ${root} → http://127.0.0.1:${port}`);
});
