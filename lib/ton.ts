/**
 * Чтение состояния ДАО из публичного API ton.vote.
 *
 *   GET https://api.ton.vote/dao/{address}
 *       -> daoAddress, daoId, daoRoles { owner, proposalOwner },
 *          daoMetadata { metadataAddress, metadataArgs { name, jetton, nft, dns, terms } },
 *          nextProposalId, daoProposals.
 *
 * Адреса принимаются в любом формате TON (`EQ…`, `UQ…`, `0:hex`)
 * и сравниваются по raw-представлению (`workchain:hash`), поэтому
 * bounceable/non-bounceable и testnet-форма одного и того же адреса
 * считаются равными.
 *
 * Получение recipient public key через toncenter API для encrypted comments.
 */

import { Address } from '@ton/core';

export const TON_VOTE_API = process.env.TON_VOTE_API_URL ?? 'https://api.ton.vote';

const USER_AGENT = 'dobro-dao-bot/1.0 (+https://github.com/gradosphera/dobro)';
const DEFAULT_TIMEOUT_MS = 7_000;

/** Нулевой адрес TON (используется как «поле не задано»). */
export const ZERO_ADDRESS = 'EQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAM9c';

export class TonError extends Error {
  readonly status?: number;

  constructor(message: string, status?: number) {
    super(message);
    this.name = 'TonError';
    this.status = status;
  }
}

export interface DaoMetadataArgs {
  name?: string | null;
  about?: string | null;
  avatar?: string | null;
  github?: string | null;
  telegram?: string | null;
  website?: string | null;
  jetton?: string | null;
  nft?: string | null;
  dns?: string | null;
  terms?: string | null;
}

export interface DaoState {
  /** Адрес в bounceable-форме (`EQ…`). */
  address: string;
  daoId: number | null;
  owner: string | null;
  proposalOwner: string | null;
  metadataAddress: string | null;
  metadata: DaoMetadataArgs;
  nextProposalId: number | null;
  proposalsCount: number;
}

export function parseTonAddress(input: unknown): Address | null {
  if (typeof input !== 'string') return null;
  const value = input.trim();
  if (!value) return null;
  try {
    return Address.parse(value);
  } catch {
    return null;
  }
}

/** Канонический вид для вывода: non-bounceable, url-safe (`UQ…`). */
export function normalizeTonAddress(input: string): string | null {
  return parseTonAddress(input)?.toString({ bounceable: false, urlSafe: true }) ?? null;
}

export function sameTonAddress(a: string, b: string): boolean {
  const left = parseTonAddress(a);
  const right = parseTonAddress(b);
  return Boolean(left && right && left.equals(right));
}

export function isZeroAddress(input: string | null | undefined): boolean {
  const parsed = parseTonAddress(input);
  if (!parsed) return true;
  return parsed.equals(parseTonAddress(ZERO_ADDRESS) as Address);
}

/** Пустая строка / нулевой адрес -> null, иначе canonical-адрес. */
function optionalAddress(input: unknown): string | null {
  if (typeof input !== 'string' || !input.trim() || isZeroAddress(input)) return null;
  return normalizeTonAddress(input) ?? input;
}

function stringOrNull(input: unknown): string | null {
  return typeof input === 'string' && input.trim() ? input : null;
}

interface RawDaoResponse {
  daoAddress?: string;
  daoId?: number;
  daoRoles?: { owner?: string | null; proposalOwner?: string | null } | null;
  daoMetadata?: {
    metadataAddress?: string | null;
    metadataArgs?: Record<string, unknown> | null;
  } | null;
  nextProposalId?: number;
  daoProposals?: unknown[] | null;
}

/**
 * Состояние ДАО. 404 -> TonError(404), сеть/5xx -> TonError(502).
 */
export async function getDao(
  address: string,
  opts: { timeoutMs?: number; retries?: number } = {},
): Promise<DaoState> {
  const parsed = parseTonAddress(address);
  if (!parsed) throw new TonError('Некорректный адрес ДАО', 400);

  const canonical = parsed.toString({ bounceable: true, urlSafe: true });
  const { timeoutMs = DEFAULT_TIMEOUT_MS, retries = 1 } = opts;
  const url = `${TON_VOTE_API.replace(/\/+$/, '')}/dao/${encodeURIComponent(canonical)}`;

  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, {
        headers: { Accept: 'application/json', 'User-Agent': USER_AGENT },
        signal: AbortSignal.timeout(timeoutMs),
        redirect: 'follow',
      });

      if (res.status === 404) {
        throw new TonError(`ДАО не найден: ${canonical}`, 404);
      }
      if (!res.ok) {
        throw new TonError(`ton.vote API: HTTP ${res.status}`, res.status);
      }

      const data = (await res.json()) as RawDaoResponse;
      if (!data || typeof data !== 'object') {
        throw new TonError('ton.vote API: пустой ответ');
      }

      const args = data.daoMetadata?.metadataArgs ?? {};
      return {
        address: normalizeTonAddress(data.daoAddress ?? canonical) ?? canonical,
        daoId: typeof data.daoId === 'number' ? data.daoId : null,
        owner: optionalAddress(data.daoRoles?.owner),
        proposalOwner: optionalAddress(data.daoRoles?.proposalOwner),
        metadataAddress: optionalAddress(data.daoMetadata?.metadataAddress),
        metadata: {
          name: stringOrNull(args.name),
          about: stringOrNull(args.about),
          avatar: stringOrNull(args.avatar),
          github: stringOrNull(args.github),
          telegram: stringOrNull(args.telegram),
          website: stringOrNull(args.website),
          jetton: optionalAddress(args.jetton),
          nft: optionalAddress(args.nft),
          dns: stringOrNull(args.dns),
          terms: stringOrNull(args.terms),
        },
        nextProposalId: typeof data.nextProposalId === 'number' ? data.nextProposalId : null,
        proposalsCount: Array.isArray(data.daoProposals) ? data.daoProposals.length : 0,
      };
    } catch (err) {
      lastError = err;
      if (err instanceof TonError && err.status && err.status < 500) throw err;
      if (attempt < retries) {
        await new Promise((resolve) => setTimeout(resolve, 300 * 2 ** attempt));
      }
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new TonError(`Не удалось прочитать состояние ДАО ${canonical}`);
}

// ---------------------------------------------------------------------------
// Recipient public key for encrypted comments
// ---------------------------------------------------------------------------

const TONCENTER_API = process.env.TONCENTER_URL ?? 'https://toncenter.com/api/v2';

interface ToncenterAddressInfo {
  address?: string;
  info?: {
    type?: string;
    balance?: string | number;
    isContract?: boolean;
    public_key?: string | null;
  };
}

/**
 * Получает Ed25519 public key адреса через toncenter API.
 * Возвращает hex-строку (без 0x) или null если key не найден.
 */
export async function getRecipientPublicKey(
  address: string,
  opts: { timeoutMs?: number; retries?: number } = {},
): Promise<string | null> {
  const parsed = parseTonAddress(address);
  if (!parsed) throw new TonError('Некорректный адрес', 400);

  const { timeoutMs = 7_000, retries = 1 } = opts;
  const friendly = parsed.toString({ bounceable: false, urlSafe: true });

  const url = `${TONCENTER_API.replace(/\/+$/, '')}/getAddress?address=${encodeURIComponent(friendly)}`;

  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, {
        headers: {
          Accept: 'application/json',
          'User-Agent': USER_AGENT,
          ...(process.env.TONCENTER_API_KEY
            ? { 'X-API-Key': process.env.TONCENTER_API_KEY }
            : {}),
        },
        signal: AbortSignal.timeout(timeoutMs),
      });

      if (!res.ok) {
        throw new TonError(`toncenter API: HTTP ${res.status}`, res.status);
      }

      const data = (await res.json()) as ToncenterAddressInfo;
      const publicKey = data.info?.public_key ?? null;
      if (!publicKey || typeof publicKey !== 'string') {
        return null;
      }
      return publicKey;
    } catch (err) {
      lastError = err;
      if (err instanceof TonError && err.status && err.status < 500) throw err;
      if (attempt < retries) {
        await new Promise((resolve) => setTimeout(resolve, 300 * 2 ** attempt));
      }
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new TonError(`Не удалось получить public key для ${friendly}`);
}
