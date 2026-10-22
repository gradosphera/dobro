/**
 * Локальный эмулятор Vercel-роутинга: статика из public/ + /api/* -> хендлеры.
 * Нужен, чтобы проверять поведение ровно так, как оно будет на Vercel,
 * без установки vercel CLI и без логина.
 *
 *   node --experimental-strip-types scripts/dev-server.ts
 *   curl 'http://localhost:3000/api/hours?q=Волонтеры-медики'
 */

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

import hours from '../api/hours.ts';
import total from '../api/total.ts';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const PUBLIC = join(ROOT, 'public');
const PORT = Number(process.env.PORT ?? 3000);

type Handler = (req: any, res: any) => Promise<unknown>;

const routes: Record<string, Handler> = {
  '/api/hours': hours as Handler,
  '/api/total': total as Handler,
};

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);

  const handler = routes[url.pathname];
  if (handler) {
    const query = Object.fromEntries(url.searchParams.entries());
    // Адаптер node:res -> Vercel-совместимый res (status/json/end/setHeader).
    const vres = {
      statusCode: 200,
      body: undefined as unknown,
      setHeader(k: string, v: string) {
        res.setHeader(k, v);
        return this;
      },
      status(code: number) {
        this.statusCode = code;
        return this;
      },
      json(payload: unknown) {
        this.body = payload;
        res.statusCode = this.statusCode;
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.end(JSON.stringify(payload));
        return this;
      },
      end() {
        res.statusCode = this.statusCode;
        res.end();
        return this;
      },
    };

    try {
      await handler({ method: req.method, query, headers: req.headers }, vres);
      if (vres.body === undefined && !res.writableEnded) {
        res.statusCode = vres.statusCode;
        res.end();
      }
    } catch (err) {
      res.statusCode = 500;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.end(JSON.stringify({ error: String(err) }));
    }
    return;
  }

  // Статика.
  const rel = url.pathname === '/' ? 'index.html' : url.pathname.replace(/^\/+/, '');
  const file = join(PUBLIC, normalize(rel));
  if (!file.startsWith(PUBLIC) || !existsSync(file)) {
    res.statusCode = 404;
    res.end('Not found');
    return;
  }

  const body = await readFile(file);
  res.statusCode = 200;
  res.setHeader('Content-Type', MIME[extname(file)] ?? 'application/octet-stream');
  res.end(body);
});

server.listen(PORT, () => {
  console.log(`dev server: http://localhost:${PORT}`);
});
