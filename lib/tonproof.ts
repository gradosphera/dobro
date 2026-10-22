/**
 * Проверка TON Connect `ton_proof` — доказательства владения кошельком.
 *
 * Формат (TON Connect):
 *
 *   message = "ton-proof-item-v2/"
 *           + int32BE(workchain)
 *           + address_hash(32)
 *           + uint32LE(domain_length)
 *           + domain
 *           + uint64LE(timestamp)
 *           + payload
 *
 *   to_sign = 0xffff + "ton-connect" + sha256(message)
 *   digest  = sha256(to_sign)
 *   signature = ed25519_sign(digest, private_key)
 *
 * Публичный ключ берётся не из ответа клиента, а из контракта кошелька
 * (get-метод `get_public_key`) — иначе подпись можно подделать.
 */

import { createHash } from 'node:crypto';

import { signVerify } from '@ton/crypto';

import { cached } from './cache.ts';
import { normalizeTonAddress, parseTonAddress } from './ton.ts';

export const TONAPI_URL = process.env.TONAPI_URL ?? 'https://tonapi.io';
const PUBLIC_KEY_TTL_MS = 5 * 60 * 1000;
const USER_AGENT = 'dobro-dao-bot/1.0 (+https://github.com/gradosphera/dobro)';

const PROOF_PREFIX = Buffer.from('ton-proof-item-v2/', 'utf8');
const SIGNATURE_PREFIX = Buffer.concat([
  Buffer.from([0xff, 0xff]),
  Buffer.from('ton-connect', 'utf8'),
]);

export class TonProofError extends Error {
  readonly status?: number;

  constructor(message: string, status?: number) {
    super(message);
    this.name = 'TonProofError';
    this.status = status;
  }
}

export interface TonProofPayload {
  address: string;
  domain: string;
  /** Unix-время в секундах. */
  timestamp: number;
  payload: string;
}

/** Внутреннее сообщение до хеширования (для тестов и отладки). */
export function tonProofMessage(input: TonProofPayload): Buffer {
  const address = parseTonAddress(input.address);
  if (!address) throw new TonProofError('Некорректный адрес кошелька', 400);
  if (!Number.isFinite(input.timestamp) || input.timestamp <= 0) {
    throw new TonProofError('Некорректный timestamp', 400);
  }

  const domain = Buffer.from(input.domain, 'utf8');
  const workchain = Buffer.alloc(4);
  workchain.writeInt32BE(address.workChain, 0);
  const domainLength = Buffer.alloc(4);
  domainLength.writeUInt32LE(domain.length, 0);
  const timestamp = Buffer.alloc(8);
  timestamp.writeBigUInt64LE(BigInt(Math.trunc(input.timestamp)), 0);

  return Buffer.concat([
    PROOF_PREFIX,
    workchain,
    address.hash,
    domainLength,
    domain,
    timestamp,
    Buffer.from(input.payload, 'utf8'),
  ]);
}

export function tonProofDigest(input: TonProofPayload): Buffer {
  const inner = createHash('sha256').update(tonProofMessage(input)).digest();
  return createHash('sha256').update(Buffer.concat([SIGNATURE_PREFIX, inner])).digest();
}

export function verifyTonProofSignature(
  input: TonProofPayload,
  signature: Buffer,
  publicKey: Buffer,
): boolean {
  if (signature.length !== 64 || publicKey.length !== 32) return false;
  try {
    return signVerify(tonProofDigest(input), signature, publicKey);
  } catch {
    return false;
  }
}

function publicKeyFromStack(data: unknown): Buffer | null {
  const value = data as {
    stack?: Array<{ type?: string; num?: string }>;
    decoded?: { public_key?: string | number };
  };

  const num = value?.stack?.[0]?.num;
  if (typeof num === 'string') {
    try {
      const hex = BigInt(num).toString(16).padStart(64, '0');
      if (hex.length <= 64) return Buffer.from(hex.slice(-64), 'hex');
    } catch {
      // попробуем decoded ниже
    }
  }

  const decoded = value?.decoded?.public_key;
  if (typeof decoded === 'string' || typeof decoded === 'number') {
    try {
      const hex = BigInt(decoded).toString(16).padStart(64, '0');
      return Buffer.from(hex.slice(-64), 'hex');
    } catch {
      return null;
    }
  }

  return null;
}

/**
 * Публичный ключ кошелька из блокчейна. Кэшируется на 5 минут:
 * ключ меняется только при пересоздании кошелька.
 */
export async function getWalletPublicKey(
  address: string,
  opts: { timeoutMs?: number; retries?: number } = {},
): Promise<Buffer> {
  const canonical = normalizeTonAddress(address);
  if (!canonical) throw new TonProofError('Некорректный адрес кошелька', 400);

  return cached(`pubkey:${canonical}`, PUBLIC_KEY_TTL_MS, async () => {
    const { timeoutMs = 7_000, retries = 1 } = opts;
    const url = `${TONAPI_URL.replace(/\/+$/, '')}/v2/blockchain/accounts/${encodeURIComponent(
      canonical,
    )}/methods/get_public_key`;

    let lastError: unknown;
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const res = await fetch(url, {
          headers: {
            Accept: 'application/json',
            'User-Agent': USER_AGENT,
            ...(process.env.TONAPI_KEY ? { Authorization: `Bearer ${process.env.TONAPI_KEY}` } : {}),
          },
          signal: AbortSignal.timeout(timeoutMs),
        });

        if (res.status === 404) {
          throw new TonProofError(`Кошелёк не найден: ${canonical}`, 404);
        }
        if (!res.ok) {
          throw new TonProofError(`tonapi: HTTP ${res.status}`, res.status);
        }

        const key = publicKeyFromStack(await res.json());
        if (!key) {
          throw new TonProofError(
            `Кошелёк ${canonical} не отдаёт get_public_key (неподдерживаемый тип кошелька)`,
            422,
          );
        }
        return key;
      } catch (err) {
        lastError = err;
        if (err instanceof TonProofError && err.status && err.status < 500) throw err;
        if (attempt < retries) {
          await new Promise((resolve) => setTimeout(resolve, 300 * 2 ** attempt));
        }
      }
    }

    throw lastError instanceof Error
      ? lastError
      : new TonProofError(`Не удалось получить публичный ключ ${canonical}`);
  });
}
