/**
 * Локальная проверка обработчиков без деплоя.
 *   node --test test/*.test.ts
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import hours from '../api/hours.ts';
import total from '../api/total.ts';
import { normalize, scoreMatch } from '../lib/match.ts';

type Handler = (req: unknown, res: unknown) => Promise<unknown>;

function mockRes() {
  const res = {
    statusCode: 0,
    body: undefined as unknown,
    headers: {} as Record<string, string>,
    setHeader(k: string, v: string) {
      this.headers[k] = v;
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
});
