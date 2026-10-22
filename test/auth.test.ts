/**
 * TON Connect ton_proof: проверка подписи, challenge и сессии.
 * Сеть не нужна — публичный ключ кошелька подменяется моком tonapi.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { keyPairFromSeed, sign } from '@ton/crypto';

import authChallenge from '../api/auth-challenge.ts';
import authMe from '../api/auth-me.ts';
import authVerify from '../api/auth-verify.ts';
import {
  AuthError,
  createChallenge,
  createSession,
  verifyChallenge,
  verifySession,
} from '../lib/auth.ts';
import { tonProofDigest, verifyTonProofSignature } from '../lib/tonproof.ts';

const ADDRESS = 'EQDExlp6EjkVN-OJ1ZcGLEYlITaold5ytBP3e8g6g_BIRaZX';
const DOMAIN = 'example.test';

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
  body?: unknown,
  headers: Record<string, string> = {},
) {
  const res = mockRes();
  await handler({ method, query: {}, body, headers }, res);
  return res;
}

function withEnv(values: Record<string, string | undefined>) {
  const saved = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(values)) {
    saved.set(key, process.env[key]);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  return () => {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
}

const SEED = Buffer.alloc(32, 7);
const KEY = keyPairFromSeed(SEED);

test('ton_proof: подпись проверяется и ломается при изменении payload', () => {
  const proof = {
    address: ADDRESS,
    domain: DOMAIN,
    timestamp: 1_730_000_000,
    payload: 'nonce-123',
  };
  const signature = sign(tonProofDigest(proof), KEY.secretKey);

  assert.equal(verifyTonProofSignature(proof, signature, KEY.publicKey), true);
  assert.equal(
    verifyTonProofSignature({ ...proof, payload: 'nonce-456' }, signature, KEY.publicKey),
    false,
  );
  assert.equal(
    verifyTonProofSignature({ ...proof, domain: 'evil.test' }, signature, KEY.publicKey),
    false,
  );

  const other = keyPairFromSeed(Buffer.alloc(32, 8));
  assert.equal(verifyTonProofSignature(proof, signature, other.publicKey), false);
  assert.equal(verifyTonProofSignature(proof, Buffer.alloc(63), KEY.publicKey), false);
});

test('challenge и сессия подписаны и привязаны к кошельку', () => {
  const restore = withEnv({ AUTH_SECRET: 'test-secret-0123456789abcdef' });
  try {
    const challenge = createChallenge(ADDRESS);
    verifyChallenge(challenge.token, ADDRESS);

    const other = 'EQBlaryI1HCY6hIlW9giBoqKGtuMHfxlULZOhD6UyzpqLcll';
    assert.throws(() => verifyChallenge(challenge.token, other), AuthError);

    const session = createSession(ADDRESS);
    assert.equal(verifySession(session.token).wallet, ADDRESS);
    assert.equal(verifySession(session.token).expiresAt, session.expiresAt);

    const expired = createChallenge(ADDRESS, { ttlMs: -1 });
    assert.throws(() => verifyChallenge(expired.token, ADDRESS), /истёк/);

    assert.throws(() => createChallenge('EQbroken'), AuthError);
  } finally {
    restore();
  }
});

test('без AUTH_SECRET auth отвечает 503', () => {
  const restore = withEnv({ AUTH_SECRET: undefined });
  try {
    assert.throws(
      () => createChallenge(ADDRESS),
      (err: unknown) => err instanceof AuthError && err.status === 503,
    );
  } finally {
    restore();
  }
});

test('полный вход: challenge -> ton_proof -> session -> /api/auth-me', async () => {
  const restore = withEnv({
    AUTH_SECRET: 'test-secret-0123456789abcdef',
    AUTH_DOMAIN: DOMAIN,
  });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: unknown) => {
    const url = String(input);
    if (!url.includes('/methods/get_public_key')) {
      throw new Error(`неожиданный fetch: ${url}`);
    }
    return new Response(
      JSON.stringify({ stack: [{ type: 'num', num: `0x${KEY.publicKey.toString('hex')}` }] }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  }) as typeof fetch;

  try {
    const challengeRes = await call(authChallenge as unknown as Handler, 'POST', {
      wallet: ADDRESS,
    });
    assert.equal(challengeRes.statusCode, 200);
    const { payload } = challengeRes.body as { payload: string };

    const timestamp = Math.floor(Date.now() / 1000);
    const proof = { address: ADDRESS, domain: DOMAIN, timestamp, payload };
    const signature = sign(tonProofDigest(proof), KEY.secretKey).toString('base64');

    const verifyRes = await call(authVerify as unknown as Handler, 'POST', {
      address: ADDRESS,
      proof: { timestamp, domain: DOMAIN, payload, signature },
    });
    assert.equal(verifyRes.statusCode, 200);
    const { token } = verifyRes.body as { token: string };

    const meRes = await call(authMe as unknown as Handler, 'GET', undefined, {
      authorization: `Bearer ${token}`,
    });
    assert.equal(meRes.statusCode, 200);
    assert.equal((meRes.body as { wallet: string }).wallet, ADDRESS);

    const badRes = await call(authVerify as unknown as Handler, 'POST', {
      address: ADDRESS,
      proof: {
        timestamp,
        domain: DOMAIN,
        payload,
        signature: Buffer.alloc(64, 1).toString('base64'),
      },
    });
    assert.equal(badRes.statusCode, 401);

    const wrongDomain = await call(authVerify as unknown as Handler, 'POST', {
      address: ADDRESS,
      proof: { timestamp, domain: 'evil.test', payload, signature },
    });
    assert.equal(wrongDomain.statusCode, 401);
  } finally {
    globalThis.fetch = originalFetch;
    restore();
  }
});

test('auth: некорректный кошелёк и методы', async () => {
  const restore = withEnv({ AUTH_SECRET: 'test-secret-0123456789abcdef' });
  try {
    const bad = await call(authChallenge as unknown as Handler, 'POST', { wallet: 'EQbroken' });
    assert.equal(bad.statusCode, 400);

    const options = await call(authVerify as unknown as Handler, 'OPTIONS');
    assert.equal(options.statusCode, 204);

    const get = await call(authChallenge as unknown as Handler, 'GET');
    assert.equal(get.statusCode, 405);
  } finally {
    restore();
  }
});
