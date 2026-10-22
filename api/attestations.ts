/**
 * GET  /api/attestations?org=<id>&limit=100  — публичный список часов и клеймов
 * POST /api/attestations                      — лидер вносит подтверждённые часы
 *
 * POST требует сессию (Bearer) и проверяет по свежему состоянию сети, что
 * кошелёк сессии — owner DAO привязанной организации. Запись создаётся
 * сразу approved; клейм — floor(hours) BLG. Идемпотентно по
 * (orgId, volunteerId, месяц).
 *
 * Требует DATABASE_URL; без него — 503.
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';

import { AuthError, requireSession } from '../lib/auth.ts';
import {
  MAX_HOURS_PER_MONTH,
  blgForHours,
  createApprovedAttestation,
  listAttestations,
  normalizePeriod,
} from '../lib/attestations.ts';
import { DbError, isDbConfigured } from '../lib/db.ts';
import { getBinding } from '../lib/orgs.ts';
import { TonError, getDao, normalizeTonAddress, sameTonAddress } from '../lib/ton.ts';

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

function proofUrl(value: unknown): string | null | undefined {
  if (value == null || String(value).trim() === '') return null;
  const raw = String(value).trim();
  if (raw.length > 2048) return undefined;
  try {
    const url = new URL(raw);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined;
    return url.toString();
  } catch {
    return undefined;
  }
}

function totals(rows: Array<{ hours: number; claimAmount: number | null }>) {
  return rows.reduce(
    (acc, row) => ({
      hours: Math.round((acc.hours + row.hours) * 100) / 100,
      blg: acc.blg + (row.claimAmount ?? 0),
    }),
    { hours: 0, blg: 0 },
  );
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');

  if (req.method === 'OPTIONS') {
    res.setHeader('Allow', 'GET, POST, OPTIONS');
    return res.status(204).end();
  }
  if (req.method !== 'GET' && req.method !== 'POST') {
    res.setHeader('Allow', 'GET, POST, OPTIONS');
    return res.status(405).json({ error: 'Метод не поддерживается' });
  }

  if (!isDbConfigured()) {
    return res.status(503).json({
      error: 'DATABASE_URL не задан: аттестации требуют Neon',
      hint: 'Подключите Neon и выполните npm run db:migrate',
    });
  }

  if (req.method === 'GET') {
    const orgId = Number(req.query.org);
    if (!Number.isInteger(orgId) || orgId <= 0) {
      return res.status(400).json({ error: 'Укажите организацию: ?org=<id>' });
    }

    try {
      const binding = await getBinding(orgId);
      if (!binding) {
        return res.status(404).json({ error: `Организация ${orgId} ещё не привязана к DAO` });
      }
      const rows = await listAttestations(orgId, Number(req.query.limit ?? 100));
      res.setHeader('Cache-Control', 'public, max-age=30, s-maxage=60, stale-while-revalidate=120');
      return res.status(200).json({
        org: binding,
        attestations: rows,
        totals: totals(rows),
        fetchedAt: new Date().toISOString(),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Неизвестная ошибка';
      return res.status(err instanceof DbError ? 503 : 500).json({ error: message });
    }
  }

  // POST
  let session: ReturnType<typeof requireSession>;
  try {
    session = requireSession(req.headers.authorization);
  } catch (err) {
    const status = err instanceof AuthError ? err.status : 401;
    return res.status(status).json({ error: err instanceof Error ? err.message : 'Нужна сессия' });
  }

  const data = body(req);
  const orgId = Number(data.orgId ?? data.org);
  const volunteerId = Number(data.volunteerId ?? data.volunteer);
  if (!Number.isInteger(orgId) || orgId <= 0) {
    return res.status(400).json({ error: 'Укажите orgId (число)' });
  }
  if (!Number.isInteger(volunteerId) || volunteerId <= 0) {
    return res.status(400).json({ error: 'Укажите volunteerId (число)' });
  }

  const wallet = normalizeTonAddress(String(data.wallet ?? ''));
  if (!wallet) {
    return res.status(400).json({ error: 'Укажите корректный wallet волонтёра' });
  }

  const periodMonth = normalizePeriod(data.period ?? data.periodMonth);
  if (!periodMonth) {
    return res.status(400).json({ error: 'Укажите период: "2026-10" или "2026-10-01"' });
  }

  const hours = Number(data.hours);
  if (!Number.isFinite(hours) || hours <= 0 || hours > MAX_HOURS_PER_MONTH) {
    return res.status(400).json({
      error: `hours должно быть > 0 и ≤ ${MAX_HOURS_PER_MONTH}`,
    });
  }

  const url = proofUrl(data.proofUrl);
  if (url === undefined) {
    return res.status(400).json({ error: 'proofUrl должен быть http(s)-ссылкой до 2048 символов' });
  }

  try {
    const binding = await getBinding(orgId);
    if (!binding?.daoAddress) {
      return res.status(409).json({
        error: `Организация ${orgId} ещё не привязана к DAO`,
        hint: 'Сначала вызовите POST /api/bind',
      });
    }

    const dao = await getDao(binding.daoAddress);
    if (!dao.owner || !sameTonAddress(dao.owner, session.wallet)) {
      return res.status(403).json({
        error: 'Кошелёк сессии не является owner DAO',
        owner: dao.owner,
        wallet: session.wallet,
      });
    }

    const result = await createApprovedAttestation({
      orgId,
      volunteerId,
      wallet,
      periodMonth,
      hours,
      proofUrl: url,
      approvedBy: session.wallet,
    });

    return res.status(result.created ? 201 : 200).json({
      created: result.created,
      amount: blgForHours(hours),
      attestation: result.attestation,
      checks: { walletIsOwner: true },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Неизвестная ошибка';
    if (err instanceof DbError) return res.status(503).json({ error: message });
    if (err instanceof TonError) {
      return res.status(err.status ?? 502).json({ error: message });
    }
    return res.status(502).json({ error: message });
  }
}
