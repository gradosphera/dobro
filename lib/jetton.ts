/**
 * Информация о jetton-минтере через tonapi.
 *
 *   GET /v2/jettons/{address}
 *       -> metadata { name, symbol, decimals }, total_supply, mintable,
 *          admin { address }
 *
 * Для проверки связки «жетон организации принадлежит DAO» используется
 * admin минтера: у BLGT это кошелёк организации (owner DAO), у BLG —
 * мультисиг фонда, поэтому для BLG проверка осознанно не проходит.
 */

import { cached } from './cache.ts';
import { normalizeTonAddress } from './ton.ts';

export const TONAPI_URL = process.env.TONAPI_URL ?? 'https://tonapi.io';
const JETTON_TTL_MS = 5 * 60 * 1000;
const USER_AGENT = 'dobro-dao-bot/1.0 (+https://github.com/gradosphera/dobro)';

export class JettonError extends Error {
  readonly status?: number;

  constructor(message: string, status?: number) {
    super(message);
    this.name = 'JettonError';
    this.status = status;
  }
}

export interface JettonInfo {
  address: string;
  name: string | null;
  symbol: string | null;
  decimals: number;
  totalSupply: string | null;
  mintable: boolean;
  admin: string | null;
}

interface RawJetton {
  metadata?: {
    name?: string | null;
    symbol?: string | null;
    decimals?: string | number | null;
    address?: string | null;
  } | null;
  total_supply?: string | number | null;
  mintable?: boolean | null;
  admin?: { address?: string | null } | null;
}

export async function getJettonInfo(
  address: string,
  opts: { timeoutMs?: number } = {},
): Promise<JettonInfo> {
  const canonical = normalizeTonAddress(address);
  if (!canonical) throw new JettonError('Некорректный адрес жетона', 400);

  return cached(`jetton:${canonical}`, JETTON_TTL_MS, async () => {
    const url = `${TONAPI_URL.replace(/\/+$/, '')}/v2/jettons/${encodeURIComponent(canonical)}`;
    const res = await fetch(url, {
      headers: {
        Accept: 'application/json',
        'User-Agent': USER_AGENT,
        ...(process.env.TONAPI_KEY ? { Authorization: `Bearer ${process.env.TONAPI_KEY}` } : {}),
      },
      signal: AbortSignal.timeout(opts.timeoutMs ?? 7_000),
    });

    if (res.status === 404) throw new JettonError(`Жетон не найден: ${canonical}`, 404);
    if (!res.ok) throw new JettonError(`tonapi: HTTP ${res.status}`, res.status);

    const data = (await res.json()) as RawJetton;
    const decimals = Number(data.metadata?.decimals ?? 0);

    return {
      address: canonical,
      name: data.metadata?.name ?? null,
      symbol: data.metadata?.symbol ?? null,
      decimals: Number.isFinite(decimals) ? decimals : 0,
      totalSupply: data.total_supply == null ? null : String(data.total_supply),
      mintable: Boolean(data.mintable),
      admin: data.admin?.address ? normalizeTonAddress(data.admin.address) : null,
    };
  });
}
