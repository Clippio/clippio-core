/**
 * Clippio payments engine. All money math is integer micro-USDC (6 decimals,
 * BigInt); floats never touch an amount after the initial USD conversion.
 *
 * Mirrors ESCROW_SPEC.md: the same reserve/claim/refund accounting that the
 * on-chain escrow program will enforce runs here for pay-as-you-go campaigns
 * and for previewing locked-vault state.
 */

import { PublicKey, Transaction } from "@solana/web3.js";
import {
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountIdempotentInstruction,
  createTransferInstruction,
} from "@solana/spl-token";

/** Launch policy: zero platform fees. Flip this single constant to turn fees on. */
export const PLATFORM_FEE_BPS = 0;

export const USDC_DECIMALS = 6;
export const MICRO = 1_000_000n;

/** USD (possibly fractional, e.g. 1.5) → micro-USDC. Exact for ≤6 decimals. */
export function usdToMicro(usd: number): bigint {
  if (!Number.isFinite(usd) || usd < 0) throw new Error(`Invalid USD amount: ${usd}`);
  return BigInt(Math.round(usd * 1e6));
}

export function microToUsd(micro: bigint): number {
  return Number(micro) / 1e6;
}

/**
 * Payout for a view count at a per-1K rate, with campaign bounds.
 * - below minMicro → 0n (didn't clear the review threshold)
 * - capped at maxMicro per post
 * Floor division: we never round a payout up.
 */
export function payoutForViews(
  views: number | bigint,
  ratePer1kMicro: bigint,
  minMicro: bigint,
  maxMicro: bigint
): bigint {
  const v = BigInt(views);
  if (v < 0n) throw new Error("Negative views");
  if (minMicro < 0n || maxMicro < 0n || ratePer1kMicro < 0n) throw new Error("Negative bound");
  const gross = (v * ratePer1kMicro) / 1000n;
  if (gross < minMicro) return 0n;
  return gross > maxMicro ? maxMicro : gross;
}

/**
 * Platform fee ON TOP of the payout: the budget pays it, the clipper never
 * does. Owner's total cost = payout + fee.  fee = floor(payout * bps / 10000).
 */
export function feeOnTop(payoutMicro: bigint, feeBps: number): bigint {
  if (!Number.isInteger(feeBps) || feeBps < 0 || feeBps > 10_000)
    throw new Error(`Invalid feeBps: ${feeBps}`);
  if (payoutMicro < 0n) throw new Error("Negative payout");
  return (payoutMicro * BigInt(feeBps)) / 10_000n;
}

// ---------------------------------------------------------------------------
// Vault accounting (mirror of the on-chain state machine)
// ---------------------------------------------------------------------------

export interface VaultState {
  balance: bigint; // tokens sitting in the vault
  reserved: bigint; // approved but not yet claimed
}

export function emptyVault(): VaultState {
  return { balance: 0n, reserved: 0n };
}

function assertInvariant(s: VaultState): VaultState {
  if (s.balance < 0n || s.reserved < 0n || s.reserved > s.balance)
    throw new Error(`Vault invariant broken: balance=${s.balance} reserved=${s.reserved}`);
  return s;
}

/** Anyone can fund (owner tranche, creator-fee router, crowdfunding). */
export function fund(s: VaultState, amount: bigint): VaultState {
  if (amount <= 0n) throw new Error("Fund amount must be positive");
  return assertInvariant({ balance: s.balance + amount, reserved: s.reserved });
}

/** Owner approves a submission: reserves payout+fee until claimed. */
export function approve(s: VaultState, amount: bigint): VaultState {
  if (amount <= 0n) throw new Error("Approve amount must be positive");
  if (amount > s.balance - s.reserved)
    throw new Error(
      `Insufficient unreserved balance: need ${amount}, available ${s.balance - s.reserved}`
    );
  return assertInvariant({ balance: s.balance, reserved: s.reserved + amount });
}

/** Clipper claims an approved amount: leaves the vault entirely. */
export function claim(s: VaultState, amount: bigint): VaultState {
  if (amount <= 0n) throw new Error("Claim amount must be positive");
  if (amount > s.reserved) throw new Error("Claim exceeds reserved");
  return assertInvariant({ balance: s.balance - amount, reserved: s.reserved - amount });
}

/** What the owner can take back after close+timelock: never touches reserved. */
export function refundable(s: VaultState): bigint {
  return s.balance - s.reserved;
}

export function refund(s: VaultState): VaultState {
  return assertInvariant({ balance: s.reserved, reserved: s.reserved });
}

// ---------------------------------------------------------------------------
// Pay-as-you-go batch transaction
// ---------------------------------------------------------------------------

export interface BatchPayout {
  /** Clipper wallet (base58). */
  recipient: string;
  /** Payout in micro-USDC (the clipper receives exactly this). */
  amountMicro: bigint;
}

export interface BatchPayoutParams {
  /** Campaign owner; pays from their own USDC ATA and signs in their wallet. */
  payer: string;
  payouts: BatchPayout[];
  feeBps: number;
  /** Platform treasury wallet (base58). */
  feeTreasury: string;
  usdcMint: string;
  recentBlockhash: string;
}

export interface BuiltBatch {
  tx: Transaction;
  totalPayoutMicro: bigint;
  totalFeeMicro: bigint;
  /** What leaves the owner's wallet: payouts + fee. */
  totalCostMicro: bigint;
}

/**
 * OPTIONAL convenience, not the default PAYG flow. Product decision 2026-08-17:
 * owners pay manually from their own wallet (payment sheet + Solana Pay links)
 * and Clippio only VERIFIES the payment on-chain (match from/to/amount against
 * the approved payout). This builder is kept tested in case we ever offer an
 * opt-in one-click batch. We never hold funds; every transfer is owner → recipient.
 */
export function buildBatchPayoutTx(p: BatchPayoutParams): BuiltBatch {
  if (p.payouts.length === 0) throw new Error("No payouts to build");
  if (p.payouts.length > 20) throw new Error("Max 20 payouts per transaction, split the batch");

  const payer = new PublicKey(p.payer);
  const mint = new PublicKey(p.usdcMint);
  const payerAta = getAssociatedTokenAddressSync(mint, payer);

  const tx = new Transaction();
  tx.feePayer = payer;
  tx.recentBlockhash = p.recentBlockhash;

  let totalPayout = 0n;
  for (const { recipient, amountMicro } of p.payouts) {
    if (amountMicro <= 0n) throw new Error(`Non-positive payout for ${recipient}`);
    const owner = new PublicKey(recipient);
    const ata = getAssociatedTokenAddressSync(mint, owner);
    tx.add(createAssociatedTokenAccountIdempotentInstruction(payer, ata, owner, mint));
    tx.add(createTransferInstruction(payerAta, ata, payer, amountMicro));
    totalPayout += amountMicro;
  }

  const totalFee = feeOnTop(totalPayout, p.feeBps);
  if (totalFee > 0n) {
    const treasury = new PublicKey(p.feeTreasury);
    const treasuryAta = getAssociatedTokenAddressSync(mint, treasury);
    tx.add(createAssociatedTokenAccountIdempotentInstruction(payer, treasuryAta, treasury, mint));
    tx.add(createTransferInstruction(payerAta, treasuryAta, payer, totalFee));
  }

  return {
    tx,
    totalPayoutMicro: totalPayout,
    totalFeeMicro: totalFee,
    totalCostMicro: totalPayout + totalFee,
  };
}
