/**
 * Проверки ленивого клиента БД: без DATABASE_URL сервис не падает,
 * а эндпоинты, которым нужна база, получают понятную ошибку 503.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { DbError, databaseUrl, isDbConfigured, query } from '../lib/db.ts';

const KEYS = ['DATABASE_URL', 'POSTGRES_URL', 'NEON_DATABASE_URL'] as const;

function withEnv(values: Partial<Record<(typeof KEYS)[number], string | undefined>>) {
  const saved = new Map<string, string | undefined>();
  for (const key of KEYS) {
    saved.set(key, process.env[key]);
    const value = values[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  return () => {
    for (const key of KEYS) {
      const value = saved.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
}

test('databaseUrl: DATABASE_URL приоритетнее POSTGRES_URL', () => {
  const restore = withEnv({
    DATABASE_URL: 'postgres://primary',
    POSTGRES_URL: 'postgres://fallback',
  });
  try {
    assert.equal(databaseUrl(), 'postgres://primary');
    assert.equal(isDbConfigured(), true);
  } finally {
    restore();
  }
});

test('databaseUrl: POSTGRES_URL используется как запасной вариант', () => {
  const restore = withEnv({ DATABASE_URL: undefined, POSTGRES_URL: 'postgres://neon' });
  try {
    assert.equal(databaseUrl(), 'postgres://neon');
  } finally {
    restore();
  }
});

test('без DATABASE_URL query отвечает DbError(503)', async () => {
  const restore = withEnv({
    DATABASE_URL: undefined,
    POSTGRES_URL: undefined,
    NEON_DATABASE_URL: undefined,
  });
  try {
    assert.equal(isDbConfigured(), false);
    await assert.rejects(
      () => query('select 1'),
      (err: unknown) => err instanceof DbError && err.status === 503,
    );
  } finally {
    restore();
  }
});
