/**
 * GET /api/verify-owner?org=<id>&dao=<address>[&wallet=<address>]
 *
 * Слой A: криптографическая привязка. Проверяет, что DAO существует,
 * организация существует и верифицирована на dobro.ru, а переданный
 * TON-кошелёк (например, из TON Connect) является owner/proposalOwner DAO.
 *
 * Ответ всегда JSON. Коды: 200 — проверка выполнена (даже если связи нет),
 * 400 — некорректные параметры, 404 — DAO или организация не найдены,
 * 502 — upstream недоступен.
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';

import { cached } from '../lib/cache.ts';
import { Deadline, DobroError, getOrganization } from '../lib/dobro.ts';
import type { OrganizationCard } from '../lib/dobro.ts';
import { TonError, getDao, normalizeTonAddress, sameTonAddress } from '../lib/ton.ts';
import type { DaoState } from '../lib/ton.ts';

const BUDGET_MS = 7_000;
const ORG_TTL_MS = 10 * 60 * 1000;
/** Владельца можно сменить — состояние DAO кэшируем ненадолго. */
const DAO_TTL_MS = 60 * 1000;

export type WalletRole = 'owner' | 'proposalOwner' | 'none' | 'unknown';

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
  const walletParam = String(req.query.wallet ?? '').trim();

  const orgId = Number(orgParam);
  if (!Number.isInteger(orgId) || orgId <= 0) {
    return res.status(400).json({ error: 'Укажите организацию: ?org=<id>' });
  }
  const daoAddress = normalizeTonAddress(daoParam);
  if (!daoAddress) {
    return res.status(400).json({ error: 'Укажите корректный адрес DAO: ?dao=<address>' });
  }
  const wallet = walletParam ? normalizeTonAddress(walletParam) : null;
  if (walletParam && !wallet) {
    return res.status(400).json({ error: 'Укажите корректный адрес кошелька: ?wallet=<address>' });
  }

  const deadline = new Deadline(BUDGET_MS);

  let org: OrganizationCard;
  let dao: DaoState;
  try {
    [org, dao] = await Promise.all([
      cached(`org:${orgId}`, ORG_TTL_MS, () =>
        getOrganization(orgId, { withPlaceInRatings: false, deadline }),
      ),
      cached(`dao:${daoAddress}`, DAO_TTL_MS, () => getDao(daoAddress, { timeoutMs: 5_000 })),
    ]);
  } catch (err) {
    if (err instanceof DobroError && err.status === 404) {
      return res.status(404).json({ error: `Организация ${orgId} не найдена на dobro.ru` });
    }
    if (err instanceof TonError && err.status === 404) {
      return res.status(404).json({ error: `DAO ${daoAddress} не найден в сети TON` });
    }
    const message = err instanceof Error ? err.message : 'Неизвестная ошибка';
    return res.status(502).json({
      error: message,
      hint: 'DAO читается через api.ton.vote, организация — через dobro.ru. Повторите запрос позже.',
      elapsedMs: BUDGET_MS - deadline.remainingMs,
    });
  }

  const walletIsOwner = wallet && dao.owner ? sameTonAddress(wallet, dao.owner) : false;
  const walletIsProposalOwner =
    wallet && dao.proposalOwner ? sameTonAddress(wallet, dao.proposalOwner) : false;

  const verdict: WalletRole = !wallet ? 'unknown' : walletIsOwner ? 'owner' : walletIsProposalOwner ? 'proposalOwner' : 'none';

  const orgVerified = Boolean(org.verified);
  const ok = orgVerified && (wallet ? verdict === 'owner' : true);

  res.setHeader('Cache-Control', 'public, max-age=30, s-maxage=60, stale-while-revalidate=120');

  return res.status(200).json({
    ok,
    verdict,
    org: {
      id: org.id,
      name: org.name,
      verified: orgVerified,
      verifiedByEsia: Boolean(org.verifiedByEsia),
      hours: Number(org.organizer?.statistic?.hours ?? 0),
      url: `https://dobro.ru/organizations/${org.id}/info`,
    },
    dao: {
      address: dao.address,
      daoId: dao.daoId,
      owner: dao.owner,
      proposalOwner: dao.proposalOwner,
      metadataAddress: dao.metadataAddress,
      name: dao.metadata.name,
      jetton: dao.metadata.jetton,
      nft: dao.metadata.nft,
      dns: dao.metadata.dns,
      terms: dao.metadata.terms,
      proposalsCount: dao.proposalsCount,
    },
    wallet: wallet
      ? { address: wallet, role: verdict, isOwner: walletIsOwner, isProposalOwner: walletIsProposalOwner }
      : null,
    checks: {
      orgExists: true,
      daoExists: true,
      orgVerified,
      orgVerifiedByEsia: Boolean(org.verifiedByEsia),
      walletIsOwner: wallet ? walletIsOwner : null,
      walletIsProposalOwner: wallet ? walletIsProposalOwner : null,
    },
    verifiedAt: new Date().toISOString(),
    elapsedMs: BUDGET_MS - deadline.remainingMs,
  });
}
