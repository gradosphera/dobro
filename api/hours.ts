/**
 * GET /api/hours?q=<название организации>&limit=5&rankings=1
 *
 * Ищет организацию на dobro.ru и возвращает общее число зарегистрированных
 * волонтёрских часов из блока «Часы» карточки (вкладка «Информация»),
 * вместе с блоками «Рейтинг» и «Результаты».
 *
 * Дополнительно отдаёт сводку по всей платформе (общее число часов по всем
 * организациям dobro.ru) — это «общее» число в общем смысле.
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';

import { cached } from '../lib/cache.ts';
import {
  DobroError,
  getOrganization,
  getPlatformStatistics,
  searchOrganizations,
  sleep,
} from '../lib/dobro.ts';
import type { PlaceInRatings } from '../lib/dobro.ts';
import { preselectCandidates, rankResults } from '../lib/match.ts';

const SEARCH_LIMIT = 50;
const DETAIL_CANDIDATES = 8;
const CONCURRENCY = 4;
const SEARCH_TTL_MS = 5 * 60 * 1000;
const DETAIL_TTL_MS = 10 * 60 * 1000;
const ANALYTICS_TTL_MS = 15 * 60 * 1000;

interface OrgRow {
  id: number;
  name: string;
  fullName: string | null;
  location: string | null;
  verified: boolean;
  /** «Часы» — количество зарегистрированных часов на портале. */
  hours: number;
  volunteers: number;
  volunteersWithHours: number;
  /** «Рейтинг». */
  rating: number | null;
  ratingCount: number;
  placeInRatings: PlaceInRatings | null;
  /** «Результаты» — свободный текст организации. */
  results: string | null;
  description: string | null;
  settlement: string | null;
  url: string;
  score: number;
  reasons: string[];
}

/** Ограниченный по параллелизму map — чтобы не долбить портал пачками запросов. */
async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;

  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const index = cursor++;
      if (index >= items.length) return;
      results[index] = await fn(items[index] as T, index);
      // Небольшая пауза между запросами к одному хосту.
      await sleep(120);
    }
  });

  await Promise.all(workers);
  return results;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method === 'OPTIONS') {
    res.setHeader('Allow', 'GET, OPTIONS');
    return res.status(204).end();
  }
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET, OPTIONS');
    return res.status(405).json({ error: 'Метод не поддерживается' });
  }

  const query = String(req.query.q ?? '').trim();
  const limit = Math.min(Math.max(Number(req.query.limit ?? 5) || 5, 1), 10);
  const wantRankings = req.query.rankings === '1' || req.query.rankings === 'true';

  if (query.length < 2) {
    return res.status(400).json({ error: 'Укажите название организации: ?q=<название>' });
  }

  try {
    const [hits, platform] = await Promise.all([
      cached(`search:${query.toLowerCase()}`, SEARCH_TTL_MS, () =>
        searchOrganizations(query, { limit: SEARCH_LIMIT }),
      ),
      cached('analytics:all', ANALYTICS_TTL_MS, () => getPlatformStatistics()),
    ]);

    // Шаг 1: по названиям из выдачи отбираем кандидатов на загрузку карточек.
    const candidates = preselectCandidates(
      query,
      hits
        .filter((h) => typeof h.remoteId === 'number')
        .map((h) => ({
          name: h.name,
          fullName: h.fullName,
          location: h.location?.title ?? null,
          volunteers: h.statistic?.volunteersCount ?? 0,
          remoteId: h.remoteId as number,
        })),
      DETAIL_CANDIDATES,
    );

    // Шаг 2: загружаем карточки и достаём блоки «Часы» / «Рейтинг» / «Результаты».
    const details = await mapWithConcurrency(candidates, CONCURRENCY, async (candidate) => {
      const id = candidate.remoteId;
      try {
        const detail = await cached(`org:${id}`, DETAIL_TTL_MS, () =>
          getOrganization(id, { withPlaceInRatings: false }),
        );
        return { candidate, detail };
      } catch (err) {
        if (err instanceof DobroError && err.status === 404) return { candidate, detail: null };
        throw err;
      }
    });

    const rows: OrgRow[] = details
      .filter((d) => d.detail !== null)
      .map(({ candidate, detail }) => {
        const org = detail as NonNullable<typeof detail>;
        const stat = org.organizer?.statistic ?? {};

        return {
          id: org.id,
          name: org.name ?? candidate.name ?? '',
          fullName: candidate.fullName ?? null,
          location: candidate.location,
          verified: Boolean(org.verified),
          hours: Number(stat.hours ?? 0),
          volunteers: Number(stat.volunteersCount ?? 0),
          volunteersWithHours: Number(stat.volunteersWithHoursCount ?? 0),
          rating: stat.organizerRating == null ? null : Number(stat.organizerRating),
          ratingCount: Number(stat.organizerRatingCount ?? 0),
          placeInRatings: null,
          results: org.results ?? null,
          description: org.description ?? null,
          settlement: org.settlement?.shortName ?? null,
          url: `https://dobro.ru/organizations/${org.id}/info`,
          score: 0,
          reasons: [],
        };
      });

    // Шаг 3: итоговое ранжирование (уже с учётом числа часов).
    const ranked = rankResults(query, rows);
    const organizations = ranked.map(({ item, score, reasons }) => ({
      ...item,
      score: Number(score.toFixed(4)),
      reasons,
    }));

    // Места в рейтингах есть только в SSR-разметке — подтягиваем для лидеров.
    if (wantRankings && organizations.length > 0) {
      const leaders = organizations.slice(0, 3);
      const rankings = await mapWithConcurrency(leaders, 2, async (org) => {
        try {
          const detail = await cached(`org:${org.id}:rankings`, DETAIL_TTL_MS, () =>
            getOrganization(org.id, { withPlaceInRatings: true }),
          );
          return { id: org.id, placeInRatings: detail.placeInRatings ?? null };
        } catch {
          return { id: org.id, placeInRatings: null };
        }
      });
      const byId = new Map(rankings.map((r) => [r.id, r.placeInRatings]));
      for (const org of organizations) {
        org.placeInRatings = byId.get(org.id) ?? null;
      }
    }

    const top = organizations[0];
    const ambiguous =
      organizations.length > 1 &&
      Math.abs((organizations[0]?.score ?? 0) - (organizations[1]?.score ?? 0)) < 0.04;

    return res.status(200).json({
      query,
      /** Общее число зарегистрированных волонтёрских часов по всей платформе. */
      platformTotalHours: platform.hours,
      platformVerifiedHours: platform.verifiedHours,
      platformVerifiedHoursShare:
        platform.hours > 0 ? Number(((platform.verifiedHours / platform.hours) * 100).toFixed(1)) : 0,
      platformOrganizers: platform.organizers,
      platformVolunteers: platform.volunteers,
      /** Число часов по лучшему совпадению — главный ответ на запрос. */
      bestMatchHours: top?.hours ?? 0,
      bestMatchName: top?.name ?? null,
      bestMatchId: top?.id ?? null,
      ambiguous,
      organizations: organizations.slice(0, limit),
      organizationsFound: organizations.length,
      fetchedAt: new Date().toISOString(),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Неизвестная ошибка';
    const status = err instanceof DobroError && err.status ? err.status : 502;
    return res.status(status).json({ error: message, query });
  }
}
