/**
 * GET /api/verify-org-doc?org=<id>&dao=<address>
 *
 * Слой B: организационное доказательство. Скачивает публичные документы
 * карточки организации на dobro.ru (вкладка «Документы») и ищет в текстовых
 * файлах адрес DAO. Возвращает сам документ, его sha256 и все найденные
 * адреса — это и есть доказательство, которое можно показать пользователю.
 *
 * Ответ всегда JSON. Коды: 200 — проверка выполнена, 400 — некорректные
 * параметры, 404 — организация не найдена, 502 — dobro.ru недоступен.
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';

import { cached } from '../lib/cache.ts';
import { Deadline, DobroError, getOrganization } from '../lib/dobro.ts';
import type { OrganizationCard } from '../lib/dobro.ts';
import { findDaoProof } from '../lib/docs.ts';
import { normalizeTonAddress } from '../lib/ton.ts';

const BUDGET_MS = 7_000;
const ORG_TTL_MS = 10 * 60 * 1000;

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

  const orgParam = String(req.query.org ?? '').trim();
  const daoParam = String(req.query.dao ?? '').trim();

  const orgId = Number(orgParam);
  if (!Number.isInteger(orgId) || orgId <= 0) {
    return res.status(400).json({ error: 'Укажите организацию: ?org=<id>' });
  }
  const dao = normalizeTonAddress(daoParam);
  if (!dao) {
    return res.status(400).json({ error: 'Укажите корректный адрес DAO: ?dao=<address>' });
  }

  const deadline = new Deadline(BUDGET_MS);

  let org: OrganizationCard;
  try {
    org = await cached(`org:${orgId}`, ORG_TTL_MS, () =>
      getOrganization(orgId, { withPlaceInRatings: false, deadline }),
    );
  } catch (err) {
    if (err instanceof DobroError && err.status === 404) {
      return res.status(404).json({ error: `Организация ${orgId} не найдена на dobro.ru` });
    }
    const message = err instanceof Error ? err.message : 'Неизвестная ошибка';
    return res.status(502).json({
      error: message,
      hint: 'Повторите запрос позже или проверьте документы вручную: /organizations/<id>/docs',
      elapsedMs: BUDGET_MS - deadline.remainingMs,
    });
  }

  const documents = Array.isArray(org.docs) ? org.docs : [];
  const proof = await findDaoProof(documents, dao, { deadline });

  const orgVerified = Boolean(org.verified);
  const docsAvailable = documents.length > 0;
  const ok = orgVerified && proof.found;

  res.setHeader('Cache-Control', 'public, max-age=120, s-maxage=300, stale-while-revalidate=600');

  return res.status(200).json({
    ok,
    found: proof.found,
    org: {
      id: org.id,
      name: org.name,
      verified: orgVerified,
      verifiedByEsia: Boolean(org.verifiedByEsia),
      hours: Number(org.organizer?.statistic?.hours ?? 0),
      url: `https://dobro.ru/organizations/${org.id}/info`,
      docsUrl: `https://dobro.ru/organizations/${org.id}/docs`,
    },
    dao: proof.dao,
    document: proof.document,
    sha256: proof.document?.sha256 ?? null,
    addresses: proof.addresses,
    scanned: proof.scanned,
    skipped: proof.skipped,
    checks: {
      orgVerified,
      docsAvailable,
      docFound: proof.found,
    },
    verifiedAt: new Date().toISOString(),
    elapsedMs: BUDGET_MS - deadline.remainingMs,
  });
}
