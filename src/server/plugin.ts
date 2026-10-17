import { readFileSync, readdirSync, renameSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import type { IncomingMessage } from 'node:http';
import type { Plugin } from 'vite';
import { DIAGRAM_FILE, layoutPathFor } from '../paths.ts';

const SKIP_DIRS = new Set(['node_modules', '.git', 'out', 'dist']);

function listPuml(root: string, dir = root, depth = 0): string[] {
  if (depth > 5) return [];
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.') || SKIP_DIRS.has(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...listPuml(root, full, depth + 1));
    else if (DIAGRAM_FILE.test(entry.name)) found.push(relative(root, full));
  }
  return found.sort();
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((ok, fail) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => ok(body));
    req.on('error', fail);
  });
}

/**
 * File access for the editor: lists .puml and .mmd files under `root`, reads a diagram
 * with its layout, writes the layout back, and pushes a `puml:changed` event
 * when either file changes on disk (an agent editing the text, say).
 */
export function pumlFiles(root: string): Plugin {
  const base = resolve(root);
  const lastWritten = new Map<string, string>();

  const resolveFile = (file: string | null): string | undefined => {
    if (!file || !DIAGRAM_FILE.test(file)) return undefined;
    const full = resolve(base, file);
    return full.startsWith(base + sep) && existsSync(full) && statSync(full).isFile() ? full : undefined;
  };

  return {
    name: 'puml-files',
    configureServer(server) {
      server.watcher.add(base);
      const onChange = (path: string) => {
        const full = resolve(path);
        if (!full.startsWith(base + sep)) return;
        const isLayout = full.endsWith('.layout.json');
        if (!isLayout && !DIAGRAM_FILE.test(full)) return;
        // Ignore the echo of our own layout writes.
        if (isLayout && existsSync(full) && readFileSync(full, 'utf8') === lastWritten.get(full)) return;
        const puml = isLayout ? listPuml(base).find((f) => layoutPathFor(resolve(base, f)) === full) : relative(base, full);
        if (puml) server.ws.send({ type: 'custom', event: 'puml:changed', data: { file: puml, what: isLayout ? 'layout' : 'source' } });
      };
      server.watcher.on('change', onChange);
      server.watcher.on('add', onChange);

      server.middlewares.use('/api', async (req, res) => {
        const url = new URL(req.url ?? '/', 'http://localhost');
        const send = (status: number, body: unknown) => {
          res.statusCode = status;
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify(body));
        };
        try {
          if (url.pathname === '/files' && req.method === 'GET') return send(200, { root: base, files: listPuml(base) });

          const full = resolveFile(url.searchParams.get('file'));
          if (!full) return send(404, { error: 'unknown diagram file' });
          const layoutPath = layoutPathFor(full);

          if (url.pathname === '/doc' && req.method === 'GET') {
            return send(200, {
              source: readFileSync(full, 'utf8'),
              layout: existsSync(layoutPath) ? readFileSync(layoutPath, 'utf8') : null,
            });
          }
          if (url.pathname === '/layout' && req.method === 'PUT') {
            const body = await readBody(req);
            JSON.parse(body); // refuse to write anything that isn't JSON
            lastWritten.set(layoutPath, body);
            const tmp = `${layoutPath}.tmp`;
            writeFileSync(tmp, body);
            renameSync(tmp, layoutPath);
            return send(200, { ok: true });
          }
          send(404, { error: 'not found' });
        } catch (error) {
          send(500, { error: String(error) });
        }
      });
    },
  };
}
