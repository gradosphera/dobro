/**
 * GET /api/total?country=RU&region=72&year=2025
 *
 * Сводка по всей платформе dobro.ru: общее число зарегистрированных
 * волонтёрских часов (и верифицированных часов) с разрезами
 * по стране, региону и году.
 *
 * Ответ всегда JSON, даже при сбое обращения к порталу.
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';

import { cached } from '../lib/cache.ts';
import { Deadline, DobroError, getPlatformStatistics } from '../lib/dobro.ts';

const TTL_MS = 15 * 60 * 1000;
const BUDGET_MS = 12_000;

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

  const country = req.query.country ? String(req.query.country) : undefined;
  const region = req.query.region ? String(req.query.region) : undefined;
  const year = req.query.year ? String(req.query.year) : undefined;

  const deadline = new Deadline(BUDGET_MS);

  try {
    const key = `analytics:${country ?? 'all'}:${region ?? 'all'}:${year ?? 'all'}`;
    const stats = await cached(key, TTL_MS, () =>
      getPlatformStatistics({ country, region, year }, deadline),
    );

    // Кэшируются только успешные ответы; ошибки уходят с no-store.
    res.setHeader('Cache-Control', 'public, max-age=60, s-maxage=600, stale-while-revalidate=600');

    return res.status(200).json({
      filters: { country: country ?? null, region: region ?? null, year: year ?? null },
      ...stats,
      verifiedHoursShare:
        stats.hours > 0 ? Number(((stats.verifiedHours / stats.hours) * 100).toFixed(1)) : 0,
      source: 'https://dobro.ru/api/v2/analytics/get',
      fetchedAt: new Date().toISOString(),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Неизвестная ошибка';
    const status = err instanceof DobroError && err.status ? err.status : 502;
    return res.status(status).json({
      error: message,
      hint: 'Возможно, адрес Vercel временно недоступен для dobro.ru — попробуйте позже.',
      fetchedAt: new Date().toISOString(),
    });
  }
}
