/**
 * Пакетная выплата BLG через Highload Wallet v3.
 *
 *   npm run payouts:batch -- --plan payouts/10072836-2026-10.json \
 *     --jetton-wallet EQ… --limit 200
 *   … --send   # после проверки dry-run и подтверждения оператора
 *
 * Highload отправляет `transfer` в свой jetton-кошелёк BLG для каждого
 * получателя. Кошелёк получателя деплоится автоматически. Скрипт не
 * проверяет баланс: перед `--send` сверьте его в tonviewer/toncenter.
 */

import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { Address, toNano } from '@ton/core';
import { mnemonicToPrivateKey } from '@ton/crypto';
import { TonClient } from '@ton/ton';

import {
  HIGHLOAD_MAX_BATCH,
  HIGHLOAD_SUBWALLET_ID,
  HIGHLOAD_TIMEOUT,
  buildPayoutBatch,
  createHighload,
  loadHighloadCode,
  loadQueryState,
  saveQueryState,
  takeQueryId,
} from '../lib/highload.ts';
import type { Payout, PayoutPlan } from '../lib/payouts.ts';
import { rpcAdapter } from '../lib/ton-rpc.ts';

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  if (index >= 0 && index + 1 < process.argv.length) return process.argv[index + 1];
  const inline = process.argv.find((value) => value.startsWith(`--${name}=`));
  return inline?.slice(name.length + 3);
}

function hasFlag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

function positiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

async function main() {
  const planPath = arg('plan');
  if (!planPath) throw new Error('Укажите план: --plan payouts/….json');

  const jettonWallet = arg('jetton-wallet');
  if (!jettonWallet) {
    throw new Error('Укажите jetton-кошелёк highload: --jetton-wallet EQ…');
  }
  Address.parse(jettonWallet);

  const plan = JSON.parse(await readFile(planPath, 'utf8')) as PayoutPlan;
  if (!Array.isArray(plan.payouts) || plan.payouts.length === 0) {
    throw new Error('В плане нет выплат');
  }

  const limit = positiveInt(arg('limit'), HIGHLOAD_MAX_BATCH);
  if (limit > HIGHLOAD_MAX_BATCH) throw new Error(`--limit не больше ${HIGHLOAD_MAX_BATCH}`);
  const selected = plan.payouts.slice(0, limit) as Payout[];

  const operatorMnemonic = process.env.HIGHLOAD_OPERATOR_MNEMONIC?.trim();
  if (!operatorMnemonic) throw new Error('Не задана HIGHLOAD_OPERATOR_MNEMONIC');
  const operator = await mnemonicToPrivateKey(operatorMnemonic.split(/\s+/));

  const network = arg('network') ?? 'testnet';
  const subwalletId = Number(arg('subwallet') ?? HIGHLOAD_SUBWALLET_ID);
  const timeout = Number(arg('timeout') ?? HIGHLOAD_TIMEOUT);
  const transferTon = toNano(arg('transfer-ton') ?? '0.05');
  const forwardTonAmount = arg('forward-ton') ? toNano(arg('forward-ton')!) : 0n;
  const queryIdBase = BigInt(arg('query-id-base') ?? '0');
  const statePath = arg('state') ?? 'state/highload-query.json';

  const code = await loadHighloadCode();
  const highload = createHighload(
    { publicKey: operator.publicKey, subwalletId, timeout },
    code,
  );

  const batch = buildPayoutBatch(selected, {
    jettonWallet: Address.parse(jettonWallet),
    highloadAddress: highload.address,
    transferTon,
    forwardTonAmount,
    queryIdBase,
  });

  const current = await loadQueryState(statePath);
  const { next } = takeQueryId(current);
  const totalBlg = selected.reduce((sum, payout) => sum + BigInt(payout.amount), 0n);

  const manifest = {
    version: 1,
    status: hasFlag('send') ? 'preparing' : 'dry-run',
    network,
    plan: planPath,
    highload: highload.address.toString(),
    jettonWallet,
    subwalletId,
    timeout,
    queryId: current.getQueryId().toString(),
    createdAt: Math.floor(Date.now() / 1000),
    transferTon: transferTon.toString(),
    actions: selected.length,
    totalBlg: totalBlg.toString(),
    totalTon: batch.totalTon.toString(),
    payouts: selected.map((payout) => ({
      key: payout.key,
      recipient: payout.recipient,
      amount: payout.amount,
    })),
  };

  console.log(JSON.stringify(manifest, null, 2));
  const serialized = `${JSON.stringify(manifest, null, 2)}\n`;
  console.log(`sha256 ${createHash('sha256').update(serialized).digest('hex')}`);

  if (!hasFlag('send')) {
    console.log('dry-run: транзакция не отправлена; добавьте --send');
    return;
  }

  const out = arg('manifest') ?? join('payouts', 'batches', `${manifest.createdAt}-${manifest.queryId}.json`);
  await mkdir(dirname(out), { recursive: true });
  await writeFile(out, serialized);

  const client = new TonClient({
    endpoint:
      arg('endpoint') ??
      (network === 'mainnet'
        ? 'https://toncenter.com/api/v2/jsonRPC'
        : 'https://testnet.toncenter.com/api/v2/jsonRPC'),
    apiKey: process.env.TONCENTER_API_KEY,
    timeout: 60_000,
    httpAdapter: rpcAdapter,
  });

  const balance = await client.getBalance(highload.address);
  const required = batch.totalTon + toNano('0.15');
  if (balance < required) {
    throw new Error(
      `На highload ${balance} nanoTON, нужно минимум ${required} (газ + запас)`,
    );
  }

  console.log(`отправляю ${selected.length} выплат, ${batch.totalTon} nanoTON газа…`);
  const opened = client.open(highload);
  await opened.sendBatch(
    operator.secretKey,
    batch.actions,
    subwalletId,
    current,
    timeout,
    manifest.createdAt,
  );
  await saveQueryState(statePath, next);

  const sent = { ...manifest, status: 'sent', sentAt: new Date().toISOString() };
  const sentSerialized = `${JSON.stringify(sent, null, 2)}\n`;
  await writeFile(out, sentSerialized);
  console.log(`sent  ${out}`);
  console.log(`sha256 ${createHash('sha256').update(sentSerialized).digest('hex')}`);
  console.log(`query_id ${current.getQueryId()}  next ${next.getQueryId()}`);
}

main().catch((err) => {
  console.error(`payouts:batch: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
