/**
 * Stateless-аутентификация по кошельку TON.
 *
 *   token = v1.<base64url(body)>.<base64url(hmac16)>
 *   body  = version(1) | kind(1) | workchain(1) | addressHash(32) | expSec(4) | nonce(8)
 *
 * Компактный бинарный формат: payload уходит в TON Connect `ton_proof`,
 * а протокол разрешает не более 128 байт на payload. Токен — 89 байт.
 * HMAC-SHA256 усечён до 16 байт (128 бит).
 *
 * Сервер ничего не хранит, поэтому схема переживает холодные старты и
 * несколько инстансов. Ограничение: challenge нельзя погасить досрочно
 * (stateless), поэтому окно повтора ограничено timestamp-проверкой
 * ton_proof (±5 минут) и временем жизни challenge (10 минут).
 */

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

import { Address } from '@ton/core';

import { parseTonAddress } from './ton.ts';

export const CHALLENGE_TTL_MS = 10 * 60 * 1000;
export const SESSION_TTL_MS = 60 * 60 * 1000;
/** Допустимое расхождение часов клиента и сервера для ton_proof. */
export const PROOF_MAX_AGE_SEC = 5 * 60;
/** Лимит TON Connect на payload в ton_proof. */
export const MAX_TON_PROOF_PAYLOAD_BYTES = 128;

const VERSION = 'v1';
const BODY_VERSION = 1;
const KINDS = { challenge: 1, session: 2 } as const;
const BODY_BYTES = 1 + 1 + 1 + 32 + 4 + 8;
const HMAC_BYTES = 16;

export class AuthError extends Error {
  readonly status: number;

  constructor(message: string, status = 401) {
    super(message);
    this.name = 'AuthError';
    this.status = status;
  }
}

interface TokenBody {
  k: 'challenge' | 'session';
  wallet: string;
  exp: number;
}

export interface IssuedToken {
  token: string;
  wallet: string;
  expiresAt: string;
}

function secret(): string {
  const value = process.env.AUTH_SECRET ?? '';
  if (value.trim().length < 16) {
    throw new AuthError(
      'AUTH_SECRET не задан или короче 16 символов: задайте его в переменных окружения',
      503,
    );
  }
  return value;
}

function hmac(encoded: string): string {
  return createHmac('sha256', secret())
    .update(`${VERSION}.${encoded}`)
    .digest()
    .subarray(0, HMAC_BYTES)
    .toString('base64url');
}

function encodeBody(kind: TokenBody['k'], wallet: string, expMs: number): string {
  const address = parseTonAddress(wallet);
  if (!address) throw new AuthError('Некорректный адрес кошелька', 400);

  const body = Buffer.alloc(BODY_BYTES);
  body[0] = BODY_VERSION;
  body[1] = KINDS[kind];
  body.writeInt8(address.workChain, 2);
  address.hash.copy(body, 3);
  body.writeUInt32BE(Math.floor(expMs / 1000), 35);
  randomBytes(8).copy(body, 39);
  return body.toString('base64url');
}

function issue(kind: TokenBody['k'], wallet: string, expMs: number): string {
  const encoded = encodeBody(kind, wallet, expMs);
  return `${VERSION}.${encoded}.${hmac(encoded)}`;
}

function parseToken(token: string, kind: TokenBody['k']): TokenBody {
  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== VERSION) {
    throw new AuthError('Некорректный токен');
  }

  const [, encoded, signature] = parts as [string, string, string];
  const expected = hmac(encoded);
  const actualBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expected);
  if (
    actualBuffer.length !== expectedBuffer.length ||
    !timingSafeEqual(actualBuffer, expectedBuffer)
  ) {
    throw new AuthError('Подпись токена неверна');
  }

  const body = Buffer.from(encoded, 'base64url');
  if (body.length !== BODY_BYTES || body[0] !== BODY_VERSION || body[1] !== KINDS[kind]) {
    throw new AuthError('Некорректный токен');
  }

  const workchain = body.readInt8(2);
  const hash = body.subarray(3, 35);
  const exp = body.readUInt32BE(35) * 1000;

  if (exp <= Date.now()) {
    throw new AuthError('Токен истёк');
  }

  const wallet = new Address(workchain, Buffer.from(hash)).toString({
    bounceable: true,
    urlSafe: true,
  });
  return { k: kind, wallet, exp };
}

function issued(kind: TokenBody['k'], wallet: string, expMs: number): IssuedToken {
  const address = parseTonAddress(wallet);
  if (!address) throw new AuthError('Некорректный адрес кошелька', 400);
  const token = issue(kind, address.toString({ bounceable: true, urlSafe: true }), expMs);
  return {
    token,
    wallet: address.toString({ bounceable: true, urlSafe: true }),
    expiresAt: new Date(Math.floor(expMs / 1000) * 1000).toISOString(),
  };
}

export function createChallenge(wallet: string, opts: { ttlMs?: number } = {}): IssuedToken {
  const result = issued('challenge', wallet, Date.now() + (opts.ttlMs ?? CHALLENGE_TTL_MS));
  if (Buffer.byteLength(result.token, 'utf8') > MAX_TON_PROOF_PAYLOAD_BYTES) {
    throw new AuthError('Challenge длиннее лимита ton_proof', 500);
  }
  return result;
}

/** payload из ton_proof должен быть выдан нами и относиться к тому же кошельку. */
export function verifyChallenge(payload: string, wallet: string): void {
  const body = parseToken(payload, 'challenge');
  const address = parseTonAddress(wallet);
  const expected = parseTonAddress(body.wallet);
  if (!address || !expected || !address.equals(expected)) {
    throw new AuthError('Challenge выдан для другого кошелька');
  }
}

export function createSession(wallet: string, opts: { ttlMs?: number } = {}): IssuedToken {
  return issued('session', wallet, Date.now() + (opts.ttlMs ?? SESSION_TTL_MS));
}

export function verifySession(token: string): IssuedToken {
  const body = parseToken(token, 'session');
  return { token, wallet: body.wallet, expiresAt: new Date(body.exp).toISOString() };
}

/** Bearer-токен из заголовка Authorization. */
export function bearerToken(header: string | string[] | undefined): string | null {
  const value = Array.isArray(header) ? header[0] : header;
  if (!value) return null;
  const match = value.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() || null;
}

export function requireSession(header: string | string[] | undefined): IssuedToken {
  const token = bearerToken(header);
  if (!token) throw new AuthError('Нужен заголовок Authorization: Bearer <session>');
  return verifySession(token);
}
