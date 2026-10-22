/**
 * Local-first режим: публичный снапшот организации + формат on-chain
 * аттестации. Здесь нет Node-зависимостей — модуль используется и
 * скриптом сборки снапшота, и браузером.
 *
 * Почему снапшот: dobro.ru не отдаёт CORS, поэтому браузер не может
 * обратиться к его API напрямую. Публичные данные организации (без ПДн)
 * снимаются оператором/CI и кладутся в `public/data/orgs/<id>.json`.
 *
 * Аттестация часов пишется в блокчейн текстовым комментарием от кошелька
 * лидера (owner DAO). Транзакция — и есть подпись; отдельный сервер и БД
 * не нужны. Читатель собирает комментарии с префиксом `dobro/att/1`.
 */

export const SNAPSHOT_VERSION = 1;
export const ATTESTATION_PREFIX = 'dobro/att/1';
export const MAX_COMMENT_BYTES = 120;
export const MAX_HOURS = 744;

export interface SnapshotDoc {
  id: string;
  name: string;
  size: number | null;
  sha256: string;
  url: string;
}

export interface OrgSnapshot {
  version: typeof SNAPSHOT_VERSION;
  orgId: number;
  name: string | null;
  verified: boolean;
  verifiedByEsia: boolean;
  hours: number | null;
  dao: string;
  daoOwner: string | null;
  jetton: string | null;
  doc: SnapshotDoc | null;
  fetchedAt: string;
}

export interface SnapshotIndex {
  version: typeof SNAPSHOT_VERSION;
  generatedAt: string;
  orgs: Array<{
    orgId: number;
    name: string | null;
    dao: string;
    docSha256: string | null;
  }>;
}

export interface AttestationPayload {
  version: 1;
  orgId: number;
  volunteerId: number;
  period: string;
  hours: number;
  docSha256Prefix: string;
}

const PERIOD_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const HASH_RE = /^[0-9a-f]{16}$/;

export function isPeriod(value: unknown): value is string {
  return typeof value === 'string' && PERIOD_RE.test(value);
}

export function normalizeHours(value: unknown): number | null {
  const hours = Number(value);
  if (!Number.isFinite(hours) || hours <= 0 || hours > MAX_HOURS) return null;
  return Math.floor(hours * 100 + 1e-9) / 100;
}

export function claimAmount(hours: number): number {
  if (!Number.isFinite(hours) || hours <= 0) return 0;
  return Math.floor(hours + 1e-9);
}

function compactHours(hours: number): string {
  return String(hours);
}

/**
 * Компактный комментарий: `dobro/att/1 o=… v=… p=YYYY-MM h=… d=<16hex>`.
 * `d` — первые 16 hex sha256 документа, в котором найден адрес DAO
 * (слой B). Ограничение стандартного текстового комментария — 127 байт.
 */
export function encodeAttestation(input: AttestationPayload): string {
  const orgId = Math.trunc(input.orgId);
  const volunteerId = Math.trunc(input.volunteerId);
  const hours = normalizeHours(input.hours);
  const hash = input.docSha256Prefix.toLowerCase();

  if (!Number.isInteger(orgId) || orgId <= 0) throw new Error('orgId должен быть > 0');
  if (!Number.isInteger(volunteerId) || volunteerId <= 0) {
    throw new Error('volunteerId должен быть > 0');
  }
  if (!isPeriod(input.period)) throw new Error('period должен быть YYYY-MM');
  if (hours == null) throw new Error(`hours должен быть в диапазоне (0, ${MAX_HOURS}]`);
  if (!HASH_RE.test(hash)) throw new Error('docSha256Prefix должен быть 16 hex-символов');

  const text = `${ATTESTATION_PREFIX} o=${orgId} v=${volunteerId} p=${input.period} h=${compactHours(hours)} d=${hash}`;
  if (new TextEncoder().encode(text).length > MAX_COMMENT_BYTES) {
    throw new Error(`комментарий длиннее ${MAX_COMMENT_BYTES} байт`);
  }
  return text;
}

export function decodeAttestation(text: string): AttestationPayload | null {
  if (typeof text !== 'string') return null;
  const trimmed = text.trim();
  if (!trimmed.startsWith(ATTESTATION_PREFIX)) return null;

  const rest = trimmed.slice(ATTESTATION_PREFIX.length).trim();
  const fields = new Map<string, string>();
  for (const part of rest.split(/\s+/)) {
    if (!part) continue;
    const eq = part.indexOf('=');
    if (eq <= 0) return null;
    fields.set(part.slice(0, eq), part.slice(eq + 1));
  }

  const orgId = Number(fields.get('o'));
  const volunteerId = Number(fields.get('v'));
  const period = fields.get('p') ?? '';
  const hours = normalizeHours(fields.get('h'));
  const hash = (fields.get('d') ?? '').toLowerCase();

  if (!Number.isInteger(orgId) || orgId <= 0) return null;
  if (!Number.isInteger(volunteerId) || volunteerId <= 0) return null;
  if (!isPeriod(period)) return null;
  if (hours == null) return null;
  if (!HASH_RE.test(hash)) return null;

  return { version: 1, orgId, volunteerId, period, hours, docSha256Prefix: hash };
}

export function attestationKey(payload: Pick<AttestationPayload, 'orgId' | 'volunteerId' | 'period'>): string {
  return `${payload.orgId}:${payload.volunteerId}:${payload.period}`;
}
