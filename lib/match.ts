/**
 * Нечёткое сопоставление запроса пользователя с найденными организациями.
 *
 * Особенность dobro.ru: у крупных сетевых организаций десятки региональных
 * филиалов с почти одинаковым названием («Волонтеры-медики | Москва»,
 * «Волонтеры-медики | Амурская область»). Поэтому название делится на
 * «основную часть» (до «|») и региональный суффикс, а регион учитывается
 * отдельным измерением.
 */

export interface Scored<T> {
  item: T;
  /** Итоговый балл 0..1. */
  score: number;
  reasons: string[];
}

export interface Matchable {
  name?: string | null;
  fullName?: string | null;
  location?: string | null;
  hours?: number | null;
  volunteers?: number | null;
}

/** Нормализация: регистр, ё, лишние пробелы, типографские кавычки и дефисы. */
export function normalize(value: string | null | undefined): string {
  if (!value) return '';
  return value
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[«»"']/g, ' ')
    .replace(/[-–—_]/g, ' ')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Название без регионального суффикса «... | Регион». */
export function baseName(name: string | null | undefined): string {
  if (!name) return '';
  const [head] = name.split('|');
  return (head ?? name).trim();
}

function tokens(value: string | null | undefined): string[] {
  return normalize(value).split(' ').filter((t) => t.length > 1);
}

function coverage(queryTokens: string[], target: string[] | Set<string>): number {
  if (queryTokens.length === 0) return 0;
  const set = target instanceof Set ? target : new Set(target);
  const hits = queryTokens.filter((t) => set.has(t)).length;
  return hits / queryTokens.length;
}

/**
 * Балл совпадения 0..1:
 *   0.85 * покрытие(запрос ⊂ название + полное имя + адрес)
 * + 0.15 * покрытие(запрос ⊂ основная часть названия)
 * + бонус за точное совпадение основной части названия
 * - штраф за «лишние» слова в названии, которых нет в запросе.
 */
export function scoreMatch(
  query: string,
  name: string | null | undefined,
  fullName?: string | null,
  location?: string | null,
): number {
  const qNormalized = normalize(query);
  if (!qNormalized) return 0;

  const head = baseName(name);
  const qTokens = tokens(query);
  if (qTokens.length === 0) return 0;

  const headTokens = tokens(head);
  const allTokens = new Set<string>([
    ...headTokens,
    ...tokens(fullName),
    ...tokens(location),
  ]);

  const coverageBase = coverage(qTokens, headTokens);
  const coverageAll = coverage(qTokens, allTokens);

  let score = 0.85 * coverageAll + 0.15 * coverageBase;

  if (qNormalized === normalize(head)) score += 0.05;
  else if (qNormalized === normalize(fullName)) score += 0.04;

  const qSet = new Set(qTokens);
  const extra = headTokens.filter((t) => !qSet.has(t)).length;
  score -= Math.min(extra * 0.03, 0.12);

  return Math.max(0, Math.min(score, 1));
}

/** Разница, при которой совпадения считаются равнозначными. */
const SCORE_BAND = 0.04;

/**
 * Ранжирование: сначала по баллу названия, а при равных баллах —
 * по объёму часов (среди одноимённых филиалов первым идёт крупнейший).
 */
export function rankResults<T extends Matchable>(query: string, items: T[]): Scored<T>[] {
  const scored = items.map((item) => {
    const score = scoreMatch(query, item.name, item.fullName, item.location);
    const hours = typeof item.hours === 'number' ? item.hours : 0;
    const reasons: string[] = [];

    if (score >= 0.97) reasons.push('точное совпадение названия');
    else if (score >= 0.8) reasons.push('название почти совпадает');
    else if (score >= 0.5) reasons.push('совпадение слов в названии');
    else reasons.push('слабое совпадение');

    return { item, score, hours, reasons };
  });

  scored.sort((a, b) => {
    const delta = b.score - a.score;
    if (Math.abs(delta) > SCORE_BAND) return delta;
    return b.hours - a.hours;
  });

  return scored.map(({ item, score, reasons }) => ({ item, score, reasons }));
}

/**
 * Предварительное ранжирование результатов поиска (до загрузки карточек):
 * используется объём выборки волонтёров как proxy размера организации.
 */
export function preselectCandidates<T extends Matchable>(query: string, items: T[], take: number): T[] {
  const scored = items.map((item) => ({
    item,
    score: scoreMatch(query, item.name, item.fullName, item.location),
    size: item.volunteers ?? 0,
  }));

  scored.sort((a, b) => {
    const delta = b.score - a.score;
    if (Math.abs(delta) > SCORE_BAND) return delta;
    return b.size - a.size;
  });

  return scored.slice(0, take).map((s) => s.item);
}
