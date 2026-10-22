/**
 * Стандартный текстовый комментарий TON: op=0 и snake-строка.
 * Используется для on-chain аттестаций; сборка BOC — через @ton/core.
 */

import { beginCell, Cell } from '@ton/core';

export function textCommentPayload(text: string): string {
  return beginCell().storeUint(0, 32).storeStringTail(text).endCell().toBoc().toString('base64');
}

export function parseTextComment(payload: string): string | null {
  try {
    const [cell] = Cell.fromBoc(Buffer.from(payload, 'base64'));
    const slice = cell.beginParse();
    if (slice.remainingBits < 32) return null;
    if (slice.loadUint(32) !== 0) return null;
    if (slice.remainingBits === 0) return '';
    return slice.loadStringTail();
  } catch {
    return null;
  }
}
