/**
 * Клиент публичного API dobro.ru + запасной путь через SSR-разметку.
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
 *       -> полная карточка в `__NEXT_DATA__`: часы, рейтинг, результаты
 *          и `placeInRatings` (мест в рейтингах в API нет вообще).
 *          Используется как запасной путь, если JSON-API недоступен.
 */

export const DOBRO_ORIGIN = 'https://dobro.ru';

const USER_AGENT =
  'dobro-hours-bot/1.0 (+https://github.com/gradosphera/dobro; contact: info@example.com)';

export const DEFAULT_TIMEOUT_MS = 7_000;
export const SSR_TIMEOUT_MS = 4_000;

export class DobroError extends Error {
  readonly status?: number;

  constructor(message: string, status?: number) {
    super(message);
    this.name = 'DobroError';
    this.status = status;
  }
}

/** Бюджет времени на весь запрос: новые обращения к порталу не запускаются. */
export class Deadline {
  private readonly expiresAt: number;

  constructor(ms: number) {
    this.expiresAt = Date.now() + ms;
  }

  get remainingMs(): number {
    return this.expiresAt - Date.now();
  }

  get expired(): boolean {
    return this.remainingMs <= 0;
  }
}

interface FetchOptions {
  timeoutMs?: number;
  retries?: number;
  deadline?: Deadline;
}

/** GET c JSON c retry c backoff. */
export async function dobroGet<T>(path: string, opts: FetchOptions = {}): Promise<T> {
  const { timeoutMs = DEFAULT_TIMEOUT_MS, retries = 1, deadline } = opts;
  const url = path.startsWith('http') ? path : `${DOBRO_ORIGIN}${path}`;

  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (deadline?.expired) {
      throw new DobroError('Исчерпан лимит времени на обращение к dobro.ru');
    }

    // Никогда не выходим за общий бюджет времени.
    const budget = deadline ? Math.min(timeoutMs, Math.max(deadline.remainingMs, 500)) : timeoutMs;

    try {
      const res = await fetch(url, {
        headers: {
          Accept: 'application/json',
          'Accept-Language': 'ru-RU,ru;q=0.9',
          'User-Agent': USER_AGENT,
        },
        signal: AbortSignal.timeout(budget),
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
      try {
        return JSON.parse(text) as T;
      } catch {
        // Портал мог отдать HTML (защита от роботов, редирект на заглушку).
        throw new DobroError(
          `Dobro API: ответ не JSON (${text.slice(0, 80).replace(/\s+/g, ' ')})`,
          502,
        );
      }
    } catch (err) {
      lastError = err;
      // 404 и 4xx повторять бессмысленно.
      if (err instanceof DobroError && err.status && err.status < 500) throw err;
      if (attempt < retries) {
        await sleep(300 * 2 ** attempt);
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

export interface OrganizationDocument {
  id: string;
  name: string;
  size?: number | null;
  url: string;
}

export interface OrganizationDetail {
  id: number;
  name: string | null;
  shortDescription?: string | null;
  description?: string | null;
  /** «Результаты» — свободный текст, заполняемый организатором. */
  results?: string | null;
  verified?: boolean | null;
  verifiedByEsia?: boolean | null;
  email?: string | null;
  /** Документы карточки организации (публичные, без авторизации). */
  docs?: OrganizationDocument[] | null;
  socialMedia?: Record<string, string | null> | null;
  leader?: {
    firstName?: string | null;
    lastName?: string | null;
    volunteerId?: number | null;
  } | null;
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

export interface OrganizationCard extends OrganizationDetail {
  placeInRatings?: PlaceInRatings | null;
}

/* ------------------------------------------------------------------ */
/* Эндпоинты                                                           */
/* ------------------------------------------------------------------ */

export async function searchOrganizations(
  query: string,
  opts: { limit?: number; page?: number; deadline?: Deadline } = {},
): Promise<OrganizerSearchHit[]> {
  const { limit = 10, page = 1, deadline } = opts;
  const params = new URLSearchParams({
    query,
    limit: String(Math.min(Math.max(limit, 1), 50)),
    page: String(Math.max(page, 1)),
  });

  const data = await dobroGet<OrganizerSearchHit[] | { 'hydra:member': OrganizerSearchHit[] }>(
    `/api/v2/organizers/search?${params.toString()}`,
    { deadline, timeoutMs: 6_000, retries: 1 },
  );

  if (Array.isArray(data)) return data;
  if (data && Array.isArray((data as { 'hydra:member': OrganizerSearchHit[] })['hydra:member'])) {
    return (data as { 'hydra:member': OrganizerSearchHit[] })['hydra:member'];
  }
  return [];
}

/**
 * Карточка организации. Сначала лёгкий JSON-API, при неудаче — SSR-разметка
 * (она содержит те же данные и вдобавок места в рейтингах).
 */
export async function getOrganization(
  id: number,
  opts: { withPlaceInRatings?: boolean; deadline?: Deadline } = {},
): Promise<OrganizationCard> {
  const { withPlaceInRatings = false, deadline } = opts;

  try {
    const detail = await dobroGet<OrganizationDetail>(
      `/api/v2/organizations/${id}?with=organizer`,
      { deadline, timeoutMs: 5_000, retries: 0 },
    );
    if (!withPlaceInRatings) return detail;

    try {
      const rankings = await getPlaceInRatings(id, deadline);
      return { ...detail, placeInRatings: rankings };
    } catch {
      return { ...detail, placeInRatings: null };
    }
  } catch (apiError) {
    // 404 — организации не существует, запасной путь бесполезен.
    if (apiError instanceof DobroError && apiError.status === 404) throw apiError;

    // JSON-API недоступен (защита от роботов, блокировка IP, 5xx) —
    // пробуем отрендеренную страницу.
    const viaSsr = await getOrganizationFromSsr(id, deadline);
    if (viaSsr) return viaSsr;
    throw apiError;
  }
}

/** Места в рейтингах — парсится из __NEXT_DATA__ страницы «Информация». */
export async function getPlaceInRatings(
  id: number,
  deadline?: Deadline,
): Promise<PlaceInRatings | null> {
  const org = await getOrganizationFromSsr(id, deadline);
  return org?.placeInRatings ?? null;
}

/** Карточка организации из SSR-разметки `__NEXT_DATA__`. */
export async function getOrganizationFromSsr(
  id: number,
  deadline?: Deadline,
): Promise<OrganizationCard | null> {
  const budget = deadline
    ? Math.min(SSR_TIMEOUT_MS, Math.max(deadline.remainingMs, 500))
    : SSR_TIMEOUT_MS;

  let html: string;
  try {
    const res = await fetch(`${DOBRO_ORIGIN}/organizations/${id}/info`, {
      headers: {
        Accept: 'text/html',
        'Accept-Language': 'ru-RU,ru;q=0.9',
        'User-Agent': USER_AGENT,
      },
      signal: AbortSignal.timeout(budget),
      redirect: 'follow',
    });
    if (!res.ok) return null;
    html = await res.text();
  } catch {
    return null;
  }

  const match = html.match(
    /<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/,
  );
  if (!match) return null;

  try {
    const parsed = JSON.parse(match[1]) as {
      props?: { pageProps?: { organization?: OrganizationCard } };
    };
    const org = parsed?.props?.pageProps?.organization;
    return org ? { ...org, id: org.id ?? id } : null;
  } catch {
    return null;
  }
}

export async function getPlatformStatistics(
  filters: { country?: string; region?: number | string; year?: number | string } = {},
  deadline?: Deadline,
): Promise<PlatformStatistics> {
  const params = new URLSearchParams();
  if (filters.country) params.set('country', filters.country);
  if (filters.region != null && filters.region !== '') params.set('region', String(filters.region));
  if (filters.year != null && filters.year !== '') params.set('year', String(filters.year));

  const suffix = params.toString() ? `?${params.toString()}` : '';
  const data = await dobroGet<{ statistics: Record<string, unknown> }>(
    `/api/v2/analytics/get${suffix}`,
    { deadline, timeoutMs: 6_000, retries: 1 },
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
