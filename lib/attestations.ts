/**
 * Аттестации часов и начисления BLG.
 *
 * Модель v1: лидер организации (owner DAO) сам вносит часы волонтёра за
 * месяц. Запись сразу `approved`, клейм создаётся на floor(hours) BLG
 * (1 BLG за целый подтверждённый час). Уникальность
 * (org_id, volunteer_id, period_month) делает повторный вызов идемпотентным.
 */

import { query, queryOne } from './db.ts';

export const MAX_HOURS_PER_MONTH = 24 * 31;

/** `2026-10`, `2026-10-15` -> `2026-10-01`. */
export function normalizePeriod(value: unknown): string | null {
  const match = String(value ?? '')
    .trim()
    .match(/^(\d{4})-(\d{2})(?:-\d{2})?$/);
  if (!match) return null;

  const year = Number(match[1]);
  const month = Number(match[2]);
  if (!Number.isInteger(year) || year < 2000 || year > 2100) return null;
  if (!Number.isInteger(month) || month < 1 || month > 12) return null;

  return `${match[1]}-${match[2]}-01`;
}

/** 1 BLG за целый час; дробная часть отбрасывается. */
export function blgForHours(hours: number): number {
  if (!Number.isFinite(hours) || hours <= 0) return 0;
  return Math.floor(hours + 1e-9);
}

export interface Attestation {
  id: number;
  orgId: number;
  volunteerId: number;
  wallet: string;
  periodMonth: string;
  hours: number;
  status: string;
  source: string;
  proofUrl: string | null;
  approvedBy: string | null;
  approvedAt: string | null;
  createdAt: string | null;
  claimAmount: number | null;
  claimStatus: string | null;
  claimTxHash: string | null;
}

interface AttestationRow {
  id: string | number;
  org_id: string | number;
  volunteer_id: string | number;
  wallet: string;
  period_month: string | Date;
  hours: string | number;
  status: string;
  source: string;
  proof_url: string | null;
  approved_by: string | null;
  approved_at: string | Date | null;
  created_at: string | Date | null;
  claim_amount: string | number | null;
  claim_status: string | null;
  claim_tx_hash: string | null;
}

const SELECT_WITH_CLAIM = `
  select a.*, c.amount as claim_amount, c.status as claim_status, c.tx_hash as claim_tx_hash
  from attestations a
  left join claims c on c.attestation_id = a.id`;

function isoDate(value: string | Date): string {
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value).slice(0, 10);
}

function isoDateTime(value: string | Date | null): string | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function mapAttestation(row: AttestationRow): Attestation {
  return {
    id: Number(row.id),
    orgId: Number(row.org_id),
    volunteerId: Number(row.volunteer_id),
    wallet: row.wallet,
    periodMonth: isoDate(row.period_month),
    hours: Number(row.hours),
    status: row.status,
    source: row.source,
    proofUrl: row.proof_url,
    approvedBy: row.approved_by,
    approvedAt: isoDateTime(row.approved_at),
    createdAt: isoDateTime(row.created_at),
    claimAmount: row.claim_amount == null ? null : Number(row.claim_amount),
    claimStatus: row.claim_status,
    claimTxHash: row.claim_tx_hash,
  };
}

export async function listAttestations(orgId: number, limit = 100): Promise<Attestation[]> {
  const safeLimit = Math.min(Math.max(Math.trunc(limit) || 100, 1), 500);
  const rows = await query<AttestationRow>(
    `${SELECT_WITH_CLAIM} where a.org_id = $1 order by a.created_at desc limit $2`,
    [orgId, safeLimit],
  );
  return rows.map(mapAttestation);
}

export async function getAttestation(id: number): Promise<Attestation | null> {
  const row = await queryOne<AttestationRow>(`${SELECT_WITH_CLAIM} where a.id = $1`, [id]);
  return row ? mapAttestation(row) : null;
}

export async function getAttestationByPeriod(
  orgId: number,
  volunteerId: number,
  periodMonth: string,
): Promise<Attestation | null> {
  const row = await queryOne<AttestationRow>(
    `${SELECT_WITH_CLAIM} where a.org_id = $1 and a.volunteer_id = $2 and a.period_month = $3`,
    [orgId, volunteerId, periodMonth],
  );
  return row ? mapAttestation(row) : null;
}

export interface CreateAttestationInput {
  orgId: number;
  volunteerId: number;
  wallet: string;
  periodMonth: string;
  hours: number;
  proofUrl?: string | null;
  approvedBy: string;
  source?: 'self' | 'dobro';
}

export interface CreateAttestationResult {
  created: boolean;
  attestation: Attestation;
  amount: number;
}

/**
 * Создаёт подтверждённую аттестацию и (если есть целые часы) клейм.
 * Повторный вызов за тот же месяц возвращает существующую запись.
 */
export async function createApprovedAttestation(
  input: CreateAttestationInput,
): Promise<CreateAttestationResult> {
  const amount = blgForHours(input.hours);

  const inserted = await queryOne<{ id: string | number }>(
    `insert into attestations
       (org_id, volunteer_id, wallet, period_month, hours, status, source,
        proof_url, approved_by, approved_at)
     values ($1, $2, $3, $4, $5, 'approved', $6, $7, $8, now())
     on conflict (org_id, volunteer_id, period_month) do nothing
     returning id`,
    [
      input.orgId,
      input.volunteerId,
      input.wallet,
      input.periodMonth,
      input.hours,
      input.source ?? 'self',
      input.proofUrl ?? null,
      input.approvedBy,
    ],
  );

  if (!inserted) {
    const existing = await getAttestationByPeriod(
      input.orgId,
      input.volunteerId,
      input.periodMonth,
    );
    if (!existing) throw new Error('Аттестация не создалась и не найдена');
    return { created: false, attestation: existing, amount: existing.claimAmount ?? 0 };
  }

  const id = Number(inserted.id);
  if (amount > 0) {
    await query(
      `insert into claims (attestation_id, wallet, amount)
       values ($1, $2, $3)
       on conflict (attestation_id) do nothing`,
      [id, input.wallet, amount],
    );
  }

  const attestation = await getAttestation(id);
  if (!attestation) throw new Error('Аттестация создана, но не читается');
  return { created: true, attestation, amount };
}
