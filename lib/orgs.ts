/**
 * Репозиторий привязок «организация dobro.ru ↔ DAO ↔ жетон».
 * Требует настроенной БД (lib/db.ts); без неё вызывающий код получает 503.
 */

import { query, queryOne } from './db.ts';

export interface OrgBinding {
  orgId: number;
  name: string | null;
  verified: boolean;
  verifiedByEsia: boolean;
  hours: number | null;
  daoAddress: string | null;
  daoOwner: string | null;
  jettonAddress: string | null;
  docId: string | null;
  docName: string | null;
  docSha256: string | null;
  boundAt: string | null;
}

interface BindingRow {
  org_id: string | number;
  name: string | null;
  verified: boolean;
  verified_by_esia: boolean;
  hours: string | number | null;
  dao_address: string | null;
  dao_owner: string | null;
  jetton_address: string | null;
  doc_id: string | null;
  doc_name: string | null;
  doc_sha256: string | null;
  bound_at: string | Date | null;
}

function isoDateTime(value: string | Date | null): string | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function mapBinding(row: BindingRow): OrgBinding {
  return {
    orgId: Number(row.org_id),
    name: row.name,
    verified: Boolean(row.verified),
    verifiedByEsia: Boolean(row.verified_by_esia),
    hours: row.hours == null ? null : Number(row.hours),
    daoAddress: row.dao_address,
    daoOwner: row.dao_owner,
    jettonAddress: row.jetton_address,
    docId: row.doc_id,
    docName: row.doc_name,
    docSha256: row.doc_sha256,
    boundAt: isoDateTime(row.bound_at),
  };
}

export async function getBinding(orgId: number): Promise<OrgBinding | null> {
  const row = await queryOne<BindingRow>('select * from organizations where org_id = $1', [orgId]);
  return row ? mapBinding(row) : null;
}

export interface SaveBindingInput {
  orgId: number;
  name: string | null;
  verified: boolean;
  verifiedByEsia: boolean;
  hours: number | null;
  daoAddress: string;
  daoOwner: string;
  jettonAddress: string | null;
  docId: string | null;
  docName: string | null;
  docSha256: string | null;
}

export async function saveBinding(input: SaveBindingInput): Promise<OrgBinding> {
  const row = await queryOne<BindingRow>(
    `insert into organizations
       (org_id, name, verified, verified_by_esia, hours,
        dao_address, dao_owner, jetton_address,
        doc_id, doc_name, doc_sha256, bound_at, updated_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, now(), now())
     on conflict (org_id) do update set
       name = excluded.name,
       verified = excluded.verified,
       verified_by_esia = excluded.verified_by_esia,
       hours = excluded.hours,
       dao_address = excluded.dao_address,
       dao_owner = excluded.dao_owner,
       jetton_address = excluded.jetton_address,
       doc_id = excluded.doc_id,
       doc_name = excluded.doc_name,
       doc_sha256 = excluded.doc_sha256,
       bound_at = now(),
       updated_at = now()
     returning *`,
    [
      input.orgId,
      input.name,
      input.verified,
      input.verifiedByEsia,
      input.hours,
      input.daoAddress,
      input.daoOwner,
      input.jettonAddress,
      input.docId,
      input.docName,
      input.docSha256,
    ],
  );

  if (!row) throw new Error('Не удалось сохранить привязку организации');
  return mapBinding(row);
}

/** Лидер организации = owner DAO; фиксируем его кошелёк в members. */
export async function upsertLeader(
  orgId: number,
  volunteerId: number,
  wallet: string,
): Promise<void> {
  await query(
    `insert into members (org_id, volunteer_id, wallet, role, status)
     values ($1, $2, $3, 'leader', 'approved')
     on conflict (org_id, volunteer_id) do update set
       wallet = excluded.wallet,
       role = 'leader',
       status = 'approved',
       updated_at = now()`,
    [orgId, volunteerId, wallet],
  );
}
