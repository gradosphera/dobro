/**
 * TESTNET ONLY: деплой тестового BLG-минтера и минт на highload.
 *
 *   node --env-file=state/testnet.env --experimental-strip-types \
 *     scripts/testnet-jetton.ts
 *
 * Нужен только для проверки выплат на testnet. Mainnet BLG не трогает.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import {
  Address,
  Cell,
  beginCell,
  contractAddress,
  internal,
  toNano,
  type OpenedContract,
  type StateInit,
} from '@ton/core';
import { mnemonicToPrivateKey } from '@ton/crypto';
import { TonClient, WalletContractV4 } from '@ton/ton';

import {
  HIGHLOAD_SUBWALLET_ID,
  HIGHLOAD_TIMEOUT,
  createHighload,
  loadHighloadCode,
} from '../lib/highload.ts';

const MINT_AMOUNT = 1_000n;

function mnemonic(env: string): string[] {
  const value = process.env[env]?.trim();
  if (!value) throw new Error(`Не задана ${env}`);
  return value.split(/\s+/);
}

async function loadBoc(name: string): Promise<Cell> {
  const url = new URL(`../test/fixtures/blago/${name}.boc`, import.meta.url);
  return Cell.fromBoc(await readFile(url))[0] as Cell;
}

function walletData(owner: Address, master: Address): Cell {
  return beginCell()
    .storeUint(0, 4)
    .storeCoins(0)
    .storeAddress(owner)
    .storeAddress(master)
    .endCell();
}

async function waitForSeqno(
  wallet: OpenedContract<WalletContractV4>,
  previous: number,
): Promise<void> {
  for (let attempt = 0; attempt < 60; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 2000));
    if ((await wallet.getSeqno()) > previous) return;
  }
  throw new Error('Не дождались подтверждения (120 c)');
}

async function send(
  wallet: OpenedContract<WalletContractV4>,
  secretKey: Buffer,
  messages: Parameters<WalletContractV4['sendTransfer']>[1]['messages'],
): Promise<void> {
  const seqno = await wallet.getSeqno();
  await wallet.sendTransfer({ seqno, secretKey, messages });
  await waitForSeqno(wallet, seqno);
}

async function main() {
  if (!process.env.HIGHLOAD_FUNDER_MNEMONIC || !process.env.HIGHLOAD_OPERATOR_MNEMONIC) {
    throw new Error('Запустите с --env-file=state/testnet.env');
  }

  const client = new TonClient({
    endpoint: 'https://testnet.toncenter.com/api/v2/jsonRPC',
    apiKey: process.env.TONCENTER_API_KEY,
  });

  const funderKey = await mnemonicToPrivateKey(mnemonic('HIGHLOAD_FUNDER_MNEMONIC'));
  const operatorKey = await mnemonicToPrivateKey(mnemonic('HIGHLOAD_OPERATOR_MNEMONIC'));
  const funder = client.open(
    WalletContractV4.create({ workchain: 0, publicKey: funderKey.publicKey }),
  );
  const highload = createHighload(
    { publicKey: operatorKey.publicKey, subwalletId: HIGHLOAD_SUBWALLET_ID, timeout: HIGHLOAD_TIMEOUT },
    await loadHighloadCode(),
  );

  const balance = await client.getBalance(funder.address);
  console.log(`funder   ${funder.address.toString()}  ${balance} nanoTON`);
  if (balance < toNano('6')) {
    throw new Error(`Пополните funder минимум на 6 test TON: ${funder.address.toString()}`);
  }

  const highloadState = await client.getContractState(highload.address);
  if (highloadState.state !== 'active') {
    throw new Error(
      `Сначала задеплойте highload: ${highload.address.toString()} (npm run highload:deploy -- --network testnet)`,
    );
  }

  const walletCode = await loadBoc('jetton-wallet');
  const minterCode = await loadBoc('jetton-minter');
  const minterData = beginCell()
    .storeCoins(0)
    .storeAddress(funder.address)
    .storeAddress(null)
    .storeRef(walletCode)
    .storeRef(beginCell().storeStringRefTail('testnet BLG').endCell())
    .endCell();
  const minterAddress = contractAddress(0, { code: minterCode, data: minterData });
  const highloadJetton = contractAddress(0, {
    code: walletCode,
    data: walletData(highload.address, minterAddress),
  });

  const minterState = await client.getContractState(minterAddress);
  if (minterState.state !== 'active') {
    console.log(`деплой минтера ${minterAddress.toString()}…`);
    await send(funder, funderKey.secretKey, [
      internal({
        to: minterAddress,
        value: toNano('0.3'),
        init: { code: minterCode, data: minterData } satisfies StateInit,
        body: beginCell().storeUint(0xd372158c, 32).storeUint(0, 64).endCell(),
        bounce: false,
      }),
    ]);
  }

  const existing = await client
    .runMethod(highloadJetton, 'get_wallet_data')
    .then((res) => res.stack.readBigNumber())
    .catch(() => 0n);

  if (existing === 0n) {
    console.log(`минт ${MINT_AMOUNT} test BLG на ${highload.address.toString()}…`);
    const internalTransfer = beginCell()
      .storeUint(0x178d4519, 32)
      .storeUint(0, 64)
      .storeCoins(MINT_AMOUNT)
      .storeAddress(null)
      .storeAddress(highload.address)
      .storeCoins(0)
      .storeBit(0)
      .endCell();
    const body = beginCell()
      .storeUint(0x642b7d07, 32)
      .storeUint(0, 64)
      .storeAddress(highload.address)
      .storeCoins(toNano('0.2'))
      .storeRef(internalTransfer)
      .endCell();
    const seqno = await funder.getSeqno();
    await funder.sendTransfer({
      seqno,
      secretKey: funderKey.secretKey,
      messages: [internal({ to: minterAddress, value: toNano('5'), body })],
    });
    await waitForSeqno(funder, seqno);
  }

  const metadata = {
    version: 1,
    network: 'testnet',
    minter: minterAddress.toString(),
    highload: highload.address.toString(),
    highloadJetton: highloadJetton.toString(),
    minted: MINT_AMOUNT.toString(),
    createdAt: new Date().toISOString(),
  };
  const out = 'state/testnet-jetton.json';
  await mkdir(dirname(out), { recursive: true });
  await writeFile(out, `${JSON.stringify(metadata, null, 2)}\n`);
  console.log(JSON.stringify(metadata, null, 2));
  console.log(`saved ${out}`);
}

main().catch((err) => {
  console.error(`testnet:jetton: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
