/**
 * Local-first слой: целостность публичного снапшота и формат on-chain
 * аттестаций. Сеть не нужна.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import {
  ATTESTATION_PREFIX,
  MAX_COMMENT_BYTES,
  SNAPSHOT_VERSION,
  claimAmount,
  decodeAttestation,
  encodeAttestation,
  normalizeHours,
  type OrgSnapshot,
  type SnapshotIndex,
} from '../lib/snapshot.ts';

const ORG_ID = 10072836;
const DAO = 'EQDExlp6EjkVN-OJ1ZcGLEYlITaold5ytBP3e8g6g_BIRaZX';
const DOC_SHA = '1be8b8a926ff0386327abddc523d7090fd0145c0fa52b557a606a92f73b2d698';
const HASH_PREFIX = DOC_SHA.slice(0, 16);

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, 'utf8')) as T;
}

test('снапшот организации валиден и совпадает с документом', async () => {
  const snapshot = await readJson<OrgSnapshot>(`public/data/orgs/${ORG_ID}.json`);

  assert.equal(snapshot.version, SNAPSHOT_VERSION);
  assert.equal(snapshot.orgId, ORG_ID);
  assert.equal(snapshot.dao, DAO);
  assert.equal(snapshot.doc?.sha256, DOC_SHA);
  assert.equal(snapshot.doc?.id, 'e1efd803-2d15-0857-2416-f9ee9c96708b');
  assert.equal(snapshot.doc?.size, 49);
  assert.ok(snapshot.daoOwner?.startsWith('EQ'));
  assert.ok(snapshot.jetton?.startsWith('EQ'));
  assert.equal(snapshot.verified, true);
  assert.ok(!Number.isNaN(Date.parse(snapshot.fetchedAt)));
});

test('индекс снапшотов содержит организацию', async () => {
  const index = await readJson<SnapshotIndex>('public/data/index.json');
  const entry = index.orgs.find((org) => org.orgId === ORG_ID);

  assert.equal(index.version, SNAPSHOT_VERSION);
  assert.ok(entry);
  assert.equal(entry.dao, DAO);
  assert.equal(entry.docSha256, DOC_SHA);
});

test('аттестация кодируется и декодируется без потерь', () => {
  const text = encodeAttestation({
    version: 1,
    orgId: ORG_ID,
    volunteerId: 95490358,
    period: '2026-10',
    hours: 12.5,
    docSha256Prefix: HASH_PREFIX,
  });

  assert.ok(text.startsWith(ATTESTATION_PREFIX));
  assert.ok(new TextEncoder().encode(text).length <= MAX_COMMENT_BYTES);

  const decoded = decodeAttestation(text);
  assert.deepEqual(decoded, {
    version: 1,
    orgId: ORG_ID,
    volunteerId: 95490358,
    period: '2026-10',
    hours: 12.5,
    docSha256Prefix: HASH_PREFIX,
  });
});

test('decodeAttestation отвергает мусор', () => {
  assert.equal(decodeAttestation(''), null);
  assert.equal(decodeAttestation('hello'), null);
  assert.equal(decodeAttestation(`${ATTESTATION_PREFIX} o=1 v=2 p=2026-13 h=3 d=${HASH_PREFIX}`), null);
  assert.equal(decodeAttestation(`${ATTESTATION_PREFIX} o=1 v=2 p=2026-10 h=0 d=${HASH_PREFIX}`), null);
  assert.equal(decodeAttestation(`${ATTESTATION_PREFIX} o=1 v=2 p=2026-10 h=745 d=${HASH_PREFIX}`), null);
  assert.equal(decodeAttestation(`${ATTESTATION_PREFIX} o=0 v=2 p=2026-10 h=3 d=${HASH_PREFIX}`), null);
  assert.equal(decodeAttestation(`${ATTESTATION_PREFIX} o=1 v=2 p=2026-10 h=3 d=xyz`), null);
  assert.equal(decodeAttestation(`${ATTESTATION_PREFIX} o=1 v=2`), null);
});

test('encodeAttestation валидирует вход', () => {
  const valid = {
    version: 1 as const,
    orgId: ORG_ID,
    volunteerId: 1,
    period: '2026-10',
    hours: 3,
    docSha256Prefix: HASH_PREFIX,
  };

  assert.throws(() => encodeAttestation({ ...valid, orgId: 0 }), /orgId/);
  assert.throws(() => encodeAttestation({ ...valid, volunteerId: 0 }), /volunteerId/);
  assert.throws(() => encodeAttestation({ ...valid, period: '2026-13' }), /period/);
  assert.throws(() => encodeAttestation({ ...valid, hours: 0 }), /hours/);
  assert.throws(() => encodeAttestation({ ...valid, hours: 745 }), /hours/);
  assert.throws(() => encodeAttestation({ ...valid, docSha256Prefix: 'abc' }), /docSha256Prefix/);
});

test('часы усекаются, BLG платится за целый час', () => {
  assert.equal(normalizeHours(1.999), 1.99);
  assert.equal(normalizeHours(12.5), 12.5);
  assert.equal(normalizeHours(0.29), 0.29);
  assert.equal(normalizeHours(0), null);
  assert.equal(normalizeHours(745), null);
  assert.equal(normalizeHours('abc'), null);

  assert.equal(claimAmount(0.99), 0);
  assert.equal(claimAmount(1), 1);
  assert.equal(claimAmount(1.99), 1);
  assert.equal(claimAmount(12.5), 12);
  assert.equal(claimAmount(744), 744);
  assert.equal(claimAmount(-1), 0);
});
