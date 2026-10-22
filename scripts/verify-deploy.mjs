/**
 * Проверка деплоя без аккаунта Vercel: собирает проект НАСТОЯЩИМ билдером
 * @vercel/node (тем же, что использует Vercel) и выполняет получившуюся
 * лямбду так же, как это делает рантайм Vercel:
 *
 *   const mod = await import(pathToFileURL(entrypoint).href);
 *
 * Это ловит ошибки, которые не видны в dev-режиме: например, билдер не
 * бандлит, а компилирует файлы по одному, поэтому относительные импорты
 * обязаны указывать на .js-файлы, иначе будет
 * ERR_MODULE_NOT_FOUND -> 500 FUNCTION_INVOCATION_FAILED.
 *
 *   node scripts/verify-deploy.mjs
 */

import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const { build } = await import('@vercel/node');
const { glob } = await import('@vercel/build-utils');

const workRoot = mkdtempSync(path.join(tmpdir(), 'dobro-vercel-'));
const projectDir = path.join(workRoot, 'project');
const workPath = path.join(workRoot, 'work');

mkdirSync(projectDir, { recursive: true });
for (const entry of readdirSync(root, { withFileTypes: true })) {
  if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === '.vercel') continue;
  cpSync(path.join(root, entry.name), path.join(projectDir, entry.name), { recursive: true });
}

const files = {};
for (const [rel, file] of Object.entries(await glob('**/*', projectDir))) {
  if (rel.startsWith('node_modules') || rel.startsWith('.git')) continue;
  files[rel] = file;
}
console.log(`исходников: ${Object.keys(files).length}`);

const ENTRYPOINTS = ['api/hours.ts', 'api/total.ts'];

// Шаблоны vercel.json -> functions проверяются Vercel по ИСХОДНЫМ путям
// (api/hours.ts). Шаблон, не совпавший ни с одной функцией, роняет сборку:
// "The pattern ... doesn't match any Serverless Functions".
{
  const vercelJson = JSON.parse(readFileSync(path.join(root, 'vercel.json'), 'utf8'));
  for (const pattern of Object.keys(vercelJson.functions ?? {})) {
    const regex = new RegExp(
      `^${pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*')}$`,
    );
    const matched = ENTRYPOINTS.filter((e) => regex.test(e));
    if (matched.length === 0) {
      console.error(
        `ОШИБКА: шаблон "${pattern}" в vercel.json не совпадает ни с одной функцией ` +
          `(${ENTRYPOINTS.join(', ')}) — сборка на Vercel упадёт с unused_function`,
      );
      process.exit(1);
    }
    console.log(`шаблон "${pattern}" -> ${matched.join(', ')}`);
  }
}

let lambdaDir;
let hoursEntry;
let totalEntry;

for (const entrypoint of ENTRYPOINTS) {
  const result = await build({
    files,
    entrypoint,
    workPath: path.join(workPath, entrypoint.replace(/\//g, '_')),
    repoRootPath: path.join(workPath, entrypoint.replace(/\//g, '_')),
    config: { projectSettings: { buildCommand: null, installCommand: null }, functions: {} },
    meta: { skipDownload: false },
    service: 'web',
    considerBuildCommand: true,
  });

  const dir = path.join(workRoot, 'lambda', entrypoint.replace(/\//g, '_'));
  mkdirSync(dir, { recursive: true });
  for (const [rel, file] of Object.entries(result.output.files ?? {})) {
    const target = path.join(dir, rel);
    mkdirSync(path.dirname(target), { recursive: true });
    if (file.data) writeFileSync(target, file.data);
    else if (file.fsPath) cpSync(file.fsPath, target);
  }

  console.log(`файлы лямбды ${entrypoint}:`);
  for (const rel of Object.keys(result.output.files ?? {})) {
    if (!rel.endsWith('.map')) console.log(`  ${rel}`);
  }

  const js = path.join(dir, 'api', entrypoint.replace(/^api\//, '').replace(/\.ts$/, '.js'));
  if (!existsSync(js)) {
    console.error(`ОШИБКА: в лямбде нет ${js}`);
    process.exit(1);
  }
  if (entrypoint === 'api/hours.ts') hoursEntry = js;
  else totalEntry = js;
  lambdaDir = dir;
}

const specifiers = readdirSync(path.join(lambdaDir, 'api'))
  .filter((f) => f.endsWith('.js'))
  .flatMap((f) => {
    const source = readFileSync(path.join(lambdaDir, 'api', f), 'utf8');
    return [...source.matchAll(/from\s+["']([^"']+)["']/g)].map((m) => m[1]);
  });

const broken = specifiers.filter((s) => s.endsWith('.ts'));
if (broken.length > 0) {
  console.error(`ОШИБКА: в собранной лямбде остались .ts-импорты: ${broken.join(', ')}`);
  console.error('Функция упадёт с ERR_MODULE_NOT_FOUND (Vercel: 500 FUNCTION_INVOCATION_FAILED).');
  process.exit(1);
}

const mod = await import(pathToFileURL(hoursEntry).href);
if (typeof mod.default !== 'function') {
  console.error('ОШИБКА: в api/hours.js нет функции-обработчика по умолчанию');
  process.exit(1);
}

const res = {
  statusCode: 0,
  body: undefined,
  headers: {},
  setHeader(k, v) {
    this.headers[k] = v;
    return this;
  },
  status(code) {
    this.statusCode = code;
    return this;
  },
  json(payload) {
    this.body = payload;
    return this;
  },
  end() {
    return this;
  },
};

const started = Date.now();
await mod.default({ method: 'GET', query: { q: 'Волонтеры-медики', limit: '2' } }, res);
const elapsed = Date.now() - started;

if (res.statusCode !== 200) {
  console.error(`ОШИБКА: лямбда ответила ${res.statusCode}: ${JSON.stringify(res.body)}`);
  process.exit(1);
}

console.log(
  `OK: /api/hours ответил 200 за ${elapsed} мс — ` +
    `${res.body.bestMatchName}: ${res.body.bestMatchHours} ч`,
);

const totalMod = await import(pathToFileURL(totalEntry).href);
const totalRes = {
  ...res,
  setHeader(k, v) {
    this.headers[k] = v;
    return this;
  },
};
await totalMod.default({ method: 'GET', query: {} }, totalRes);
if (totalRes.statusCode !== 200 || !totalRes.body?.hours) {
  console.error(`ОШИБКА: /api/total ответил ${totalRes.statusCode}`);
  process.exit(1);
}
console.log(`OK: /api/total ответил 200 — ${totalRes.body.hours} ч на платформе`);

rmSync(workRoot, { recursive: true, force: true });
