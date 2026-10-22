/**
 * POST /api/bind { "orgId": 10072836, "dao": "EQ…" }
 *
 * Закрепляет связку «организация dobro.ru ↔ DAO ↔ жетон» в БД.
 * Требует сессию (Bearer) и проверяет:
 *   1) организация верифицирована на dobro.ru;
 *   2) кошелёк сессии — owner DAO (свежее состояние из сети);
 *   3) адрес DAO записан в публичном документе организации (слой B);
 *   4) admin жетона DAO (если задан) — для отчёта, не блокирует.
 *
 * Требует DATABASE_URL; без него — 503.
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';

import { AuthError, requireSession } from '../lib/auth.ts';
import { DbError, isDbConfigured } from '../lib/db.ts';
import { Deadline, DobroError, getOrganization } from '../lib/dobro.ts';
import { findDaoProof } from '../lib/docs.ts';
import { getJettonInfo } from '../lib/jetton.ts';
import type { JettonInfo } from '../lib/jetton.ts';
import { saveBinding, upsertLeader } from '../lib/orgs.ts';
import { TonError, getDao, normalizeTonAddress, sameTonAddress } from '../lib/ton.ts';

const BUDGET_MS = 7_000;

function body(req: VercelRequest): Record<string, unknown> {
  const raw = req.body as unknown;
  if (!raw) return {};
  if (typeof raw === 'string') {
    try {
      return JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return {};
    }
  }
  return raw as Record<string, unknown>;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');

  if (req.method === 'OPTIONS') {
    res.setHeader('Allow', 'POST, OPTIONS');
    return res.status(204).end();
  }
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST, OPTIONS');
    return res.status(405).json({ error: 'Метод не поддерживается' });
  }

  let session: ReturnType<typeof requireSession>;
  try {
    session = requireSession(req.headers.authorization);
  } catch (err) {
    const status = err instanceof AuthError ? err.status : 401;
    return res.status(status).json({ error: err instanceof Error ? err.message : 'Нужна сессия' });
  }

  if (!isDbConfigured()) {
    return res.status(503).json({
      error: 'DATABASE_URL не задан: привязка требует Neon',
      hint: 'Подключите Neon и выполните npm run db:migrate',
    });
  }

  const data = body(req);
  const orgId = Number(data.orgId ?? data.org);
  if (!Number.isInteger(orgId) || orgId <= 0) {
    return res.status(400).json({ error: 'Укажите orgId (число)' });
  }
  const daoAddress = normalizeTonAddress(String(data.dao ?? ''));
  if (!daoAddress) {
    return res.status(400).json({ error: 'Укажите корректный адрес DAO' });
  }

  const deadline = new Deadline(BUDGET_MS);

  try {
    const [org, dao] = await Promise.all([
      getOrganization(orgId, { withPlaceInRatings: false, deadline }),
      getDao(daoAddress),
    ]);

    if (!org.verified) {
      return res.status(403).json({
        error: 'Организация не верифицирована на dobro.ru',
        org: { id: org.id, name: org.name, verified: Boolean(org.verified) },
      });
    }
    if (!dao.owner || !sameTonAddress(dao.owner, session.wallet)) {
      return res.status(403).json({
        error: 'Кошелёк сессии не является owner DAO',
        owner: dao.owner,
        wallet: session.wallet,
      });
    }

    const [proof, jetton] = await Promise.all([
      findDaoProof(org.docs ?? [], daoAddress, { deadline }),
      dao.metadata.jetton
        ? getJettonInfo(dao.metadata.jetton).catch(() => null)
        : Promise.resolve(null as JettonInfo | null),
    ]);

    if (!proof.found) {
      return res.status(403).json({
        error: 'Адрес DAO не найден в документах организации',
        expected: daoAddress,
        scanned: proof.scanned,
        skipped: proof.skipped,
        hint: 'Добавьте vote.txt с адресом DAO в карточку организации на dobro.ru',
      });
    }

    const jettonMatchesOwner = Boolean(
      jetton?.admin && dao.owner && sameTonAddress(jetton.admin, dao.owner),
    );

    const binding = await saveBinding({
      orgId,
      name: org.name,
      verified: Boolean(org.verified),
      verifiedByEsia: Boolean(org.verifiedByEsia),
      hours: Number(org.organizer?.statistic?.hours ?? 0),
      daoAddress,
      daoOwner: dao.owner,
      jettonAddress: dao.metadata.jetton ?? null,
      docId: proof.document?.id ?? null,
      docName: proof.document?.name ?? null,
      docSha256: proof.document?.sha256 ?? null,
    });

    const leaderVolunteerId = org.leader?.volunteerId;
    if (typeof leaderVolunteerId === 'number' && leaderVolunteerId > 0) {
      await upsertLeader(orgId, leaderVolunteerId, session.wallet);
    }

    return res.status(200).json({
      ok: true,
      binding,
      document: proof.document,
      jetton,
      checks: {
        orgVerified: Boolean(org.verified),
        walletIsOwner: true,
        docFound: true,
        jettonMatchesOwner,
      },
      verifiedAt: new Date().toISOString(),
      elapsedMs: BUDGET_MS - deadline.remainingMs,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Неизвестная ошибка';
    if (err instanceof DbError) return res.status(503).json({ error: message });
    if (err instanceof DobroError && err.status === 404) {
      return res.status(404).json({ error: `Организация ${orgId} не найдена на dobro.ru` });
    }
    if (err instanceof TonError && err.status === 404) {
      return res.status(404).json({ error: `DAO ${daoAddress} не найден в сети TON` });
    }
    return res.status(502).json({
      error: message,
      hint: 'Проверьте доступность dobro.ru и api.ton.vote, затем повторите',
      elapsedMs: BUDGET_MS - deadline.remainingMs,
    });
  }
}
