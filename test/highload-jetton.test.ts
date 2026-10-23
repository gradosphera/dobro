import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { Address, Cell, beginCell, contractAddress, internal, toNano } from '@ton/core';
import { keyPairFromSeed } from '@ton/crypto';
import { Blockchain } from '@ton/sandbox';

import { HighloadQueryId } from '../contracts/highload/HighloadQueryId.ts';
import {
  HIGHLOAD_SUBWALLET_ID,
  HIGHLOAD_TIMEOUT,
  buildPayoutBatch,
  createHighload,
  loadHighloadCode,
} from '../lib/highload.ts';
import type { Payout } from '../lib/payouts.ts';

const KEY = keyPairFromSeed(Buffer.alloc(32, 5));
const MINT_AMOUNT = 1000n;
const TRANSFER_TON = toNano('0.1');

async function loadBoc(name: string): Promise<Cell> {
  const path = new URL(`./fixtures/blago/${name}.boc`, import.meta.url);
  const bytes = await readFile(path);
  return Cell.fromBoc(bytes)[0] as Cell;
}

function walletData(owner: Address, master: Address): Cell {
  return beginCell()
    .storeUint(0, 4)
    .storeCoins(0)
    .storeAddress(owner)
    .storeAddress(master)
    .endCell();
}

async function jettonBalance(blockchain: Blockchain, address: Address): Promise<bigint> {
  const contract = await blockchain.getContract(address);
  const result = await contract.get('get_wallet_data');
  return result.stackReader.readBigNumber();
}

test('highload -> jetton wallet -> получатель: полный BLG-батч', async () => {
  const blockchain = await Blockchain.create();
  blockchain.now = 1000;

  const admin = await blockchain.treasury('blg-admin');
  const walletCode = await loadBoc('jetton-wallet');
  const minterCode = await loadBoc('jetton-minter');

  const minterData = beginCell()
    .storeCoins(0)
    .storeAddress(admin.address)
    .storeAddress(null)
    .storeRef(walletCode)
    .storeRef(beginCell().storeStringRefTail('test-blg').endCell())
    .endCell();
  const minterAddress = contractAddress(0, { code: minterCode, data: minterData });

  await admin.send({
    to: minterAddress,
    value: toNano('0.2'),
    init: { code: minterCode, data: minterData },
    body: beginCell().storeUint(0xd372158c, 32).storeUint(0, 64).endCell(),
    bounce: false,
  });

  const highload = blockchain.openContract(
    createHighload(
      { publicKey: KEY.publicKey, subwalletId: HIGHLOAD_SUBWALLET_ID, timeout: HIGHLOAD_TIMEOUT },
      await loadHighloadCode(),
    ),
  );
  await highload.sendDeploy(admin.getSender(), toNano('10'));

  const highloadJetton = contractAddress(0, {
    code: walletCode,
    data: walletData(highload.address, minterAddress),
  });

  const mintMessage = beginCell()
    .storeUint(0x178d4519, 32)
    .storeUint(0, 64)
    .storeCoins(MINT_AMOUNT)
    .storeAddress(null)
    .storeAddress(highload.address)
    .storeCoins(0)
    .storeBit(0)
    .endCell();

  await admin.send({
    to: minterAddress,
    value: toNano('5'),
    body: beginCell()
      .storeUint(0x642b7d07, 32)
      .storeUint(0, 64)
      .storeAddress(highload.address)
      .storeCoins(toNano('0.15'))
      .storeRef(mintMessage)
      .endCell(),
  });

  assert.equal(await jettonBalance(blockchain, highloadJetton), MINT_AMOUNT);

  const recipient = await blockchain.treasury('blg-recipient');
  const recipientJetton = contractAddress(0, {
    code: walletCode,
    data: walletData(recipient.address, minterAddress),
  });

  const payout: Payout = {
    key: '10072836:97062745:2026-10',
    orgId: 10072836,
    volunteerId: 97062745,
    period: '2026-10',
    recipient: recipient.address.toString(),
    hours: 3,
    amount: 3,
    attestationTx: 'att',
    attestationLt: '1',
    claimTx: 'claim',
    claimLt: '2',
    claimedAt: '2026-10-23T03:03:36.000Z',
  };

  const batch = buildPayoutBatch([payout], {
    jettonWallet: highloadJetton,
    highloadAddress: highload.address,
    transferTon: TRANSFER_TON,
  });

  const result = await highload.sendBatch(
    KEY.secretKey,
    batch.actions,
    HIGHLOAD_SUBWALLET_ID,
    new HighloadQueryId(),
    HIGHLOAD_TIMEOUT,
    blockchain.now,
  );
  assert.ok(result.transactions.length > 0);

  assert.equal(await jettonBalance(blockchain, recipientJetton), 3n);
  assert.equal(await jettonBalance(blockchain, highloadJetton), MINT_AMOUNT - 3n);

  const recipientState = await blockchain.getContract(recipientJetton);
  assert.equal(recipientState.accountState?.type, 'active');
});
