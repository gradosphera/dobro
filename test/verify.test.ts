/**
 * Проверки слоёв A и B: чтение DAO, сверка адресов, поиск доказательства
 * в документах организации. Часть тестов ходит в сеть (ton.vote, dobro.ru).
 *
 *   node --experimental-strip-types --test test/verify.test.ts
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import verifyOrgDoc from '../api/verify-org-doc.ts';
import verifyOwner from '../api/verify-owner.ts';
import { getOrganization } from '../lib/dobro.ts';
import { extractTonAddresses, findDaoProof } from '../lib/docs.ts';
import { getDao, normalizeTonAddress, sameTonAddress } from '../lib/ton.ts';

const DAO = 'EQDExlp6EjkVN-OJ1ZcGLEYlITaold5ytBP3e8g6g_BIRaZX';
const OWNER = 'EQB7fbZPQ0MGHJt-hGpgAAfQT-tSXm2wMcOSzllnBs-zA3jz';
const ORG = 10072836;

type Handler = (req: unknown, res: unknown) => Promise<unknown>;

function mockRes() {
  return {
    statusCode: 0,
    body: undefined as unknown,
    headers: {} as Record<string, string>,
    setHeader(k: string, v: string) {
      this.headers[k] = v;
      return this;
    },
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(payload: unknown) {
      this.body = payload;
      return this;
    },
    end() {
      return this;
    },
  };
}

async function call(handler: Handler, method: string, query: Record<string, string>) {
  const res = mockRes();
  await handler({ method, query }, res);
  return res;
}

test('адрес сравнивается независимо от bounceable/testnet формы', () => {
  const uq = 'UQDExlp6EjkVN-OJ1ZcGLEYlITaold5ytBP3e8g6g_BIRfuS';
  assert.equal(normalizeTonAddress(uq), DAO);
  assert.ok(sameTonAddress(DAO, uq), 'EQ и UQ одного адреса должны совпадать');
  assert.ok(sameTonAddress(DAO, '0:c4c65a7a12391537e389d597062c46252136a895de72b413f77bc83a83f04845'));
});

test('некорректные адреса отклоняются', () => {
  assert.equal(normalizeTonAddress('EQbroken'), null);
  assert.equal(normalizeTonAddress(''), null);
  assert.equal(normalizeTonAddress('0:xyz'), null);
});

test('из текста извлекается адрес, но не кусок base64', () => {
  const text = `DAO: ${DAO}\nПодпись: Антон\n`;
  assert.deepEqual(extractTonAddresses(text), [DAO]);

  const raw = '0:c4c65a7a12391537e389d597062c46252136a895de72b413f77bc83a83f04845';
  assert.deepEqual(extractTonAddresses(`address = ${raw}`), [DAO]);
  assert.deepEqual(extractTonAddresses(`x${DAO}`), [], 'адрес внутри base64 не должен находиться');
});

test('getDao читает состояние DAO Градосфера', async () => {
  const dao = await getDao(DAO);
  assert.equal(dao.address, DAO);
  assert.equal(dao.daoId, 85);
  assert.ok(dao.owner && sameTonAddress(dao.owner, OWNER), `owner = ${dao.owner}`);
  assert.ok(dao.proposalOwner && sameTonAddress(dao.proposalOwner, OWNER));
  assert.ok(dao.metadata.jetton?.startsWith('EQ'), 'у DAO должен быть жетон');
  assert.equal(dao.metadata.dns, 'gradosphera.ton');
  assert.equal(dao.metadata.terms, null, 'пустой terms должен приходить как null');
  console.log(`  DAO 85: owner ${dao.owner}, proposals ${dao.proposalsCount}`);
});

test('документ vote.txt доказывает связь организации с DAO', async () => {
  const org = await getOrganization(ORG);
  assert.ok(org.docs && org.docs.length > 0, 'у организации должны быть документы');

  const proof = await findDaoProof(org.docs, DAO);
  assert.equal(proof.found, true, 'адрес DAO должен найтись в документах');
  assert.equal(proof.document?.name, 'vote.txt');
  assert.ok(proof.document?.sha256 && /^[0-9a-f]{64}$/.test(proof.document.sha256));
  assert.ok(proof.addresses.includes(DAO));
  console.log(`  ${proof.document?.name}: sha256 ${proof.document?.sha256}`);
});

test('чужой DAO не подтверждается документами организации', async () => {
  const org = await getOrganization(ORG);
  const other = 'EQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAM9c';
  const proof = await findDaoProof(org.docs ?? [], other);
  assert.equal(proof.found, false);
  assert.ok(proof.scanned.length > 0, 'документы должны быть просканированы');
});

test('GET /api/verify-owner: владелец DAO подтверждается', async () => {
  const res = await call(verifyOwner as unknown as Handler, 'GET', {
    org: String(ORG),
    dao: DAO,
    wallet: OWNER,
  });
  assert.equal(res.statusCode, 200);
  const body = res.body as {
    ok: boolean;
    verdict: string;
    wallet: { isOwner: boolean };
    checks: { walletIsOwner: boolean; orgVerified: boolean };
    dao: { owner: string };
  };
  assert.equal(body.verdict, 'owner');
  assert.equal(body.wallet.isOwner, true);
  assert.equal(body.checks.orgVerified, true);
  assert.equal(body.ok, true);
});

test('GET /api/verify-owner: чужой кошелёк не подтверждается', async () => {
  const res = await call(verifyOwner as unknown as Handler, 'GET', {
    org: String(ORG),
    dao: DAO,
    wallet: 'EQBlaryI1HCY6hIlW9giBoqKGtuMHfxlULZOhD6UyzpqLcll',
  });
  assert.equal(res.statusCode, 200);
  const body = res.body as { ok: boolean; verdict: string };
  assert.equal(body.verdict, 'none');
  assert.equal(body.ok, false);
});

test('GET /api/verify-owner: без dao — 400', async () => {
  const res = await call(verifyOwner as unknown as Handler, 'GET', { org: String(ORG) });
  assert.equal(res.statusCode, 400);
});

test('GET /api/verify-org-doc: vote.txt подтверждает DAO', async () => {
  const res = await call(verifyOrgDoc as unknown as Handler, 'GET', {
    org: String(ORG),
    dao: DAO,
  });
  assert.equal(res.statusCode, 200);
  const body = res.body as {
    ok: boolean;
    found: boolean;
    sha256: string;
    document: { name: string };
    checks: { docFound: boolean; orgVerified: boolean };
  };
  assert.equal(body.found, true);
  assert.equal(body.document.name, 'vote.txt');
  assert.match(body.sha256, /^[0-9a-f]{64}$/);
  assert.equal(body.checks.docFound, true);
  assert.equal(body.ok, true);
});

test('GET /api/verify-org-doc: чужой DAO не подтверждается', async () => {
  const res = await call(verifyOrgDoc as unknown as Handler, 'GET', {
    org: String(ORG),
    dao: 'EQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAM9c',
  });
  assert.equal(res.statusCode, 200);
  const body = res.body as { found: boolean; ok: boolean };
  assert.equal(body.found, false);
  assert.equal(body.ok, false);
});

test('verify-*: OPTIONS и неподдерживаемый метод', async () => {
  const options = await call(verifyOwner as unknown as Handler, 'OPTIONS', {});
  assert.equal(options.statusCode, 204);

  const post = await call(verifyOrgDoc as unknown as Handler, 'POST', {});
  assert.equal(post.statusCode, 405);
});
