/**
 * Слой B: доказательство связи организации dobro.ru с DAO.
 *
 * Организация прикладывает к своей карточке текстовый документ
 * (`vote.txt`) с адресом DAO. Документ публичен, скачивается без
 * авторизации, поэтому сервис может проверить его в любой момент.
 *
 *   GET /api/v2/organizations/{id}?with=organizer
 *       -> docs[] { id, name, size, url }
 *
 * Безопасность: скачиваются только https-ссылки с хостов из allowlist,
 * только текстовые расширения, с ограничением размера и времени.
 */

import { createHash } from 'node:crypto';

import type { Deadline } from './dobro.ts';
import { normalizeTonAddress, parseTonAddress } from './ton.ts';

export const MAX_DOC_BYTES = 64 * 1024;
const MAX_DOCS_PER_SCAN = 5;
const FETCH_TIMEOUT_MS = 5_000;
const USER_AGENT = 'dobro-dao-bot/1.0 (+https://github.com/gradosphera/dobro)';

const ALLOWED_HOSTS = new Set(['storage.yandexcloud.net', 'dobro.ru']);
const TEXT_EXTENSIONS = /\.(txt|md|json)$/i;

/**
 * Адрес TON: user-friendly (48 символов, EQ/UQ/kQ/0Q) или raw (`0:hex`).
 * Границы не дают выхватить адрес из середины base64-строки.
 */
const ADDRESS_RE =
  /(?<![A-Za-z0-9_-])(?:EQ|UQ|kQ|0Q)[A-Za-z0-9_-]{46}(?![A-Za-z0-9_-])|(?<![A-Za-z0-9_])-?\d+:[0-9a-fA-F]{64}(?![A-Za-z0-9_])/g;

export interface OrgDocument {
  id: string;
  name: string;
  size?: number | null;
  url: string;
}

export type DocStatus = 'match' | 'no-address' | 'unreachable';

export interface DocScanEntry {
  id: string;
  name: string;
  size: number | null;
  status: DocStatus;
  addresses?: string[];
  sha256?: string;
  error?: string;
}

export interface DocProof {
  found: boolean;
  dao: string;
  document: DocScanEntry | null;
  addresses: string[];
  scanned: DocScanEntry[];
  skipped: Array<{ id: string; name: string; reason: string }>;
}

export interface DocumentContent {
  document: OrgDocument;
  text: string;
  bytes: number;
  sha256: string;
  finalUrl: string;
}

export function extractTonAddresses(text: string): string[] {
  const seen = new Set<string>();
  const result: string[] = [];

  for (const candidate of text.match(ADDRESS_RE) ?? []) {
    const parsed = parseTonAddress(candidate);
    if (!parsed) continue;
    const key = parsed.toRawString();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(parsed.toString({ bounceable: true, urlSafe: true }));
  }

  return result;
}

function isTextDocument(doc: OrgDocument): boolean {
  return TEXT_EXTENSIONS.test(doc.name);
}

function validateUrl(doc: OrgDocument): { url: URL } | { error: string } {
  let url: URL;
  try {
    url = new URL(doc.url, 'https://dobro.ru');
  } catch {
    return { error: 'некорректная ссылка' };
  }
  if (url.protocol !== 'https:') return { error: 'только https' };
  if (!ALLOWED_HOSTS.has(url.hostname)) return { error: `хост не разрешён: ${url.hostname}` };
  return { url };
}

function decodeUtf8(buffer: Uint8Array): string {
  return new TextDecoder('utf-8')
    .decode(buffer)
    .replace(/^\uFEFF/, '')
    .replace(/\r\n?/g, '\n')
    .trim();
}

/**
 * Скачивает текстовый документ. Возвращает null, если документ не текст,
 * слишком большой, лежит на неразрешённом хосте или недоступен.
 */
export async function fetchOrgDocumentText(
  doc: OrgDocument,
  opts: { deadline?: Deadline; timeoutMs?: number } = {},
): Promise<DocumentContent | null> {
  if (!isTextDocument(doc)) return null;

  const checked = validateUrl(doc);
  if ('error' in checked) return null;
  if (typeof doc.size === 'number' && doc.size > MAX_DOC_BYTES) return null;

  const budget = opts.deadline
    ? Math.min(opts.timeoutMs ?? FETCH_TIMEOUT_MS, Math.max(opts.deadline.remainingMs, 500))
    : (opts.timeoutMs ?? FETCH_TIMEOUT_MS);

  let res: Response;
  try {
    res = await fetch(checked.url, {
      headers: {
        Accept: 'text/plain, text/markdown;q=0.9, application/json;q=0.8, */*;q=0.1',
        'Accept-Language': 'ru-RU,ru;q=0.9',
        'User-Agent': USER_AGENT,
      },
      signal: AbortSignal.timeout(budget),
      redirect: 'follow',
    });
  } catch {
    return null;
  }

  if (!res.ok) return null;
  // Редирект не должен уводить с разрешённого хоста.
  try {
    if (!ALLOWED_HOSTS.has(new URL(res.url).hostname)) return null;
  } catch {
    return null;
  }

  const declared = Number(res.headers.get('content-length') ?? 0);
  if (declared > MAX_DOC_BYTES) return null;

  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await res.arrayBuffer());
  } catch {
    return null;
  }
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_DOC_BYTES) return null;

  const text = decodeUtf8(bytes);
  if (!text) return null;

  return {
    document: doc,
    text,
    bytes: bytes.byteLength,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    finalUrl: res.url,
  };
}

function byPriority(a: OrgDocument, b: OrgDocument): number {
  const vote = (d: OrgDocument) => (/^vote\.(txt|md)$/i.test(d.name) ? 0 : 1);
  const diff = vote(a) - vote(b);
  if (diff !== 0) return diff;
  return (a.size ?? Number.MAX_SAFE_INTEGER) - (b.size ?? Number.MAX_SAFE_INTEGER);
}

/**
 * Ищет в документах организации адрес DAO. Останавливается на первом
 * совпадении, но не дольше общего бюджета времени.
 */
export async function findDaoProof(
  documents: OrgDocument[],
  dao: string,
  opts: { deadline?: Deadline; maxDocs?: number } = {},
): Promise<DocProof> {
  const canonical = normalizeTonAddress(dao);
  if (!canonical) throw new Error('Некорректный адрес DAO');

  const scanned: DocScanEntry[] = [];
  const skipped: Array<{ id: string; name: string; reason: string }> = [];
  const limit = Math.min(opts.maxDocs ?? MAX_DOCS_PER_SCAN, MAX_DOCS_PER_SCAN);

  let attempts = 0;
  for (const doc of [...documents].sort(byPriority)) {
    if (attempts >= limit || opts.deadline?.expired) {
      skipped.push({ id: doc.id, name: doc.name, reason: 'лимит сканирования' });
      continue;
    }
    if (!isTextDocument(doc)) {
      skipped.push({ id: doc.id, name: doc.name, reason: 'не текстовый формат' });
      continue;
    }
    if (typeof doc.size === 'number' && doc.size > MAX_DOC_BYTES) {
      skipped.push({ id: doc.id, name: doc.name, reason: 'слишком большой файл' });
      continue;
    }
    if ('error' in validateUrl(doc)) {
      skipped.push({ id: doc.id, name: doc.name, reason: 'неразрешённый источник' });
      continue;
    }

    attempts++;
    const content = await fetchOrgDocumentText(doc, { deadline: opts.deadline });
    if (!content) {
      scanned.push({ id: doc.id, name: doc.name, size: doc.size ?? null, status: 'unreachable' });
      continue;
    }

    const addresses = extractTonAddresses(content.text);
    const matched = addresses.includes(canonical);
    const entry: DocScanEntry = {
      id: doc.id,
      name: doc.name,
      size: doc.size ?? content.bytes,
      status: matched ? 'match' : 'no-address',
      addresses,
      sha256: content.sha256,
    };
    scanned.push(entry);

    if (matched) {
      return {
        found: true,
        dao: canonical,
        document: entry,
        addresses,
        scanned,
        skipped,
      };
    }
  }

  return { found: false, dao: canonical, document: null, addresses: [], scanned, skipped };
}
