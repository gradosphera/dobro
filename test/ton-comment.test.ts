/**
 * Payload аттестации: стандартный текстовый комментарий TON (op=0).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Cell } from '@ton/core';

import { encodeAttestation } from '../lib/snapshot.ts';
import { parseTextComment, textCommentPayload, toFriendlyAddress } from '../lib/ton-comment.ts';

const COMMENT = encodeAttestation({
  version: 1,
  orgId: 10072836,
  volunteerId: 95490358,
  period: '2026-10',
  hours: 12.5,
  docSha256Prefix: '1be8b8a926ff0386',
});

test('payload — стандартный комментарий с op=0', () => {
  const payload = textCommentPayload(COMMENT);
  assert.ok(payload.length > 0);

  const [cell] = Cell.fromBoc(Buffer.from(payload, 'base64'));
  const slice = cell.beginParse();
  assert.equal(slice.loadUint(32), 0);
  assert.equal(slice.loadStringTail(), COMMENT);
});

test('parseTextComment возвращает исходный текст', () => {
  assert.equal(parseTextComment(textCommentPayload(COMMENT)), COMMENT);
  assert.equal(parseTextComment(textCommentPayload('привет')), 'привет');
});

test('parseTextComment не падает на мусоре', () => {
  assert.equal(parseTextComment(''), null);
  assert.equal(parseTextComment('not-base64!!!'), null);
  assert.equal(parseTextComment(Buffer.from([1, 2, 3]).toString('base64')), null);
});

test('toFriendlyAddress: raw из TON Connect -> EQ…', () => {
  const raw = '0:7b7dfb64f4343061b7e869600007d04feb525e6db031c392ce5941b3f0bc33ce';
  const friendly = toFriendlyAddress(raw);
  assert.match(friendly, /^EQ[A-Za-z0-9_-]{46}$/);
  assert.equal(toFriendlyAddress(friendly), friendly);
  assert.equal(toFriendlyAddress(raw), toFriendlyAddress(friendly));
});
