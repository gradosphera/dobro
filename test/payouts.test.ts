import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Address } from '@ton/core';

import { buildPayoutPlan, extractPayoutEvents } from '../lib/payouts.ts';
import type { ChainTransaction } from '../lib/chain-transactions.ts';

const OWNER = 'EQDExlp6EjkVN-OJ1ZcGLEYlITaold5ytBP3e8g6g_BIRaZX';
const VOLUNTEER = 'EQBlaryI1HCY6hIlW9giBoqKGtuMHfxlULZOhD6UyzpqLcll';
const OTHER = 'EQB7fbZPQ0MGHJt-hGpgAAfQT-tSXm2wMcOSzllnBs-zA3jz';
const HASH = '1be8b8a926ff0386';

function raw(address: string): string {
  return Address.parse(address).toRawString();
}

function tx(
  hash: string,
  lt: string,
  source: string | null,
  destination: string | null,
  text: string | null,
  success = true,
): ChainTransaction {
  return {
    hash,
    lt,
    now: 1_792_000_000,
    success,
    in_msg: {
      source: source ? { address: raw(source) } : null,
      destination: destination ? { address: raw(destination) } : null,
      decoded_body: text ? { text } : null,
    },
  };
}

function attestation(volunteerId: number, hours: number, lt: string, hash = `att-${volunteerId}-${lt}`) {
  return tx(hash, lt, OWNER, OWNER, `dobro/att/1 o=10072836 v=${volunteerId} p=2026-10 h=${hours} d=${HASH}`);
}

function claim(volunteerId: number, recipient: string, lt: string, hash = `claim-${volunteerId}-${lt}`) {
  return tx(hash, lt, recipient, OWNER, `dobro/claim/1 o=10072836 v=${volunteerId} p=2026-10`);
}

test('payouts: join аттестации и клейма, floor(hours)', () => {
  const plan = buildPayoutPlan({
    transactions: [
      attestation(1, 3.5, '100'),
      claim(1, VOLUNTEER, '110'),
      attestation(2, 0.5, '120'),
      claim(2, VOLUNTEER, '130'),
      attestation(3, 4, '140'),
    ],
    owner: OWNER,
    orgId: 10072836,
    period: '2026-10',
    now: new Date('2026-10-23T00:00:00Z'),
  });

  assert.equal(plan.totals.attestations, 3);
  assert.equal(plan.totals.claims, 2);
  assert.equal(plan.totals.payouts, 1);
  assert.equal(plan.totals.totalAmount, 3);
  assert.equal(plan.payouts[0]?.recipient, VOLUNTEER);
  assert.equal(plan.payouts[0]?.hours, 3.5);
  assert.equal(plan.payouts[0]?.amount, 3);
  assert.deepEqual(plan.unclaimed.map((item) => item.volunteerId), [3]);
  assert.ok(plan.issues.some((issue) => issue.kind === 'zero-amount'));
});

test('payouts: последняя аттестация и первый клейм', () => {
  const plan = buildPayoutPlan({
    transactions: [
      attestation(7, 2, '100', 'att-old'),
      claim(7, VOLUNTEER, '120', 'claim-first'),
      attestation(7, 5, '130', 'att-new'),
      claim(7, OTHER, '140', 'claim-second'),
    ],
    owner: OWNER,
    orgId: 10072836,
    period: '2026-10',
  });

  assert.equal(plan.payouts.length, 1);
  assert.equal(plan.payouts[0]?.hours, 5);
  assert.equal(plan.payouts[0]?.amount, 5);
  assert.equal(plan.payouts[0]?.recipient, VOLUNTEER);
  assert.equal(plan.payouts[0]?.attestationTx, 'att-new');
  assert.equal(plan.payouts[0]?.claimTx, 'claim-first');
  assert.ok(plan.issues.some((issue) => issue.kind === 'duplicate-attestation'));
  assert.ok(plan.issues.some((issue) => issue.kind === 'duplicate-claim'));
});

test('payouts: фильтрует чужие сообщения, failed и другие периоды', () => {
  const extracted = extractPayoutEvents(
    [
      attestation(1, 3, '100'),
      tx('bad-owner', '101', OTHER, OWNER, 'dobro/att/1 o=10072836 v=1 p=2026-10 h=9 d=0000000000000000'),
      tx('failed', '102', OWNER, OWNER, 'dobro/att/1 o=10072836 v=1 p=2026-10 h=9 d=0000000000000000', false),
      tx('other-period', '103', OWNER, OWNER, 'dobro/att/1 o=10072836 v=9 p=2026-09 h=9 d=0000000000000000'),
      tx('other-dest', '104', VOLUNTEER, OTHER, 'dobro/claim/1 o=10072836 v=1 p=2026-10'),
      tx('no-comment', '105', VOLUNTEER, OWNER, null),
    ],
    OWNER,
  );

  assert.equal(extracted.attestations.length, 2);
  assert.equal(extracted.claims.length, 0);
  const plan = buildPayoutPlan({
    transactions: [
      attestation(1, 3, '100'),
      tx('other-period', '103', OWNER, OWNER, 'dobro/att/1 o=10072836 v=9 p=2026-09 h=9 d=0000000000000000'),
      claim(1, VOLUNTEER, '110'),
    ],
    owner: OWNER,
    orgId: 10072836,
    period: '2026-10',
  });
  assert.equal(plan.totals.attestations, 1);
  assert.equal(plan.totals.payouts, 1);
});

test('payouts: claim без аттестации попадает в issues', () => {
  const plan = buildPayoutPlan({
    transactions: [claim(42, VOLUNTEER, '100')],
    owner: OWNER,
    orgId: 10072836,
    period: '2026-10',
  });
  assert.equal(plan.payouts.length, 0);
  assert.ok(plan.issues.some((issue) => issue.kind === 'claim-without-attestation'));
});
