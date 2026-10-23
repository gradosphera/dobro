/**
 * Highload Wallet v3: деплой, query_id и сборка батча выплат BLG.
 *
 * Контракт вендорен в `contracts/highload` (аудит TonTech 2025-04-24).
 * Highload владеет jetton-кошельком BLG; каждое действие батча —
 * `transfer#0f8a7ea5` в этот кошелёк, а он уже деплоит кошелёк получателя.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import {
  Address,
  Cell,
  SendMode,
  beginCell,
  internal,
  toNano,
  type OutActionSendMsg,
} from '@ton/core';

import {
  HighloadWalletV3,
  type HighloadWalletV3Config,
} from '../contracts/highload/HighloadWalletV3.ts';
import { HighloadQueryId } from '../contracts/highload/HighloadQueryId.ts';
import type { Payout } from './payouts.ts';

export const HIGHLOAD_SUBWALLET_ID = 0x10ad;
export const HIGHLOAD_TIMEOUT = 3600;
export const HIGHLOAD_MAX_BATCH = 200;
/** Ориентир: деплой jetton-кошелька получателя + пересылка. */
export const DEFAULT_TRANSFER_TON = toNano('0.05');

export const HIGHLOAD_CODE_PATH = new URL(
  '../contracts/highload/build/HighloadWalletV3.compiled.json',
  import.meta.url,
);

export async function loadHighloadCode(): Promise<Cell> {
  const payload = JSON.parse(await readFile(HIGHLOAD_CODE_PATH, 'utf8')) as { hex?: string };
  if (!payload.hex) throw new Error('В compiled.json нет поля hex');
  return Cell.fromBoc(Buffer.from(payload.hex, 'hex'))[0] as Cell;
}

export function createHighload(
  config: HighloadWalletV3Config,
  code: Cell,
): HighloadWalletV3 {
  return HighloadWalletV3.createFromConfig(config, code);
}

export interface JettonTransferInput {
  queryId: bigint;
  amount: bigint;
  destination: Address;
  responseDestination: Address;
  forwardTonAmount?: bigint;
  forwardPayload?: Cell | null;
}

/** TL-B transfer#0f8a7ea5 (TEP-74). */
export function buildJettonTransferBody(input: JettonTransferInput): Cell {
  if (input.amount <= 0n) throw new Error('amount должен быть > 0');
  if (input.queryId < 0n || input.queryId > 2n ** 64n - 1n) {
    throw new Error('queryId вне uint64');
  }
  const forwardTonAmount = input.forwardTonAmount ?? 0n;
  if (forwardTonAmount < 0n) throw new Error('forwardTonAmount не может быть < 0');

  const builder = beginCell()
    .storeUint(0x0f8a7ea5, 32)
    .storeUint(input.queryId, 64)
    .storeCoins(input.amount)
    .storeAddress(input.destination)
    .storeAddress(input.responseDestination)
    .storeMaybeRef(null)
    .storeCoins(forwardTonAmount)
    .storeBit(input.forwardPayload ? 1 : 0);
  if (input.forwardPayload) builder.storeRef(input.forwardPayload);
  return builder.endCell();
}

export interface PayoutBatchOptions {
  jettonWallet: Address;
  highloadAddress: Address;
  transferTon?: bigint;
  forwardTonAmount?: bigint;
  queryIdBase?: bigint;
}

export interface PayoutBatch {
  actions: OutActionSendMsg[];
  totalTon: bigint;
}

/** Один payout -> одно transfer-сообщение в jetton-кошелёк highload. */
export function buildPayoutBatch(payouts: Payout[], opts: PayoutBatchOptions): PayoutBatch {
  if (payouts.length === 0) throw new Error('Пустой список выплат');
  if (payouts.length > HIGHLOAD_MAX_BATCH) {
    throw new Error(
      `Слишком много выплат: ${payouts.length}; максимум ${HIGHLOAD_MAX_BATCH} на батч`,
    );
  }

  const transferTon = opts.transferTon ?? DEFAULT_TRANSFER_TON;
  const forwardTonAmount = opts.forwardTonAmount ?? 0n;
  const queryIdBase = opts.queryIdBase ?? 0n;

  const actions: OutActionSendMsg[] = [];
  let totalTon = 0n;

  payouts.forEach((payout, index) => {
    const destination = Address.parse(payout.recipient);
    const body = buildJettonTransferBody({
      queryId: queryIdBase + BigInt(index),
      amount: BigInt(payout.amount),
      destination,
      responseDestination: opts.highloadAddress,
      forwardTonAmount,
    });
    actions.push({
      type: 'sendMsg',
      mode: SendMode.PAY_GAS_SEPARATELY,
      outMsg: internal({
        to: opts.jettonWallet,
        value: transferTon,
        body,
        bounce: true,
      }),
    });
    totalTon += transferTon;
  });

  return { actions, totalTon };
}

export interface QueryState {
  shift: string;
  bit: string;
}

export function queryIdFromState(state: QueryState): HighloadQueryId {
  return HighloadQueryId.fromShiftAndBitNumber(BigInt(state.shift), BigInt(state.bit));
}

export function stateFromQueryId(id: HighloadQueryId): QueryState {
  return { shift: id.getShift().toString(), bit: id.getBitNumber().toString() };
}

export async function loadQueryState(path: string): Promise<HighloadQueryId> {
  try {
    const raw = JSON.parse(await readFile(path, 'utf8')) as QueryState;
    return queryIdFromState(raw);
  } catch {
    return new HighloadQueryId();
  }
}

export async function saveQueryState(path: string, id: HighloadQueryId): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(stateFromQueryId(id), null, 2)}\n`);
}

/** Возвращает query_id для текущего батча и следующий для сохранения. */
export function takeQueryId(current: HighloadQueryId): {
  current: HighloadQueryId;
  next: HighloadQueryId;
} {
  return { current, next: current.getNext() };
}
