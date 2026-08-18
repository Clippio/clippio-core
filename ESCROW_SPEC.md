# Clippio Escrow Program Specification (v0.1)

The on-chain vault behind locked campaigns on [clippio.fun](https://clippio.fun). One minimal
Anchor program; every campaign gets its own vault. This document is the exact design the
program implements, and the accounting in [`payments.ts`](./payments.ts) is its executable
reference, pinned by [the test suite](./payments.test.ts).

Status: **spec final, program in build.** Until the program ships on mainnet, locked
campaigns on Clippio show `vault: pending` and pay-as-you-go is the live mode. Nothing is
labeled trustless before it can be verified.

## Principles

1. **No path to the platform.** There is no instruction that sends vault funds to Clippio.
   If a platform fee is ever introduced, it is charged inside `claim` at a rate fixed per
   campaign at creation time, to a treasury address recorded at creation time. At launch the
   fee is zero.
2. **Minimal surface.** Six instructions, nothing else. Anything not listed here is not
   forbidden, it is impossible.
3. **Permissionless where possible.** Funding a vault and claiming an approved payout need
   nobody's permission and nobody's uptime.
4. **Vaults have no keys.** Each vault is a program-derived address (PDA), derived off the
   ed25519 curve. No private key exists for it, for anyone, including Clippio.

## State

**`Campaign` (PDA)**, seeds `["campaign", campaign_id]`:

| Field | Type | Set | Notes |
| --- | --- | --- | --- |
| `owner` | `Pubkey` | at init | the only signer for approve, close, refund |
| `mint` | `Pubkey` | at init | the payout token (USDC), immutable |
| `treasury` | `Pubkey` | at init | fee destination, immutable |
| `fee_bps` | `u16` | at init | 0 at launch, immutable per campaign |
| `max_per_submission` | `u64` | at init | cap for any single payout |
| `total_reserved` | `u64` | runtime | approved but not yet claimed |
| `status` | enum | runtime | `Active` or `Closing` |
| `closed_at` | `i64` | runtime | set by `close_campaign` |

**`Vault`**: a token account whose authority is the Campaign PDA. Only the program's
instructions can move it.

**`Approval` (PDA)**, seeds `["approval", campaign, submission_id]`: `clipper: Pubkey`,
`amount: u64`, `claimed: bool`. Created only by `approve`. This account is the on-chain
authorization of one payout to one wallet.

## Instructions

1. **`create_campaign(id, max_per_submission, fee_bps)`**, owner signs. Initializes the
   Campaign account and its vault.
2. **`fund(amount)`**, anyone signs. Deposits into the vault. This is deliberately
   permissionless: it serves owner top-ups, routing of creator fees, and community
   crowdfunding with a single instruction.
3. **`approve(submission_id, clipper, amount)`**, owner signs. Checks
   `amount <= max_per_submission` and `amount <= vault_balance - total_reserved`, then
   creates the Approval and increases `total_reserved`.
4. **`claim(submission_id)`**, the approved clipper signs. Transfers `amount - fee` to the
   clipper and `fee` to the treasury, marks the Approval claimed, decreases
   `total_reserved`. No one can block or reverse it.
5. **`close_campaign()`**, owner signs. Sets status to `Closing` and records `closed_at`.
6. **`refund()`**, owner signs. Only after `closed_at + 48h`, and only
   `vault_balance - total_reserved`. Approved but unclaimed payouts can never be refunded
   away.

## Invariants

Always true, enforced by the program and pinned by the reference tests:

- `0 <= total_reserved <= vault_balance`
- A refund can never touch reserved funds.
- An approved payout can only ever reach the clipper it was approved for.
- There is no withdraw-to-platform path in the instruction set.

## Security notes

- All arithmetic is checked; amounts are integer token base units.
- The mint is fixed per campaign at creation.
- Off-chain data (view counts, campaign rules) never enters the program. The owner's
  explicit `approve` is the only bridge between off-chain judgment and on-chain money,
  which keeps the trusted surface small and visible.
- An owner could approve payouts to wallets they control instead of refunding after the
  timelock. This spends their own budget and takes nothing from clippers; every approval is
  public, so it costs reputation.

## Rollout and verification path

- **P0, build and test**: program implementation against this spec, with the invariant
  suite ported on-chain.
- **P1, guarded mainnet**: program ID published. Upgrade authority held by a time-locked
  multisig, publicly announced, so any upgrade is visible before it can activate and users
  have time to claim and exit.
- **P2, soak and review**: live campaigns plus external review of the public source.
- **P3, renounce**: upgrade authority set to `None`, freezing the code forever, plus a
  verified build so the deployed bytecode provably matches this repository.

Check the upgrade authority yourself at any time:

```
solana program show <PROGRAM_ID>
```
