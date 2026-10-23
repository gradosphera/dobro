/**
 * Сборка плана выплат BLG из on-chain аттестаций и клеймов.
 *
 *   npm run payouts:build -- --org 10072836 --period 2026-10
 *   npm run payouts:build -- --org 10072836 --period 2026-10 --owner EQ… --out plan.json
 *
 * Скрипт читает снапшот организации (owner DAO), историю owner через tonapi,
 * склеивает аттестации и клеймы и пишет payouts.json. Деньги не двигает.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { buildPayoutPlan } from '../lib/payouts.ts';
import { isPeriod, type OrgSnapshot } from '../lib/snapshot.ts';
import { normalizeTonAddress } from '../lib/ton.ts';
import { fetchAccountTransactions } from '../lib/chain-transactions.ts';

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  if (index >= 0 && index + 1 < process.argv.length) return process.argv[index + 1];
  const inline = process.argv.find((value) => value.startsWith(`--${name}=`));
  return inline?.slice(name.length + 3);
}

function positiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

async function main() {
  const orgId = positiveInt(arg('org'), 0);
  if (!orgId) throw new Error('Укажите организацию: --org 10072836');

  const period = arg('period') ?? '';
  if (!isPeriod(period)) throw new Error('Укажите период: --period YYYY-MM');

  const snapshotPath = arg('snapshot') ?? join('public/data/orgs', `${orgId}.json`);
  const snapshot = JSON.parse(await readFile(snapshotPath, 'utf8')) as OrgSnapshot;
  const owner = normalizeTonAddress(arg('owner') ?? snapshot.daoOwner ?? '');
  if (!owner) throw new Error('В снапшоте нет daoOwner: укажите --owner EQ…');

  const maxTransactions = positiveInt(arg('max-tx'), 2_000);
  console.log(`org ${orgId}  period ${period}  owner ${owner}`);
  console.log(`читаю историю owner (до ${maxTransactions} транзакций)…`);

  const transactions = await fetchAccountTransactions(owner, { maxTransactions });
  const plan = buildPayoutPlan({ transactions, owner, orgId, period });
  const output = {
    ...plan,
    source: {
      owner,
      snapshot: snapshotPath,
      transactions: transactions.length,
      fetchedAt: new Date().toISOString(),
    },
  };

  const out = arg('out') ?? join('payouts', `${orgId}-${period}.json`);
  await mkdir(dirname(out), { recursive: true });
  await writeFile(out, `${JSON.stringify(output, null, 2)}\n`);

  console.log(
    `attestations ${plan.totals.attestations}  claims ${plan.totals.claims}  ` +
      `payouts ${plan.totals.payouts}  total ${plan.totals.totalAmount} BLG  ` +
      `unclaimed ${plan.totals.unclaimed}`,
  );
  for (const issue of plan.issues.slice(0, 20)) {
    console.log(`  ! ${issue.kind}: ${issue.key} — ${issue.detail}`);
  }
  if (plan.issues.length > 20) console.log(`  … ещё ${plan.issues.length - 20} issues`);
  for (const payout of plan.payouts.slice(0, 10)) {
    console.log(
      `  ${payout.key}  ${payout.amount} BLG  ${payout.recipient}  att ${payout.attestationTx.slice(0, 10)}`,
    );
  }
  if (plan.payouts.length > 10) console.log(`  … ещё ${plan.payouts.length - 10} выплат`);
  console.log(`saved ${out}`);
}

main().catch((err) => {
  console.error(`payouts: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
