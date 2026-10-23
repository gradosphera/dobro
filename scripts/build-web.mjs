/**
 * Сборка статики: esbuild-бандл UI + vendor TON Connect + манифест.
 *
 *   SITE_URL=https://example.org npm run build:web
 *
 * Без SITE_URL берётся Vercel-домен или localhost. Артефакты
 * (public/js, public/vendor, public/tonconnect-manifest.json) в git
 * не попадают и создаются при деплое/локальной сборке.
 */

import { build } from 'esbuild';
import { copyFile, mkdir, writeFile } from 'node:fs/promises';

const siteUrl =
  process.env.SITE_URL ??
  (process.env.VERCEL_PROJECT_PRODUCTION_URL
    ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`
    : process.env.VERCEL_URL
      ? `https://${process.env.VERCEL_URL}`
      : 'http://localhost:3000');

await mkdir('public/vendor', { recursive: true });
await mkdir('public/js', { recursive: true });

await copyFile(
  'node_modules/@tonconnect/ui/dist/tonconnect-ui.min.js',
  'public/vendor/tonconnect-ui.min.js',
);

for (const [entry, outfile] of [
  ['web/main.ts', 'public/js/app.js'],
  ['web/claim.ts', 'public/js/claim.js'],
]) {
  await build({
    entryPoints: [entry],
    outfile,
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: ['es2020'],
    minify: true,
    legalComments: 'none',
    inject: ['web/buffer-shim.ts'],
    logLevel: 'info',
  });
}

const manifest = {
  url: siteUrl,
  name: 'Добро.DAO',
  iconUrl: new URL('icon.png', siteUrl).href,
};

await writeFile(
  'public/tonconnect-manifest.json',
  `${JSON.stringify(manifest, null, 2)}\n`,
);

console.log(`manifest: ${manifest.url}`);
console.log(`icon:     ${manifest.iconUrl}`);
