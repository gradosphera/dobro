/**
 * Локальная проверка обработчиков без деплоя.
 *   node --test test/*.test.ts
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import hours from '../api/hours.ts';
import total from '../api/total.ts';
import { getOrganization, getOrganizationFromSsr } from '../lib/dobro.ts';
import { normalize, scoreMatch } from '../lib/match.ts';

type Handler = (req: unknown, res: unknown) => Promise<unknown>;

function mockRes() {
  const res = {
    statusCode: 0,
    body: undefined as unknown,
    headers: {} as Record<string, string>,
    setHeader(k: string, v: string) {
      this.headers[k] = v;
      return this;
    },
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(payload: unknown) {
      this.body = payload;
      return this;
    },
    end() {
      return this;
    },
  };
  return res;
}

async function call(handler: Handler, query: Record<string, string>) {
  const res = mockRes();
  await handler({ method: 'GET', query }, res);
  return res;
}

test('normalize приводит ё/регистр/кавычки к общему виду', () => {
  assert.equal(normalize('«НЕравнодушные» СШ7'), 'неравнодушные сш7');
  assert.equal(normalize('Ёлка'), 'елка');
});

test('scoreMatch: точное совпадение даёт 1', () => {
  assert.equal(scoreMatch('Волонтеры-медики', 'Волонтеры-медики | Москва'), 1);
});

test('scoreMatch: разные организации не путаются', () => {
  const s = scoreMatch('Волонтеры-медики', 'Спортивные Волонтеры | Москва');
  assert.ok(s < 0.5, `ожидался низкий балл, получено ${s}`);
});

test('scoreMatch: региональный суффикс не ломает совпадение', () => {
  const withRegion = scoreMatch('Волонтеры-медики', 'Волонтеры-медики | Москва');
  const withoutRegion = scoreMatch('Волонтеры-медики', 'Волонтеры-медики');
  assert.ok(withRegion > 0.9, `региональный филиал должен совпадать, получено ${withRegion}`);
  assert.ok(
    withoutRegion >= withRegion,
    `точный базовый матч не должен быть хуже регионального (${withoutRegion} < ${withRegion})`,
  );
});

test('scoreMatch: лишние слова в названии снижают балл', () => {
  const exact = scoreMatch('БФ Неравнодушные', 'БФ "Неравнодушные"');
  const noisy = scoreMatch('БФ Неравнодушные', 'Отряд Неравнодушные 84');
  assert.ok(exact > noisy, `${exact} должно быть > ${noisy}`);
});

test('scoreMatch: город из запроса повышает балл нужного филиала', () => {
  const moscow = scoreMatch(
    'Волонтеры-медики Москва',
    'Волонтеры-медики | Москва',
    null,
    'г Москва, 3-й Павелецкий проезд',
  );
  const other = scoreMatch(
    'Волонтеры-медики Москва',
    'Волонтеры-медики | Амурская область',
    null,
    'г Благовещенск, ул Горького',
  );
  assert.ok(moscow > other, `${moscow} должно быть > ${other}`);
});

test('GET /api/total отдаёт общее число часов по платформе', async () => {
  const res = await call(total as unknown as Handler, {});
  assert.equal(res.statusCode, 200);
  const body = res.body as { hours: number; verifiedHours: number; organizers: number };
  assert.ok(body.hours > 0, 'hours должен быть > 0');
  assert.ok(body.verifiedHours > 0, 'verifiedHours должен быть > 0');
  assert.ok(body.verifiedHours <= body.hours);
  console.log(`  всего часов: ${body.hours}, верифицировано: ${body.verifiedHours}`);
});

test('GET /api/total с фильтром по региону', async () => {
  const res = await call(total as unknown as Handler, { region: '77' });
  assert.equal(res.statusCode, 200);
  const body = res.body as { hours: number; filters: { region: string } };
  assert.equal(body.filters.region, '77');
  assert.ok(body.hours > 0);
});

test('GET /api/hours находит организацию и отдаёт её «Часы»', async () => {
  const res = await call(hours as unknown as Handler, { q: 'Волонтеры-медики', limit: '3' });
  assert.equal(res.statusCode, 200);
  const body = res.body as {
    bestMatchName: string;
    bestMatchHours: number;
    platformTotalHours: number;
    organizations: Array<{ name: string; hours: number; rating: number | null }>;
  };
  assert.ok(body.platformTotalHours > 0);
  assert.ok(body.organizations.length > 0, 'должны быть найдены организации');
  assert.ok(body.bestMatchHours > 0, 'у лучшего совпадения должны быть часы');
  assert.match(body.bestMatchName, /медик/i);
  console.log(
    `  ${body.bestMatchName}: ${body.bestMatchHours} ч (всего на платформе ${body.platformTotalHours})`,
  );
});

test('GET /api/hours отдаёт рейтинг и результаты', async () => {
  const res = await call(hours as unknown as Handler, { q: 'Волонтеры-медики', limit: '1' });
  const body = res.body as {
    organizations: Array<{
      hours: number;
      rating: number | null;
      ratingCount: number;
      results: string | null;
      url: string;
    }>;
  };
  const org = body.organizations[0]!;
  assert.ok(org.hours > 0);
  assert.ok(org.rating !== null, 'рейтинг должен быть извлечён');
  assert.ok(org.ratingCount > 0, 'количество оценок должно быть > 0');
  assert.ok(org.url.includes('dobro.ru/organizations/'));
});

test('GET /api/hours отклоняет слишком короткий запрос', async () => {
  const res = await call(hours as unknown as Handler, { q: 'а' });
  assert.equal(res.statusCode, 400);
  assert.ok(res.body && typeof res.body === 'object', 'ответ должен быть JSON-объектом');
});

test('запасной путь через SSR-разметку отдаёт «Часы»', async () => {
  const org = await getOrganizationFromSsr(813);
  assert.ok(org, 'карточка должна была распарситься из __NEXT_DATA__');
  assert.equal(org!.name, 'Волонтеры-медики | Москва');
  const hoursValue = org!.organizer?.statistic?.hours;
  assert.ok(typeof hoursValue === 'number' && hoursValue > 0, 'часы должны быть извлечены из SSR');
  console.log(`  SSR: ${org!.name} => ${hoursValue} ч`);
});

test('обработчик /api/hours укладывается в лимит времени', async () => {
  const started = Date.now();
  const res = await call(hours as unknown as Handler, { q: 'Волонтеры-медики', limit: '3' });
  const elapsed = Date.now() - started;
  assert.equal(res.statusCode, 200);
  assert.ok(elapsed < 20_000, `обработчик занял ${elapsed} мс — платформа успеет убить инстанс`);
  const body = res.body as { elapsedMs: number; partial: boolean };
  assert.equal(typeof body.elapsedMs, 'number');
  assert.equal(typeof body.partial, 'boolean');
  console.log(`  обработчик отработал за ${elapsed} мс`);
});

test('GET /api/hours отдаёт JSON даже при ошибке', async () => {
  const res = await call(hours as unknown as Handler, { q: 'организация-которой-не-существует-12345' });
  assert.ok(res.statusCode === 200 || res.statusCode === 502, `неожиданный код ${res.statusCode}`);
  assert.ok(res.body && typeof res.body === 'object', 'ответ должен быть JSON-объектом');
});

test('если JSON-API недоступен, карточка берётся из SSR-разметки', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: unknown, init?: unknown) => {
    const url = String(typeof input === 'string' ? input : (input as { url?: string })?.url ?? '');
    if (url.includes('/api/v2/organizations/')) {
      return new Response('blocked by WAF', { status: 403 });
    }
    return original(input as string, init as RequestInit);
  }) as typeof fetch;

  try {
    const org = await getOrganization(813, {});
    assert.ok(org, 'карточка должна была прийти из SSR-разметки');
    assert.ok((org!.organizer?.statistic?.hours ?? 0) > 0, 'часы должны быть извлечены из SSR');
    console.log(`  fallback: ${org!.name} => ${org!.organizer?.statistic?.hours} ч`);
  } finally {
    globalThis.fetch = original;
  }
});

test('опциональные параметры detail и rankings не ломают ответ', async () => {
  const res = await call(hours as unknown as Handler, {
    q: 'Волонтеры-медики',
    limit: '2',
    detail: '2',
    rankings: '1',
  });
  assert.equal(res.statusCode, 200);
  const body = res.body as { organizations: unknown[] };
  assert.ok(body.organizations.length <= 2);
});
