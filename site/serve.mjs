// A small static server for looking at the built site. It serves dist/ only,
// so what you see locally is the artifact the Pages workflow uploads.

import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, 'dist');
const port = Number(process.env.PORT ?? 4173);

const types = new Map([
  ['.css', 'text/css; charset=utf-8'],
  ['.html', 'text/html; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.md', 'text/markdown; charset=utf-8'],
  ['.svg', 'image/svg+xml'],
  ['.txt', 'text/plain; charset=utf-8'],
]);

function resolveRequest(url) {
  const pathname = decodeURIComponent(new URL(url, 'http://localhost').pathname);
  const relative = pathname.endsWith('/') ? `${pathname}index.html` : pathname;
  const target = path.normalize(path.join(root, relative));
  if (target !== root && !target.startsWith(`${root}${path.sep}`)) return null;
  return target;
}

const server = createServer(async (request, response) => {
  const target = resolveRequest(request.url ?? '/');
  if (!target) {
    response.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' });
    response.end('Bad request\n');
    return;
  }

  let file = target;
  try {
    const info = await stat(file);
    if (info.isDirectory()) file = path.join(file, 'index.html');
  } catch {
    response.writeHead(404, { 'content-type': 'text/html; charset=utf-8' });
    response.end('<!doctype html><title>Not found</title><p>Not found. <a href="/">Go home</a>.</p>\n');
    return;
  }

  try {
    const info = await stat(file);
    response.writeHead(200, {
      'content-type': types.get(path.extname(file).toLowerCase()) ?? 'application/octet-stream',
      'content-length': info.size,
      'cache-control': 'no-store',
    });
    createReadStream(file).pipe(response);
  } catch {
    response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    response.end('Not found\n');
  }
});

server.listen(port, '127.0.0.1', () => {
  console.log(`Site: http://127.0.0.1:${port}/`);
  console.log('Edit site/src, then run `npm run dev` again to rebuild. Ctrl+C stops the server.');
});
