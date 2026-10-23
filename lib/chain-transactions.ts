/**
 * История транзакций аккаунта через toncenter v2.
 *
 * tonapi для аккаунта с длинной историей отдаёт страницы слишком медленно,
 * поэтому индексер выплат использует toncenter. Текстовые комментарии
 * приходят либо декодированными (`in_msg.message`), либо в `msg_data`:
 * `dataText` (base64 текста) или `dataRaw` (BOC тела).
 */

import { parseTextComment } from './ton-comment.ts';

export const TONCENTER_URL =
  process.env.TONCENTER_URL ?? 'https://toncenter.com/api/v2';
const USER_AGENT = 'dobro-dao-bot/1.0 (+https://github.com/gradosphera/dobro)';

export interface ChainAccountRef {
  address: string;
}

export interface ChainMessage {
  source?: ChainAccountRef | null;
  destination?: ChainAccountRef | null;
  value?: string;
  decoded_body?: { text?: string } | null;
}

export interface ChainTransaction {
  hash: string;
  lt: string;
  now: number;
  success: boolean;
  in_msg?: ChainMessage | null;
}

export class ChainTransactionsError extends Error {
  readonly status?: number;

  constructor(message: string, status?: number) {
    super(message);
    this.name = 'ChainTransactionsError';
    this.status = status;
  }
}

interface ToncenterMessage {
  source?: string;
  destination?: string;
  value?: string;
  message?: string;
  msg_data?: {
    '@type'?: string;
    text?: string;
    body?: string;
  };
}

interface ToncenterTransaction {
  transaction_id?: { lt?: string; hash?: string };
  utime?: number;
  in_msg?: ToncenterMessage;
  description?: {
    compute_ph?: { success?: boolean };
    action_ph?: { success?: boolean };
  };
}

function decodeMsgData(message: ToncenterMessage): string | null {
  const data = message.msg_data;
  if (data?.['@type'] === 'msg.dataText' && typeof data.text === 'string') {
    try {
      return Buffer.from(data.text, 'base64').toString('utf8').trim() || null;
    } catch {
      // попробуем raw body ниже
    }
  }
  if (data?.['@type'] === 'msg.dataRaw' && typeof data.body === 'string') {
    const text = parseTextComment(data.body);
    if (text != null) return text;
  }
  const text = typeof message.message === 'string' ? message.message.trim() : '';
  return text || null;
}

function isSuccess(tx: ToncenterTransaction): boolean {
  return tx.description?.compute_ph?.success !== false && tx.description?.action_ph?.success !== false;
}

function toChainTransaction(tx: ToncenterTransaction): ChainTransaction | null {
  const lt = tx.transaction_id?.lt;
  const hash = tx.transaction_id?.hash;
  if (!lt || !hash) return null;
  const message = tx.in_msg;
  return {
    hash,
    lt,
    now: Number(tx.utime ?? 0),
    success: isSuccess(tx),
    in_msg: message
      ? {
          source: message.source ? { address: message.source } : null,
          destination: message.destination ? { address: message.destination } : null,
          value: message.value,
          decoded_body: { text: decodeMsgData(message) ?? undefined },
        }
      : null,
  };
}

export interface FetchTransactionsOptions {
  limit?: number;
  maxTransactions?: number;
  timeoutMs?: number;
  retries?: number;
  fetchImpl?: typeof fetch;
}

async function getJson(
  url: string,
  timeoutMs: number,
  retries: number,
  fetchImpl: typeof fetch,
): Promise<unknown> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetchImpl(url, {
        headers: {
          Accept: 'application/json',
          'User-Agent': USER_AGENT,
          ...(process.env.TONCENTER_API_KEY
            ? { 'X-API-Key': process.env.TONCENTER_API_KEY }
            : {}),
        },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (res.status === 429 || res.status >= 500) {
        throw new ChainTransactionsError(`toncenter: HTTP ${res.status}`, res.status);
      }
      if (!res.ok) {
        throw new ChainTransactionsError(`toncenter: HTTP ${res.status}`, res.status);
      }
      return await res.json();
    } catch (err) {
      lastError = err;
      const status = err instanceof ChainTransactionsError ? err.status : undefined;
      if (status && status < 500 && status !== 429) throw err;
      if (attempt < retries) {
        await new Promise((resolve) => setTimeout(resolve, 300 * 2 ** attempt));
      }
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new ChainTransactionsError('Не удалось прочитать транзакции toncenter');
}

/** Возвращает транзакции от новых к старым. */
export async function fetchAccountTransactions(
  address: string,
  opts: FetchTransactionsOptions = {},
): Promise<ChainTransaction[]> {
  const {
    limit = 100,
    maxTransactions = 2_000,
    timeoutMs = 15_000,
    retries = 2,
    fetchImpl = fetch,
  } = opts;

  const base = TONCENTER_URL.replace(/\/+$/, '');
  const result: ChainTransaction[] = [];
  const seen = new Set<string>();
  let toLt: string | null = null;

  for (let page = 0; page < Math.ceil(maxTransactions / limit); page++) {
    const params = new URLSearchParams({
      address,
      limit: String(Math.min(limit, maxTransactions - result.length)),
      archival: 'true',
    });
    if (toLt) params.set('to_lt', toLt);
    const url = `${base}/getTransactions?${params}`;
    const payload = (await getJson(url, timeoutMs, retries, fetchImpl)) as {
      ok?: boolean;
      error?: string;
      result?: ToncenterTransaction[];
    };
    if (payload.ok === false) {
      throw new ChainTransactionsError(payload.error ?? 'toncenter вернул ошибку');
    }

    const transactions = Array.isArray(payload.result) ? payload.result : [];
    if (transactions.length === 0) break;

    let added = 0;
    for (const raw of transactions) {
      const tx = toChainTransaction(raw);
      if (!tx || seen.has(tx.hash)) continue;
      seen.add(tx.hash);
      result.push(tx);
      added++;
      if (result.length >= maxTransactions) break;
    }
    if (result.length >= maxTransactions) break;

    const next = transactions[transactions.length - 1]?.transaction_id?.lt ?? null;
    if (!next || next === toLt) break;
    toLt = next;
    if (added === 0) break;
  }

  return result;
}
