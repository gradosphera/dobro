/**
 * Ленивый клиент Neon Postgres.
 *
 * Без DATABASE_URL сервис продолжает работать в режиме только-чтения
 * (слои A/B не требуют БД); эндпоинты, которым нужна база, отвечают 503.
 * Клиент создаётся при первом запросе — это важно для холодного старта
 * Vercel и для локальных тестов без базы.
 *
 * Neon-драйвер общается по HTTP, поэтому не требует постоянного соединения
 * и нормально живёт в serverless-функциях.
 */

import { neon } from '@neondatabase/serverless';

export class DbError extends Error {
  readonly status = 503;

  constructor(message: string) {
    super(message);
    this.name = 'DbError';
  }
}

type Sql = ReturnType<typeof neon>;

let cached: { url: string; sql: Sql } | null = null;

export function databaseUrl(): string | null {
  const url =
    process.env.DATABASE_URL ?? process.env.POSTGRES_URL ?? process.env.NEON_DATABASE_URL ?? '';
  return url.trim() || null;
}

export function isDbConfigured(): boolean {
  return databaseUrl() !== null;
}

function client(): Sql {
  const url = databaseUrl();
  if (!url) {
    throw new DbError(
      'DATABASE_URL не задан: подключите Neon к проекту Vercel (Storage → Neon) или задайте переменную локально',
    );
  }
  if (!cached || cached.url !== url) {
    cached = { url, sql: neon(url) };
  }
  return cached.sql;
}

/** Параметризованный запрос. Ошибки соединения не маскируются. */
export async function query<T extends Record<string, unknown> = Record<string, unknown>>(
  text: string,
  params: unknown[] = [],
): Promise<T[]> {
  const sql = client();
  const rows = await sql.query(text, params);
  return rows as T[];
}

export async function queryOne<T extends Record<string, unknown> = Record<string, unknown>>(
  text: string,
  params: unknown[] = [],
): Promise<T | null> {
  const rows = await query<T>(text, params);
  return rows[0] ?? null;
}
