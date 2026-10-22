-- Схема Neon Postgres для «Добро.DAO».
--
-- Храним только публичные идентификаторы dobro.ru (org_id, volunteer_id),
-- TON-адреса, часы и статусы. ФИО, email и телефоны не сохраняем —
-- это снижает риск по п. 3.7 политики конфиденциальности dobro.ru.
--
-- Все адреса TON хранятся в bounceable-форме (`EQ…`).
-- Денежные суммы — в минимальных единицах (BLG decimals = 0).

create table if not exists schema_migrations (
  version text primary key,
  applied_at timestamptz not null default now()
);

create table if not exists organizations (
  org_id bigint primary key,
  name text,
  verified boolean not null default false,
  verified_by_esia boolean not null default false,
  hours numeric(14, 1),
  dao_address text,
  dao_owner text,
  jetton_address text,
  doc_id text,
  doc_name text,
  doc_sha256 text,
  bound_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists members (
  id bigserial primary key,
  org_id bigint not null references organizations(org_id) on delete cascade,
  volunteer_id bigint not null,
  wallet text not null,
  role text not null default 'volunteer' check (role in ('leader', 'volunteer')),
  status text not null default 'pending' check (status in ('pending', 'approved', 'revoked')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (org_id, volunteer_id)
);

create index if not exists members_wallet_idx on members (wallet);

create table if not exists attestations (
  id bigserial primary key,
  org_id bigint not null references organizations(org_id) on delete cascade,
  volunteer_id bigint not null,
  wallet text not null,
  -- Первое число месяца, за который заявлены часы. Нормализуется в приложении.
  period_month date not null,
  hours numeric(8, 2) not null check (hours > 0),
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
  source text not null default 'self' check (source in ('self', 'dobro')),
  proof_url text,
  approved_by text,
  approved_at timestamptz,
  created_at timestamptz not null default now(),
  unique (org_id, volunteer_id, period_month)
);

create index if not exists attestations_org_status_idx on attestations (org_id, status);
create index if not exists attestations_wallet_idx on attestations (wallet);

create table if not exists claims (
  id bigserial primary key,
  attestation_id bigint not null unique references attestations(id) on delete cascade,
  wallet text not null,
  -- 1 BLG за целый подтверждённый час (decimals = 0).
  amount bigint not null check (amount > 0),
  status text not null default 'pending' check (status in ('pending', 'paid', 'failed')),
  query_id text,
  tx_hash text,
  created_at timestamptz not null default now(),
  paid_at timestamptz
);

create index if not exists claims_status_idx on claims (status);
create index if not exists claims_wallet_idx on claims (wallet);
