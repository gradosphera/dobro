/**
 * GET /api/auth-me с заголовком `Authorization: Bearer <session>`
 * отдаёт кошелёк и срок действия сессии. Используется фронтендом,
 * чтобы понять, что сессия ещё жива.
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';

import { AuthError, requireSession } from '../lib/auth.ts';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');

  if (req.method === 'OPTIONS') {
    res.setHeader('Allow', 'GET, OPTIONS');
    return res.status(204).end();
  }
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET, OPTIONS');
    return res.status(405).json({ error: 'Метод не поддерживается' });
  }

  try {
    const session = requireSession(req.headers.authorization);
    return res.status(200).json({ wallet: session.wallet, expiresAt: session.expiresAt });
  } catch (err) {
    const status = err instanceof AuthError ? err.status : 401;
    return res.status(status).json({ error: err instanceof Error ? err.message : 'Ошибка' });
  }
}
