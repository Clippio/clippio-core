# clippio · verify

The verifiable core of [Clippio](https://clippio.fun), the marketplace where clippers get
paid per view on Solana. This repository exists so you can check our claims instead of
trusting them. Everything the money touches is here; run the tests yourself.

## What is in this repository

| File | What it is |
| --- | --- |
| [`payments.ts`](./payments.ts) | The payout engine: USD to micro-USDC conversion, the per-view payout formula with min/max bounds, the vault accounting state machine (fund, approve, claim, refund), and the batch transfer builder. All money math is integer BigInt; floats never touch an amount. |
| [`payments.test.ts`](./payments.test.ts) | 20 automated tests that pin the rules: exact conversions (including classic float traps), floor-only rounding, min/max enforcement, fee edges, vault invariants under 2,000 randomized operations, and byte-level verification of transfer amounts inside built transactions. |
| [`ESCROW_SPEC.md`](./ESCROW_SPEC.md) | The full specification of the on-chain escrow program behind locked campaigns: state, the six instructions, invariants, and the verification path up to renouncing the upgrade authority. |

This is the same code that runs on clippio.fun, published verbatim.

## Run the tests

```
npm install
npm test
```

Expected: 20 passed.

## The claims this repository backs

- Payouts are `floor(views × rate / 1000)` in integer micro-USDC, never rounded up,
  bounded by each campaign's minimum and per-post maximum.
- Platform fees are zero at launch. The fee machinery exists, is tested at every edge, and
  is set to `PLATFORM_FEE_BPS = 0`.
- In vault accounting, a refund can never touch approved-but-unclaimed payouts, and an
  approved payout can only reach the wallet it was approved for.
- Clippio is not in the payment path. Pay-as-you-go payments are made by campaign owners
  from their own wallets and verified on-chain by matching sender, recipient and exact
  amount against the approved payout. Locked campaigns will use the escrow program
  specified here, whose vaults are PDAs with no private keys.

## What is intentionally not here

- The web application and its operational code.
- Fraud detection heuristics. Publishing them would hand bot operators a manual for
  gaming view verification, so they stay private. The money paths above do not depend on
  them: no heuristic can move funds.

## Contact

Questions, review findings, or holes in the logic: reach us through the official Clippio X
account. We want to hear them.
