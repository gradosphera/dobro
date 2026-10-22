/**
 * Применяет db/schema.sql к базе из DATABASE_URL.
 *
 *   DATABASE_URL=postgres://… npm run db:migrate
 *
 * Скрипт идемпотентен: все объекты создаются через IF NOT EXISTS,
 * факт применения фиксируется в schema_migrations. Транзакции по всему
 * файлу нет (Neon HTTP выполняет запросы по одному), поэтому при обрыве
 * скрипт можно просто запустить повторно.
 */

import { readFileSync } from 'node:fs';

import { databaseUrl, query } from '../lib/db.ts';

const VERSION = '001_initial';
const schema = readFileSync(new URL('../db/schema.sql', import.meta.url), 'utf8');

function statements(text: string): string[] {
  return text
    .split(/;\s*(?:\n|$)/)
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0);
}

async function main() {
  if (!databaseUrl()) {
    console.error('DATABASE_URL не задан. Пример: DATABASE_URL=postgres://… npm run db:migrate');
    process.exitCode = 1;
    return;
  }

  await query(
    'create table if not exists schema_migrations (version text primary key, applied_at timestamptz not null default now())',
  );

  const applied = await query('select 1 from schema_migrations where version = $1', [VERSION]);
  if (applied.length > 0) {
    console.log(`миграция ${VERSION} уже применена`);
    return;
  }

  const list = statements(schema);
  for (const statement of list) {
    await query(statement);
  }
  await query('insert into schema_migrations (version) values ($1) on conflict do nothing', [VERSION]);

  console.log(`миграция ${VERSION} применена (${list.length} запросов)`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
