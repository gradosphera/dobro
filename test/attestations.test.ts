/**
 * Аттестации: нормализация периода, округление BLG и деградация без БД.
 * SQL-часть проверяется на живом Neon после `npm run db:migrate`.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import attestations from '../api/attestations.ts';
import bind from '../api/bind.ts';
import { blgForHours, normalizePeriod } from '../lib/attestations.ts';
import { createSession } from '../lib/auth.ts';

const ADDRESS = 'EQDExlp6EjkVN-OJ1ZcGLEYlITaold5ytBP3e8g6g_BIRaZX';

type Handler = (req: unknown, res: unknown) => Promise<unknown>;

function mockRes() {
  return {
    statusCode: 0,
    body: undefined as unknown,
    headers: {} as Record<string, string>,
    setHeader(k: string, v: string) {
      this.headers[k] = v;
      return this;
    },
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(payload: unknown) {
      this.body = payload;
      return this;
    },
    end() {
      return this;
    },
  };
}

async function call(
  handler: Handler,
  method: string,
  query: Record<string, string> = {},
  body?: unknown,
  headers: Record<string, string> = {},
) {
  const res = mockRes();
  await handler({ method, query, body, headers }, res);
  return res;
}

function withEnv(values: Record<string, string | undefined>) {
  const keys = ['DATABASE_URL', 'POSTGRES_URL', 'NEON_DATABASE_URL', 'AUTH_SECRET'];
  const saved = new Map<string, string | undefined>();
  for (const key of keys) saved.set(key, process.env[key]);

  for (const key of keys) {
    const value = key in values ? values[key] : saved.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }

  return () => {
    for (const key of keys) {
      const value = saved.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
}

test('normalizePeriod приводит месяц к первому числу', () => {
  assert.equal(normalizePeriod('2026-10'), '2026-10-01');
  assert.equal(normalizePeriod('2026-10-15'), '2026-10-01');
  assert.equal(normalizePeriod(' 2026-01 '), '2026-01-01');
  assert.equal(normalizePeriod('2026-13'), null);
  assert.equal(normalizePeriod('2026-00'), null);
  assert.equal(normalizePeriod('26-10'), null);
  assert.equal(normalizePeriod(''), null);
});

test('blgForHours: 1 BLG за целый час, дробь вниз', () => {
  assert.equal(blgForHours(0.5), 0);
  assert.equal(blgForHours(0.99), 0);
  assert.equal(blgForHours(1), 1);
  assert.equal(blgForHours(1.99), 1);
  assert.equal(blgForHours(2), 2);
  assert.equal(blgForHours(2.0000000001), 2);
  assert.equal(blgForHours(744), 744);
  assert.equal(blgForHours(-1), 0);
  assert.equal(blgForHours(Number.NaN), 0);
});

test('GET /api/attestations без БД отвечает 503', async () => {
  const restore = withEnv({
    DATABASE_URL: undefined,
    POSTGRES_URL: undefined,
    NEON_DATABASE_URL: undefined,
  });
  try {
    const res = await call(attestations as unknown as Handler, 'GET', { org: '1' });
    assert.equal(res.statusCode, 503);
  } finally {
    restore();
  }
});

test('POST /api/attestations без сессии отвечает 401 (БД настроена)', async () => {
  const restore = withEnv({
    DATABASE_URL: 'postgres://user:pass@localhost:5432/db',
    AUTH_SECRET: 'test-secret-0123456789abcdef',
  });
  try {
    const res = await call(attestations as unknown as Handler, 'POST', {}, {
      orgId: 1,
      volunteerId: 2,
      wallet: ADDRESS,
      period: '2026-10',
      hours: 3,
    });
    assert.equal(res.statusCode, 401);
  } finally {
    restore();
  }
});

test('POST /api/attestations без БД отвечает 503', async () => {
  const restore = withEnv({
    DATABASE_URL: undefined,
    POSTGRES_URL: undefined,
    NEON_DATABASE_URL: undefined,
  });
  try {
    const res = await call(attestations as unknown as Handler, 'POST');
    assert.equal(res.statusCode, 503);
  } finally {
    restore();
  }
});

test('POST /api/bind с сессией без БД отвечает 503', async () => {
  const restore = withEnv({
    DATABASE_URL: undefined,
    POSTGRES_URL: undefined,
    NEON_DATABASE_URL: undefined,
    AUTH_SECRET: 'test-secret-0123456789abcdef',
  });
  try {
    const session = createSession(ADDRESS);
    const res = await call(
      bind as unknown as Handler,
      'POST',
      {},
      { orgId: 10072836, dao: ADDRESS },
      { authorization: `Bearer ${session.token}` },
    );
    assert.equal(res.statusCode, 503);
  } finally {
    restore();
  }
});

test('attestations: OPTIONS и неподдерживаемый метод', async () => {
  const options = await call(attestations as unknown as Handler, 'OPTIONS');
  assert.equal(options.statusCode, 204);

  const restore = withEnv({ DATABASE_URL: 'postgres://x', AUTH_SECRET: 'test-secret-0123456789abcdef' });
  try {
    const put = await call(attestations as unknown as Handler, 'PUT');
    assert.equal(put.statusCode, 405);
  } finally {
    restore();
  }
});
