/**
 * POST /api/auth-verify
 *
 * Проверяет TON Connect `tonProof` и выдаёт сессию (Bearer-токен).
 *
 * Тело:
 * {
 *   "address": "EQ…",
 *   "proof": {
 *     "timestamp": 1730000000,
 *     "domain": "example.com",
 *     "payload": "<из /api/auth-challenge>",
 *     "signature": "<base64>"
 *   }
 * }
 *
 * Публичный ключ всегда берётся из контракта кошелька (tonapi), а не из
 * тела запроса. Домен сверяется с AUTH_DOMAIN (или Host запроса).
 * Окно валидности timestamp — ±5 минут.
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';

import {
  AuthError,
  PROOF_MAX_AGE_SEC,
  createSession,
  verifyChallenge,
} from '../lib/auth.ts';
import {
  MAX_PAYLOAD_BYTES,
  TonProofError,
  getWalletPublicKey,
  parseProofDomain,
  verifyTonProofSignature,
} from '../lib/tonproof.ts';
import { normalizeTonAddress } from '../lib/ton.ts';

function body(req: VercelRequest): Record<string, unknown> {
  const raw = req.body as unknown;
  if (!raw) return {};
  if (typeof raw === 'string') {
    try {
      return JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return {};
    }
  }
  return raw as Record<string, unknown>;
}

function normalizeDomain(value: string): string {
  return value.trim().toLowerCase();
}

function allowedNetworks(): string[] {
  const fromEnv = (process.env.AUTH_NETWORKS ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
  return fromEnv.length > 0 ? fromEnv : ['-239'];
}

function expectedDomains(req: VercelRequest): string[] {
  const fromEnv = (process.env.AUTH_DOMAIN ?? '')
    .split(',')
    .map(normalizeDomain)
    .filter(Boolean);
  if (fromEnv.length > 0) return fromEnv;

  const raw = req.headers['x-forwarded-host'] ?? req.headers.host ?? '';
  const host = Array.isArray(raw) ? raw[0] : raw;
  return host ? [normalizeDomain(host.split(',')[0] ?? '')] : [];
}

function decodeSignature(value: unknown): Buffer | null {
  if (typeof value !== 'string' || !value) return null;
  for (const encoding of ['base64', 'base64url'] as const) {
    try {
      const buffer = Buffer.from(value, encoding);
      if (buffer.length === 64) return buffer;
    } catch {
      // пробуем следующую кодировку
    }
  }
  return null;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');

  if (req.method === 'OPTIONS') {
    res.setHeader('Allow', 'POST, OPTIONS');
    return res.status(204).end();
  }
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST, OPTIONS');
    return res.status(405).json({ error: 'Метод не поддерживается' });
  }

  const data = body(req);
  const address = normalizeTonAddress(String(data.address ?? ''));
  if (!address) {
    return res.status(400).json({ error: 'Укажите корректный address' });
  }

  const network = String(data.network ?? '-239');
  if (!allowedNetworks().includes(network)) {
    return res.status(401).json({ error: `Сеть не поддерживается: ${network}` });
  }

  const proof = (data.proof ?? {}) as Record<string, unknown>;
  const timestamp = Number(proof.timestamp);
  const parsedDomain = parseProofDomain(proof.domain);
  const domain = parsedDomain ? normalizeDomain(parsedDomain.value) : '';
  const domainLength = parsedDomain?.lengthBytes ?? null;
  const payload = typeof proof.payload === 'string' ? proof.payload : '';
  const signature = decodeSignature(proof.signature);

  if (!Number.isFinite(timestamp) || timestamp <= 0) {
    return res.status(400).json({ error: 'В proof отсутствует корректный timestamp' });
  }
  if (!domain) {
    return res.status(400).json({ error: 'В proof отсутствует domain' });
  }
  if (!payload || Buffer.byteLength(payload, 'utf8') > MAX_PAYLOAD_BYTES) {
    return res.status(400).json({ error: 'В proof отсутствует корректный payload' });
  }
  if (domainLength !== null && Buffer.byteLength(domain, 'utf8') !== domainLength) {
    return res.status(400).json({ error: 'domain.lengthBytes не совпадает с domain' });
  }
  if (!signature) {
    return res.status(400).json({ error: 'В proof отсутствует корректная signature' });
  }

  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - timestamp) > PROOF_MAX_AGE_SEC) {
    return res.status(401).json({ error: 'Подпись устарела: обновите challenge и повторите' });
  }

  const allowedDomains = expectedDomains(req);
  if (allowedDomains.length === 0) {
    return res.status(400).json({ error: 'Не удалось определить домен для проверки подписи' });
  }
  if (!allowedDomains.includes(domain)) {
    return res.status(401).json({
      error: `Домен подписи не совпадает: ${domain}`,
      expected: allowedDomains,
    });
  }

  try {
    verifyChallenge(payload, address);
    const publicKey = await getWalletPublicKey(address);
    const ok = verifyTonProofSignature(
      { address, domain, domainLength: domainLength ?? undefined, timestamp, payload },
      signature,
      publicKey,
    );
    if (!ok) {
      return res.status(401).json({ error: 'Подпись ton_proof неверна' });
    }

    const session = createSession(address);
    return res.status(200).json({
      token: session.token,
      wallet: session.wallet,
      expiresAt: session.expiresAt,
    });
  } catch (err) {
    if (err instanceof AuthError) {
      return res.status(err.status).json({ error: err.message });
    }
    if (err instanceof TonProofError) {
      return res.status(err.status ?? 502).json({ error: err.message });
    }
    return res.status(502).json({
      error: err instanceof Error ? err.message : 'Не удалось проверить подпись',
    });
  }
}
