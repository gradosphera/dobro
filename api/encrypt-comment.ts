/**
 * POST /api/encrypt-comment — шифрует текстовый комментарий для on-chain отправки.
 *
 * Требует сессию (Bearer) и использует sender private key из env vars.
 * Получает recipient public key через toncenter API.
 *
 * Body:
 *   { recipient: string, comment: string }
 *
 * Response:
 *   { payload: string }  // base64-encoded BOC с op=0x2167da4b
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';

import { Address } from '@ton/core';

import { requireSession } from '../lib/auth.ts';
import { isDbConfigured } from '../lib/db.ts';
import {
  encryptedCommentPayload,
  toFriendlyAddress,
} from '../lib/ton-comment.ts';
import { getRecipientPublicKey, TonError } from '../lib/ton.ts';

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

  if (!isDbConfigured()) {
    return res.status(503).json({
      error: 'DATABASE_URL не задан: требуется авторизация',
      hint: 'Подключите Neon и выполните npm run db:migrate',
    });
  }

  // Auth
  let session: ReturnType<typeof requireSession>;
  try {
    session = requireSession(req.headers.authorization);
  } catch (err) {
    const status = err instanceof TonError ? err.status ?? 401 : 401;
    return res.status(status).json({ error: err instanceof Error ? err.message : 'Нужна сессия' });
  }

  const data = body(req);
  const recipient = String(data.recipient ?? '');
  const comment = String(data.comment ?? '');

  if (!recipient) {
    return res.status(400).json({ error: 'Укажите recipient (адрес TON)' });
  }
  if (!comment) {
    return res.status(400).json({ error: 'Укажите comment (текст для шифрования)' });
  }

  // Sender private key from env
  const senderPrivateKey = process.env.TON_PRIVATE_KEY ?? process.env.SENDER_PRIVATE_KEY;
  if (!senderPrivateKey) {
    return res.status(500).json({
      error: 'TON_PRIVATE_KEY не задан в env vars',
    });
  }

  // Convert sender private key (hex string) to Buffer
  let senderSeed: Buffer;
  try {
    senderSeed = Buffer.from(senderPrivateKey.replace(/^0x/, ''), 'hex');
  } catch {
    return res.status(400).json({ error: 'TON_PRIVATE_KEY должен быть hex-строкой' });
  }

  if (senderSeed.length !== 32) {
    return res.status(400).json({ error: 'TON_PRIVATE_KEY должен быть 32 байта' });
  }

  // Sender address from session
  const senderAddress = toFriendlyAddress(session.wallet);

  try {
    // Get recipient public key via toncenter API
    const recipientPublicKeyHex = await getRecipientPublicKey(recipient, {
      timeoutMs: 10_000,
      retries: 2,
    });

    if (!recipientPublicKeyHex) {
      return res.status(404).json({
        error: 'Не удалось получить public key получателя',
        hint: 'Адрес может быть не инициализирован или toncenter API недоступен',
      });
    }

    const recipientPublicKey = Buffer.from(recipientPublicKeyHex, 'hex');

    // Encrypt
    const payload = await encryptedCommentPayload({
      senderPrivateSeed: senderSeed,
      senderAddress: Address.parse(session.wallet),
      recipientPublicKey,
      comment,
    });

    return res.status(200).json({ payload });
  } catch (err) {
    if (err instanceof TonError) {
      return res.status(err.status ?? 502).json({ error: err.message });
    }
    const message = err instanceof Error ? err.message : 'Неизвестная ошибка';
    return res.status(502).json({ error: message });
  }
}
