# amana_escrow — Public Interface

This is the integrator reference for the `amana_escrow` Soroban contract
(`EscrowContract` in [`../src/lib.rs`](../src/lib.rs)). It lists every public
entrypoint, its parameters, who must authorize it, and the trade state
transitions it allows. You should not need to read the Rust source to
integrate with the contract.

Background and rationale are in the ADRs and topic docs linked at the end.
If this file and the source disagree, the source is authoritative. Please
open a PR to fix this file.

---

## Conventions

- **Types.** `Address` is a Stellar account or contract address. `u64`
  timestamps are ledger seconds since the Unix epoch. Token amounts are
  `i128` in the token's smallest unit (stroops). `*_bps` values are basis
  points, where `10_000` is 100%.
- **Auth.** "Auth: X" means the call fails unless `X.require_auth()` succeeds,
  so X must sign the transaction or authorize the invocation. "Admin" is
  the address stored at `initialize`. The contract never takes it as a
  caller argument.
- **Errors.** Every failure is a contract panic with a deterministic message
  string, such as `"Trade must be in Created status"`. There is no
  `Result`/error enum. Backends classify failures by matching the message.
  See [docs/contract-error-codes.md](../../../docs/contract-error-codes.md).
- **Pause.** When a guardian has paused the contract, the entrypoints marked
  **⏸ pausable** panic with `"contract is paused"`. No other entrypoint
  checks the pause flag.
- **Events.** Topics are listed in brackets, for example `[TRDCRT]`. Field
  layouts are in [docs/event-schema.md](../../../docs/event-schema.md) and the
  canonical schema at `schemas/events/amana_escrow.events.json`.

---

## Trade state machine

`TradeStatus` is one of `Created`, `Funded`, `Delivered`, `Completed`,
`Disputed` or `Cancelled`. `Completed` and `Cancelled` are terminal.

```
                    create_trade
                         │
                         ▼
   cancel_trade ┌──── Created ────┐ deposit
 cancel_by_buyer│                 │ deposit_with_path → finalize_path_payment
                ▼                 ▼
           Cancelled ◄──────── Funded ──────────────┐
                ▲   cancel_trade │                  │ initiate_dispute
                │   refund       │ confirm_delivery ▼
                │   claim_expiry │              Disputed ──────┐
                │   _refund      ▼                  │          │
                │             Delivered             │          │
                │   refund       │                  │          │
                ├────────────────┤ release_funds    │          │
                │                ▼                  │          │
                │             Completed ◄───────────┘          │
                │                     resolve_dispute          │
                │                     cast_dispute_vote        │
                │                     resolve_dispute_by_fallback
                │                                              │
                └──────────────────────────────────────────────┘
                   admin_clawback / execute_clawback
                   (only when the clawback empties the escrow)
```

| From \ To   | Funded | Delivered | Completed | Disputed | Cancelled |
|-------------|--------|-----------|-----------|----------|-----------|
| **Created** | `deposit`, `finalize_path_payment` | | | | `cancel_trade`, `cancel_by_buyer` |
| **Funded**  | | `confirm_delivery` | | `initiate_dispute` | `cancel_trade`, `refund`, `claim_expiry_refund`, full `admin_clawback`/`execute_clawback` |
| **Delivered** | | | `release_funds` | | `refund` |
| **Disputed** | | | `resolve_dispute`, `cast_dispute_vote` (on quorum), `resolve_dispute_by_fallback` | | full `admin_clawback`/`execute_clawback` |

Calls that act on a trade without changing its status:

- `extend_deadline`: `Funded` only.
- `submit_manifest`: `Funded` only.
- `submit_video_proof`: `Funded` or `Disputed`.
- `submit_evidence`: `Disputed` only.
- `cast_dispute_vote` below quorum: `Disputed` only.
- Partial `admin_clawback`/`execute_clawback`: `Funded` or `Disputed`.
  These reduce `trade.amount`.
- A single-party `cancel_trade` on a `Funded` trade records a cancel
  request only. See below.

---

## 1. Setup

### `initialize(admin, cngn_contract, treasury, fee_bps, source_token)`

| Param | Type | Notes |
|-------|------|-------|
| `admin` | `Address` | Stored as the contract admin. |
| `cngn_contract` | `Address` | Escrow token (cNGN). All new trades use it. |
| `treasury` | `Address` | Stored and readable via `get_treasury`. |
| `fee_bps` | `u32` | Platform fee, `≤ 10_000`. |
| `source_token` | `Address` | Token accepted by `deposit_with_path`. |

- **Auth:** `admin`.
- **Effect:** One-shot. A second call panics with `AlreadyInitialized`.
  Sets the schema version, and sets the default timelock delays: 1 day
  for clawback and 7 days for upgrade.
- **Event:** `[amana, initialized]`.

---

## 2. Trade lifecycle

### `create_trade(buyer, seller, amount, buyer_loss_bps, seller_loss_bps, expires_at) -> u64`

**⏸ pausable**

| Param | Type | Notes |
|-------|------|-------|
| `buyer` | `Address` | Must differ from `seller`. |
| `seller` | `Address` | |
| `amount` | `i128` | `> 0` and `≤ MAX_TRADE_VALUE` (1e12). |
| `buyer_loss_bps` | `u32` | `≤ 10_000`. |
| `seller_loss_bps` | `u32` | `≤ 10_000`. The two loss shares must sum to exactly `10_000`. |
| `expires_at` | `Option<u64>` | Optional delivery deadline. If set, it must be in the future. |

- **Auth:** `buyer`.
- **Transition:** none to `Created`.
- **Returns:** the new `trade_id`, computed as `(ledger_sequence << 32) | counter`.
- **Event:** `[TRDCRT]`.

### `deposit(trade_id)`

**⏸ pausable**

- **Auth:** the trade's buyer.
- **Transition:** `Created` to `Funded`.
- **Effect:** Transfers `trade.amount` of the escrow token from the buyer to
  the contract.
- **Event:** `[TRDFND]`.

### `deposit_with_path(trade_id, buyer, source_amount, dest_min, path)`

| Param | Type | Notes |
|-------|------|-------|
| `buyer` | `Address` | Must equal the trade's buyer. |
| `source_amount` | `i128` | `> 0`. Amount of `source_token` pulled from the buyer. |
| `dest_min` | `i128` | `> 0`. Minimum cNGN that must arrive. |
| `path` | `Vec<Address>` | Conversion path. Recorded, not executed on-chain. |

- **Auth:** `buyer`.
- **Transition:** none. The trade stays `Created`.
- **Effect:** Transfers `source_amount` of the source token into the
  contract. Snapshots the contract's cNGN balance and stores a
  `PathPaymentIntent`. Only one intent may be pending per trade.
- **Event:** `[PTHINT]`.
- **Next step:** `finalize_path_payment`.

### `finalize_path_payment(trade_id, caller)`

- **Auth:** `caller`, who must be the intent's buyer or the admin.
- **Transition:** `Created` to `Funded`.
- **Effect:** Sets `trade.amount` to the cNGN received since the snapshot,
  which must be `≥ dest_min`. Clears the intent.
- **Event:** `[PTHPAY]`.

### `confirm_delivery(trade_id)`

- **Auth:** the trade's buyer.
- **Transition:** `Funded` to `Delivered`.
- **Event:** `[DELCNF]`.

### `release_funds(trade_id, caller)`

**⏸ pausable**

- **Auth:** `caller`, who must be the buyer or the admin.
- **Transition:** `Delivered` to `Completed`.
- **Effect:** Pays `amount − fee` to the seller, where
  `fee = amount × fee_bps / 10_000`. The fee is added to the accrued fees
  held in the contract. Withdraw it with `withdraw_fees`.
- **Event:** `[RELSD]`.

### `cancel_trade(trade_id, caller)`

**⏸ pausable**

- **Auth:** `caller`.
- **In `Created`:** buyer, seller or admin may cancel. The trade moves to
  `Cancelled` and no funds move.
- **In `Funded`, called by the admin:** immediate full refund to the buyer.
  The trade moves to `Cancelled`.
- **In `Funded`, called by the buyer or seller:** records that party's cancel
  request. When both parties have requested, the full refund goes to the
  buyer and the trade moves to `Cancelled`. Until then, the status is
  unchanged.
- **Any other status:** panics.
- **Event:** `[TRDCAN]` when the cancellation executes.

### `cancel_by_buyer(trade_id)`

- **Auth:** the trade's buyer.
- **Transition:** `Created` to `Cancelled`. No funds move.
- **Event:** `[TCNBYR]`.

### `refund(trade_id)`

- **Auth:** the trade's seller.
- **Transition:** `Funded` or `Delivered` to `Cancelled`.
- **Effect:** Voluntary full refund of `trade.amount` to the buyer.
- **Event:** `[TRDCAN]`.

### `claim_expiry_refund(trade_id, caller)`

- **Auth:** `caller`, who must be the buyer or the seller.
- **Transition:** `Funded` to `Cancelled`. Requires `expires_at` to be set
  and the current time to be at or after `expires_at`.
- **Effect:** Full refund of `trade.amount` to the buyer.
- **Event:** `[TRDEXP]`.

### `extend_deadline(trade_id, new_deadline)`

- **Auth:** both the trade's buyer and its seller.
- **Transition:** none. The trade must be `Funded` and have a deadline that
  has not yet passed.
- **Rules:**
  - `new_deadline` must be later than the current deadline.
  - The trade must have extensions left under
    `ExtensionPolicy.max_extensions`.
  - The total push past the original deadline must stay within
    `max_total_extension_secs`.
- **Events:** `[DEDBGT]`, then `[DEDEXT]`.

---

## 3. Disputes

### `initiate_dispute(trade_id, initiator, reason_hash)`

| Param | Type | Notes |
|-------|------|-------|
| `initiator` | `Address` | Buyer or seller. |
| `reason_hash` | `String` | IPFS CID or hash. Non-empty and `≤ MAX_HASH_LEN` (256). |

- **Auth:** `initiator`.
- **Transition:** `Funded` to `Disputed`.
- **Effect:** Stores a `DisputeRecord`.
- **Event:** `[DISINI]`.

### `resolve_dispute(trade_id, mediator, seller_gets_bps)`

This is the single-mediator path.

- **Auth:** `mediator`, who must be in the mediator registry or the legacy
  mediator slot.
- **Precondition:** the trade does **not** require quorum. See
  `requires_quorum`.
- **Transition:** `Disputed` to `Completed`.
- **Payout:** loss-sharing split. See
  [ADR-002](../../../docs/adr/ADR-002-escrow-loss-sharing-model.md).
  1. `loss_bps = 10_000 − seller_gets_bps`.
  2. The seller's share of the loss is
     `amount × loss_bps × seller_loss_bps / 10_000²`.
  3. The seller's gross share is `amount` minus the seller's loss.
  4. The buyer is refunded the rest.
  5. The fee is taken from the seller's gross share only, and is accrued
     in the contract.
- **Event:** `[DISRES]`.

### `cast_dispute_vote(trade_id, mediator, seller_gets_bps, rationale_hash)`

This is the quorum path for high-value trades.

- **Auth:** `mediator`, who must be an approved mediator.
- **Preconditions:**
  - The trade is `Disputed`.
  - Quorum is enabled and `trade.amount ≥ value_threshold`.
  - This mediator has not already voted on this trade.
  - `rationale_hash` is non-empty and `≤ 256` bytes.
- **Effect:** Records a vote weighted by `get_mediator_weight`. When the
  weight behind one `seller_gets_bps` value reaches `required_weight`, the
  trade settles immediately with the same payout as `resolve_dispute`.
  The trade then moves from `Disputed` to `Completed`.
- **Events:** `[DVOTE]`. On settlement, also `[DISRES]` and `[DQURES]`.

### `resolve_dispute_by_fallback(trade_id, caller)`

- **Auth:** `caller`, who must be the buyer, the seller or an approved
  mediator.
- **Preconditions:**
  - The trade is `Disputed` and requires quorum.
  - At least one vote exists.
  - `vote_window_secs` has elapsed since the first vote.
  - Total voted weight is `≥ fallback_min_weight`.
- **Transition:** `Disputed` to `Completed`, using the outcome with the most
  weight. Ties go to the lowest `seller_gets_bps`, which favours the buyer.
- **Events:** `[DISRES]` and `[DQURES]`.

### `submit_evidence(trade_id, caller, ipfs_hash, description_hash)`

- **Auth:** `caller`, who must be the buyer, the seller or an approved
  mediator.
- **Precondition:** the trade is `Disputed`.
- **Rules:** `ipfs_hash` must be non-empty and `≤ 256` bytes.
  `description_hash` must be `≤ 256` bytes and may be empty.
- **Effect:** Appends an `EvidenceRecord`. Calls can be repeated.
- **Event:** `[EVDSUB]`.

### `submit_video_proof(trade_id, submitter, ipfs_cid)`

- **Auth:** `submitter`, who must be the buyer or the seller.
- **Precondition:** the trade is `Funded` or `Disputed`.
- **Rules:** `ipfs_cid` must be non-empty and `≤ 256` bytes. Only one video
  proof is allowed per trade, and it cannot be overwritten.
- **Event:** `[VIDPRF]`.

### `submit_manifest(trade_id, seller, driver_name_hash, driver_id_hash)`

- **Auth:** `seller`, who must be the trade's seller.
- **Precondition:** the trade is `Funded`.
- **Rules:** both hashes must be non-empty and `≤ 256` bytes. The manifest
  can be submitted once per trade.
- **Effect:** Stamps `manifest_submitted_at` in the release sequence.
- **Event:** `[MNFST]`.

---

## 4. Admin: fees, mediators, policy

All functions in this section need **Auth: admin**. None of them changes
trade status.

| Function | Params | Rules / effect | Event |
|----------|--------|----------------|-------|
| `update_fee_bps` | `new_fee_bps: u32` | Must be in `[MIN_FEE_BPS, MAX_FEE_BPS]` = `[1, 500]`. | `[FEEUPD]` |
| `withdraw_fees` | `amount: i128, destination: Address` | `0 < amount ≤ get_accrued_fees()`. Transfers escrow token. | `[FEEWTH]` |
| `set_mediator` | `mediator: Address` | Legacy single-mediator slot. Also adds the address to the registry. | `[MEDADD]` |
| `add_mediator` | `mediator_address: Address` | Adds to the registry. | `[MEDADD]` |
| `remove_mediator` | `mediator_address: Address` | Removes from the registry and clears the legacy slot if it matches. | `[MEDREM]` |
| `set_mediator_weight` | `mediator: Address, weight: u32` | `1 ≤ weight ≤ MAX_MEDIATOR_WEIGHT` (10). | `[MEDWGT]` |
| `set_quorum_config` | `enabled: bool, value_threshold: i128, required_weight: u32, vote_window_secs: u64, fallback_min_weight: u32` | `value_threshold ≥ 0`. The other values must be `> 0`, and `fallback_min_weight ≤ required_weight`. Disabled by default. | `[QURCFG]` |
| `set_extension_policy` | `max_extensions: u32, max_total_extension_secs: u64` | `max_extensions ≤ 12` and `max_total_extension_secs ≤ 365 days`. Setting `max_extensions` to `0` disables extensions. The defaults are 3 extensions and 30 days. | `[EXTPOL]` |
| `add_guardian` / `remove_guardian` | `guardian: Address` | Manages the pause guardian set. | none |
| `allow_asset` | `asset: Address, decimals: u32` | `decimals ≤ 18`. Allowlist bookkeeping only. `create_trade` always uses the `cngn_contract` from `initialize`. | none |
| `disallow_asset` | `asset: Address` | Removes the asset from the allowlist. | none |
| `set_clawback_enabled` | `enabled: bool` | Feature switch for `admin_clawback`. Treated as enabled when unset. | none |

---

## 5. Guardian: emergency pause

| Function | Params | Auth | Effect |
|----------|--------|------|--------|
| `pause` | `guardian: Address` | `guardian`, who must be a registered guardian | Sets the pause flag. |
| `unpause` | `guardian: Address` | `guardian`, who must be a registered guardian | Clears the pause flag. |

The pause flag blocks only `create_trade`, `deposit`, `cancel_trade` and
`release_funds`.

---

## 6. Admin: clawback and timelocked operations

### `admin_clawback(trade_id, clawback_amount, destination)`

This is the immediate path.

- **Auth:** admin.
- **Preconditions:**
  - `is_clawback_enabled()` is true.
  - The trade is `Funded` or `Disputed`.
  - `0 < clawback_amount ≤ trade.amount`. A non-positive amount panics with
    `CLAWBACK_INVALID_AMOUNT`.
- **Effect:**
  - Transfers the amount to `destination`.
  - Reduces `trade.amount` by the amount.
  - Adds the amount to `get_clawback_total(trade_id)`.
- **Transition:** unchanged for a partial clawback. `Cancelled` when the
  clawback empties the escrow.
- **Event:** `[CLWBCK]`, which carries `schema_version`.

### Timelocked operations

These return or take an `operation_id`.

| Function | Params | Effect | Event |
|----------|--------|--------|-------|
| `queue_clawback` | `trade_id: u64, clawback_amount: i128, destination: Address` | Queues a clawback that can run after the clawback delay (default 1 day). `clawback_amount > 0`. Returns `operation_id`. | `[TLKQUE]` |
| `execute_clawback` | `operation_id: u64` | After the delay: same checks and effects as `admin_clawback`, except it **does not** check `is_clawback_enabled`. | `[TLKEXE]` |
| `queue_upgrade` | `new_wasm_hash: BytesN<32>` | Queues a WASM upgrade that can run after the upgrade delay (default 7 days). Returns `operation_id`. | `[UPGQUE]` |
| `execute_upgrade` | `operation_id: u64` | After the delay: replaces the contract WASM. | `[UPGRAD]` |
| `cancel_queued_operation` | `operation_id: u64` | Cancels an operation that has not been executed or cancelled. | `[TLKCAN]` |

All five need **Auth: admin**. An operation can execute once. It cannot run
before `execute_after` or after it has been cancelled. See
[safe-upgrade-guide.md](safe-upgrade-guide.md) and
[admin-governance.md](admin-governance.md).

---

## 7. Read-only views

None of these need auth, and none of them change state.

| Function | Params | Returns |
|----------|--------|---------|
| `get_trade` | `trade_id` | `Trade`. Panics with `Trade not found` if the trade does not exist. |
| `get_trade_history` | `trade_id` | `Vec<TradeEvent>`: the on-chain audit trail. Empty if the trade is unknown. |
| `get_release_sequence` | `trade_id` | `ReleaseSequence`: timestamps for each lifecycle step. |
| `get_extension_status` | `trade_id` | `ExtensionStatus`: the remaining extension budget and `is_final_extension`/`is_exhausted` flags. |
| `get_extension_policy` | none | `ExtensionPolicy`: the configured policy or the defaults. |
| `get_dispute_record` | `trade_id` | `Option<DisputeRecord>` |
| `get_dispute_votes` | `trade_id` | `Vec<MediatorVote>`. Kept after resolution. |
| `requires_quorum` | `trade_id` | `bool` |
| `get_quorum_config` | none | `QuorumConfig`: the configured config, or the defaults with quorum disabled. |
| `get_mediator_weight` | `mediator` | `u32`. Defaults to `1`. |
| `get_evidence_list` | `trade_id` | `Vec<EvidenceRecord>`, in chronological order. |
| `get_evidence` | `trade_id, submitter` | `Option<Bytes>`: a legacy placeholder. Use `get_evidence_list` instead. |
| `get_video_proof` | `trade_id` | `Option<VideoProofRecord>` |
| `get_manifest` | `trade_id` | `Option<DeliveryManifestRecord>` |
| `get_clawback_total` | `trade_id` | `i128`: the cumulative amount clawed back. |
| `get_claimed_amount` | `trade_id` | `i128`: for a `Completed` trade, `amount − clawback_total`. Otherwise `0`. |
| `get_stream_accounting` | `trade_id` | `(amount, claimed, clawback_total)` |
| `get_queued_operation` | `operation_id` | `Option<QueuedOperation>` |
| `get_contract_metrics` | none | `(total_trades, total_disputes, total_resolved)` |
| `get_accrued_fees` | none | `i128`: fees that have not been withdrawn. |
| `get_fee_bps` | none | `u32` |
| `get_admin` / `get_treasury` / `get_token_contract` / `get_source_token` | none | `Address` |
| `get_schema_version` | none | `u32`: the storage schema version. Currently `1`. |
| `is_mediator` / `is_guardian` | `address` | `bool` |
| `is_paused` | none | `bool` |
| `is_clawback_enabled` | none | `bool` |
| `is_asset_allowed` | `asset` | `bool` |
| `get_asset_decimals` | `asset` | `Option<u32>` |

---

## Further reading

- [ADR-001 — Stellar path payment architecture](../../../docs/adr/ADR-001-stellar-path-payment-architecture.md)
- [ADR-002 — Escrow loss-sharing model](../../../docs/adr/ADR-002-escrow-loss-sharing-model.md)
- [Contract overview](../../../docs/eziagric_contract_overview.md)
- [Contract error codes](../../../docs/contract-error-codes.md)
- [Event schema](../../../docs/event-schema.md)
- [Mediator quorum](../../../docs/mediator-quorum.md)
- [Deadline extension caps](../../../docs/deadline-extension-caps.md)
- [Admin governance](admin-governance.md)
- [Safe upgrade guide](safe-upgrade-guide.md)
- [SECURITY.md](../../../SECURITY.md)
