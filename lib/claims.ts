/**
 * Клейм волонтёра: привязка volunteerId к кошельку получателя.
 *
 * Волонтёр отправляет 0.01 TON на owner DAO с текстовым комментарием
 * `dobro/claim/1 o=… v=… p=YYYY-MM`. Адрес получателя — sender транзакции,
 * поэтому в комментарии его нет.
 */

import { isPeriod } from './snapshot.ts';

export const CLAIM_PREFIX = 'dobro/claim/1';
export const MAX_CLAIM_BYTES = 127;

export interface ClaimPayload {
  version: 1;
  orgId: number;
  volunteerId: number;
  period: string;
}

export function payoutKey(
  payload: Pick<ClaimPayload, 'orgId' | 'volunteerId' | 'period'>,
): string {
  return `${payload.orgId}:${payload.volunteerId}:${payload.period}`;
}

export function encodeClaim(input: ClaimPayload): string {
  const orgId = Math.trunc(input.orgId);
  const volunteerId = Math.trunc(input.volunteerId);

  if (!Number.isInteger(orgId) || orgId <= 0) throw new Error('orgId должен быть > 0');
  if (!Number.isInteger(volunteerId) || volunteerId <= 0) {
    throw new Error('volunteerId должен быть > 0');
  }
  if (!isPeriod(input.period)) throw new Error('period должен быть YYYY-MM');

  const text = `${CLAIM_PREFIX} o=${orgId} v=${volunteerId} p=${input.period}`;
  if (new TextEncoder().encode(text).length > MAX_CLAIM_BYTES) {
    throw new Error(`комментарий длиннее ${MAX_CLAIM_BYTES} байт`);
  }
  return text;
}

export function decodeClaim(text: string): ClaimPayload | null {
  if (typeof text !== 'string') return null;
  const trimmed = text.trim();
  if (!trimmed.startsWith(CLAIM_PREFIX)) return null;

  const rest = trimmed.slice(CLAIM_PREFIX.length).trim();
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

  if (!Number.isInteger(orgId) || orgId <= 0) return null;
  if (!Number.isInteger(volunteerId) || volunteerId <= 0) return null;
  if (!isPeriod(period)) return null;

  return { version: 1, orgId, volunteerId, period };
}
