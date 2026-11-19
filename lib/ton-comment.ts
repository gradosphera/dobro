/**
 * Стандартный текстовый комментарий TON: op=0 и snake-строка.
 * Используется для on-chain аттестаций; сборка BOC — через @ton/core.
 *
 * Encrypted comment format (op=0x2167da4b) — скрывает содержимое комментария
 * от публичного просмотра. Спецификация:
 * https://github.com/ton-blockchain/docs/blob/main/content/contracts/standard/wallets/interact.mdx
 */

import { createCipheriv, createDecipheriv } from 'node:crypto';
import pkg from '@ton/crypto';
const { getSecureRandomBytes, hmac_sha512, keyPairFromSeed, sha512 } = pkg;
import { Address, beginCell, Cell } from '@ton/core';

const ENCRYPTED_COMMENT_OP = 0x2167da4b;
const MAX_COMMENT_BYTES = 960;
const MAX_PAYLOAD_BYTES = 1024;

// ---------------------------------------------------------------------------
// Helpers: Ed25519 → X25519 (Curve25519)
// ---------------------------------------------------------------------------

const P255 = (1n << 255n) - 19n;

function mod(a: bigint): bigint {
  const r = a % P255;
  return r >= 0n ? r : r + P255;
}

function modPow(a: bigint, e: bigint): bigint {
  let x = mod(a);
  let r = 1n;
  while (e > 0n) {
    if (e & 1n) {
      r = mod(r * x);
    }
    x = mod(x * x);
    e >>= 1n;
  }
  return r;
}

function inv(a: bigint): bigint {
  return modPow(a, P255 - 2n);
}

function leToBigInt(bytes: Buffer): bigint {
  let n = 0n;
  for (let i = bytes.length - 1; i >= 0; i--) {
    n = (n << 8n) + BigInt(bytes[i]);
  }
  return n;
}

function bigIntToLe(n: bigint, size: number): Buffer {
  const out = Buffer.alloc(size);
  for (let i = 0; i < size; i++) {
    out[i] = Number(n & 255n);
    n >>= 8n;
  }
  return out;
}

function x25519(scalar: Buffer, uBytes: Buffer): Buffer {
  const k = Buffer.from(scalar);
  k[0] &= 248;
  k[31] &= 127;
  k[31] |= 64;

  const x1 = leToBigInt(uBytes);
  let x2 = 1n;
  let z2 = 0n;
  let x3 = x1;
  let z3 = 1n;
  let swap = 0n;
  const kNum = leToBigInt(k);

  for (let t = 254; t >= 0; t--) {
    const kt = (kNum >> BigInt(t)) & 1n;
    swap ^= kt;

    if (swap) {
      [x2, x3] = [x3, x2];
      [z2, z3] = [z3, z2];
    }

    swap = kt;

    const a = mod(x2 + z2);
    const aa = mod(a * a);
    const b = mod(x2 - z2);
    const bb = mod(b * b);
    const e = mod(aa - bb);
    const c = mod(x3 + z3);
    const d = mod(x3 - z3);
    const da = mod(d * a);
    const cb = mod(c * b);

    x3 = mod((da + cb) ** 2n);
    z3 = mod(x1 * mod((da - cb) ** 2n));
    x2 = mod(aa * bb);
    z2 = mod(e * mod(aa + 121665n * e));
  }

  if (swap) {
    [x2, x3] = [x3, x2];
    [z2, z3] = [z3, z2];
  }

  return bigIntToLe(mod(x2 * inv(z2)), 32);
}

async function tonEd25519SharedSecret(
  peerPublicKey: Buffer,
  privateSeed: Buffer,
): Promise<Buffer> {
  if (peerPublicKey.length !== 32) {
    throw new Error('peerPublicKey must be 32 bytes');
  }
  if (privateSeed.length !== 32) {
    throw new Error('privateSeed must be a 32-byte Ed25519 seed');
  }

  const publicY = Buffer.from(peerPublicKey);
  publicY[31] &= 127;

  const y = leToBigInt(publicY);
  if (y >= P255) {
    throw new Error('Invalid Ed25519 public key');
  }

  // Validate that the encoded y coordinate corresponds to an Ed25519 point.
  const ySquared = mod(y * y);
  const d = mod(-121665n * inv(121666n));
  const xSquared = mod((ySquared - 1n) * inv(d * ySquared + 1n));
  if (
    (xSquared === 0n && (peerPublicKey[31] & 128) !== 0) ||
    (xSquared !== 0n && modPow(xSquared, (P255 - 1n) / 2n) !== 1n)
  ) {
    throw new Error('Invalid Ed25519 public key');
  }

  const u = mod((y + 1n) * inv(1n - y));

  const h = await sha512(privateSeed);
  const scalar = Buffer.from(h.subarray(0, 32));

  const sharedSecret = x25519(scalar, bigIntToLe(u, 32));
  if (sharedSecret.every((byte) => byte === 0)) {
    throw new Error('Invalid public key: all-zero shared secret');
  }
  return sharedSecret;
}

// ---------------------------------------------------------------------------
// Helpers: XOR, HMAC, AES
// ---------------------------------------------------------------------------

function xor32(a: Buffer, b: Buffer): Buffer {
  if (a.length !== 32 || b.length !== 32) {
    throw new Error('Expected 32-byte public keys');
  }
  const out = Buffer.alloc(32);
  for (let i = 0; i < 32; i++) {
    out[i] = a[i] ^ b[i];
  }
  return out;
}

// ---------------------------------------------------------------------------
// Snake cell encoding
// ---------------------------------------------------------------------------

function encryptedCommentToCell(encryptedComment: Buffer): Cell {
  if (encryptedComment.length > MAX_PAYLOAD_BYTES) {
    throw new Error('Encrypted comment is too long (>1024 bytes)');
  }

  // First chunk: 35 bytes (includes 4-byte opcode in the root cell)
  const chunks: Buffer[] = [encryptedComment.subarray(0, 35)];
  for (let i = 35; i < encryptedComment.length; i += 127) {
    chunks.push(encryptedComment.subarray(i, i + 127));
  }

  let ref: Cell | null = null;
  for (let i = chunks.length - 1; i >= 1; i--) {
    const builder = beginCell().storeBuffer(chunks[i]);
    if (ref) {
      builder.storeRef(ref);
    }
    ref = builder.endCell();
  }

  const root = beginCell()
    .storeUint(ENCRYPTED_COMMENT_OP, 32)
    .storeBuffer(chunks[0]);

  if (ref) {
    root.storeRef(ref);
  }

  return root.endCell();
}

// ---------------------------------------------------------------------------
// Public API: Text comment (op=0) — unchanged
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

// ---------------------------------------------------------------------------
// Public API: Encrypted comment (op=0x2167da4b)
// ---------------------------------------------------------------------------

export interface EncryptedCommentArgs {
  /** 32-byte Ed25519 private seed (signing key) */
  senderPrivateSeed: Buffer;
  /** Sender's TON address (used for HMAC salt) */
  senderAddress: Address;
  /** Recipient's 32-byte Ed25519 public key */
  recipientPublicKey: Buffer;
  /** Plaintext comment or data to encrypt (max 960 bytes) */
  comment: string | Buffer;
}

/**
 * Creates an encrypted comment cell.
 * Returns base64-encoded BOC ready for sendTransaction payload.
 */
export async function encryptedCommentPayload(args: EncryptedCommentArgs): Promise<string> {
  const senderSeed = Buffer.from(args.senderPrivateSeed);
  if (senderSeed.length !== 32) {
    throw new Error('senderPrivateSeed must be a 32-byte Ed25519 seed');
  }
  if (args.recipientPublicKey.length !== 32) {
    throw new Error('recipientPublicKey must be 32 bytes');
  }

  // Derive sender public key from seed
  const senderPublicKey = Buffer.from(keyPairFromSeed(senderSeed).publicKey);

  // Step 1: comment bytes
  const comment = typeof args.comment === 'string'
    ? Buffer.from(args.comment, 'utf8')
    : Buffer.from(args.comment);

  if (comment.length > MAX_COMMENT_BYTES) {
    throw new Error(`Encrypted comment plaintext must be <= ${MAX_COMMENT_BYTES} bytes`);
  }

  // Step 2-3: prefix (random bytes, length >= 16, aligned to 16)
  const prefixLength = ((16 + 15 + comment.length) & ~15) - comment.length;
  const prefix = Buffer.from(await getSecureRandomBytes(prefixLength));
  prefix[0] = prefixLength;

  // Step 4: padded_data
  const paddedData = Buffer.concat([prefix, comment]);

  // Step 5: shared_secret
  const sharedSecret = await tonEd25519SharedSecret(
    Buffer.from(args.recipientPublicKey),
    senderSeed,
  );

  // Step 6: salt = bounceable, URL-safe, user-friendly sender address string
  const salt = Buffer.from(args.senderAddress.toString({
    bounceable: true,
    testOnly: false,
    urlSafe: true,
  }));

  // Step 7: msg_key = first 16 bytes of HMAC-SHA512(salt, padded_data)
  const msgKey = Buffer.from(await hmac_sha512(salt, paddedData)).subarray(0, 16);

  // Step 8-9: x = HMAC-SHA512(shared_secret, msg_key)
  const x = Buffer.from(await hmac_sha512(sharedSecret, msgKey));
  const key = x.subarray(0, 32);
  const iv = x.subarray(32, 48);

  // Step 10: ciphertext (AES-256-CBC, no auto padding)
  const cipher = createCipheriv('aes-256-cbc', key, iv);
  cipher.setAutoPadding(false);
  const ciphertext = Buffer.concat([cipher.update(paddedData), cipher.final()]);

  // Step 11: concat pub_xor + msg_key + ciphertext → snake cell
  const encryptedComment = Buffer.concat([
    xor32(senderPublicKey, Buffer.from(args.recipientPublicKey)),
    msgKey,
    ciphertext,
  ]);

  return encryptedCommentToCell(encryptedComment).toBoc().toString('base64');
}

// ---------------------------------------------------------------------------
// Public API: Decrypt encrypted comment
// ---------------------------------------------------------------------------

export interface DecryptedCommentArgs {
  /** 32-byte Ed25519 private seed */
  privateSeed: Buffer;
  /** Encrypted payload as base64-encoded BOC */
  payload: string;
}

/**
 * Decrypts an encrypted comment payload.
 * Returns the original plaintext or null if decryption fails.
 */
export async function parseEncryptedComment(args: DecryptedCommentArgs): Promise<string | null> {
  try {
    const [cell] = Cell.fromBoc(Buffer.from(args.payload, 'base64'));
    const slice = cell.beginParse();

    // Check opcode
    if (slice.loadUint(32) !== ENCRYPTED_COMMENT_OP) {
      return null;
    }

    // Reconstruct the encrypted bytes from snake cells
    const allBits = collectCellBits(cell);
    if (allBits.length < 48) return null; // 32 (pub_xor) + 16 (msg_key) min

    const encryptedBuffer = Buffer.from(allBits);
    if (encryptedBuffer.length < 48) return null;

    // Split into pub_xor (32), msg_key (16), ciphertext
    const pubXor = encryptedBuffer.subarray(0, 32);
    const storedMsgKey = encryptedBuffer.subarray(32, 48);
    const ciphertext = encryptedBuffer.subarray(48);

    // Derive sender public key
    const senderPublicKey = Buffer.from(keyPairFromSeed(Buffer.from(args.privateSeed)).publicKey);
    const recipientPublicKey = xor32(senderPublicKey, Buffer.from(pubXor));

    // We need sender address for salt — this requires additional context
    // For now, return null (decryption requires sender address)
    // This function is for future use when address is available
    return null;
  } catch {
    return null;
  }
}

/**
 * Collects all bits from a snake-encoded cell chain.
 */
function collectCellBits(cell: Cell): Buffer {
  const bits: number[] = [];

  function collect(slice: import('@ton/core').Slice) {
    const remaining = slice.remainingBits;
    for (let i = 0; i < remaining; i++) {
      bits.push(slice.loadBit() ? 1 : 0);
    }
    // Follow references
    if (slice.remainingRefs > 0) {
      for (let i = 0; i < slice.remainingRefs; i++) {
        const ref = slice.loadRef();
        collect(ref.beginParse());
      }
    }
  }

  collect(cell.beginParse());

  const bytes = Buffer.alloc(Math.ceil(bits.length / 8));
  for (let i = 0; i < bits.length; i++) {
    const byteIndex = Math.floor(i / 8);
    const bitIndex = 7 - (i % 8);
    if (bits[i]) {
      bytes[byteIndex] |= (1 << bitIndex);
    }
  }

  return bytes;
}
