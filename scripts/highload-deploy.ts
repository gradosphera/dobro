/**
 * Деплой Highload Wallet v3.
 *
 *   HIGHLOAD_OPERATOR_MNEMONIC="…" HIGHLOAD_FUNDER_MNEMONIC="…" \
 *     npm run highload:deploy -- --network testnet --value 1
 *
 * Ключ оператора — отдельный горячий ключ: он подписывает только выплаты
 * и не должен совпадать с ключом фонда/мультисига. Скрипт не печатает
 * мнемоники и секретные ключи.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import { beginCell, internal, SendMode, toNano } from '@ton/core';
import { mnemonicToPrivateKey } from '@ton/crypto';
import { TonClient, WalletContractV4 } from '@ton/ton';

import {
  HIGHLOAD_SUBWALLET_ID,
  HIGHLOAD_TIMEOUT,
  createHighload,
  loadHighloadCode,
} from '../lib/highload.ts';

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  if (index >= 0 && index + 1 < process.argv.length) return process.argv[index + 1];
  const inline = process.argv.find((value) => value.startsWith(`--${name}=`));
  return inline?.slice(name.length + 3);
}

function hasFlag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

function mnemonic(env: string): string[] {
  const value = process.env[env]?.trim();
  if (!value) throw new Error(`Не задана переменная ${env} (24 слова через пробел)`);
  return value.split(/\s+/);
}

function endpoint(network: string): string {
  if (network === 'mainnet') return 'https://toncenter.com/api/v2/jsonRPC';
  if (network === 'testnet') return 'https://testnet.toncenter.com/api/v2/jsonRPC';
  throw new Error('Сеть должна быть testnet или mainnet');
}

function hex(value: number, width = 8): string {
  return `0x${value.toString(16).padStart(width, '0')}`;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function retry<T>(label: string, fn: () => Promise<T>): Promise<T> {
  for (let attempt = 0; attempt < 8; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const status = (err as { response?: { status?: number } }).response?.status;
      if (status !== 429) throw err;
      const wait = 2000 * (attempt + 1);
      console.log(`${label}: 429, ждём ${wait} мс…`);
      await sleep(wait);
    }
  }
  throw new Error(`${label}: toncenter 429 после повторов`);
}

async function waitForSeqno(wallet: { getSeqno(): Promise<number> }, previous: number) {
  for (let attempt = 0; attempt < 60; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 2000));
    try {
      if ((await wallet.getSeqno()) > previous) return;
    } catch {
      // кошелёк ещё не задеплоен/не проиндексирован
    }
  }
  throw new Error('Не дождались подтверждения деплоя (120 c)');
}

async function main() {
  const network = arg('network') ?? 'testnet';
  const subwalletId = Number(arg('subwallet') ?? HIGHLOAD_SUBWALLET_ID);
  const timeout = Number(arg('timeout') ?? HIGHLOAD_TIMEOUT);
  const value = arg('value') ?? '1';
  const out = arg('out') ?? 'state/highload.json';
  const dryRun = hasFlag('dry-run');

  if (!Number.isInteger(subwalletId) || subwalletId < 0) throw new Error('Некорректный --subwallet');
  if (!Number.isInteger(timeout) || timeout < 3600) throw new Error('--timeout не меньше 3600');

  const operator = await mnemonicToPrivateKey(mnemonic('HIGHLOAD_OPERATOR_MNEMONIC'));
  const code = await loadHighloadCode();
  const highload = createHighload(
    { publicKey: operator.publicKey, subwalletId, timeout },
    code,
  );

  const metadata = {
    version: 1,
    network,
    address: highload.address.toString(),
    subwalletId,
    timeout,
    operatorPublicKey: operator.publicKey.toString('hex'),
    codeHash: code.hash().toString('hex'),
    createdAt: new Date().toISOString(),
  };

  console.log(JSON.stringify(metadata, null, 2));
  await mkdir(dirname(out), { recursive: true });
  await writeFile(out, `${JSON.stringify(metadata, null, 2)}\n`);
  console.log(`saved ${out}`);

  if (dryRun) {
    console.log('dry-run: деплой не отправлен');
    return;
  }

  const client = new TonClient({
    endpoint: arg('endpoint') ?? endpoint(network),
    apiKey: process.env.TONCENTER_API_KEY,
  });

  await sleep(1000);
  const state = await retry('getContractState(highload)', () => client.getContractState(highload.address));
  if (state.state === 'active') {
    console.log('highload уже задеплоен, отправка не нужна');
    return;
  }

  const funder = await mnemonicToPrivateKey(mnemonic('HIGHLOAD_FUNDER_MNEMONIC'));
  const funderWallet = client.open(
    WalletContractV4.create({ workchain: 0, publicKey: funder.publicKey }),
  );
  await sleep(1000);
  const funderState = await retry('getContractState(funder)', () => client.getContractState(funderWallet.address));
  await sleep(500);
  const seqno = funderState.state === 'active' ? await retry('getSeqno', () => funderWallet.getSeqno()) : 0;

  console.log(`деплой ${highload.address.toString()} на ${value} TON…`);
  await sleep(1000);
  await retry('sendTransfer', () => funderWallet.sendTransfer({
    seqno,
    secretKey: funder.secretKey,
    sendMode: SendMode.PAY_GAS_SEPARATELY,
    messages: [
      internal({
        to: highload.address,
        value: toNano(value),
        init: highload.init,
        body: beginCell().endCell(),
        bounce: false,
      }),
    ],
  }));

  await waitForSeqno(funderWallet, seqno);
  console.log(`deployed ${highload.address.toString()}  subwallet ${hex(subwalletId)}`);
}

main().catch((err) => {
  console.error(`highload:deploy: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
