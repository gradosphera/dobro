/**
 * POST /api/auth-challenge { wallet }
 *
 * Выдаёт payload для TON Connect `tonProof`. Клиент передаёт его в
 * `tonConnectUI.connectWallet({ tonProof: payload })`, кошелёк подписывает
 * доказательство владения, а `/api/auth-verify` проверяет подпись.
 *
 * Payload — самодостаточный HMAC-токен: сервер не хранит nonce, поэтому
 * схема работает на нескольких инстансах Vercel.
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';

import { AuthError, createChallenge } from '../lib/auth.ts';

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

  const wallet = String(body(req).wallet ?? '').trim();
  if (!wallet) {
    return res.status(400).json({ error: 'Укажите кошелёк: { "wallet": "EQ…" }' });
  }

  try {
    const challenge = createChallenge(wallet);
    return res.status(200).json({
      wallet: challenge.wallet,
      /** Передать в tonProof как payload. */
      payload: challenge.token,
      expiresAt: challenge.expiresAt,
    });
  } catch (err) {
    const status = err instanceof AuthError ? err.status : 400;
    return res.status(status).json({ error: err instanceof Error ? err.message : 'Ошибка' });
  }
}
