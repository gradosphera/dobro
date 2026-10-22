/**
 * GET /api/hours?q=<название организации>&limit=5&rankings=1
 *
 * Ищет организацию на dobro.ru и возвращает общее число зарегистрированных
 * волонтёрских часов из блока «Часы» карточки (вкладка «Информация»),
 * вместе с блоками «Рейтинг» и «Результаты».
 *
 * Дополнительно отдаёт сводку по всей платформе (общее число часов по всем
 * организациям dobro.ru) — это «общее» число в общем смысле.
 *
 * Функция всегда отвечает JSON. Внутренний бюджет времени (BUDGET_MS) не даёт
 * инстансу Vercel быть убитым по maxDuration — вместо этого возвращаются
 * те данные, которые успели собраться.
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';

import { cached } from '../lib/cache.ts';
import {
  Deadline,
  DobroError,
  getOrganization,
  getPlatformStatistics,
  searchOrganizations,
  sleep,
} from '../lib/dobro.ts';
import type { PlaceInRatings } from '../lib/dobro.ts';
import { preselectCandidates, rankResults } from '../lib/match.ts';

/**
 * Общий бюджет времени на запрос. Должен быть меньше maxDuration из
 * vercel.json (10 c) — иначе платформа убьёт инстанс и отдаст 500 вместо
 * JSON. При исчерпании бюджета возвращаются те данные, что успели собраться.
 */
const BUDGET_MS = 7_000;
const SEARCH_LIMIT = 50;
const DEFAULT_DETAIL_CANDIDATES = 5;
const MAX_DETAIL_CANDIDATES = 8;
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

/** Ограниченный по параллелизму map с учётом общего бюджета времени. */
async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  deadline: Deadline,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;

  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const index = cursor++;
      if (index >= items.length) return;
      // Не начинаем новый запрос, если времени не хватает.
      if (deadline.expired) {
        results[index] = undefined as R;
        return;
      }
      try {
        results[index] = await fn(items[index] as T, index);
      } catch {
        results[index] = undefined as R;
      }
      // Небольшая пауза между запросами к одному хосту.
      await sleep(100);
    }
  });

  await Promise.all(workers);
  return results;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  // Любой ответ — только JSON, даже если что-то пошло не так.
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

  const query = String(req.query.q ?? '').trim();
  const limit = Math.min(Math.max(Number(req.query.limit ?? 5) || 5, 1), 10);
  const wantRankings = req.query.rankings === '1' || req.query.rankings === 'true';
  const detailCount = Math.min(
    Math.max(Number(req.query.detail ?? DEFAULT_DETAIL_CANDIDATES) || DEFAULT_DETAIL_CANDIDATES, 1),
    MAX_DETAIL_CANDIDATES,
  );

  if (query.length < 2) {
    return res.status(400).json({ error: 'Укажите название организации: ?q=<название>' });
  }

  const deadline = new Deadline(BUDGET_MS);

  try {
    const [hits, platform] = await Promise.all([
      cached(`search:${query.toLowerCase()}`, SEARCH_TTL_MS, () =>
        searchOrganizations(query, { limit: SEARCH_LIMIT, deadline }),
      ),
      cached('analytics:all', ANALYTICS_TTL_MS, () => getPlatformStatistics({}, deadline)).catch(
        () => null,
      ),
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
      detailCount,
    );

    // Шаг 2: загружаем карточки и достаём блоки «Часы» / «Рейтинг» / «Результаты».
    const details = await mapWithConcurrency(candidates, CONCURRENCY, deadline, async (candidate) => {
      const id = candidate.remoteId;
      const detail = await cached(`org:${id}`, DETAIL_TTL_MS, () =>
        getOrganization(id, { withPlaceInRatings: false, deadline }),
      );
      return { candidate, detail };
    });

    const rows: OrgRow[] = details
      .filter((d): d is { candidate: (typeof candidates)[number]; detail: NonNullable<typeof d.detail> } =>
        Boolean(d && d.detail),
      )
      .map(({ candidate, detail }) => {
        const stat = detail.organizer?.statistic ?? {};

        return {
          id: detail.id,
          name: detail.name ?? candidate.name ?? '',
          fullName: candidate.fullName ?? null,
          location: candidate.location,
          verified: Boolean(detail.verified),
          hours: Number(stat.hours ?? 0),
          volunteers: Number(stat.volunteersCount ?? 0),
          volunteersWithHours: Number(stat.volunteersWithHoursCount ?? 0),
          rating: stat.organizerRating == null ? null : Number(stat.organizerRating),
          ratingCount: Number(stat.organizerRatingCount ?? 0),
          placeInRatings: (detail.placeInRatings as PlaceInRatings | undefined) ?? null,
          results: detail.results ?? null,
          description: detail.description ?? null,
          settlement: detail.settlement?.shortName ?? null,
          url: `https://dobro.ru/organizations/${detail.id}/info`,
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
      const leaders = organizations.slice(0, 2);
      const rankings = await mapWithConcurrency(leaders, 2, deadline, async (org) => {
        const detail = await cached(`org:${org.id}:rankings`, DETAIL_TTL_MS, () =>
          getOrganization(org.id, { withPlaceInRatings: true, deadline }),
        );
        return { id: org.id, placeInRatings: (detail.placeInRatings ?? null) as PlaceInRatings | null };
      });
      const byId = new Map(rankings.filter(Boolean).map((r) => [r.id, r.placeInRatings]));
      for (const org of organizations) {
        org.placeInRatings = byId.get(org.id) ?? org.placeInRatings ?? null;
      }
    }

    const top = organizations[0];
    const ambiguous =
      organizations.length > 1 &&
      Math.abs((organizations[0]?.score ?? 0) - (organizations[1]?.score ?? 0)) < 0.04;

    // Кэшируются только успешные ответы; ошибки уходят с no-store.
    res.setHeader('Cache-Control', 'public, max-age=60, s-maxage=600, stale-while-revalidate=600');

    return res.status(200).json({
      query,
      /** Общее число зарегистрированных волонтёрских часов по всей платформе. */
      platformTotalHours: platform?.hours ?? null,
      platformVerifiedHours: platform?.verifiedHours ?? null,
      platformVerifiedHoursShare:
        platform && platform.hours > 0
          ? Number(((platform.verifiedHours / platform.hours) * 100).toFixed(1))
          : null,
      platformOrganizers: platform?.organizers ?? null,
      platformVolunteers: platform?.volunteers ?? null,
      /** Число часов по лучшему совпадению — главный ответ на запрос. */
      bestMatchHours: top?.hours ?? 0,
      bestMatchName: top?.name ?? null,
      bestMatchId: top?.id ?? null,
      ambiguous,
      organizations: organizations.slice(0, limit),
      organizationsFound: organizations.length,
      partial: deadline.expired,
      elapsedMs: BUDGET_MS - deadline.remainingMs,
      fetchedAt: new Date().toISOString(),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Неизвестная ошибка';
    const status = err instanceof DobroError && err.status ? err.status : 502;
    return res.status(status).json({
      error: message,
      query,
      hint:
        'Если ошибка повторяется: возможно, адрес Vercel заблокирован защитой dobro.ru. ' +
        'Укажите контакт для связи или используйте официальный запрос к Ассоциации «Добро.рф» (info@dobro.ru).',
      elapsedMs: BUDGET_MS - deadline.remainingMs,
    });
  }
}
