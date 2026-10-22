/**
 * Stateless-аутентификация по кошельку TON.
 *
 *   challenge = v1.<base64url({k:"challenge", wallet, exp, n})>.<hmac>
 *   session   = v1.<base64url({k:"session",   wallet, exp, n})>.<hmac>
 *
 * HMAC-SHA256 на AUTH_SECRET. Сервер ничего не хранит, поэтому схема
 * переживает холодные старты и несколько инстансов Vercel.
 *
 * Ограничение: challenge нельзя погасить досрочно (stateless), поэтому
 * окно повтора ограничено timestamp-проверкой ton_proof (±5 минут)
 * и временем жизни challenge (10 минут).
 */

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

import { normalizeTonAddress, sameTonAddress } from './ton.ts';

export const CHALLENGE_TTL_MS = 10 * 60 * 1000;
export const SESSION_TTL_MS = 60 * 60 * 1000;
/** Допустимое расхождение часов клиента и сервера для ton_proof. */
export const PROOF_MAX_AGE_SEC = 5 * 60;

const VERSION = 'v1';

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
  n: string;
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

function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64url');
}

function sign(body: string): string {
  return createHmac('sha256', secret()).update(`${VERSION}.${body}`).digest('base64url');
}

function issue(body: TokenBody): string {
  const encoded = base64url(JSON.stringify(body));
  return `${VERSION}.${encoded}.${sign(encoded)}`;
}

function parse(token: string, kind: TokenBody['k']): TokenBody {
  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== VERSION) {
    throw new AuthError('Некорректный токен');
  }

  const [, encoded, signature] = parts as [string, string, string];
  const expected = sign(encoded);
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    throw new AuthError('Подпись токена неверна');
  }

  let body: TokenBody;
  try {
    body = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as TokenBody;
  } catch {
    throw new AuthError('Некорректный токен');
  }

  if (!body || body.k !== kind || typeof body.wallet !== 'string' || typeof body.exp !== 'number') {
    throw new AuthError('Некорректный токен');
  }
  if (body.exp <= Date.now()) {
    throw new AuthError('Токен истёк');
  }

  return body;
}

export function createChallenge(wallet: string, opts: { ttlMs?: number } = {}): IssuedToken {
  const canonical = normalizeTonAddress(wallet);
  if (!canonical) throw new AuthError('Некорректный адрес кошелька', 400);

  const exp = Date.now() + (opts.ttlMs ?? CHALLENGE_TTL_MS);
  const token = issue({ k: 'challenge', wallet: canonical, exp, n: randomBytes(16).toString('hex') });
  return { token, wallet: canonical, expiresAt: new Date(exp).toISOString() };
}

/** payload из ton_proof должен быть выдан нами и относиться к тому же кошельку. */
export function verifyChallenge(payload: string, wallet: string): void {
  const body = parse(payload, 'challenge');
  if (!sameTonAddress(body.wallet, wallet)) {
    throw new AuthError('Challenge выдан для другого кошелька');
  }
}

export function createSession(wallet: string, opts: { ttlMs?: number } = {}): IssuedToken {
  const canonical = normalizeTonAddress(wallet);
  if (!canonical) throw new AuthError('Некорректный адрес кошелька', 400);

  const exp = Date.now() + (opts.ttlMs ?? SESSION_TTL_MS);
  const token = issue({ k: 'session', wallet: canonical, exp, n: randomBytes(16).toString('hex') });
  return { token, wallet: canonical, expiresAt: new Date(exp).toISOString() };
}

export function verifySession(token: string): IssuedToken {
  const body = parse(token, 'session');
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
