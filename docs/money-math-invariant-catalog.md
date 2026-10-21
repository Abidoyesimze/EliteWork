# Money-Math Invariant Catalog

> **Issue #239** — Shared property-based money-math test library
> Maintained by: Money-math team
> Last updated: 2026-08-30

## Overview

This document catalogs every money-math invariant enforced by the Amana escrow
system. Each invariant is tested in both Rust (on-chain contract) and TypeScript
(off-chain API/frontend) using the shared fixture corpus at
`shared-test-fixtures/money_math_corpus.json`.

The corpus is generated deterministically from seed **42** with **1000 generated
cases** per property, plus boundary exhaustion cases. Both stacks consume the
identical JSON fixture file to guarantee cross-language parity.

---

## Invariant Catalog

### INV-001: Release Funds Conservation

**Category:** Fee calculation
**Owning test files:**
- Rust: `contracts/amana_escrow/src/tests/bps_fuzz_tests.rs` (`prop_release_funds_conservation`)
- Rust parity (CI-enforced): `contracts/amana_escrow/tests/parity_money_math.rs` (`release_funds_conservation_parity`, run by `money-math-parity.yml`)
- TS parity (CI-enforced): `shared-test-fixtures/__tests__/money_math_parity.test.ts` (run by `money-math-parity.yml`)

**Invariant:**
```
seller_amount + fee_amount == amount
```

**Description:** When `release_funds()` executes, the total trade amount must
be exactly conserved. The seller receives `amount - fee` and the platform
receives `fee = amount * fee_bps / 10_000`.

**Edge cases covered:**
- `fee_bps = 0` → fee = 0, seller gets all
- `fee_bps = 10_000` → fee = amount, seller gets 0
- `amount = 1` (minimum) at various fee rates
- `amount = i64::MAX` (maximum safe trade value)

---

### INV-002: Fee Amount Non-Negative

**Category:** Fee calculation
**Owning test files:**
- Rust: `contracts/amana_escrow/src/tests/bps_fuzz_tests.rs` (`prop_fee_amount_non_negative`)
- Parity (CI-enforced): `contracts/amana_escrow/tests/parity_money_math.rs` (`fee_boundary_parity`, `fee_generated_parity`, run by `money-math-parity.yml`) — asserts `fee >= 0`

**Invariant:**
```
fee >= 0 for all valid inputs
```

**Description:** The platform fee must never be negative, regardless of the
input amount or fee rate.

---

### INV-003: Fee Amount Does Not Exceed Trade Amount

**Category:** Fee calculation
**Owning test files:**
- Rust: `contracts/amana_escrow/src/tests/bps_fuzz_tests.rs` (`prop_fee_amount_le_amount`)
- Parity (CI-enforced): `contracts/amana_escrow/tests/parity_money_math.rs` (`fee_boundary_parity`, `fee_generated_parity`, run by `money-math-parity.yml`) — asserts `fee <= amount`

**Invariant:**
```
fee <= amount for all valid inputs
```

**Description:** The platform fee must never exceed the total trade amount.

---

### INV-004: Resolve Dispute Conservation

**Category:** Dispute resolution
**Owning test files:**
- Rust: `contracts/amana_escrow/src/tests/bps_fuzz_tests.rs` (`prop_resolve_dispute_conservation`)
- Rust parity (CI-enforced): `contracts/amana_escrow/tests/parity_money_math.rs` (`resolve_dispute_conservation_parity`, run by `money-math-parity.yml`)
- TS parity (CI-enforced): `shared-test-fixtures/__tests__/money_math_parity.test.ts` (run by `money-math-parity.yml`)

**Invariant:**
```
seller_net + buyer_refund + fee == total
```

**Description:** When a mediator resolves a dispute, the total trade amount
must be exactly conserved across three destinations: the seller's net payout,
the buyer's refund, and the platform fee.

**Computation chain:**
1. `loss_bps = BPS_DIVISOR - seller_gets_bps`
2. `seller_loss = total * loss_bps * seller_loss_bps / BPS_DIVISOR^2`
3. `seller_raw = total - seller_loss`
4. `buyer_refund = total - seller_raw`
5. `fee = seller_raw * fee_bps / BPS_DIVISOR`
6. `seller_net = seller_raw - fee`

---

### INV-005: Dispute Payouts Non-Negative

**Category:** Dispute resolution
**Owning test files:**
- Rust: `contracts/amana_escrow/src/tests/bps_fuzz_tests.rs` (`prop_resolve_dispute_seller_net_non_negative`, `prop_resolve_dispute_buyer_refund_non_negative`)
- Parity (CI-enforced): Same as INV-004 — asserts `seller_net >= 0`, `buyer_refund >= 0`, `fee >= 0`

**Invariant:**
```
seller_net >= 0 AND buyer_refund >= 0 AND fee >= 0
```

---

### INV-006: Loss Amount Non-Negative

**Category:** Loss sharing
**Owning test files:**
- Rust: `contracts/amana_escrow/src/tests/bps_fuzz_tests.rs` (`prop_loss_amount_non_negative`)
- Parity (CI-enforced): `contracts/amana_escrow/tests/parity_money_math.rs` (`loss_boundary_parity`, run by `money-math-parity.yml`) — asserts `loss >= 0`

**Invariant:**
```
loss >= 0 for all valid inputs
```

---

### INV-007: Loss Amount Does Not Exceed Total

**Category:** Loss sharing
**Owning test files:**
- Rust: `contracts/amana_escrow/src/tests/bps_fuzz_tests.rs` (`prop_loss_amount_le_total`)
- Parity (CI-enforced): `contracts/amana_escrow/tests/parity_money_math.rs` (`loss_boundary_parity`, run by `money-math-parity.yml`) — asserts `loss <= total`

**Invariant:**
```
loss <= total for all valid inputs
```

---

### INV-008: Clawback Conservation

**Category:** Admin clawback
**Owning test files:**
- Rust parity (CI-enforced): `contracts/amana_escrow/tests/parity_money_math.rs` (`clawback_conservation_parity`, run by `money-math-parity.yml`)
- TS parity (CI-enforced): `shared-test-fixtures/__tests__/money_math_parity.test.ts` (run by `money-math-parity.yml`)
- Additional: `contracts/amana_escrow/tests/clawback_invariant_tests.rs`

**Invariant:**
```
remaining + clawback_amount == trade_amount
```

**Description:** When the admin performs a clawback, the remaining escrowed
amount plus the clawed-back amount must equal the original trade amount.

---

## Cross-Language Parity Testing

### How it works

1. **Generate:** `shared-test-fixtures/generate-corpus.js --seed 42 --cases 1000`
   produces `shared-test-fixtures/money_math_corpus.json`

2. **Rust consumption:** `contracts/amana_escrow/tests/parity_money_math.rs`
   deserializes the JSON with `serde_json` and runs each fixture through the
   Rust `checked_fee_amount` / `checked_loss_amount` replicas.

3. **TypeScript consumption:** `shared-test-fixtures/__tests__/money_math_parity.test.ts`
   loads the same JSON and runs each fixture through the TypeScript
   `checkedFeeAmount` / `checkedLossAmount` implementations.

4. **Parity guarantee:** Both stacks compute the same functions on the same
   inputs and assert the same expected outputs. Any divergence in arithmetic
   between Rust and TypeScript will surface as a test failure.

### Regenerating the corpus

```bash
# From the repo root
node shared-test-fixtures/generate-corpus.js --seed 42 --cases 1000

# Verify both stacks pass
cd contracts/amana_escrow && cargo test parity_money_math
cd shared-test-fixtures && npx jest money_math_parity
```

### Adding new invariants

1. Add the invariant formula to the `invariants` array in the generator
2. Add corresponding fixture generation in `generate-corpus.js`
3. Add a test case in both `parity_money_math.rs` and `money_math_parity.test.ts`
4. Update this catalog with the new INV-XXX entry
5. Run both test suites to confirm parity

---

## CI Integration

The cross-language parity job runs in `.github/workflows/money-math-parity.yml`:

- Generates the corpus with the pinned seed
- Runs Rust `cargo test parity_money_math`
- Runs TypeScript `jest money_math_parity`
- Fails if either stack diverges from the expected corpus values

### CI coverage of catalog invariants

Every invariant in this catalog is asserted by at least one test executed by
`money-math-parity.yml` (Rust `parity_money_math.rs` and/or TypeScript
`money_math_parity.test.ts`):

| Invariant | Invariant expression | Asserted in CI by |
|---|---|---|
| INV-001 | `seller_amount + fee_amount == amount` | `release_funds_conservation_parity` (Rust) + TS release-funds test |
| INV-002 | `fee >= 0` | `fee_boundary_parity` / `fee_generated_parity` (Rust) |
| INV-003 | `fee <= amount` | `fee_boundary_parity` / `fee_generated_parity` (Rust) |
| INV-004 | `seller_net + buyer_refund + fee == total` | `resolve_dispute_conservation_parity` (Rust) + TS dispute test |
| INV-005 | `seller_net >= 0 AND buyer_refund >= 0 AND fee >= 0` | `resolve_dispute_conservation_parity` (Rust) + TS dispute test |
| INV-006 | `loss >= 0` | `loss_boundary_parity` (Rust) |
| INV-007 | `loss <= total` | `loss_boundary_parity` (Rust) |
| INV-008 | `remaining + clawback_amount == trade_amount` | `clawback_conservation_parity` (Rust) + TS clawback test |

**Gap history (closed in this revision):** INV-002, INV-003, INV-006 and
INV-007 were owned by `bps_fuzz_tests.rs` only, which is not part of the CI
test filter (`cargo test parity_money_math`). Explicit `assert!` checks for
those four invariants were added to `contracts/amana_escrow/tests/parity_money_math.rs`
so they are now enforced by CI, and
`docs/money-math-invariant-catalog.md` was added to the workflow's
`paths` trigger so future catalog changes re-run the parity job.
