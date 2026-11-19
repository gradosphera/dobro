/**
 * Стандартный текстовый комментарий TON: op=0 и snake-строка.
 * Используется для on-chain аттестаций; сборка BOC — через @ton/core.
 *
 * Encrypted comment format (op=0x2167da4b) вынесен в `ton-comment-encrypted.ts`
 * (использует `node:crypto`, не доступен в браузере).
 */

import { Address, beginCell, Cell } from '@ton/core';

// ---------------------------------------------------------------------------
// Public API: Text comment (op=0)
// ---------------------------------------------------------------------------

/** Raw-адрес TON Connect (`0:…`) -> user-friendly (`EQ…`), как требует sendTransaction. */
export function toFriendlyAddress(input: string): string {
  return Address.parse(input).toString({ bounceable: false, urlSafe: true });
}

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
