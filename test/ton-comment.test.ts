/**
 * Payload аттестации: стандартный текстовый комментарий TON (op=0) и
 * encrypted comment format (op=0x2167da4b).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Address, Cell } from '@ton/core';
import pkg from '@ton/crypto';
const { mnemonicNew, mnemonicToPrivateKey } = pkg;

import { encodeAttestation } from '../lib/snapshot.ts';
import {
  parseTextComment,
  textCommentPayload,
  toFriendlyAddress,
} from '../lib/ton-comment.ts';
import { encryptedCommentPayload } from '../lib/ton-comment-encrypted.ts';

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

test('toFriendlyAddress: raw из TON Connect -> UQ…', () => {
  const raw = '0:7b7dfb64f4343061b7e869600007d04feb525e6db031c392ce5941b3f0bc33ce';
  const friendly = toFriendlyAddress(raw);
  assert.match(friendly, /^UQ[A-Za-z0-9_-]{46}$/);
  assert.equal(toFriendlyAddress(friendly), friendly);
  assert.equal(toFriendlyAddress(raw), toFriendlyAddress(friendly));
});

// ---------------------------------------------------------------------------
// Encrypted comment tests
// ---------------------------------------------------------------------------

// Generate a test keypair for encryption tests
async function testKeyPair(): Promise<Buffer> {
  const mnemonic = await mnemonicNew();
  const kp = await mnemonicToPrivateKey(mnemonic);
  // secretKey is 64 bytes: first 32 are the Ed25519 seed
  return Buffer.from(kp.secretKey.subarray(0, 32));
}

test('encryptedCommentPayload — создаёт BOC с op=0x2167da4b', async () => {
  const senderSeed = await testKeyPair();
  const recipientKeyPair = await mnemonicToPrivateKey(await mnemonicNew());
  const recipientPublicKey = Buffer.from(recipientKeyPair.publicKey);

  const senderAddress = Address.parseRaw(
    '0:7b7dfb64f4343061b7e869600007d04feb525e6db031c392ce5941b3f0bc33ce',
  );

  const payload = await encryptedCommentPayload({
    senderPrivateSeed: senderSeed,
    senderAddress,
    recipientPublicKey,
    comment: COMMENT,
  });

  assert.ok(payload.length > 0);

  // Verify the BOC contains the correct opcode
  const [cell] = Cell.fromBoc(Buffer.from(payload, 'base64'));
  const slice = cell.beginParse();
  assert.equal(slice.loadUint(32), 0x2167da4b, 'opcode должен быть 0x2167da4b');
});

test('encryptedCommentPayload — roundtrip (шифрование + парсинг структуры)', async () => {
  const senderSeed = await testKeyPair();
  const recipientKeyPair = await mnemonicToPrivateKey(await mnemonicNew());
  const recipientPublicKey = Buffer.from(recipientKeyPair.publicKey);

  const senderAddress = Address.parseRaw(
    '0:7b7dfb64f4343061b7e869600007d04feb525e6db031c392ce5941b3f0bc33ce',
  );

  const testComment = 'test encrypted comment 2026';

  const payload = await encryptedCommentPayload({
    senderPrivateSeed: senderSeed,
    senderAddress,
    recipientPublicKey,
    comment: testComment,
  });

  // Verify we can parse the BOC structure
  const [cell] = Cell.fromBoc(Buffer.from(payload, 'base64'));
  const slice = cell.beginParse();
  assert.equal(slice.loadUint(32), 0x2167da4b);

  // The encrypted data is in snake cells: first chunk has 31 bits (35-4),
  // subsequent chunks have 1016 bits (127 bytes). Total should be at least 48 bytes.
  // Collect all bits from the cell chain
  let totalBits = slice.remainingBits;
  let ref = cell.refs[0];
  while (ref) {
    totalBits += ref.beginParse().remainingBits;
    ref = ref.refs[0];
  }
  assert.ok(totalBits >= 384, `должно быть минимум 384 бита (48 байт), получено ${totalBits}`);
});

test('encryptedCommentPayload — пустой комментарий', async () => {
  const senderSeed = await testKeyPair();
  const recipientKeyPair = await mnemonicToPrivateKey(await mnemonicNew());
  const recipientPublicKey = Buffer.from(recipientKeyPair.publicKey);

  const senderAddress = Address.parseRaw(
    '0:7b7dfb64f4343061b7e869600007d04feb525e6db031c392ce5941b3f0bc33ce',
  );

  const payload = await encryptedCommentPayload({
    senderPrivateSeed: senderSeed,
    senderAddress,
    recipientPublicKey,
    comment: '',
  });

  assert.ok(payload.length > 0);
  const [cell] = Cell.fromBoc(Buffer.from(payload, 'base64'));
  const slice = cell.beginParse();
  assert.equal(slice.loadUint(32), 0x2167da4b);
});

test('encryptedCommentPayload — большой комментарий (960 байт)', async () => {
  const senderSeed = await testKeyPair();
  const recipientKeyPair = await mnemonicToPrivateKey(await mnemonicNew());
  const recipientPublicKey = Buffer.from(recipientKeyPair.publicKey);

  const senderAddress = Address.parseRaw(
    '0:7b7dfb64f4343061b7e869600007d04feb525e6db031c392ce5941b3f0bc33ce',
  );

  // 960 bytes of repeated text
  const bigComment = 'ab'.repeat(480);
  assert.equal(Buffer.byteLength(bigComment, 'utf8'), 960);

  const payload = await encryptedCommentPayload({
    senderPrivateSeed: senderSeed,
    senderAddress,
    recipientPublicKey,
    comment: bigComment,
  });

  assert.ok(payload.length > 0);
});

test('encryptedCommentPayload — отклоняет комментарий > 960 байт', async () => {
  const senderSeed = await testKeyPair();
  const recipientKeyPair = await mnemonicToPrivateKey(await mnemonicNew());
  const recipientPublicKey = Buffer.from(recipientKeyPair.publicKey);

  const senderAddress = Address.parseRaw(
    '0:7b7dfb64f4343061b7e869600007d04feb525e6db031c392ce5941b3f0bc33ce',
  );

  const tooLong = 'a'.repeat(961);
  await assert.rejects(
    encryptedCommentPayload({
      senderPrivateSeed: senderSeed,
      senderAddress,
      recipientPublicKey,
      comment: tooLong,
    }),
    /must be <= 960 bytes/,
  );
});

test('encryptedCommentPayload — отклоняет невалидный senderPrivateSeed', async () => {
  const recipientKeyPair = await mnemonicToPrivateKey(await mnemonicNew());
  const recipientPublicKey = Buffer.from(recipientKeyPair.publicKey);

  const senderAddress = Address.parseRaw(
    '0:7b7dfb64f4343061b7e869600007d04feb525e6db031c392ce5941b3f0bc33ce',
  );

  await assert.rejects(
    encryptedCommentPayload({
      senderPrivateSeed: Buffer.from('short'),
      senderAddress,
      recipientPublicKey,
      comment: 'test',
    }),
    /32-byte/,
  );
});

test('encryptedCommentPayload — разные recipient дают разные payload', async () => {
  const senderSeed = await testKeyPair();
  const recipient1KeyPair = await mnemonicToPrivateKey(await mnemonicNew());
  const recipient2KeyPair = await mnemonicToPrivateKey(await mnemonicNew());

  const senderAddress = Address.parseRaw(
    '0:7b7dfb64f4343061b7e869600007d04feb525e6db031c392ce5941b3f0bc33ce',
  );

  const payload1 = await encryptedCommentPayload({
    senderPrivateSeed: senderSeed,
    senderAddress,
    recipientPublicKey: Buffer.from(recipient1KeyPair.publicKey),
    comment: COMMENT,
  });

  const payload2 = await encryptedCommentPayload({
    senderPrivateSeed: senderSeed,
    senderAddress,
    recipientPublicKey: Buffer.from(recipient2KeyPair.publicKey),
    comment: COMMENT,
  });

  assert.notEqual(payload1, payload2, 'разные recipient должны давать разные payload');
});

test('encryptedCommentPayload — self-encryption (sender = recipient)', async () => {
  const senderSeed = await testKeyPair();
  const senderPublicKey = Buffer.from(
    pkg.keyPairFromSeed(senderSeed).publicKey,
  );

  const senderAddress = Address.parseRaw(
    '0:7b7dfb64f4343061b7e869600007d04feb525e6db031c392ce5941b3f0bc33ce',
  );

  const payload = await encryptedCommentPayload({
    senderPrivateSeed: senderSeed,
    senderAddress,
    recipientPublicKey: senderPublicKey,
    comment: COMMENT,
  });

  assert.ok(payload.length > 0);
  const [cell] = Cell.fromBoc(Buffer.from(payload, 'base64'));
  const slice = cell.beginParse();
  assert.equal(slice.loadUint(32), 0x2167da4b);
});
