/**
 * Публичный снапшот организации для local-first режима.
 *
 *   npm run snapshot -- --org 10072836 --dao EQDExlp6…
 *
 * Скрипт снимает карточку dobro.ru, ищет адрес DAO в документах (слой B),
 * читает owner/жетон DAO и пишет JSON в `public/data/orgs/<id>.json`.
 * В снапшоте нет персональных данных — только публичная карточка,
 * отпечаток документа и параметры DAO.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { getOrganization } from '../lib/dobro.ts';
import { findDaoProof } from '../lib/docs.ts';
import { SNAPSHOT_VERSION, type OrgSnapshot, type SnapshotIndex } from '../lib/snapshot.ts';
import { getDao, normalizeTonAddress } from '../lib/ton.ts';

const OUT_DIR = process.env.SNAPSHOT_OUT ?? 'public/data';

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  if (index >= 0 && index + 1 < process.argv.length) return process.argv[index + 1];
  const inline = process.argv.find((value) => value.startsWith(`--${name}=`));
  return inline?.slice(name.length + 3);
}

function positiveInt(value: string | undefined, fallback?: number): number {
  const parsed = Number(value);
  if (Number.isInteger(parsed) && parsed > 0) return parsed;
  if (fallback) return fallback;
  throw new Error(`Ожидалось положительное целое, получено: ${value ?? '(пусто)'}`);
}

async function updateIndex(snapshot: OrgSnapshot, outDir: string): Promise<void> {
  const path = join(outDir, 'index.json');
  let existing: SnapshotIndex | null = null;
  try {
    existing = JSON.parse(await readFile(path, 'utf8')) as SnapshotIndex;
  } catch {
    existing = null;
  }

  const orgs = (existing?.orgs ?? []).filter((entry) => entry.orgId !== snapshot.orgId);
  orgs.push({
    orgId: snapshot.orgId,
    name: snapshot.name,
    dao: snapshot.dao,
    docSha256: snapshot.doc?.sha256 ?? null,
  });
  orgs.sort((a, b) => a.orgId - b.orgId);

  const index: SnapshotIndex = {
    version: SNAPSHOT_VERSION,
    generatedAt: new Date().toISOString(),
    orgs,
  };
  await writeFile(path, `${JSON.stringify(index, null, 2)}\n`);
}

async function main() {
  const orgId = positiveInt(arg('org'));
  const daoInput = arg('dao');
  if (!daoInput) throw new Error('Укажите адрес DAO: --dao EQ…');

  const dao = normalizeTonAddress(daoInput);
  if (!dao) throw new Error(`Некорректный адрес DAO: ${daoInput}`);

  const org = await getOrganization(orgId);
  const proof = await findDaoProof(org.docs ?? [], dao);
  if (!proof.found || !proof.document?.sha256) {
    throw new Error(`Адрес ${dao} не найден в документах организации ${orgId}`);
  }

  const docUrl = (org.docs ?? []).find((doc) => doc.id === proof.document?.id)?.url ?? '';
  const state = await getDao(dao);

  const snapshot: OrgSnapshot = {
    version: SNAPSHOT_VERSION,
    orgId,
    name: org.name ?? null,
    verified: Boolean(org.verified),
    verifiedByEsia: Boolean(org.verifiedByEsia),
    hours: Number(org.organizer?.statistic?.hours ?? 0) || null,
    dao,
    daoOwner: state.owner,
    jetton: state.metadata.jetton ?? null,
    doc: {
      id: proof.document.id,
      name: proof.document.name,
      size: proof.document.size ?? null,
      sha256: proof.document.sha256,
      url: docUrl,
    },
    fetchedAt: new Date().toISOString(),
  };

  const path = join(OUT_DIR, 'orgs', `${orgId}.json`);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(snapshot, null, 2)}\n`);
  await updateIndex(snapshot, OUT_DIR);

  console.log(`org ${orgId}: ${snapshot.name ?? '(без названия)'}`);
  console.log(`dao ${dao}  owner ${state.owner ?? '—'}  jetton ${snapshot.jetton ?? '—'}`);
  console.log(`doc ${proof.document.name}  sha256 ${proof.document.sha256}`);
  console.log(`saved ${path}`);
}

main().catch((err) => {
  console.error(`snapshot: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
