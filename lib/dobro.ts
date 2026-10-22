/**
 * Клиент публичного API dobro.ru.
 *
 * Используются только открытые (не требующие авторизации) эндпоинты,
 * которые сам портал вызывает для рендера страниц:
 *
 *   GET /api/v2/organizers/search?query=&limit=&page=
 *       -> поиск организаторов. В ответе `remoteId` = id организации,
 *          `name` = название, `fullName` = полное наименование,
 *          `location.title` = адрес, `statistic` = рейтинг/волонтёры.
 *
 *   GET /api/v2/organizations/{id}?with=organizer
 *       -> карточка организации. `organizer.statistic.hours` — это и есть
 *          блок «Часы» (количество зарегистрированных часов на портале),
 *          `organizer.statistic.volunteersWithHoursCount` — волонтёры с часами,
 *          `organizer.statistic.organizerRating` / `organizerRatingCount` — рейтинг,
 *          `results` — блок «Результаты».
 *
 *   GET /api/v2/analytics/get[?country=&region=&year=]
 *       -> сводка по всей платформе: `statistics.hours`,
 *          `statistics.verifiedHours`, `statistics.organizers` и т.д.
 *
 *   GET /organizations/{id}/info  (SSR)
 *       -> нужен только ради `placeInRatings` (места в рейтингах),
 *          которых нет в публичном API.
 */

export const DOBRO_ORIGIN = 'https://dobro.ru';

const USER_AGENT =
  'dobro-hours-bot/1.0 (Vercel PoC; +https://github.com/; contact: set-me@example.com)';

const DEFAULT_TIMEOUT_MS = 12_000;

export class DobroError extends Error {
  readonly status?: number;

  constructor(message: string, status?: number) {
    super(message);
    this.name = 'DobroError';
    this.status = status;
  }
}

interface FetchOptions {
  timeoutMs?: number;
  retries?: number;
  accept?: string;
}

/** GET c JSON c retry c backoff. */
export async function dobroGet<T>(path: string, opts: FetchOptions = {}): Promise<T> {
  const { timeoutMs = DEFAULT_TIMEOUT_MS, retries = 2, accept = 'application/json' } = opts;
  const url = path.startsWith('http') ? path : `${DOBRO_ORIGIN}${path}`;

  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, {
        headers: {
          Accept: accept,
          'Accept-Language': 'ru-RU,ru;q=0.9',
          'User-Agent': USER_AGENT,
        },
        signal: AbortSignal.timeout(timeoutMs),
        redirect: 'follow',
      });

      if (res.status === 404) {
        throw new DobroError(`Dobro API: 404 ${path}`, 404);
      }
      if (!res.ok) {
        throw new DobroError(`Dobro API: HTTP ${res.status} ${path}`, res.status);
      }

      const text = await res.text();
      if (!text.trim()) {
        throw new DobroError(`Dobro API: пустой ответ ${path}`);
      }
      return JSON.parse(text) as T;
    } catch (err) {
      lastError = err;
      // 404 и 4xx повторять бессмысленно.
      if (err instanceof DobroError && err.status && err.status < 500) throw err;
      if (attempt < retries) {
        await sleep(400 * 2 ** attempt);
      }
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new DobroError(`Dobro API: неизвестная ошибка для ${path}`);
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/* ------------------------------------------------------------------ */
/* Типы                                                                */
/* ------------------------------------------------------------------ */

export interface OrganizerSearchHit {
  id: number;
  remoteId: number | null;
  name: string | null;
  fullName: string | null;
  location?: { title?: string | null } | null;
  verified?: boolean | null;
  verifiedByEsia?: boolean | null;
  type?: string | null;
  statistic?: {
    volunteersCount?: number | null;
    organizerRating?: number | null;
    organizerRatingCount?: number | null;
  } | null;
}

export interface OrganizerStatistic {
  eventsCount?: number | null;
  projectsCount?: number | null;
  volunteersCount?: number | null;
  organizerRating?: number | null;
  organizerRatingCount?: number | null;
  assistantsCount?: number | null;
  vacanciesCount?: number | null;
  acceptedVacancyRequestsCount?: number | null;
  volunteersWithHoursCount?: number | null;
  /** «Часы» — количество зарегистрированных часов на портале. */
  hours?: number | null;
}

export interface OrganizationDetail {
  id: number;
  name: string | null;
  shortDescription?: string | null;
  description?: string | null;
  /** «Результаты» — свободный текст, заполняемый организатором. */
  results?: string | null;
  verified?: boolean | null;
  leader?: { firstName?: string | null; lastName?: string | null } | null;
  settlement?: { shortName?: string | null; regionName?: string | null } | null;
  organizer?: { id?: number | null; statistic?: OrganizerStatistic | null } | null;
}

export interface PlatformStatistics {
  hours: number;
  verifiedHours: number;
  volunteers: number;
  events: number;
  vacancies: number;
  projects: number;
  organizers: number;
  activeVacancies: number;
  averageAge?: number | null;
  genderPercentage?: Record<string, number> | null;
}

export interface PlaceInRatings {
  year?: { all?: number | null; region?: number | null };
  all?: { all?: number | null; region?: number | null };
}

/* ------------------------------------------------------------------ */
/* Эндпоинты                                                           */
/* ------------------------------------------------------------------ */

export async function searchOrganizations(
  query: string,
  opts: { limit?: number; page?: number; signal?: AbortSignal } = {},
): Promise<OrganizerSearchHit[]> {
  const { limit = 10, page = 1 } = opts;
  const params = new URLSearchParams({
    query,
    limit: String(Math.min(Math.max(limit, 1), 50)),
    page: String(Math.max(page, 1)),
  });

  const data = await dobroGet<OrganizerSearchHit[] | { 'hydra:member': OrganizerSearchHit[] }>(
    `/api/v2/organizers/search?${params.toString()}`,
  );

  if (Array.isArray(data)) return data;
  if (data && Array.isArray((data as { 'hydra:member': OrganizerSearchHit[] })['hydra:member'])) {
    return (data as { 'hydra:member': OrganizerSearchHit[] })['hydra:member'];
  }
  return [];
}

export async function getOrganization(
  id: number,
  opts: { withPlaceInRatings?: boolean } = {},
): Promise<OrganizationDetail & { placeInRatings?: PlaceInRatings | null }> {
  const detail = await dobroGet<OrganizationDetail>(
    `/api/v2/organizations/${id}?with=organizer`,
  );

  if (!opts.withPlaceInRatings) return detail;

  // placeInRatings отдаётся только серверным рендером страницы организации.
  try {
    const rankings = await getPlaceInRatings(id);
    return { ...detail, placeInRatings: rankings };
  } catch {
    return { ...detail, placeInRatings: null };
  }
}

/** Места в рейтингах — парсится из __NEXT_DATA__ страницы «Информация». */
export async function getPlaceInRatings(id: number): Promise<PlaceInRatings | null> {
  const res = await fetch(`${DOBRO_ORIGIN}/organizations/${id}/info`, {
    headers: {
      Accept: 'text/html',
      'Accept-Language': 'ru-RU,ru;q=0.9',
      'User-Agent': USER_AGENT,
    },
    signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
    redirect: 'follow',
  });

  if (!res.ok) throw new DobroError(`Dobro SSR: HTTP ${res.status}`, res.status);

  const html = await res.text();
  const match = html.match(
    /<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/,
  );
  if (!match) return null;

  const parsed = JSON.parse(match[1]) as {
    props?: { pageProps?: { organization?: { placeInRatings?: PlaceInRatings | null } } };
  };
  return parsed?.props?.pageProps?.organization?.placeInRatings ?? null;
}

export async function getPlatformStatistics(
  filters: { country?: string; region?: number | string; year?: number | string } = {},
): Promise<PlatformStatistics> {
  const params = new URLSearchParams();
  if (filters.country) params.set('country', filters.country);
  if (filters.region != null && filters.region !== '') params.set('region', String(filters.region));
  if (filters.year != null && filters.year !== '') params.set('year', String(filters.year));

  const suffix = params.toString() ? `?${params.toString()}` : '';
  const data = await dobroGet<{ statistics: Record<string, unknown> }>(
    `/api/v2/analytics/get${suffix}`,
  );
  const s = data.statistics ?? {};

  return {
    hours: Number(s.hours ?? 0),
    verifiedHours: Number(s.verifiedHours ?? 0),
    volunteers: Number(s.volunteers ?? 0),
    events: Number(s.events ?? 0),
    vacancies: Number(s.vacancies ?? 0),
    projects: Number(s.projects ?? 0),
    organizers: Number(s.organizers ?? 0),
    activeVacancies: Number(s.activeVacancies ?? 0),
    averageAge: s.averageAge == null ? null : Number(s.averageAge),
    genderPercentage: (s.genderPercentage as Record<string, number>) ?? null,
  };
}
