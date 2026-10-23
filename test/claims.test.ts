import { test } from 'node:test';
import assert from 'node:assert/strict';

import { CLAIM_PREFIX, decodeClaim, encodeClaim, payoutKey } from '../lib/claims.ts';

test('claim: encode/decode и ключ', () => {
  const text = encodeClaim({ version: 1, orgId: 10072836, volunteerId: 97062745, period: '2026-10' });
  assert.equal(text, `${CLAIM_PREFIX} o=10072836 v=97062745 p=2026-10`);
  assert.deepEqual(decodeClaim(text), {
    version: 1,
    orgId: 10072836,
    volunteerId: 97062745,
    period: '2026-10',
  });
  assert.equal(payoutKey({ orgId: 10072836, volunteerId: 97062745, period: '2026-10' }), '10072836:97062745:2026-10');
  assert.ok(Buffer.byteLength(text, 'utf8') <= 127);
});

test('claim: отклоняет мусор', () => {
  assert.equal(decodeClaim(''), null);
  assert.equal(decodeClaim('dobro/att/1 o=1 v=2 p=2026-10'), null);
  assert.equal(decodeClaim(`${CLAIM_PREFIX} o=0 v=2 p=2026-10`), null);
  assert.equal(decodeClaim(`${CLAIM_PREFIX} o=1 v=-2 p=2026-10`), null);
  assert.equal(decodeClaim(`${CLAIM_PREFIX} o=1 v=2 p=2026-13`), null);
  assert.equal(decodeClaim(`${CLAIM_PREFIX} o=1 v=2`), null);
  assert.throws(() => encodeClaim({ version: 1, orgId: 1, volunteerId: 2, period: '2026-13' }));
});
