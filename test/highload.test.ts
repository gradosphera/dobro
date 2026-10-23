import { test } from 'node:test';
import assert from 'node:assert/strict';
import { unlink } from 'node:fs/promises';

import { Address, Cell, SendMode, beginCell, internal, toNano } from '@ton/core';
import { keyPairFromSeed } from '@ton/crypto';
import { Blockchain } from '@ton/sandbox';

import { HighloadQueryId } from '../contracts/highload/HighloadQueryId.ts';
import {
  DEFAULT_TRANSFER_TON,
  HIGHLOAD_MAX_BATCH,
  HIGHLOAD_SUBWALLET_ID,
  HIGHLOAD_TIMEOUT,
  buildJettonTransferBody,
  buildPayoutBatch,
  createHighload,
  loadHighloadCode,
  loadQueryState,
  saveQueryState,
  takeQueryId,
} from '../lib/highload.ts';
import type { Payout } from '../lib/payouts.ts';

const KEY = keyPairFromSeed(Buffer.alloc(32, 9));
const JETTON_WALLET = Address.parse('EQBlaryI1HCY6hIlW9giBoqKGtuMHfxlULZOhD6UyzpqLcll');
const HIGHLIGHT = Address.parse('EQDExlp6EjkVN-OJ1ZcGLEYlITaold5ytBP3e8g6g_BIRaZX');

function payout(index: number, recipient: string): Payout {
  return {
    key: `10072836:${index}:2026-10`,
    orgId: 10072836,
    volunteerId: index,
    period: '2026-10',
    recipient,
    hours: index,
    amount: index,
    attestationTx: `att-${index}`,
    attestationLt: String(index),
    claimTx: `claim-${index}`,
    claimLt: String(index),
    claimedAt: '2026-10-23T00:00:00.000Z',
  };
}

test('highload: jetton transfer TL-B', () => {
  const destination = Address.parse('EQB7fbZPQ0MGHJt-hGpgAAfQT-tSXm2wMcOSzllnBs-zA3jz');
  const body = buildJettonTransferBody({
    queryId: 42n,
    amount: 12n,
    destination,
    responseDestination: HIGHLIGHT,
  });

  const slice = body.beginParse();
  assert.equal(slice.loadUint(32), 0x0f8a7ea5);
  assert.equal(slice.loadUintBig(64), 42n);
  assert.equal(slice.loadCoins(), 12n);
  assert.ok(slice.loadAddress()?.equals(destination));
  assert.ok(slice.loadAddress()?.equals(HIGHLIGHT));
  assert.equal(slice.loadMaybeRef(), null);
  assert.equal(slice.loadCoins(), 0n);
  assert.equal(slice.loadBit(), false);
  slice.endParse();
});

test('highload: батч payout -> transfer в jetton-кошелёк', () => {
  const payouts = [
    payout(1, 'EQB7fbZPQ0MGHJt-hGpgAAfQT-tSXm2wMcOSzllnBs-zA3jz'),
    payout(2, 'EQBlaryI1HCY6hIlW9giBoqKGtuMHfxlULZOhD6UyzpqLcll'),
  ];
  const batch = buildPayoutBatch(payouts, {
    jettonWallet: JETTON_WALLET,
    highloadAddress: HIGHLIGHT,
    queryIdBase: 100n,
  });

  assert.equal(batch.actions.length, 2);
  assert.equal(batch.totalTon, DEFAULT_TRANSFER_TON * 2n);
  for (const action of batch.actions) {
    assert.equal(action.type, 'sendMsg');
    assert.equal(action.mode, SendMode.PAY_GAS_SEPARATELY);
    assert.equal(action.outMsg.info.type, 'internal');
    if (action.outMsg.info.type === 'internal') {
      assert.ok(action.outMsg.info.dest.equals(JETTON_WALLET));
      assert.equal(action.outMsg.info.value.coins, DEFAULT_TRANSFER_TON);
    }
  }

  assert.throws(
    () =>
      buildPayoutBatch(
        Array.from({ length: HIGHLOAD_MAX_BATCH + 1 }, (_, index) =>
          payout(index + 1, 'EQB7fbZPQ0MGHJt-hGpgAAfQT-tSXm2wMcOSzllnBs-zA3jz'),
        ),
        { jettonWallet: JETTON_WALLET, highloadAddress: HIGHLIGHT },
      ),
    /максимум/,
  );
});

test('highload: query_id state', async () => {
  const path = `/tmp/opencode/highload-query-${process.pid}.json`;
  const initial = await loadQueryState(path);
  assert.equal(initial.getQueryId(), 0n);
  const { current, next } = takeQueryId(initial);
  assert.equal(current.getQueryId(), 0n);
  assert.equal(next.getQueryId(), 1n);
  await saveQueryState(path, next);
  const loaded = await loadQueryState(path);
  assert.equal(loaded.getQueryId(), 1n);
  await unlink(path).catch(() => {});
});

test('highload: sandbox deploy + TON batch + replay', async () => {
  const blockchain = await Blockchain.create();
  blockchain.now = 1000;

  const code = await loadHighloadCode();
  const wallet = blockchain.openContract(
    createHighload(
      { publicKey: KEY.publicKey, subwalletId: HIGHLOAD_SUBWALLET_ID, timeout: HIGHLOAD_TIMEOUT },
      code,
    ),
  );

  const deployer = await blockchain.treasury('payout-deployer');
  const deploy = await wallet.sendDeploy(deployer.getSender(), toNano('100'));
  assert.ok(deploy.transactions.length > 0);
  assert.deepEqual(await wallet.getPublicKey(), KEY.publicKey);

  const recipient = await blockchain.treasury('payout-recipient');
  const before = (await blockchain.getContract(recipient.address)).balance;
  const queryId = new HighloadQueryId();
  const actions = [
    {
      type: 'sendMsg' as const,
      mode: SendMode.PAY_GAS_SEPARATELY,
      outMsg: internal({
        to: recipient.address,
        value: toNano('0.5'),
        body: beginCell().storeUint(7, 32).endCell(),
      }),
    },
  ];

  const result = await wallet.sendBatch(
    KEY.secretKey,
    actions,
    HIGHLOAD_SUBWALLET_ID,
    queryId,
    HIGHLOAD_TIMEOUT,
    blockchain.now,
  );
  assert.ok(result.transactions.length > 0);
  const after = (await blockchain.getContract(recipient.address)).balance;
  const received = after - before;
  assert.ok(received > toNano('0.49'), `получено слишком мало: ${received}`);
  assert.ok(received <= toNano('0.5'), `получено больше отправленного: ${received}`);
  assert.equal(await wallet.getProcessed(queryId), true);

  await assert.rejects(
    wallet.sendBatch(
      KEY.secretKey,
      actions,
      HIGHLOAD_SUBWALLET_ID,
      queryId,
      HIGHLOAD_TIMEOUT,
      blockchain.now,
    ),
  );
});

test('highload: BOC с зафиксированным хешем', async () => {
  const code = await loadHighloadCode();
  assert.equal(
    code.hash().toString('hex'),
    '11acad7955844090f283bf238bc1449871f783e7cc0979408d3f4859483e8525',
  );
  assert.ok(code instanceof Cell);
});
