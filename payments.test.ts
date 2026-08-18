import { describe, it, expect } from "vitest";
import { Keypair } from "@solana/web3.js";
import {
  usdToMicro,
  microToUsd,
  payoutForViews,
  feeOnTop,
  emptyVault,
  fund,
  approve,
  claim,
  refundable,
  refund,
  buildBatchPayoutTx,
} from "./payments";

describe("usdToMicro", () => {
  it("converts exactly for common rates", () => {
    expect(usdToMicro(1)).toBe(1_000_000n);
    expect(usdToMicro(1.5)).toBe(1_500_000n);
    expect(usdToMicro(0.05)).toBe(50_000n);
    expect(usdToMicro(0.07)).toBe(70_000n); // classic float trap: 0.07*1e6 = 69999.99…
    expect(usdToMicro(2.01)).toBe(2_010_000n);
    expect(usdToMicro(0)).toBe(0n);
  });
  it("rejects negatives and non-finite", () => {
    expect(() => usdToMicro(-1)).toThrow();
    expect(() => usdToMicro(NaN)).toThrow();
    expect(() => usdToMicro(Infinity)).toThrow();
  });
});

describe("payoutForViews", () => {
  const rate = usdToMicro(1.5); // $1.50 per 1K
  const min = usdToMicro(2);
  const max = usdToMicro(300);

  it("computes floor(views * rate / 1000)", () => {
    expect(payoutForViews(10_000, rate, min, max)).toBe(usdToMicro(15));
    expect(payoutForViews(1_000, rate, min, max)).toBe(0n); // $1.50 < $2 min
    expect(payoutForViews(1_333, rate, min, max)).toBe(0n); // $1.9995 < min
    expect(payoutForViews(1_334, rate, min, max)).toBe(2_001_000n); // just over min
  });

  it("never rounds up", () => {
    // 333 views * $1/1K = $0.333 exactly → 333000 micro
    expect(payoutForViews(333, usdToMicro(1), 0n, max)).toBe(333_000n);
    // 1 view * $0.07/1K = 0.00007 → 70 micro, floor stays exact
    expect(payoutForViews(1, usdToMicro(0.07), 0n, max)).toBe(70n);
  });

  it("caps at max per post", () => {
    expect(payoutForViews(10_000_000, rate, min, max)).toBe(max);
  });

  it("zero rate → zero payout", () => {
    expect(payoutForViews(1_000_000, 0n, 0n, max)).toBe(0n);
  });
});

describe("feeOnTop", () => {
  it("is exact at the edges", () => {
    expect(feeOnTop(1_000_000n, 0)).toBe(0n);
    expect(feeOnTop(1_000_000n, 10_000)).toBe(1_000_000n);
    expect(feeOnTop(1_000_000n, 500)).toBe(50_000n); // 5%
  });
  it("floors, never rounds up", () => {
    expect(feeOnTop(999n, 500)).toBe(49n); // 999*500/10000 = 49.95 → 49
    expect(feeOnTop(1n, 500)).toBe(0n);
  });
  it("cost = payout + fee is stable across splits", () => {
    // Fee charged on the batch total must never exceed the sum of per-item
    // fees by more than the rounding saved, and never undercharges the
    // clipper (clipper always gets the full payout).
    const payouts = [123_457n, 999_999n, 50_001n];
    const total = payouts.reduce((a, b) => a + b, 0n);
    const batchFee = feeOnTop(total, 500);
    const itemFees = payouts.map((x) => feeOnTop(x, 500)).reduce((a, b) => a + b, 0n);
    expect(batchFee >= itemFees).toBe(true);
    expect(batchFee - itemFees <= BigInt(payouts.length)).toBe(true);
  });
  it("rejects invalid bps", () => {
    expect(() => feeOnTop(1n, -1)).toThrow();
    expect(() => feeOnTop(1n, 10_001)).toThrow();
    expect(() => feeOnTop(1n, 2.5)).toThrow();
  });
});

describe("vault accounting", () => {
  it("happy path: fund → approve → claim → refund", () => {
    let s = emptyVault();
    s = fund(s, 10_000n);
    s = approve(s, 4_000n);
    expect(refundable(s)).toBe(6_000n);
    s = claim(s, 4_000n);
    expect(s.balance).toBe(6_000n);
    expect(s.reserved).toBe(0n);
    s = refund(s);
    expect(s.balance).toBe(0n);
  });

  it("cannot approve beyond unreserved balance", () => {
    let s = fund(emptyVault(), 10_000n);
    s = approve(s, 9_000n);
    expect(() => approve(s, 1_001n)).toThrow(/Insufficient/);
    s = approve(s, 1_000n); // exactly the remainder is fine
    expect(refundable(s)).toBe(0n);
  });

  it("refund NEVER touches reserved (the spec's core promise)", () => {
    let s = fund(emptyVault(), 10_000n);
    s = approve(s, 7_500n);
    s = refund(s); // owner pulls unspent
    expect(s.balance).toBe(7_500n); // approved money still there
    expect(s.reserved).toBe(7_500n);
    s = claim(s, 7_500n); // clipper still gets paid in full
    expect(s.balance).toBe(0n);
  });

  it("cannot claim more than reserved", () => {
    let s = fund(emptyVault(), 10_000n);
    s = approve(s, 1_000n);
    expect(() => claim(s, 1_001n)).toThrow();
  });

  it("random walk keeps invariants", () => {
    let s = emptyVault();
    let seed = 42;
    const rnd = () => {
      seed = (seed * 1103515245 + 12345) % 2 ** 31;
      return seed / 2 ** 31;
    };
    for (let i = 0; i < 2_000; i++) {
      const amt = BigInt(Math.floor(rnd() * 5_000) + 1);
      const op = rnd();
      try {
        if (op < 0.4) s = fund(s, amt);
        else if (op < 0.7) s = approve(s, amt);
        else if (op < 0.9) s = claim(s, amt);
        else s = refund(s);
      } catch {
        // rejected ops must not mutate state; nothing to check here,
        // functions are pure and we only assign on success
      }
      expect(s.reserved >= 0n).toBe(true);
      expect(s.balance >= s.reserved).toBe(true);
    }
  });
});

describe("buildBatchPayoutTx", () => {
  const payer = Keypair.generate().publicKey.toBase58();
  const treasury = Keypair.generate().publicKey.toBase58();
  const mint = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"; // USDC mainnet
  const blockhash = "EETubP5AKHgjPAhzPAFcb8BAY1hMH639CWCFTqi3hq1k";

  const clippers = [Keypair.generate().publicKey.toBase58(), Keypair.generate().publicKey.toBase58()];

  it("builds ATA + transfer per payout, plus one fee leg", () => {
    const { tx, totalPayoutMicro, totalFeeMicro, totalCostMicro } = buildBatchPayoutTx({
      payer,
      payouts: [
        { recipient: clippers[0], amountMicro: 1_500_000n },
        { recipient: clippers[1], amountMicro: 2_500_000n },
      ],
      feeBps: 500,
      feeTreasury: treasury,
      usdcMint: mint,
      recentBlockhash: blockhash,
    });
    // 2×(ATA + transfer) + fee ATA + fee transfer
    expect(tx.instructions.length).toBe(6);
    expect(totalPayoutMicro).toBe(4_000_000n);
    expect(totalFeeMicro).toBe(200_000n); // 5% of $4
    expect(totalCostMicro).toBe(4_200_000n);
    // owner signs, nobody else
    expect(tx.feePayer?.toBase58()).toBe(payer);
    // serializes cleanly for wallet handoff
    const wire = tx.serialize({ requireAllSignatures: false, verifySignatures: false });
    expect(wire.length).toBeGreaterThan(0);
  });

  it("encodes exact amounts in the transfer instructions", () => {
    const amounts = [123_456n, 7_000_001n];
    const { tx } = buildBatchPayoutTx({
      payer,
      payouts: amounts.map((amountMicro, i) => ({ recipient: clippers[i], amountMicro })),
      feeBps: 0,
      feeTreasury: treasury,
      usdcMint: mint,
      recentBlockhash: blockhash,
    });
    // transfer ix data: [3, u64 amount LE]
    const transfers = tx.instructions.filter((ix) => ix.data[0] === 3);
    expect(transfers.length).toBe(2);
    const decoded = transfers.map((ix) => ix.data.readBigUInt64LE(1));
    expect(decoded).toEqual(amounts);
  });

  it("omits the fee leg at 0 bps", () => {
    const { tx, totalFeeMicro } = buildBatchPayoutTx({
      payer,
      payouts: [{ recipient: clippers[0], amountMicro: 1_000_000n }],
      feeBps: 0,
      feeTreasury: treasury,
      usdcMint: mint,
      recentBlockhash: blockhash,
    });
    expect(totalFeeMicro).toBe(0n);
    expect(tx.instructions.length).toBe(2);
  });

  it("rejects empty and oversized batches", () => {
    const base = { payer, feeBps: 500, feeTreasury: treasury, usdcMint: mint, recentBlockhash: blockhash };
    expect(() => buildBatchPayoutTx({ ...base, payouts: [] })).toThrow();
    const many = Array.from({ length: 21 }, () => ({
      recipient: Keypair.generate().publicKey.toBase58(),
      amountMicro: 1n,
    }));
    expect(() => buildBatchPayoutTx({ ...base, payouts: many })).toThrow(/Max 20/);
  });

  it("rejects non-positive amounts", () => {
    expect(() =>
      buildBatchPayoutTx({
        payer,
        payouts: [{ recipient: clippers[0], amountMicro: 0n }],
        feeBps: 500,
        feeTreasury: treasury,
        usdcMint: mint,
        recentBlockhash: blockhash,
      })
    ).toThrow();
  });
});
