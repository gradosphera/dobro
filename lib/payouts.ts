/**
 * Сборка плана выплат из on-chain историй:
 *
 *   attestation: dobro/att/1 от owner DAO (self-transfer)
 *   claim:       dobro/claim/1 от волонтёра на owner DAO
 *
 * Для ключа `(orgId, volunteerId, period)` действует последняя аттестация
 * и первый клейм. Сумма — floor(hours) BLG (decimals 0).
 */

import { CLAIM_PREFIX, decodeClaim, payoutKey, type ClaimPayload } from './claims.ts';
import {
  ATTESTATION_PREFIX,
  attestationKey,
  claimAmount,
  decodeAttestation,
  type AttestationPayload,
} from './snapshot.ts';
import { normalizeTonAddress, sameTonAddress } from './ton.ts';
import type { ChainTransaction } from './chain-transactions.ts';

export interface AttestationEvent extends AttestationPayload {
  key: string;
  sender: string;
  txHash: string;
  lt: string;
  time: number;
}

export interface ClaimEvent extends ClaimPayload {
  key: string;
  recipient: string;
  txHash: string;
  lt: string;
  time: number;
}

export interface ExtractResult {
  attestations: AttestationEvent[];
  claims: ClaimEvent[];
  skipped: number;
}

export interface Payout {
  key: string;
  orgId: number;
  volunteerId: number;
  period: string;
  recipient: string;
  hours: number;
  amount: number;
  attestationTx: string;
  attestationLt: string;
  claimTx: string;
  claimLt: string;
  claimedAt: string;
}

export type PayoutIssueKind =
  | 'duplicate-attestation'
  | 'duplicate-claim'
  | 'claim-without-attestation'
  | 'zero-amount';

export interface PayoutIssue {
  kind: PayoutIssueKind;
  key: string;
  detail: string;
}

export interface PayoutPlan {
  version: 1;
  orgId: number;
  period: string;
  owner: string;
  generatedAt: string;
  payouts: Payout[];
  unclaimed: Array<{ key: string; volunteerId: number; hours: number }>;
  totals: {
    attestations: number;
    claims: number;
    payouts: number;
    totalHours: number;
    totalAmount: number;
    unclaimed: number;
  };
  issues: PayoutIssue[];
}

function textOf(tx: ChainTransaction): string | null {
  const text = tx.in_msg?.decoded_body?.text;
  return typeof text === 'string' && text.trim() ? text.trim() : null;
}

/**
 * Извлекает аттестации и клеймы из транзакций owner DAO.
 * Учитываются только успешные входящие сообщения на owner.
 */
export function extractPayoutEvents(
  transactions: ChainTransaction[],
  owner: string,
): ExtractResult {
  const canonicalOwner = normalizeTonAddress(owner);
  if (!canonicalOwner) throw new Error(`Некорректный адрес owner: ${owner}`);

  const attestations: AttestationEvent[] = [];
  const claims: ClaimEvent[] = [];
  const seen = new Set<string>();
  let skipped = 0;

  for (const tx of transactions) {
    if (!tx.success || !tx.hash || !tx.in_msg) {
      skipped++;
      continue;
    }
    if (seen.has(tx.hash)) continue;

    const destination = tx.in_msg.destination?.address;
    if (!destination || !sameTonAddress(destination, canonicalOwner)) {
      skipped++;
      continue;
    }

    const source = tx.in_msg.source?.address;
    if (!source) {
      skipped++;
      continue;
    }
    const sender = normalizeTonAddress(source);
    if (!sender) {
      skipped++;
      continue;
    }

    const text = textOf(tx);
    if (!text) {
      skipped++;
      continue;
    }

    const lt = String(tx.lt ?? '0');
    if (text.startsWith(ATTESTATION_PREFIX)) {
      const payload = decodeAttestation(text);
      if (!payload || !sameTonAddress(sender, canonicalOwner)) {
        skipped++;
        continue;
      }
      seen.add(tx.hash);
      attestations.push({
        ...payload,
        key: attestationKey(payload),
        sender,
        txHash: tx.hash,
        lt,
        time: Number(tx.now ?? 0),
      });
      continue;
    }

    if (text.startsWith(CLAIM_PREFIX)) {
      const payload = decodeClaim(text);
      if (!payload || sameTonAddress(sender, canonicalOwner)) {
        skipped++;
        continue;
      }
      seen.add(tx.hash);
      claims.push({
        ...payload,
        key: payoutKey(payload),
        recipient: sender,
        txHash: tx.hash,
        lt,
        time: Number(tx.now ?? 0),
      });
      continue;
    }

    skipped++;
  }

  return { attestations, claims, skipped };
}

function later(a: { lt: string }, b: { lt: string }): boolean {
  try {
    return BigInt(a.lt) > BigInt(b.lt);
  } catch {
    return Number(a.lt) > Number(b.lt);
  }
}

function earlier(a: { lt: string }, b: { lt: string }): boolean {
  return later(b, a);
}

export function buildPayoutPlan(input: {
  transactions: ChainTransaction[];
  owner: string;
  orgId: number;
  period: string;
  now?: Date;
}): PayoutPlan {
  const { transactions, owner, orgId, period } = input;
  const extracted = extractPayoutEvents(transactions, owner);

  const attestations = extracted.attestations.filter(
    (item) => item.orgId === orgId && item.period === period,
  );
  const claims = extracted.claims.filter(
    (item) => item.orgId === orgId && item.period === period,
  );

  const latestAttestation = new Map<string, AttestationEvent>();
  const attestationCounts = new Map<string, AttestationEvent[]>();
  for (const item of attestations) {
    const list = attestationCounts.get(item.key) ?? [];
    list.push(item);
    attestationCounts.set(item.key, list);
    const current = latestAttestation.get(item.key);
    if (!current || later(item, current)) latestAttestation.set(item.key, item);
  }

  const firstClaim = new Map<string, ClaimEvent>();
  const claimCounts = new Map<string, ClaimEvent[]>();
  for (const item of claims) {
    const list = claimCounts.get(item.key) ?? [];
    list.push(item);
    claimCounts.set(item.key, list);
    const current = firstClaim.get(item.key);
    if (!current || earlier(item, current)) firstClaim.set(item.key, item);
  }

  const issues: PayoutIssue[] = [];
  for (const [key, list] of attestationCounts) {
    if (list.length > 1) {
      issues.push({
        kind: 'duplicate-attestation',
        key,
        detail: `аттестаций: ${list.length}, взята последняя ${latestAttestation.get(key)?.txHash}`,
      });
    }
  }
  for (const [key, list] of claimCounts) {
    if (list.length > 1) {
      issues.push({
        kind: 'duplicate-claim',
        key,
        detail: `клеймов: ${list.length}, взят первый ${firstClaim.get(key)?.txHash}`,
      });
    }
    if (!latestAttestation.has(key)) {
      issues.push({
        kind: 'claim-without-attestation',
        key,
        detail: `клейм ${list[0]?.txHash} без аттестации`,
      });
    }
  }

  const payouts: Payout[] = [];
  const unclaimed: PayoutPlan['unclaimed'] = [];
  let totalHours = 0;

  for (const [key, attestation] of latestAttestation) {
    const claim = firstClaim.get(key);
    const amount = claimAmount(attestation.hours);
    if (!claim) {
      unclaimed.push({
        key,
        volunteerId: attestation.volunteerId,
        hours: attestation.hours,
      });
      continue;
    }
    if (amount <= 0) {
      issues.push({
        kind: 'zero-amount',
        key,
        detail: `часы ${attestation.hours} дают 0 BLG`,
      });
      continue;
    }

    totalHours += attestation.hours;
    payouts.push({
      key,
      orgId: attestation.orgId,
      volunteerId: attestation.volunteerId,
      period: attestation.period,
      recipient: claim.recipient,
      hours: attestation.hours,
      amount,
      attestationTx: attestation.txHash,
      attestationLt: attestation.lt,
      claimTx: claim.txHash,
      claimLt: claim.lt,
      claimedAt: new Date(claim.time * 1000).toISOString(),
    });
  }

  payouts.sort((a, b) => a.key.localeCompare(b.key));
  unclaimed.sort((a, b) => a.key.localeCompare(b.key));

  return {
    version: 1,
    orgId,
    period,
    owner: normalizeTonAddress(owner) ?? owner,
    generatedAt: (input.now ?? new Date()).toISOString(),
    payouts,
    unclaimed,
    totals: {
      attestations: attestations.length,
      claims: claims.length,
      payouts: payouts.length,
      totalHours: Math.round(totalHours * 100) / 100,
      totalAmount: payouts.reduce((sum, item) => sum + item.amount, 0),
      unclaimed: unclaimed.length,
    },
    issues,
  };
}
