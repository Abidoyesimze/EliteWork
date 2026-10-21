//! # Amana Escrow Contract
//!
//! A decentralized, multi-token escrow and dispute settlement protocol built on Soroban.
//! Provides programmatic custody of trade funds, milestones, video/evidence logging,
//! multi-party dispute arbitration, and timelocked administrative controls.

#![no_std]

#[cfg(test)]
mod tests;

/// Shared admin signer fixture for contract unit and integration tests (#108).
/// Available on native / test builds only; excluded from the WASM artifact.
#[cfg(not(feature = "wasm"))]
pub mod test_fixture;

/// Admin transaction payload builder — issue #98.
/// Provides strongly-typed helpers for constructing admin contract call arguments.
/// Available in test builds and as an `rlib` dependency for off-chain tooling.
pub mod admin_payload;

/// Event topic and field constants generated from the canonical schema
/// (`schemas/events/amana_escrow.events.json`). Tests assert the emitted shape
/// against these, so a topic or field rename that is not reflected in the
/// schema — and therefore not in the TypeScript decoder — fails here.
pub mod generated;

use soroban_sdk::{
    Address, Bytes, BytesN, Env, String, Symbol, Vec, contract, contractimpl, symbol_short, token,
};

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const NEXT_TRADE_ID: Symbol = symbol_short!("NXTTRD");
const BPS_DIVISOR: i128 = 10_000;
const INSTANCE_TTL_THRESHOLD: u32 = 50_000;
pub(crate) const INSTANCE_TTL_EXTEND_TO: u32 = 50_000;

/// Maximum byte length accepted for any caller-supplied hash / IPFS CID input.
/// Real IPFS CIDs (≤ ~62 bytes) and hex digests (64 bytes) fit comfortably; the
/// cap rejects malformed oversized payloads that would otherwise bloat
/// persistent storage and inflate read/write gas for every later access.
pub const MAX_HASH_LEN: u32 = 256;

/// Current on-chain persistent storage schema version. Bump this whenever the
/// persistent layout changes so a future upgrade can branch on
/// `get_schema_version()` and run the matching migration. See SECURITY.md.
pub const CURRENT_SCHEMA_VERSION: u32 = 1;

/// Event schema version, distinct from the storage schema version.
///
/// This constant is embedded in the `ClawbackExecutedEvent` (and any new event
/// type added after it) as a `schema_version` field so downstream listeners can
/// detect structural changes and apply the appropriate parser.
///
/// Policy:
/// - Bump when a **new field is added** to any event struct.
/// - Never remove or reorder existing fields on a bump — always additive.
/// - Old listeners that ignore unknown trailing fields remain compatible.
/// - Document every bump in `docs/event-schema-migration-plan.md`.
///
/// Events predating this constant (all v1 events) have a stable, locked shape
/// documented in `src/tests/event_schema_tests.rs`. They are not retrofitted
/// with this field to preserve backward compatibility with deployed listeners.
pub const EVENT_SCHEMA_VERSION: u32 = 1;

/// Maximum single-trade escrow value in stroops (i128). Set to 1 trillion cNGN
/// to guard against fat-finger amounts that would exhaust token supply.
pub const MAX_TRADE_VALUE: i128 = 1_000_000_000_000_i128;

/// Default cap on how many times one trade's delivery deadline may be extended
/// (#194). Without a cap a seller can extend indefinitely, locking the buyer's
/// capital in escrow with no exit — the extension itself requires both
/// signatures, but a buyer facing "extend or lose the goods" has no real
/// choice. Applies when the admin has not set an explicit `ExtensionPolicy`.
pub const DEFAULT_MAX_DEADLINE_EXTENSIONS: u32 = 3;

/// Default absolute cap, in seconds, on how far past its *original* deadline a
/// trade may be pushed (#194). Measured from the first deadline rather than the
/// current one, so many small extensions cannot outflank the limit that one
/// large extension would hit. 30 days.
pub const DEFAULT_MAX_TOTAL_EXTENSION_SECS: u64 = 30 * 24 * 60 * 60;

/// Upper bound the admin itself cannot exceed when configuring the extension
/// policy. A cap that can be raised without limit is not a cap; this bounds the
/// worst case an admin key compromise can impose on buyers. 365 days.
pub const EXTENSION_POLICY_CEILING_SECS: u64 = 365 * 24 * 60 * 60;

/// Upper bound on the configurable extension count, for the same reason.
pub const EXTENSION_POLICY_CEILING_COUNT: u32 = 12;

/// Default escrow value at or above which a dispute needs a mediator quorum
/// rather than one mediator's decision (#195). Only consulted when quorum is
/// enabled; see [`QuorumConfig::enabled`].
pub const DEFAULT_QUORUM_VALUE_THRESHOLD: i128 = 10_000_000_000_i128;

/// Default total vote weight that must back one outcome to resolve on quorum.
pub const DEFAULT_QUORUM_REQUIRED_WEIGHT: u32 = 3;

/// Default window, in seconds, from the first vote until fallback resolution
/// becomes available. Without a fallback a quorum that never assembles would
/// strand the escrow permanently — the opposite of the problem quorum solves.
/// 7 days.
pub const DEFAULT_QUORUM_VOTE_WINDOW_SECS: u64 = 7 * 24 * 60 * 60;

/// Default minimum weight that must have voted for fallback resolution to be
/// permitted once the window closes.
pub const DEFAULT_QUORUM_FALLBACK_MIN_WEIGHT: u32 = 2;

/// Weight assigned to a mediator with no explicit weight configured.
pub const DEFAULT_MEDIATOR_WEIGHT: u32 = 1;

/// Ceiling on any single mediator's vote weight. Bounds how far one mediator
/// can be favoured, so "quorum" cannot be quietly reduced to one signature.
pub const MAX_MEDIATOR_WEIGHT: u32 = 10;

/// Minimum allowed platform fee in basis points (0.01%).
pub const MIN_FEE_BPS: u32 = 1;
/// Maximum allowed platform fee in basis points (5%).
pub const MAX_FEE_BPS: u32 = 500;

fn checked_fee_amount(amount: i128, fee_bps: u32) -> i128 {
    amount
        .checked_mul(fee_bps as i128)
        .expect("fee calculation overflow")
        / BPS_DIVISOR
}

fn checked_loss_amount(total: i128, loss_bps: i128, seller_loss_bps: u32) -> i128 {
    total
        .checked_mul(loss_bps)
        .expect("loss calculation overflow")
        .checked_mul(seller_loss_bps as i128)
        .expect("loss sharing calculation overflow")
        / (BPS_DIVISOR * BPS_DIVISOR)
}

// ---------------------------------------------------------------------------

pub mod errors;
pub mod events;
pub mod types;

pub use errors::*;
pub use events::*;
pub use types::*;

// ---------------------------------------------------------------------------
// Escrow Contract
// ---------------------------------------------------------------------------

#[contract]
pub struct EscrowContract;

#[contractimpl]
impl EscrowContract {
    fn bump_instance_ttl(env: &Env) {
        env.storage()
            .instance()
            .extend_ttl(INSTANCE_TTL_THRESHOLD, INSTANCE_TTL_EXTEND_TO);
    }

    /// Panics with "contract is paused" when the global pause flag is set.
    /// Call this at the top of every state-changing entrypoint.
    fn assert_not_paused(env: &Env) {
        let paused: bool = env
            .storage()
            .instance()
            .get(&DataKey::Paused)
            .unwrap_or(false);
        assert!(!paused, "contract is paused");
    }

    // -----------------------------------------------------------------------
    // Admin / Setup
    // -----------------------------------------------------------------------

    /// Initializes the escrow contract instance with administrative roles and token configuration.
    ///
    /// # Parameters
    /// - `env`: Soroban environment.
    /// - `admin`: Address with administrative authority.
    /// - `cngn_contract`: Primary settlement token contract address.
    /// - `treasury`: Address designated to collect platform fees.
    /// - `fee_bps`: Platform fee rate in basis points (max 10,000).
    /// - `source_token`: Default source token address for path payments.
    ///
    /// # Panics
    /// - Panics with `"AlreadyInitialized"` if the contract has already been initialized.
    /// - Panics if `fee_bps` exceeds `10_000`.
    /// - Panics if caller is not authorized as `admin`.
    ///
    /// # State Effects
    /// - Stores `Admin`, `CngnContract`, `Treasury`, `FeeBps`, and `SourceToken` in instance storage.
    /// - Sets `Initialized` flag to `true` and records current `SchemaVersion`.
    /// - Emits an `InitializedEvent`.
    pub fn initialize(
        env: Env,
        admin: Address,
        cngn_contract: Address,
        treasury: Address,
        fee_bps: u32,
        source_token: Address,
    ) {
        if env.storage().instance().has(&DataKey::Initialized) {
            panic!("AlreadyInitialized");
        }
        assert!(fee_bps <= 10_000, "fee_bps must not exceed 10000");
        admin.require_auth();
        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage()
            .instance()
            .set(&DataKey::CngnContract, &cngn_contract);
        env.storage().instance().set(&DataKey::Treasury, &treasury);
        env.storage().instance().set(&DataKey::FeeBps, &fee_bps);
        env.storage()
            .instance()
            .set(&DataKey::SourceToken, &source_token);
        env.storage().instance().set(&DataKey::Initialized, &true);
        env.storage()
            .instance()
            .set(&DataKey::SchemaVersion, &CURRENT_SCHEMA_VERSION);
        let timelock_config = TimelockConfig {
            clawback_delay_seconds: 86400,
            upgrade_delay_seconds: 604800,
        };
        env.storage()
            .instance()
            .set(&DataKey::TimelockConfig, &timelock_config);
        env.storage().instance().set(&DataKey::NextTimelockId, &0u64);
        Self::bump_instance_ttl(&env);
        InitializedEvent { admin, fee_bps, timestamp: env.ledger().timestamp() }.publish(&env);
    }

    /// Register a single legacy mediator address. Only the admin may call this.
    /// For multi-mediator support, prefer `add_mediator()`.
    /// Emits `MediatorAdded` so governance indexers see every registration path.
    pub fn set_mediator(env: Env, mediator: Address) {
        let admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .expect("Not initialized");
        admin.require_auth();
        env.storage().instance().set(&DataKey::Mediator, &mediator);
        // Also register in the per-address registry so is_mediator() reflects this.
        env.storage()
            .persistent()
            .set(&DataKey::MediatorRegistry(mediator.clone()), &true);
        MediatorAddedEvent {
            mediator: mediator.clone(),
        }
        .publish(&env);
    }

    // -----------------------------------------------------------------------
    // Mediator registry
    // -----------------------------------------------------------------------

    /// Add `mediator_address` to the approved mediator registry.
    /// Admin only. Emits `MediatorAdded`.
    pub fn add_mediator(env: Env, mediator_address: Address) {
        let admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .expect("Not initialized");
        admin.require_auth();
        env.storage()
            .persistent()
            .set(&DataKey::MediatorRegistry(mediator_address.clone()), &true);
        MediatorAddedEvent {
            mediator: mediator_address,
        }
        .publish(&env);
    }

    /// Remove `mediator_address` from the approved mediator registry.
    /// Also clears the legacy single-mediator slot if it holds the same address,
    /// ensuring revocation is complete regardless of which registration path was used.
    /// Admin only. Emits `MediatorRemoved`.
    pub fn remove_mediator(env: Env, mediator_address: Address) {
        let admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .expect("Not initialized");
        admin.require_auth();

        // Clear registry slot (add_mediator / set_mediator dual-writes here)
        env.storage()
            .persistent()
            .remove(&DataKey::MediatorRegistry(mediator_address.clone()));

        // Clear legacy slot if it points to the same address
        if let Some(legacy) = env
            .storage()
            .instance()
            .get::<_, Address>(&DataKey::Mediator)
            && legacy == mediator_address
        {
            env.storage().instance().remove(&DataKey::Mediator);
        }

        MediatorRemovedEvent {
            mediator: mediator_address,
        }
        .publish(&env);
    }

    /// Returns `true` if `address` is currently in the approved mediator registry.
    /// Read-only; callable by anyone.
    pub fn is_mediator(env: Env, address: Address) -> bool {
        env.storage()
            .persistent()
            .get::<_, bool>(&DataKey::MediatorRegistry(address))
            .unwrap_or(false)
    }

    // -----------------------------------------------------------------------
    // Guardian multisig — emergency pause (#188)
    // -----------------------------------------------------------------------

    /// Registers an address as an authorized guardian.
    /// Only the contract admin may call this.
    pub fn add_guardian(env: Env, guardian: Address) {
        let admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .expect("not initialized");
        admin.require_auth();
        env.storage()
            .persistent()
            .set(&DataKey::GuardianRegistry(guardian), &true);
        Self::bump_instance_ttl(&env);
    }

    /// Removes a guardian. Admin only.
    pub fn remove_guardian(env: Env, guardian: Address) {
        let admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .expect("not initialized");
        admin.require_auth();
        env.storage()
            .persistent()
            .remove(&DataKey::GuardianRegistry(guardian));
        Self::bump_instance_ttl(&env);
    }

    /// Returns true when the given address is a registered guardian.
    pub fn is_guardian(env: Env, address: Address) -> bool {
        env.storage()
            .persistent()
            .get::<_, bool>(&DataKey::GuardianRegistry(address))
            .unwrap_or(false)
    }

    /// Pauses all state-changing contract operations. Caller must be a guardian.
    pub fn pause(env: Env, guardian: Address) {
        guardian.require_auth();
        assert!(
            env.storage()
                .persistent()
                .get::<_, bool>(&DataKey::GuardianRegistry(guardian))
                .unwrap_or(false),
            "caller is not a guardian"
        );
        env.storage().instance().set(&DataKey::Paused, &true);
        Self::bump_instance_ttl(&env);
    }

    /// Unpauses the contract. Caller must be a guardian.
    /// A timelock is not enforced here — the admin may also unpause via admin key
    /// to recover from an accidental freeze; the incident runbook covers both paths.
    pub fn unpause(env: Env, guardian: Address) {
        guardian.require_auth();
        assert!(
            env.storage()
                .persistent()
                .get::<_, bool>(&DataKey::GuardianRegistry(guardian))
                .unwrap_or(false),
            "caller is not a guardian"
        );
        env.storage().instance().set(&DataKey::Paused, &false);
        Self::bump_instance_ttl(&env);
    }

    /// Returns true when the contract is currently paused.
    pub fn is_paused(env: Env) -> bool {
        env.storage()
            .instance()
            .get(&DataKey::Paused)
            .unwrap_or(false)
    }

    // -----------------------------------------------------------------------
    // Multi-asset allowlist (#187)
    // -----------------------------------------------------------------------

    /// Registers an asset contract address as allowed for escrow operations.
    /// `decimals` controls fixed-point display for downstream clients.
    /// Admin only.
    pub fn allow_asset(env: Env, asset: Address, decimals: u32) {
        let admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .expect("not initialized");
        admin.require_auth();
        assert!(decimals <= 18, "decimals must be <= 18");
        env.storage()
            .persistent()
            .set(&DataKey::AllowedAsset(asset.clone()), &true);
        env.storage()
            .persistent()
            .set(&DataKey::AssetDecimals(asset), &decimals);
        Self::bump_instance_ttl(&env);
    }

    /// Removes an asset from the allowlist. Admin only.
    pub fn disallow_asset(env: Env, asset: Address) {
        let admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .expect("not initialized");
        admin.require_auth();
        env.storage()
            .persistent()
            .remove(&DataKey::AllowedAsset(asset.clone()));
        env.storage()
            .persistent()
            .remove(&DataKey::AssetDecimals(asset));
        Self::bump_instance_ttl(&env);
    }

    /// Returns true when the given asset contract address is on the allowlist.
    pub fn is_asset_allowed(env: Env, asset: Address) -> bool {
        env.storage()
            .persistent()
            .get::<_, bool>(&DataKey::AllowedAsset(asset))
            .unwrap_or(false)
    }

    /// Returns the decimal precision stored for an allowed asset.
    pub fn get_asset_decimals(env: Env, asset: Address) -> Option<u32> {
        env.storage()
            .persistent()
            .get(&DataKey::AssetDecimals(asset))
    }

    /// Returns the persistent storage schema version of this contract instance.
    ///
    /// Instances initialized before schema versioning existed have no stored
    /// value and report version 1 (the original layout), so upgrades can branch
    /// on this number to decide whether a migration is required. Read-only.
    pub fn get_schema_version(env: Env) -> u32 {
        env.storage()
            .instance()
            .get(&DataKey::SchemaVersion)
            .unwrap_or(CURRENT_SCHEMA_VERSION)
    }

    /// Update the platform fee rate. Admin only.
    /// `new_fee_bps` must be within [`MIN_FEE_BPS`, `MAX_FEE_BPS`].
    /// Emits `FeeRateUpdated(old, new)`.
    pub fn update_fee_bps(env: Env, new_fee_bps: u32) {
        let admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .expect("Not initialized");
        admin.require_auth();
        assert!(
            (MIN_FEE_BPS..=MAX_FEE_BPS).contains(&new_fee_bps),
            "fee_bps out of range"
        );
        let old_fee_bps: u32 = env.storage().instance().get(&DataKey::FeeBps).unwrap_or(0);
        env.storage().instance().set(&DataKey::FeeBps, &new_fee_bps);
        FeeRateUpdatedEvent {
            old_fee_bps,
            new_fee_bps,
        }
        .publish(&env);
    }

    /// Withdraw accrued platform fees from the contract to `destination`.
    /// Only the admin may call this. Reverts if `amount` is zero or exceeds
    /// the currently accrued fees. Emits `FeesWithdrawn`.
    pub fn withdraw_fees(env: Env, amount: i128, destination: Address) {
        let admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .expect("Not initialized");
        admin.require_auth();
        assert!(amount > 0, "amount must be greater than zero");
        let accrued_fees: i128 = env
            .storage()
            .instance()
            .get(&DataKey::AccruedFees)
            .unwrap_or(0);
        assert!(amount <= accrued_fees, "insufficient accrued fees");
        let token: Address = env
            .storage()
            .instance()
            .get(&DataKey::CngnContract)
            .expect("Not initialized");
        let token_client = token::Client::new(&env, &token);
        token_client.transfer(&env.current_contract_address(), &destination, &amount);
        env.storage()
            .instance()
            .set(&DataKey::AccruedFees, &(accrued_fees - amount));
        FeesWithdrawnEvent {
            amount,
            destination,
        }
        .publish(&env);
        Self::bump_instance_ttl(&env);
    }

    /// Return the total accrued platform fees that remain unwithdrawn.
    pub fn get_accrued_fees(env: Env) -> i128 {
        env.storage()
            .instance()
            .get(&DataKey::AccruedFees)
            .unwrap_or(0)
    }

    // -----------------------------------------------------------------------
    // Timelock operations (Issue #189)
    // -----------------------------------------------------------------------

    /// Enqueues a timelocked administrative clawback operation for a trade.
    ///
    /// # Parameters
    /// - `env`: Soroban environment.
    /// - `trade_id`: Unique identifier of the trade subject to clawback.
    /// - `clawback_amount`: Amount of funds to claw back from escrow.
    /// - `destination`: Recipient address for the clawed back funds.
    ///
    /// # Panics
    /// - Panics if caller is not authorized as contract admin.
    /// - Panics if trade does not exist or clawback amount is invalid.
    ///
    /// # State Effects
    /// - Generates a new unique `operation_id`.
    /// - Records `QueuedOperation` in persistent storage with an execution timelock.
    /// - Emits `ClawbackQueued` event.
    pub fn queue_clawback(
        env: Env,
        trade_id: u64,
        clawback_amount: i128,
        destination: Address,
    ) -> u64 {
        let admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .expect("Not initialized");
        admin.require_auth();

        assert!(
            clawback_amount > 0,
            "{}",
            clawback_errors::INVALID_AMOUNT
        );

        let config: TimelockConfig = env
            .storage()
            .instance()
            .get(&DataKey::TimelockConfig)
            .unwrap_or(TimelockConfig {
                clawback_delay_seconds: 86400,
                upgrade_delay_seconds: 604800,
            });

        let now = env.ledger().timestamp();
        let execute_after = now + config.clawback_delay_seconds;
        let operation_id: u64 = env
            .storage()
            .instance()
            .get(&DataKey::NextTimelockId)
            .unwrap_or(0);

        let queued_op = QueuedOperation {
            operation_id,
            operation_type: soroban_sdk::String::from_str(&env, "clawback"),
            payload: TimelockOpPayload::Clawback(TimelockClawbackOp {
                trade_id,
                clawback_amount,
                destination,
            }),
            queued_at: now,
            execute_after,
            executed: false,
            cancelled: false,
            admin: admin.clone(),
        };

        env.storage()
            .persistent()
            .set(&DataKey::TimelockOperation(operation_id), &queued_op);
        env.storage()
            .instance()
            .set(&DataKey::NextTimelockId, &(operation_id + 1));

        TimelockOperationQueued {
            operation_id,
            operation_type: soroban_sdk::String::from_str(&env, "clawback"),
            queued_at: now,
            execute_after,
            admin,
        }
        .publish(&env);

        Self::bump_instance_ttl(&env);
        operation_id
    }

    /// Executes a previously queued administrative clawback once its timelock delay has elapsed.
    ///
    /// # Parameters
    /// - `env`: Soroban environment.
    /// - `operation_id`: Unique identifier of the queued clawback operation.
    ///
    /// # Panics
    /// - Panics if caller is not authorized as contract admin.
    /// - Panics if the operation does not exist or has already been executed/cancelled.
    /// - Panics if the current ledger timestamp is prior to the operation's execution time.
    ///
    /// # State Effects
    /// - Transfers clawback amount from contract escrow to the specified destination.
    /// - Marks the operation status as executed in storage.
    /// - Emits `ClawbackExecuted` event.
    pub fn execute_clawback(env: Env, operation_id: u64) {
        let admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .expect("Not initialized");
        admin.require_auth();

        let key = DataKey::TimelockOperation(operation_id);
        let mut queued_op: QueuedOperation = env
            .storage()
            .persistent()
            .get(&key)
            .expect("operation not found");

        let now = env.ledger().timestamp();
        assert!(now >= queued_op.execute_after, "operation not ready for execution");
        assert!(!queued_op.executed, "operation already executed");
        assert!(!queued_op.cancelled, "operation has been cancelled");

        if let TimelockOpPayload::Clawback(clawback_op) = queued_op.payload.clone() {
            assert!(
                clawback_op.clawback_amount > 0,
                "{}",
                clawback_errors::INVALID_AMOUNT
            );

            let trade_key = DataKey::Trade(clawback_op.trade_id);
            let mut trade: Trade = Self::load_trade(&env, &trade_key);

            assert!(
                matches!(trade.status, TradeStatus::Funded | TradeStatus::Disputed),
                "Trade must be in Funded or Disputed status for clawback"
            );
            assert!(
                clawback_op.clawback_amount <= trade.amount,
                "clawback_amount exceeds remaining escrowed amount"
            );

            let token_client = token::Client::new(&env, &trade.token);
            token_client.transfer(
                &env.current_contract_address(),
                &clawback_op.destination,
                &clawback_op.clawback_amount,
            );

            trade.amount -= clawback_op.clawback_amount;
            if trade.amount == 0 {
                trade.status = TradeStatus::Cancelled;
            }
            trade.updated_at = now;
            Self::save_trade(&env, &trade_key, &trade);

            let clawback_total: i128 = env
                .storage()
                .persistent()
                .get::<_, i128>(&DataKey::ClawbackTotal(clawback_op.trade_id))
                .unwrap_or(0);
            env.storage()
                .persistent()
                .set(
                    &DataKey::ClawbackTotal(clawback_op.trade_id),
                    &(clawback_total + clawback_op.clawback_amount),
                );

            queued_op.executed = true;
            env.storage().persistent().set(&key, &queued_op);

            TimelockOperationExecuted {
                operation_id,
                executed_at: now,
            }
            .publish(&env);
        }

        Self::bump_instance_ttl(&env);
    }

    /// Cancels a pending queued administrative operation before execution.
    ///
    /// # Parameters
    /// - `env`: Soroban environment.
    /// - `operation_id`: Unique identifier of the queued operation to cancel.
    ///
    /// # Panics
    /// - Panics if caller is not authorized as contract admin.
    /// - Panics if the operation does not exist or is not in a pending state.
    ///
    /// # State Effects
    /// - Updates the operation status to cancelled in storage.
    /// - Emits `OperationCancelled` event.
    pub fn cancel_queued_operation(env: Env, operation_id: u64) {
        let admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .expect("Not initialized");
        admin.require_auth();

        let key = DataKey::TimelockOperation(operation_id);
        let mut queued_op: QueuedOperation = env
            .storage()
            .persistent()
            .get(&key)
            .expect("operation not found");

        assert!(!queued_op.executed, "cannot cancel executed operation");
        assert!(!queued_op.cancelled, "operation already cancelled");

        queued_op.cancelled = true;
        env.storage().persistent().set(&key, &queued_op);

        let now = env.ledger().timestamp();
        TimelockOperationCancelled {
            operation_id,
            cancelled_at: now,
            admin,
        }
        .publish(&env);

        Self::bump_instance_ttl(&env);
    }

    /// Retrieves the details of a queued administrative operation by its ID.
    ///
    /// # Parameters
    /// - `env`: Soroban environment.
    /// - `operation_id`: Unique identifier of the queued operation.
    ///
    /// # Panics
    /// - Does not panic.
    ///
    /// # State Effects
    /// - Read-only query; no state modifications.
    pub fn get_queued_operation(env: Env, operation_id: u64) -> Option<QueuedOperation> {
        env.storage()
            .persistent()
            .get(&DataKey::TimelockOperation(operation_id))
    }

    /// Perform a partial (or full) admin clawback on an escrowed trade.
    ///
    /// The admin may call this any number of times as long as funds remain in
    /// escrow. Each call reduces `trade.amount` by `clawback_amount` and
    /// transfers that amount to `destination`. When the remaining balance
    /// reaches zero the trade is transitioned to `Cancelled`.
    ///
    /// # Safety invariants
    /// - Trade must be in `Funded` or `Disputed` status.
    /// - `clawback_amount` must be `> 0` (panics with [`clawback_errors::INVALID_AMOUNT`] /
    ///   `CLAWBACK_INVALID_AMOUNT` for zero or negative amounts).
    /// - `clawback_amount` must be ≤ remaining `trade.amount` (no over-clawback).
    /// - Cumulative `ClawbackTotal` is updated on every call for auditability.
    ///
    /// # Access control (Issue #105 audit)
    /// The admin address is read directly from instance storage — never taken
    /// as a caller-supplied argument — so it cannot be spoofed. `require_auth()`
    /// is invoked on that stored address before any state is read or mutated,
    /// so an unauthorized caller cannot reach the storage/transfer logic below
    /// even under a mocked-auth test harness. There is no implicit admin
    /// fallback: if `DataKey::Admin` was never set, `expect("Not initialized")`
    /// panics rather than defaulting to an open-access state.
    ///
    /// # Feature gating (Issue #113)
    /// Also requires `ClawbackEnabled` (see `set_clawback_enabled`) to be true;
    /// this lets an admin freeze clawbacks during a staged rollout or incident
    /// without a contract upgrade.
    ///
    /// Emits [`ClawbackExecutedEvent`] including the `schema_version` field so
    /// listeners can detect future structural additions.
    pub fn admin_clawback(env: Env, trade_id: u64, clawback_amount: i128, destination: Address) {
        // ACCESS CONTROL: admin is read from storage (not a param), then
        // require_auth() is enforced before any state is touched.
        let admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .expect("Not initialized");
        admin.require_auth();

        assert!(
            Self::is_clawback_enabled(env.clone()),
            "admin_clawback: clawback feature is currently disabled"
        );

        assert!(
            clawback_amount > 0,
            "{}",
            clawback_errors::INVALID_AMOUNT
        );

        let key = DataKey::Trade(trade_id);
        let mut trade: Trade = Self::load_trade(&env, &key);

        assert!(
            matches!(trade.status, TradeStatus::Funded | TradeStatus::Disputed),
            "Trade must be in Funded or Disputed status for clawback"
        );
        assert!(
            clawback_amount <= trade.amount,
            "clawback_amount exceeds remaining escrowed amount"
        );

        // Transfer clawback funds out of escrow
        let token_client = token::Client::new(&env, &trade.token);
        token_client.transfer(
            &env.current_contract_address(),
            &destination,
            &clawback_amount,
        );

        // Track cumulative clawback for this trade
        let clawback_key = DataKey::ClawbackTotal(trade_id);
        let prior_clawback_total: i128 = env
            .storage()
            .persistent()
            .get(&clawback_key)
            .unwrap_or(0_i128);
        let new_clawback_total = prior_clawback_total
            .checked_add(clawback_amount)
            .expect("clawback total overflow");
        env.storage()
            .persistent()
            .set(&clawback_key, &new_clawback_total);

        // Reduce the escrowed amount
        let remaining_amount = trade.amount - clawback_amount;
        trade.amount = remaining_amount;
        let now = env.ledger().timestamp();
        trade.updated_at = now;

        // If nothing remains, transition to Cancelled
        if remaining_amount == 0 {
            trade.status = TradeStatus::Cancelled;
            Self::update_release_sequence(&env, &trade, |sequence, at| {
                sequence.cancelled_at = Some(at);
            });
        Self::record_trade_event(
            &env,
            trade_id,
            "clawback_full",
            admin.clone(),
            "admin full clawback — trade cancelled",
        );
        } else {
        Self::record_trade_event(
            &env,
            trade_id,
            "clawback_partial",
            admin.clone(),
            "admin partial clawback",
        );
        }

        Self::save_trade(&env, &key, &trade);

        ClawbackExecutedEvent {
            trade_id,
            clawback_amount,
            remaining_amount,
            destination,
            admin,
            schema_version: EVENT_SCHEMA_VERSION,
        }
        .publish(&env);

        Self::bump_instance_ttl(&env);
    }

    /// Return the cumulative amount clawed back from a given trade by the admin.
    /// Returns 0 if no clawback has been performed on this trade.
    pub fn get_clawback_total(env: Env, trade_id: u64) -> i128 {
        env.storage()
            .persistent()
            .get(&DataKey::ClawbackTotal(trade_id))
            .unwrap_or(0_i128)
    }

    /// Deployment-time enablement switch for `admin_clawback` (Issue #113).
    /// Admin-only. Lets a rollout stage or freeze the clawback feature without
    /// a contract upgrade.
    pub fn set_clawback_enabled(env: Env, enabled: bool) {
        let admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .expect("Not initialized");
        admin.require_auth();

        env.storage()
            .instance()
            .set(&DataKey::ClawbackEnabled, &enabled);
        Self::bump_instance_ttl(&env);
    }

    /// Whether `admin_clawback` is currently enabled. Defaults to `true` when
    /// unset so upgrading existing deployments preserves current behavior;
    /// call `set_clawback_enabled(false)` to opt into a staged rollout.
    pub fn is_clawback_enabled(env: Env) -> bool {
        env.storage()
            .instance()
            .get(&DataKey::ClawbackEnabled)
            .unwrap_or(true)
    }

    /// Return the total amount claimed (released) from a given trade.
    /// This calculates the amount based on trade status and clawback history.
    /// Returns 0 if the trade has not completed or no funds have been released.
    pub fn get_claimed_amount(env: Env, trade_id: u64) -> i128 {
        let key = DataKey::Trade(trade_id);
        if !env.storage().persistent().has(&key) {
            return 0;
        }
        let trade: Trade = Self::load_trade(&env, &key);
        
        match trade.status {
            TradeStatus::Completed => {
                let original_amount = trade.amount;
                let clawed_back = Self::get_clawback_total(env, trade_id);
                original_amount.saturating_sub(clawed_back)
            }
            _ => 0
        }
    }

    /// Return accounting summary for a trade stream: original amount, claimed, and clawed back.
    /// Returns a tuple of (original_amount, claimed_amount, clawback_total).
    pub fn get_stream_accounting(env: Env, trade_id: u64) -> (i128, i128, i128) {
        let key = DataKey::Trade(trade_id);
        if !env.storage().persistent().has(&key) {
            return (0, 0, 0);
        }
        let trade: Trade = Self::load_trade(&env, &key);
        let original_amount = trade.amount;
        let clawback_total = Self::get_clawback_total(env.clone(), trade_id);
        let claimed_amount = Self::get_claimed_amount(env, trade_id);
        
        (original_amount, claimed_amount, clawback_total)
    }

    // -----------------------------------------------------------------------
    // Upgrade operations (Issue #193)
    // -----------------------------------------------------------------------

    /// Enqueues a timelocked contract WASM code upgrade.
    ///
    /// # Parameters
    /// - `env`: Soroban environment.
    /// - `new_wasm_hash`: 32-byte hash of the newly uploaded WASM bytecode.
    ///
    /// # Panics
    /// - Panics if caller is not authorized as contract admin.
    ///
    /// # State Effects
    /// - Stores a pending upgrade operation in persistent storage with timelock delay.
    /// - Emits `UpgradeQueued` event.
    pub fn queue_upgrade(env: Env, new_wasm_hash: BytesN<32>) -> u64 {
        let admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .expect("Not initialized");
        admin.require_auth();

        let config: TimelockConfig = env
            .storage()
            .instance()
            .get(&DataKey::TimelockConfig)
            .unwrap_or(TimelockConfig {
                clawback_delay_seconds: 86400,
                upgrade_delay_seconds: 604800,
            });

        let now = env.ledger().timestamp();
        let execute_after = now + config.upgrade_delay_seconds;
        let operation_id: u64 = env
            .storage()
            .instance()
            .get(&DataKey::NextTimelockId)
            .unwrap_or(0);

        let queued_op = QueuedOperation {
            operation_id,
            operation_type: soroban_sdk::String::from_str(&env, "upgrade"),
            payload: TimelockOpPayload::Upgrade(TimelockUpgradeOp {
                new_wasm_hash: new_wasm_hash.clone(),
            }),
            queued_at: now,
            execute_after,
            executed: false,
            cancelled: false,
            admin: admin.clone(),
        };

        env.storage()
            .persistent()
            .set(&DataKey::TimelockOperation(operation_id), &queued_op);
        env.storage()
            .instance()
            .set(&DataKey::NextTimelockId, &(operation_id + 1));

        ContractUpgradeQueued {
            operation_id,
            new_wasm_hash,
            queued_at: now,
            execute_after,
        }
        .publish(&env);

        Self::bump_instance_ttl(&env);
        operation_id
    }

    /// Executes an enqueued contract upgrade after the timelock window expires.
    ///
    /// # Parameters
    /// - `env`: Soroban environment.
    /// - `operation_id`: Unique identifier of the queued upgrade operation.
    ///
    /// # Panics
    /// - Panics if caller is not authorized as admin.
    /// - Panics if operation does not exist or timelock has not expired.
    ///
    /// # State Effects
    /// - Updates the contract's executable WASM bytecode via `env.deployer().update_current_contract_wasm()`.
    /// - Marks operation as executed.
    /// - Emits `UpgradeExecuted` event.
    pub fn execute_upgrade(env: Env, operation_id: u64) {
        let admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .expect("Not initialized");
        admin.require_auth();

        let key = DataKey::TimelockOperation(operation_id);
        let mut queued_op: QueuedOperation = env
            .storage()
            .persistent()
            .get(&key)
            .expect("operation not found");

        let now = env.ledger().timestamp();
        assert!(now >= queued_op.execute_after, "operation not ready for execution");
        assert!(!queued_op.executed, "operation already executed");
        assert!(!queued_op.cancelled, "operation has been cancelled");

        if let TimelockOpPayload::Upgrade(upgrade_op) = queued_op.payload.clone() {
            let new_wasm_hash = upgrade_op.new_wasm_hash.clone();
            env.deployer()
                .update_current_contract_wasm(upgrade_op.new_wasm_hash);

            queued_op.executed = true;
            env.storage().persistent().set(&key, &queued_op);

            ContractUpgradedEvent {
                admin,
                new_wasm_hash,
            }
            .publish(&env);
        }

        Self::bump_instance_ttl(&env);
    }

    // -----------------------------------------------------------------------
    // Internal helpers
    // -----------------------------------------------------------------------

    /// Verifies that the caller is an approved mediator (registry OR legacy slot).
    fn require_mediator(env: &Env, mediator: Address) -> Address {
        mediator.require_auth();

        let in_registry = env
            .storage()
            .persistent()
            .get::<_, bool>(&DataKey::MediatorRegistry(mediator.clone()))
            .unwrap_or(false);
        if in_registry {
            return mediator;
        }

        if let Some(legacy_mediator) = env
            .storage()
            .instance()
            .get::<_, Address>(&DataKey::Mediator)
            && legacy_mediator == mediator
        {
            return mediator;
        }

        panic!("Unauthorized mediator");
    }

    fn default_release_sequence(trade: &Trade) -> ReleaseSequence {
        ReleaseSequence {
            trade_id: trade.trade_id,
            created_at: trade.created_at,
            funded_at: trade.funded_at,
            manifest_submitted_at: None,
            delivered_at: trade.delivered_at,
            disputed_at: None,
            released_at: None,
            resolved_at: None,
            cancelled_at: None,
            expired_at: None,
        }
    }

    fn update_release_sequence(env: &Env, trade: &Trade, updater: fn(&mut ReleaseSequence, u64)) {
        let key = DataKey::ReleaseSequence(trade.trade_id);
        let mut sequence: ReleaseSequence = env
            .storage()
            .persistent()
            .get(&key)
            .unwrap_or_else(|| Self::default_release_sequence(trade));
        updater(&mut sequence, env.ledger().timestamp());
        env.storage().persistent().set(&key, &sequence);
    }

    /// Load a trade from persistent storage, unpacking the versioned `TradeData` envelope.
    fn load_trade(env: &Env, key: &DataKey) -> Trade {
        let data: TradeData = env
            .storage()
            .persistent()
            .get(key)
            .expect("Trade not found");
        match data {
            TradeData::V0(t) => t,
        }
    }

    /// Save a trade to persistent storage, wrapping it in the `TradeData::V0` envelope.
    fn save_trade(env: &Env, key: &DataKey, trade: &Trade) {
        env.storage()
            .persistent()
            .set(key, &TradeData::V0(trade.clone()));
    }

    // -----------------------------------------------------------------------
    // Trade lifecycle
    // -----------------------------------------------------------------------

    /// Creates a new escrow trade between a buyer and seller.
    ///
    /// # Parameters
    /// - `env`: Soroban environment.
    /// - `buyer`: Address of the buyer funding the escrow.
    /// - `seller`: Address of the seller delivering goods/services.
    /// - `amount`: Total payment amount in stroops.
    /// - `buyer_loss_bps`: Loss share for buyer in case of dispute (in basis points).
    /// - `seller_loss_bps`: Loss share for seller in case of dispute (in basis points).
    /// - `expires_at`: Optional Unix timestamp deadline for trade completion.
    ///
    /// # Panics
    /// - Panics if `amount <= 0`.
    /// - Panics if buyer equals seller.
    /// - Panics if `buyer_loss_bps + seller_loss_bps != 10_000`.
    ///
    /// # State Effects
    /// - Increments the contract trade ID counter.
    /// - Stores a new `Trade` record in `Created` status.
    /// - Emits `TradeCreated` event.
    pub fn create_trade(
        env: Env,
        buyer: Address,
        seller: Address,
        amount: i128,
        buyer_loss_bps: u32,
        seller_loss_bps: u32,
        expires_at: Option<u64>,
    ) -> u64 {
        Self::assert_not_paused(&env);
        buyer.require_auth();
        assert!(amount > 0, "amount must be greater than zero");
        assert!(amount <= MAX_TRADE_VALUE, "TradeValueTooLarge");
        assert!(
            buyer != seller,
            "buyer and seller must be different addresses"
        );
        // Bound each share before summing so a malformed out-of-range value is
        // rejected with a clear message rather than triggering an opaque u32
        // overflow panic on the addition below.
        assert!(
            buyer_loss_bps <= 10_000,
            "buyer_loss_bps must not exceed 10000"
        );
        assert!(
            seller_loss_bps <= 10_000,
            "seller_loss_bps must not exceed 10000"
        );
        assert!(
            buyer_loss_bps + seller_loss_bps == 10_000,
            "loss ratios must sum to 10000 (100%)"
        );
        let now = env.ledger().timestamp();
        // Validate deadline is in the future when provided
        if let Some(deadline) = expires_at {
            assert!(deadline > now, "expires_at must be in the future");
        }
        let next_id: u64 = env
            .storage()
            .instance()
            .get(&NEXT_TRADE_ID)
            .unwrap_or(1_u64);
        let ledger_seq = env.ledger().sequence() as u64;
        let trade_id = (ledger_seq << 32) | next_id;
        env.storage().instance().set(&NEXT_TRADE_ID, &(next_id + 1));
        let total_trades: u64 = env
            .storage()
            .instance()
            .get(&DataKey::TotalTrades)
            .unwrap_or(0);
        env.storage()
            .instance()
            .set(&DataKey::TotalTrades, &(total_trades + 1));
        let cngn_address: Address = env
            .storage()
            .instance()
            .get(&DataKey::CngnContract)
            .expect("Not initialized");
        let trade = Trade {
            trade_id,
            buyer: buyer.clone(),
            seller: seller.clone(),
            token: cngn_address,
            amount,
            status: TradeStatus::Created,
            created_at: now,
            updated_at: now,
            funded_at: None,
            delivered_at: None,
            buyer_loss_bps,
            seller_loss_bps,
            expires_at,
        };
        Self::save_trade(&env, &DataKey::Trade(trade_id), &trade);
        env.storage().persistent().set(
            &DataKey::ReleaseSequence(trade_id),
            &Self::default_release_sequence(&trade),
        );
        Self::record_trade_event(
            &env,
            trade_id,
            "created",
            trade.buyer,
            "trade created",
        );
        TradeCreatedEvent {
            trade_id,
            buyer,
            seller,
            amount,
        }
        .publish(&env);
        Self::bump_instance_ttl(&env);
        trade_id
    }

    /// Deposits funds into escrow for a created trade.
    ///
    /// # Parameters
    /// - `env`: Soroban environment.
    /// - `trade_id`: Unique identifier of the trade to fund.
    ///
    /// # Panics
    /// - Panics if trade does not exist or is not in `Created` status.
    /// - Panics if caller is not authorized as trade buyer.
    ///
    /// # State Effects
    /// - Transfers trade amount from buyer to the escrow contract address.
    /// - Updates trade status to `Funded`.
    /// - Emits `Deposited` event.
    pub fn deposit(env: Env, trade_id: u64) {
        Self::assert_not_paused(&env);
        let key = DataKey::Trade(trade_id);
        let mut trade: Trade = Self::load_trade(&env, &key);
        assert!(
            matches!(trade.status, TradeStatus::Created),
            "Trade must be in Created status"
        );
        trade.buyer.require_auth();
        let token_client = token::Client::new(&env, &trade.token);
        token_client.transfer(&trade.buyer, env.current_contract_address(), &trade.amount);
        let now = env.ledger().timestamp();
        trade.status = TradeStatus::Funded;
        trade.funded_at = Some(now);
        trade.updated_at = now;
        Self::save_trade(&env, &key, &trade);
        Self::update_release_sequence(&env, &trade, |sequence, at| {
            sequence.funded_at = Some(at);
        });
        Self::record_trade_event(
            &env,
            trade_id,
            "funded",
            trade.buyer,
            "escrow funded",
        );
        TradeFundedEvent {
            trade_id,
            amount: trade.amount,
        }
        .publish(&env);
        Self::bump_instance_ttl(&env);
    }

    /// Funds an escrow trade using a multi-hop path payment swap from an alternate source token.
    ///
    /// # Parameters
    /// - `env`: Soroban environment.
    /// - `trade_id`: Unique identifier of the trade.
    /// - `buyer`: Address of the buyer providing source tokens.
    /// - `source_amount`: Maximum amount of source tokens to spend.
    /// - `dest_min`: Minimum amount of destination settlement tokens required.
    /// - `path`: Ordered vector of intermediary token addresses for the swap route.
    ///
    /// # Panics
    /// - Panics if caller is not authorized as buyer.
    /// - Panics if swap output is less than `dest_min` or trade amount.
    ///
    /// # State Effects
    /// - Executes path payment, custodying required trade amount in escrow.
    /// - Transitions trade status to `Funded`.
    /// - Emits `DepositedWithPath` event.
    pub fn deposit_with_path(
        env: Env,
        trade_id: u64,
        buyer: Address,
        source_amount: i128,
        dest_min: i128,
        path: Vec<Address>,
    ) {
        assert!(source_amount > 0, "source_amount must be greater than zero");
        assert!(dest_min > 0, "dest_min must be greater than zero");

        let key = DataKey::Trade(trade_id);
        let mut trade: Trade = Self::load_trade(&env, &key);
        assert!(
            matches!(trade.status, TradeStatus::Created),
            "Trade must be in Created status"
        );
        assert!(
            buyer == trade.buyer,
            "Only the buyer can perform a path payment deposit"
        );
        buyer.require_auth();

        let source_token: Address = env
            .storage()
            .instance()
            .get(&DataKey::SourceToken)
            .expect("SourceToken not configured");

        let source_client = token::Client::new(&env, &source_token);
        let contract_addr = env.current_contract_address();

        source_client.transfer(&trade.buyer, &contract_addr, &source_amount);
        let cngn_client = token::Client::new(&env, &trade.token);
        let cngn_before = cngn_client.balance(&contract_addr);

        let intent_key = DataKey::PathPaymentIntent(trade_id);
        assert!(
            !env.storage().persistent().has(&intent_key),
            "Path payment already pending"
        );

        let intent = PathPaymentIntent {
            buyer: buyer.clone(),
            source_amount,
            dest_min,
            path: path.clone(),
            cngn_balance_before: cngn_before,
        };

        env.storage().persistent().set(&intent_key, &intent);

        trade.updated_at = env.ledger().timestamp();
        Self::save_trade(&env, &key, &trade);

        PathPaymentInitiatedEvent {
            trade_id,
            buyer,
            source_token,
            source_amount,
            dest_min,
            path,
        }
        .publish(&env);

        Self::bump_instance_ttl(&env);
    }

    /// Returns the default configured source token for path payments.
    ///
    /// # Parameters
    /// - `env`: Soroban environment.
    ///
    /// # Panics
    /// - Panics if contract has not been initialized.
    ///
    /// # State Effects
    /// - Read-only query; no state modifications.
    pub fn get_source_token(env: Env) -> Address {
        env.storage()
            .instance()
            .get(&DataKey::SourceToken)
            .expect("SourceToken not configured")
    }

    /// Return the admin address.
    pub fn get_admin(env: Env) -> Address {
        env.storage()
            .instance()
            .get(&DataKey::Admin)
            .expect("Not initialized")
    }

    /// Return the token contract address (formerly cngn_contract).
    pub fn get_token_contract(env: Env) -> Address {
        env.storage()
            .instance()
            .get(&DataKey::CngnContract)
            .expect("Not initialized")
    }

    /// Return the treasury address.
    pub fn get_treasury(env: Env) -> Address {
        env.storage()
            .instance()
            .get(&DataKey::Treasury)
            .expect("Not initialized")
    }

    /// Return the current platform fee in basis points.
    pub fn get_fee_bps(env: Env) -> u32 {
        env.storage().instance().get(&DataKey::FeeBps).unwrap_or(0)
    }

    /// Finalize a previously initiated path payment once cNGN has been received.
    pub fn finalize_path_payment(env: Env, trade_id: u64, caller: Address) {
        caller.require_auth();

        let intent_key = DataKey::PathPaymentIntent(trade_id);
        let intent: PathPaymentIntent = env
            .storage()
            .persistent()
            .get(&intent_key)
            .expect("No pending path payment");

        let key = DataKey::Trade(trade_id);
        let mut trade: Trade = Self::load_trade(&env, &key);
        assert!(
            matches!(trade.status, TradeStatus::Created),
            "Trade must be in Created status"
        );

        let admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .expect("Not initialized");
        assert!(
            caller == intent.buyer || caller == admin,
            "Unauthorized path payment finalization"
        );

        let contract_addr = env.current_contract_address();
        let cngn_client = token::Client::new(&env, &trade.token);
        let cngn_after = cngn_client.balance(&contract_addr);
        let dest_amount = cngn_after
            .checked_sub(intent.cngn_balance_before)
            .expect("cNGN balance underflow");

        assert!(
            dest_amount >= intent.dest_min,
            "Path payment: dest_amount below dest_min"
        );

        let now = env.ledger().timestamp();
        trade.amount = dest_amount;
        trade.status = TradeStatus::Funded;
        trade.funded_at = Some(now);
        trade.updated_at = now;
        Self::save_trade(&env, &key, &trade);

        env.storage().persistent().remove(&intent_key);

        PathPaymentExecutedEvent {
            trade_id,
            buyer: intent.buyer,
            source_token: env
                .storage()
                .instance()
                .get(&DataKey::SourceToken)
                .expect("SourceToken not configured"),
            source_amount: intent.source_amount,
            dest_token: trade.token.clone(),
            dest_amount,
        }
        .publish(&env);

        Self::bump_instance_ttl(&env);
    }

    /// Cancel a trade or perform an admin clawback.
    ///
    /// If the trade is in `Created` status, the buyer, seller, or admin can cancel without moving funds.
    /// If the trade is in `Funded` status:
    /// - If called by the `admin`, it acts as an immediate unilateral clawback/refund of escrowed funds to the buyer.
    /// - If called by buyer or seller, both parties must submit cancellation requests before funds are returned to the buyer.
    ///
    /// # Cost Drivers for Admin Clawback (Funded status)
    /// - Storage read for `Trade` record and `Admin` address instance storage.
    /// - Auth verification for `caller` (`admin.require_auth()`).
    /// - Token transfer (`token::Client::transfer`) from contract address back to buyer address.
    /// - Persistent storage write to update `TradeStatus::Cancelled` and `updated_at`.
    /// - Persistent storage write for `ReleaseSequence` tracking (`cancelled_at`).
    /// - Contract event publication (`TradeCancelledEvent`).
    /// - Instance storage TTL extension (`bump_instance_ttl`).
    pub fn cancel_trade(env: Env, trade_id: u64, caller: Address) {
        Self::assert_not_paused(&env);
        let key = DataKey::Trade(trade_id);
        let mut trade: Trade = Self::load_trade(&env, &key);
        let admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .expect("Not initialized");

        caller.require_auth();

        if matches!(trade.status, TradeStatus::Created) {
            assert!(
                caller == trade.buyer || caller == trade.seller || caller == admin,
                "Unauthorized caller"
            );
            Self::execute_cancellation(&env, &mut trade, 0, caller);
        } else if matches!(trade.status, TradeStatus::Funded) {
            let amount = trade.amount;
            if caller == admin {
                Self::execute_cancellation(&env, &mut trade, amount, admin);
            } else {
                assert!(
                    caller == trade.buyer || caller == trade.seller,
                    "Unauthorized caller"
                );

                let req_key = DataKey::CancelRequest(trade_id);
                let mut requests: (bool, bool) = env
                    .storage()
                    .persistent()
                    .get(&req_key)
                    .unwrap_or((false, false));

                if caller == trade.buyer {
                    requests.0 = true;
                } else if caller == trade.seller {
                    requests.1 = true;
                }

                if requests.0 && requests.1 {
                    Self::execute_cancellation(&env, &mut trade, amount, caller);
                    env.storage().persistent().remove(&req_key);
                } else {
                    env.storage().persistent().set(&req_key, &requests);
                    trade.updated_at = env.ledger().timestamp();
                    Self::save_trade(&env, &key, &trade);
                }
            }
        } else {
            panic!("Cannot cancel trade in current status");
        }
    }

    /// Allow the buyer to cancel a trade before funds are deposited.
    ///
    /// This is intentionally narrower than `cancel_trade`: only the buyer may
    /// call it and only while the trade is still `Created`.
    pub fn cancel_by_buyer(env: Env, trade_id: u64) {
        let key = DataKey::Trade(trade_id);
        let mut trade: Trade = Self::load_trade(&env, &key);

        trade.buyer.require_auth();
        assert!(
            matches!(trade.status, TradeStatus::Created),
            "Trade must be in Created status"
        );

        trade.status = TradeStatus::Cancelled;
        trade.updated_at = env.ledger().timestamp();
        Self::save_trade(&env, &key, &trade);
        Self::update_release_sequence(&env, &trade, |sequence, at| {
            sequence.cancelled_at = Some(at);
        });

        TradeCancelledByBuyerEvent {
            trade_id,
            buyer: trade.buyer,
        }
        .publish(&env);
        Self::bump_instance_ttl(&env);
    }

    /// Unilaterally refund a funded or delivered trade.
    ///
    /// Only the seller may call this. It transitions the trade to `Cancelled`
    /// and returns the full escrowed amount to the buyer. This is useful when
    /// the seller cannot fulfill the order or chooses to return funds after
    /// a delivery issue without requiring a formal dispute.
    pub fn refund(env: Env, trade_id: u64) {
        let key = DataKey::Trade(trade_id);
        let mut trade: Trade = Self::load_trade(&env, &key);

        trade.seller.require_auth();

        assert!(
            matches!(trade.status, TradeStatus::Funded | TradeStatus::Delivered),
            "Trade must be Funded or Delivered to be refunded by seller"
        );

        let amount = trade.amount;
        let seller = trade.seller.clone();
        Self::execute_cancellation(&env, &mut trade, amount, seller);
    }

    /// Claim an auto-refund on a trade whose expiry deadline has passed.
    ///
    /// Either the buyer or the seller may call this once `expires_at` has been
    /// reached and the trade is still in `Funded` status (i.e. the buyer has
    /// not yet confirmed delivery and no dispute is active). The full escrowed
    /// amount is returned to the buyer.
    ///
    /// Reverts if:
    /// - The trade has no `expires_at` deadline set.
    /// - The current ledger timestamp is before `expires_at`.
    /// - The trade is not in `Funded` status (already delivered, disputed, etc.).
    /// - The caller is neither the buyer nor the seller.
    pub fn claim_expiry_refund(env: Env, trade_id: u64, caller: Address) {
        caller.require_auth();

        let key = DataKey::Trade(trade_id);
        // The trade is stored as a versioned `TradeData` envelope — reading it
        // directly from persistent storage fails to convert and panics, and
        // writing it back that way would corrupt the envelope for every later
        // read. `load_trade`/`save_trade` are the only supported accessors.
        let mut trade: Trade = Self::load_trade(&env, &key);

        assert!(
            caller == trade.buyer || caller == trade.seller,
            "Only the buyer or seller can claim an expiry refund"
        );
        assert!(
            matches!(trade.status, TradeStatus::Funded),
            "Trade must be in Funded status to claim expiry refund"
        );

        let deadline = trade.expires_at.expect("Trade has no expiry deadline");

        let now = env.ledger().timestamp();
        assert!(now >= deadline, "Trade has not yet expired");

        let refund_amount = trade.amount;

        // Return funds to buyer
        let token_client = token::Client::new(&env, &trade.token);
        token_client.transfer(
            &env.current_contract_address(),
            &trade.buyer,
            &refund_amount,
        );

        trade.status = TradeStatus::Cancelled;
        trade.updated_at = now;
        Self::save_trade(&env, &key, &trade);

        Self::update_release_sequence(&env, &trade, |sequence, at| {
            sequence.expired_at = Some(at);
            sequence.cancelled_at = Some(at);
        });

        TradeExpiredEvent {
            trade_id,
            refund_amount,
            caller,
        }
        .publish(&env);
    }

    /// Allow both the buyer and seller to mutually agree to extend the delivery
    /// deadline on a funded trade. The caller is the buyer (who triggers the
    /// extension), and the contract also requires the seller's authorization.
    ///
    /// Both caps in [`ExtensionPolicy`] are enforced here, at the contract
    /// layer, because this is the only authoritative one: the backend mirror in
    /// `tradeDeadline.service.ts` can be bypassed by calling the contract
    /// directly (#194).
    ///
    /// Reverts if:
    /// - The trade is not in `Funded` status.
    /// - The current ledger timestamp is at or past the existing deadline.
    /// - The new deadline is not strictly in the future.
    /// - The trade has already used its full extension count.
    /// - The new deadline would push the trade past the absolute lifetime cap.
    /// - The new deadline is not later than the current one (an "extension"
    ///   that shortens the deadline would consume budget while giving the
    ///   buyer nothing).
    pub fn extend_deadline(env: Env, trade_id: u64, new_deadline: u64) {
        let key = DataKey::Trade(trade_id);
        let mut trade: Trade = Self::load_trade(&env, &key);

        // Require authorization from both parties
        trade.buyer.require_auth();
        trade.seller.require_auth();

        assert!(
            matches!(trade.status, TradeStatus::Funded),
            "Trade must be Funded to extend deadline"
        );

        let old_deadline = trade.expires_at.expect("Trade has no deadline to extend");

        let now = env.ledger().timestamp();
        assert!(
            now < old_deadline,
            "Cannot extend a deadline that has already passed"
        );
        assert!(new_deadline > now, "New deadline must be in the future");
        assert!(
            new_deadline > old_deadline,
            "New deadline must be later than the current deadline"
        );

        let policy = Self::get_extension_policy(env.clone());
        let used = Self::extension_count(&env, trade_id);

        assert!(
            used < policy.max_extensions,
            "Trade has exhausted its deadline extension allowance"
        );

        // The original deadline is captured on the first extension; from then
        // on every cap check measures against that fixed origin.
        let original_deadline = Self::original_deadline(&env, trade_id).unwrap_or(old_deadline);
        let extended_by = new_deadline.saturating_sub(original_deadline);
        assert!(
            extended_by <= policy.max_total_extension_secs,
            "New deadline exceeds the maximum total extension for this trade"
        );

        if used == 0 {
            env.storage()
                .persistent()
                .set(&DataKey::OriginalDeadline(trade_id), &original_deadline);
        }

        let extensions_used = used + 1;
        env.storage()
            .persistent()
            .set(&DataKey::ExtensionCount(trade_id), &extensions_used);

        trade.expires_at = Some(new_deadline);
        trade.updated_at = now;
        Self::save_trade(&env, &key, &trade);
        Self::record_trade_event(
            &env,
            trade_id,
            "deadline_extended",
            trade.buyer,
            "delivery deadline extended",
        );

        // Budget first, then the extension itself: `DeadlineExtendedEvent`
        // stays the last event this call emits, which existing listeners and
        // `extend_deadline_tests.rs` rely on to identify the extension.
        DeadlineExtensionBudgetEvent {
            trade_id,
            extensions_used,
            extensions_remaining: policy.max_extensions - extensions_used,
            original_deadline,
            extended_by_secs: extended_by,
            extension_secs_remaining: policy
                .max_total_extension_secs
                .saturating_sub(extended_by),
            schema_version: EVENT_SCHEMA_VERSION,
        }
        .publish(&env);

        DeadlineExtendedEvent {
            trade_id,
            old_deadline,
            new_deadline,
        }
        .publish(&env);

        Self::bump_instance_ttl(&env);
    }

    /// Return the active extension policy, falling back to the defaults when
    /// the admin has not configured one (#194).
    pub fn get_extension_policy(env: Env) -> ExtensionPolicy {
        env.storage()
            .instance()
            .get(&DataKey::ExtensionPolicy)
            .unwrap_or(ExtensionPolicy {
                max_extensions: DEFAULT_MAX_DEADLINE_EXTENSIONS,
                max_total_extension_secs: DEFAULT_MAX_TOTAL_EXTENSION_SECS,
            })
    }

    /// Configure the extension caps. Admin only (#194).
    ///
    /// Both values are bounded by `EXTENSION_POLICY_CEILING_*` so that the cap
    /// remains a meaningful protection for buyers even against a compromised
    /// admin key. `max_extensions` of zero is permitted and disables extensions
    /// entirely.
    pub fn set_extension_policy(env: Env, max_extensions: u32, max_total_extension_secs: u64) {
        let admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .expect("Not initialized");
        admin.require_auth();

        assert!(
            max_extensions <= EXTENSION_POLICY_CEILING_COUNT,
            "max_extensions exceeds the policy ceiling"
        );
        assert!(
            max_total_extension_secs <= EXTENSION_POLICY_CEILING_SECS,
            "max_total_extension_secs exceeds the policy ceiling"
        );

        let policy = ExtensionPolicy {
            max_extensions,
            max_total_extension_secs,
        };
        env.storage()
            .instance()
            .set(&DataKey::ExtensionPolicy, &policy);

        ExtensionPolicyUpdatedEvent {
            max_extensions,
            max_total_extension_secs,
            schema_version: EVENT_SCHEMA_VERSION,
        }
        .publish(&env);
        Self::bump_instance_ttl(&env);
    }

    /// Report a trade's remaining extension budget (#194).
    ///
    /// Read-only, so a client can warn before the parties sign an extension
    /// that turns out to be their last.
    pub fn get_extension_status(env: Env, trade_id: u64) -> ExtensionStatus {
        let trade: Trade = Self::load_trade(&env, &DataKey::Trade(trade_id));
        let policy = Self::get_extension_policy(env.clone());
        let used = Self::extension_count(&env, trade_id);

        // Before the first extension the current deadline *is* the original.
        let original_deadline = Self::original_deadline(&env, trade_id).or(trade.expires_at);
        let extended_by = match (original_deadline, trade.expires_at) {
            (Some(original), Some(current)) => current.saturating_sub(original),
            _ => 0,
        };
        let secs_remaining = policy.max_total_extension_secs.saturating_sub(extended_by);
        let count_remaining = policy.max_extensions.saturating_sub(used);

        ExtensionStatus {
            trade_id,
            extensions_used: used,
            extensions_remaining: count_remaining,
            original_deadline,
            extended_by_secs: extended_by,
            extension_secs_remaining: secs_remaining,
            is_final_extension: count_remaining == 1,
            is_exhausted: count_remaining == 0 || secs_remaining == 0,
        }
    }

    /// Extensions applied to `trade_id` so far. Absent storage means zero.
    fn extension_count(env: &Env, trade_id: u64) -> u32 {
        env.storage()
            .persistent()
            .get(&DataKey::ExtensionCount(trade_id))
            .unwrap_or(0)
    }

    /// The trade's first deadline, once captured. `None` before the first
    /// extension.
    fn original_deadline(env: &Env, trade_id: u64) -> Option<u64> {
        env.storage()
            .persistent()
            .get(&DataKey::OriginalDeadline(trade_id))
    }

    fn execute_cancellation(env: &Env, trade: &mut Trade, refund_amount: i128, caller: Address) {
        if refund_amount > 0 {
            let token_client = token::Client::new(env, &trade.token);
            token_client.transfer(
                &env.current_contract_address(),
                &trade.buyer,
                &refund_amount,
            );
        }

        trade.status = TradeStatus::Cancelled;
        trade.updated_at = env.ledger().timestamp();
        Self::save_trade(env, &DataKey::Trade(trade.trade_id), trade);
        Self::update_release_sequence(env, trade, |sequence, at| {
            sequence.cancelled_at = Some(at);
        });

        Self::record_trade_event(
            &env,
            trade.trade_id,
            "cancelled",
            caller.clone(),
            "trade cancelled",
        );
        TradeCancelledEvent {
            trade_id: trade.trade_id,
            refund_amount,
            caller,
            timestamp: env.ledger().timestamp(),
        }
        .publish(env);
    }

    /// Marks goods or services as delivered by the seller, pending buyer confirmation or dispute.
    ///
    /// # Parameters
    /// - `env`: Soroban environment.
    /// - `trade_id`: Unique identifier of the trade.
    ///
    /// # Panics
    /// - Panics if trade status is not `Funded`.
    /// - Panics if caller is not authorized as the trade seller.
    ///
    /// # State Effects
    /// - Transitions trade status to `Delivered`.
    /// - Records delivery timestamp.
    /// - Emits `DeliveryConfirmed` event.
    pub fn confirm_delivery(env: Env, trade_id: u64) {
        let key = DataKey::Trade(trade_id);
        let mut trade: Trade = Self::load_trade(&env, &key);
        trade.buyer.require_auth();
        assert!(
            matches!(trade.status, TradeStatus::Funded),
            "Trade must be funded"
        );
        let now = env.ledger().timestamp();
        trade.status = TradeStatus::Delivered;
        trade.delivered_at = Some(now);
        trade.updated_at = now;
        Self::save_trade(&env, &key, &trade);
        Self::update_release_sequence(&env, &trade, |sequence, at| {
            sequence.delivered_at = Some(at);
        });
        Self::record_trade_event(
            &env,
            trade_id,
            "delivered",
            trade.buyer,
            "delivery confirmed",
        );
        DeliveryConfirmedEvent {
            trade_id,
            delivered_at: now,
        }
        .publish(&env);
    }

    /// Releases escrowed funds to seller after delivery or buyer approval.
    ///
    /// # Parameters
    /// - `env`: Soroban environment.
    /// - `trade_id`: Unique identifier of the trade.
    /// - `caller`: Address triggering fund release (buyer or seller after window).
    ///
    /// # Panics
    /// - Panics if trade status is not `Funded` or `Delivered`.
    /// - Panics if unauthorized caller attempts premature release.
    ///
    /// # State Effects
    /// - Deducts platform fee and transfers fee to treasury.
    /// - Transfers net trade amount to seller.
    /// - Transitions trade status to `Completed`.
    /// - Emits `FundsReleased` event.
    pub fn release_funds(env: Env, trade_id: u64, caller: Address) {
        Self::assert_not_paused(&env);
        let key = DataKey::Trade(trade_id);
        let mut trade: Trade = Self::load_trade(&env, &key);
        assert!(
            matches!(trade.status, TradeStatus::Delivered),
            "Trade must be delivered"
        );

        caller.require_auth();

        let admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .expect("Not initialized");
        assert!(
            caller == trade.buyer || caller == admin,
            "Unauthorized caller"
        );

        let fee_bps: u32 = env.storage().instance().get(&DataKey::FeeBps).unwrap_or(0);
        let fee_amount = checked_fee_amount(trade.amount, fee_bps);
        let seller_amount = trade.amount - fee_amount;
        assert!(
            seller_amount + fee_amount == trade.amount,
            "release_funds: cNGN conservation invariant violated"
        );
        assert!(seller_amount >= 0, "seller_amount must be non-negative");
        assert!(fee_amount >= 0, "fee_amount must be non-negative");
        let token_client = token::Client::new(&env, &trade.token);
        token_client.transfer(
            &env.current_contract_address(),
            &trade.seller,
            &seller_amount,
        );
        if fee_amount > 0 {
            let accrued_fees: i128 = env
                .storage()
                .instance()
                .get(&DataKey::AccruedFees)
                .unwrap_or(0);
            env.storage()
                .instance()
                .set(&DataKey::AccruedFees, &(accrued_fees + fee_amount));
        }
        let now = env.ledger().timestamp();
        trade.status = TradeStatus::Completed;
        trade.updated_at = now;
        Self::save_trade(&env, &key, &trade);
        Self::update_release_sequence(&env, &trade, |sequence, at| {
            sequence.released_at = Some(at);
        });
        Self::record_trade_event(
            &env,
            trade_id,
            "released",
            caller,
            "funds released to seller",
        );
        FundsReleasedEvent {
            trade_id,
            seller_amount,
            fee_amount,
        }
        .publish(&env);
    }

    // -----------------------------------------------------------------------
    // Dispute resolution
    // -----------------------------------------------------------------------

    /// Formally initiate a dispute on a funded trade, recording the reason on-chain.
    ///
    /// Either the buyer or the seller may call this while the trade is `Funded`.
    /// Calling this:
    ///   - Transitions the trade to `TradeStatus::Disputed` (freezing the escrow)
    ///   - Persists a `DisputeRecord` under `DataKey::DisputeData(trade_id)`
    ///   - Emits a `DisputeInitiated` event containing the trade ID, initiator,
    ///     and the supplied `reason_hash`
    ///
    /// `reason_hash` should be an IPFS CID or the SHA-256 hex digest of a
    /// dispute brief so the full content lives off-chain but is committed here.
    pub fn initiate_dispute(env: Env, trade_id: u64, initiator: Address, reason_hash: String) {
        initiator.require_auth();
        assert!(!reason_hash.is_empty(), "reason_hash must not be empty");
        assert!(
            reason_hash.len() <= MAX_HASH_LEN,
            "reason_hash exceeds max length"
        );

        let key = DataKey::Trade(trade_id);
        let mut trade: Trade = Self::load_trade(&env, &key);

        assert!(
            matches!(trade.status, TradeStatus::Funded),
            "Trade must be in Funded status to initiate a dispute"
        );
        assert!(
            initiator == trade.buyer || initiator == trade.seller,
            "Only the buyer or seller can initiate a dispute"
        );

        let now = env.ledger().timestamp();

        // Persist the structured dispute record for mediator look-up
        let record = DisputeRecord {
            initiator: initiator.clone(),
            reason_hash: reason_hash.clone(),
            disputed_at: now,
        };
        env.storage()
            .persistent()
            .set(&DataKey::DisputeData(trade_id), &record);

        // Lock the trade in Disputed state
        trade.status = TradeStatus::Disputed;
        trade.updated_at = now;
        Self::save_trade(&env, &key, &trade);
        Self::update_release_sequence(&env, &trade, |sequence, at| {
            sequence.disputed_at = Some(at);
        });

        // Increment aggregate dispute counter
        let total_disputes: u64 = env
            .storage()
            .instance()
            .get(&DataKey::TotalDisputes)
            .unwrap_or(0);
        env.storage()
            .instance()
            .set(&DataKey::TotalDisputes, &(total_disputes + 1));

        // Record trade history entry
        Self::record_trade_event(
            &env,
            trade_id,
            "disputed",
            initiator.clone(),
            "dispute initiated",
        );

        // Emit on-chain event
        DisputeInitiatedEvent {
            trade_id,
            initiator,
            reason_hash,
        }
        .publish(&env);
    }

    /// Retrieve the `DisputeRecord` stored by `initiate_dispute()`, if any.
    pub fn get_dispute_record(env: Env, trade_id: u64) -> Option<DisputeRecord> {
        env.storage()
            .persistent()
            .get(&DataKey::DisputeData(trade_id))
    }

    /// Resolve a disputed trade with loss-sharing payouts.
    /// Only the registered mediator may call this.
    ///
    /// # Payout Math with Loss-Sharing
    ///
    /// Given:
    ///   - `total`              = total escrowed amount
    ///   - `seller_gets_bps`    = mediator's ruling: what fraction seller deserves (0–10_000)
    ///   - `buyer_loss_bps`     = buyer's share of any loss (from trade creation)
    ///   - `seller_loss_bps`    = seller's share of any loss (from trade creation)
    ///   - `fee_bps`            = platform fee in basis points (e.g. 100 = 1%)
    ///
    /// Step 1: Calculate the loss amount
    ///   loss_bps = 10_000 - seller_gets_bps
    ///   (e.g., if seller_gets_bps = 7_000, then loss_bps = 3_000 = 30% loss)
    ///
    /// Step 2: Distribute the loss according to agreed ratios
    ///   buyer_loss_amount  = total * loss_bps * buyer_loss_bps  / (10_000 * 10_000)
    ///   seller_loss_amount = total * loss_bps * seller_loss_bps / (10_000 * 10_000)
    ///
    /// Step 3: Calculate raw payouts
    ///   seller_raw   = total - seller_loss_amount
    ///   buyer_refund = total - seller_raw
    ///
    /// Step 4: Deduct platform fee from seller's portion only
    ///   fee        = seller_raw * fee_bps / 10_000
    ///   seller_net = seller_raw - fee
    ///
    /// Example (total=10_000, seller_gets_bps=7_000, buyer_loss_bps=6_000,
    ///          seller_loss_bps=4_000, fee_bps=100):
    ///   loss_bps         = 3_000 (30% loss)
    ///   buyer_loss       = 10_000 * 3_000 * 6_000 / 100_000_000 = 1_800
    ///   seller_loss      = 10_000 * 3_000 * 4_000 / 100_000_000 = 1_200
    ///   seller_raw       = 10_000 - 1_200 = 8_800
    ///   buyer_refund     = 10_000 - 8_800 = 1_200
    ///   fee              = 8_800 * 100 / 10_000 = 88
    ///   seller_net       = 8_800 - 88 = 8_712  → seller
    ///   buyer_refund     = 1_200                → buyer
    ///   treasury         = 88                   → treasury
    ///
    /// Verification: 8_712 + 1_200 + 88 = 10_000 ✓
    pub fn resolve_dispute(env: Env, trade_id: u64, mediator: Address, seller_gets_bps: u32) {
        // 1. Verify caller is the registered mediator
        let mediator = Self::require_mediator(&env, mediator);

        assert!(
            seller_gets_bps <= BPS_DIVISOR as u32,
            "seller_gets_bps must be <= 10_000"
        );

        // High-value disputes are not one mediator's to decide (#195).
        assert!(
            !Self::requires_quorum(env.clone(), trade_id),
            "Trade value requires a mediator quorum; use cast_dispute_vote"
        );

        Self::settle_dispute(&env, trade_id, seller_gets_bps, mediator);
    }

    /// Apply a decided dispute outcome: compute the split, move the funds, and
    /// close the trade.
    ///
    /// Shared by the single-mediator path and both quorum paths so all three
    /// settle identically — the only difference between them is who is allowed
    /// to decide `seller_gets_bps`, never how the money is split (#195).
    fn settle_dispute(env: &Env, trade_id: u64, seller_gets_bps: u32, mediator: Address) {
        let env = env.clone();
        // 2. Load and validate trade
        let key = DataKey::Trade(trade_id);
        let mut trade: Trade = Self::load_trade(&env, &key);
        assert!(
            matches!(trade.status, TradeStatus::Disputed),
            "Trade must be in Disputed status"
        );

        // 3. Load fee config
        let fee_bps: u32 = env.storage().instance().get(&DataKey::FeeBps).unwrap_or(0);

        // 4. Payout math with loss-sharing
        let total = trade.amount;

        // Calculate the loss amount in basis points
        let loss_bps = BPS_DIVISOR - (seller_gets_bps as i128);

        // Distribute loss according to agreed ratios
        // seller_loss = total * loss_bps * seller_loss_bps / (10_000 * 10_000)
        let seller_loss_amount = checked_loss_amount(total, loss_bps, trade.seller_loss_bps);

        // Calculate raw payouts
        let seller_raw = total - seller_loss_amount;
        let buyer_refund = total - seller_raw;

        // Deduct platform fee from seller's portion only
        let fee = checked_fee_amount(seller_raw, fee_bps);
        let seller_net = seller_raw - fee;

        // Invariants: all payouts non-negative and sum to total cNGN escrowed
        assert!(seller_net >= 0, "seller_net must be non-negative");
        assert!(buyer_refund >= 0, "buyer_refund must be non-negative");
        assert!(fee >= 0, "fee must be non-negative");
        assert!(
            seller_net + buyer_refund + fee == total,
            "resolve_dispute: cNGN conservation invariant violated"
        );

        // 5. Execute three atomic transfers
        let token_client = token::Client::new(&env, &trade.token);

        if seller_net > 0 {
            token_client.transfer(&env.current_contract_address(), &trade.seller, &seller_net);
        }
        if fee > 0 {
            let accrued_fees: i128 = env
                .storage()
                .instance()
                .get(&DataKey::AccruedFees)
                .unwrap_or(0);
            env.storage()
                .instance()
                .set(&DataKey::AccruedFees, &(accrued_fees + fee));
        }
        if buyer_refund > 0 {
            token_client.transfer(&env.current_contract_address(), &trade.buyer, &buyer_refund);
        }

        // 6. Update trade state
        let now = env.ledger().timestamp();
        trade.status = TradeStatus::Completed;
        trade.updated_at = now;
        Self::save_trade(&env, &key, &trade);
        Self::update_release_sequence(&env, &trade, |sequence, at| {
            sequence.resolved_at = Some(at);
        });

        // Increment aggregate resolved counter
        let total_resolved: u64 = env
            .storage()
            .instance()
            .get(&DataKey::TotalResolved)
            .unwrap_or(0);
        env.storage()
            .instance()
            .set(&DataKey::TotalResolved, &(total_resolved + 1));

        // 7. Emit event
        Self::record_trade_event(
            &env,
            trade_id,
            "resolved",
            mediator.clone(),
            "dispute resolved",
        );
        DisputeResolvedEvent {
            trade_id,
            seller_payout: seller_net,
            buyer_refund,
            mediator,
        }
        .publish(&env);
    }

    // -----------------------------------------------------------------------
    // Mediator quorum for high-value disputes (#195)
    // -----------------------------------------------------------------------

    /// Return the active quorum policy, or the disabled default when the admin
    /// has not configured one.
    pub fn get_quorum_config(env: Env) -> QuorumConfig {
        env.storage()
            .instance()
            .get(&DataKey::QuorumConfig)
            .unwrap_or(QuorumConfig {
                enabled: false,
                value_threshold: DEFAULT_QUORUM_VALUE_THRESHOLD,
                required_weight: DEFAULT_QUORUM_REQUIRED_WEIGHT,
                vote_window_secs: DEFAULT_QUORUM_VOTE_WINDOW_SECS,
                fallback_min_weight: DEFAULT_QUORUM_FALLBACK_MIN_WEIGHT,
            })
    }

    /// Configure the quorum policy. Admin only.
    ///
    /// `fallback_min_weight` may not exceed `required_weight`: a fallback
    /// threshold above the quorum threshold could never be reached by a vote
    /// set that failed quorum, which would strand the escrow.
    pub fn set_quorum_config(
        env: Env,
        enabled: bool,
        value_threshold: i128,
        required_weight: u32,
        vote_window_secs: u64,
        fallback_min_weight: u32,
    ) {
        let admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .expect("Not initialized");
        admin.require_auth();

        assert!(value_threshold >= 0, "value_threshold must be non-negative");
        assert!(required_weight > 0, "required_weight must be positive");
        assert!(vote_window_secs > 0, "vote_window_secs must be positive");
        assert!(
            fallback_min_weight > 0,
            "fallback_min_weight must be positive"
        );
        assert!(
            fallback_min_weight <= required_weight,
            "fallback_min_weight must not exceed required_weight"
        );

        let config = QuorumConfig {
            enabled,
            value_threshold,
            required_weight,
            vote_window_secs,
            fallback_min_weight,
        };
        env.storage()
            .instance()
            .set(&DataKey::QuorumConfig, &config);

        QuorumConfigUpdatedEvent {
            enabled,
            value_threshold,
            required_weight,
            vote_window_secs,
            fallback_min_weight,
            schema_version: EVENT_SCHEMA_VERSION,
        }
        .publish(&env);
        Self::bump_instance_ttl(&env);
    }

    /// A mediator's vote weight. Unconfigured mediators carry
    /// [`DEFAULT_MEDIATOR_WEIGHT`].
    pub fn get_mediator_weight(env: Env, mediator: Address) -> u32 {
        env.storage()
            .persistent()
            .get(&DataKey::MediatorWeight(mediator))
            .unwrap_or(DEFAULT_MEDIATOR_WEIGHT)
    }

    /// Set a mediator's vote weight. Admin only.
    ///
    /// Capped at [`MAX_MEDIATOR_WEIGHT`] so weighting cannot quietly collapse a
    /// quorum back into a single decisive signature.
    pub fn set_mediator_weight(env: Env, mediator: Address, weight: u32) {
        let admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .expect("Not initialized");
        admin.require_auth();

        assert!(weight > 0, "mediator weight must be positive");
        assert!(
            weight <= MAX_MEDIATOR_WEIGHT,
            "mediator weight exceeds the maximum"
        );

        env.storage()
            .persistent()
            .set(&DataKey::MediatorWeight(mediator.clone()), &weight);

        MediatorWeightUpdatedEvent {
            mediator,
            weight,
            schema_version: EVENT_SCHEMA_VERSION,
        }
        .publish(&env);
    }

    /// Whether `trade_id` must be resolved by quorum rather than by a single
    /// mediator.
    pub fn requires_quorum(env: Env, trade_id: u64) -> bool {
        let config = Self::get_quorum_config(env.clone());
        if !config.enabled {
            return false;
        }
        let trade: Trade = Self::load_trade(&env, &DataKey::Trade(trade_id));
        trade.amount >= config.value_threshold
    }

    /// Votes cast so far on a disputed trade, in the order they were cast.
    pub fn get_dispute_votes(env: Env, trade_id: u64) -> Vec<MediatorVote> {
        Self::quorum_state(&env, trade_id)
            .map(|state| state.votes)
            .unwrap_or(Vec::new(&env))
    }

    /// Cast a weighted vote on a high-value dispute (#195).
    ///
    /// Each approved mediator may vote once. When the weight backing a single
    /// outcome reaches `required_weight`, the dispute settles immediately on
    /// that outcome — no further call is needed.
    ///
    /// `rationale_hash` is mandatory: a vote that moves someone's money should
    /// be accountable to a stated reason, and the hash is what the audit trail
    /// and the dashboard display.
    ///
    /// Reverts if:
    /// - The caller is not an approved mediator.
    /// - The trade is not in `Disputed` status.
    /// - The trade does not require quorum (use `resolve_dispute`).
    /// - This mediator has already voted.
    /// - `rationale_hash` is empty or oversized.
    pub fn cast_dispute_vote(
        env: Env,
        trade_id: u64,
        mediator: Address,
        seller_gets_bps: u32,
        rationale_hash: String,
    ) {
        let mediator = Self::require_mediator(&env, mediator);

        assert!(
            seller_gets_bps <= BPS_DIVISOR as u32,
            "seller_gets_bps must be <= 10_000"
        );
        assert!(
            !rationale_hash.is_empty(),
            "rationale_hash must not be empty"
        );
        assert!(
            rationale_hash.len() <= MAX_HASH_LEN,
            "rationale_hash exceeds max length"
        );

        let trade: Trade = Self::load_trade(&env, &DataKey::Trade(trade_id));
        assert!(
            matches!(trade.status, TradeStatus::Disputed),
            "Trade must be in Disputed status"
        );

        let config = Self::get_quorum_config(env.clone());
        assert!(
            config.enabled && trade.amount >= config.value_threshold,
            "Trade does not require a mediator quorum; use resolve_dispute"
        );

        let now = env.ledger().timestamp();
        let mut state = Self::quorum_state(&env, trade_id).unwrap_or(QuorumState {
            trade_id,
            votes: Vec::new(&env),
            opened_at: now,
        });

        for existing in state.votes.iter() {
            assert!(
                existing.mediator != mediator,
                "Mediator has already voted on this dispute"
            );
        }

        let weight = Self::get_mediator_weight(env.clone(), mediator.clone());
        state.votes.push_back(MediatorVote {
            mediator: mediator.clone(),
            seller_gets_bps,
            weight,
            rationale_hash: rationale_hash.clone(),
            voted_at: now,
        });
        env.storage()
            .persistent()
            .set(&DataKey::DisputeVotes(trade_id), &state);

        let outcome_weight = Self::weight_for_outcome(&state.votes, seller_gets_bps);

        DisputeVoteCastEvent {
            trade_id,
            mediator,
            seller_gets_bps,
            weight,
            rationale_hash,
            outcome_weight,
            weight_to_quorum: config.required_weight.saturating_sub(outcome_weight),
            voted_at: now,
            schema_version: EVENT_SCHEMA_VERSION,
        }
        .publish(&env);

        // Settle as soon as one outcome carries enough weight.
        if outcome_weight >= config.required_weight {
            Self::finalize_quorum(
                &env,
                trade_id,
                &state,
                seller_gets_bps,
                outcome_weight,
                QuorumOutcome::Quorum,
            );
        }
    }

    /// Resolve a quorum dispute that never reached quorum, once its vote window
    /// has closed (#195).
    ///
    /// Without this, a quorum that fails to assemble would lock the escrow
    /// permanently — trading the single-mediator trust problem for a worse
    /// liveness one. The plurality outcome is applied, provided at least
    /// `fallback_min_weight` has voted.
    ///
    /// Callable by either trade party or any approved mediator: the parties are
    /// the ones whose funds are stuck, so they must not depend on a mediator
    /// choosing to act.
    ///
    /// Ties resolve to the lowest `seller_gets_bps` among the tied outcomes —
    /// the buyer-protective reading, since the buyer is the party whose funds
    /// are held and who did not receive the goods in question.
    pub fn resolve_dispute_by_fallback(env: Env, trade_id: u64, caller: Address) {
        caller.require_auth();

        let trade: Trade = Self::load_trade(&env, &DataKey::Trade(trade_id));
        assert!(
            matches!(trade.status, TradeStatus::Disputed),
            "Trade must be in Disputed status"
        );

        let is_party = caller == trade.buyer || caller == trade.seller;
        let is_mediator = Self::is_mediator(env.clone(), caller.clone());
        assert!(
            is_party || is_mediator,
            "Only a trade party or an approved mediator may trigger fallback resolution"
        );

        let config = Self::get_quorum_config(env.clone());
        assert!(
            config.enabled && trade.amount >= config.value_threshold,
            "Trade does not require a mediator quorum; use resolve_dispute"
        );

        let state = Self::quorum_state(&env, trade_id).expect("No votes cast on this dispute");
        assert!(!state.votes.is_empty(), "No votes cast on this dispute");

        let now = env.ledger().timestamp();
        assert!(
            now >= state.opened_at + config.vote_window_secs,
            "Vote window has not closed yet"
        );

        let total_weight = Self::total_vote_weight(&state.votes);
        assert!(
            total_weight >= config.fallback_min_weight,
            "Insufficient vote weight for fallback resolution"
        );

        let (winning_bps, winning_weight) = Self::plurality_outcome(&state.votes);
        Self::finalize_quorum(
            &env,
            trade_id,
            &state,
            winning_bps,
            winning_weight,
            QuorumOutcome::Fallback,
        );
    }

    /// Settle a quorum dispute and publish the quorum-specific event.
    ///
    /// The votes are deliberately left in storage: they are the audit trail for
    /// a decision that moved someone's money, and `get_dispute_votes()` must
    /// keep answering after resolution.
    fn finalize_quorum(
        env: &Env,
        trade_id: u64,
        state: &QuorumState,
        seller_gets_bps: u32,
        winning_weight: u32,
        outcome: QuorumOutcome,
    ) {
        // The winning outcome's first voter stands as the mediator of record on
        // DisputeResolvedEvent, so existing listeners still see a mediator.
        let mediator_of_record = state
            .votes
            .iter()
            .find(|vote| vote.seller_gets_bps == seller_gets_bps)
            .map(|vote| vote.mediator)
            .expect("winning outcome must have at least one vote");

        Self::settle_dispute(env, trade_id, seller_gets_bps, mediator_of_record);

        DisputeQuorumResolvedEvent {
            trade_id,
            seller_gets_bps,
            outcome,
            winning_weight,
            total_weight: Self::total_vote_weight(&state.votes),
            vote_count: state.votes.len(),
            schema_version: EVENT_SCHEMA_VERSION,
        }
        .publish(env);
    }

    fn quorum_state(env: &Env, trade_id: u64) -> Option<QuorumState> {
        env.storage()
            .persistent()
            .get(&DataKey::DisputeVotes(trade_id))
    }

    /// Total weight backing one specific outcome.
    fn weight_for_outcome(votes: &Vec<MediatorVote>, seller_gets_bps: u32) -> u32 {
        let mut total = 0u32;
        for vote in votes.iter() {
            if vote.seller_gets_bps == seller_gets_bps {
                total = total.saturating_add(vote.weight);
            }
        }
        total
    }

    fn total_vote_weight(votes: &Vec<MediatorVote>) -> u32 {
        let mut total = 0u32;
        for vote in votes.iter() {
            total = total.saturating_add(vote.weight);
        }
        total
    }

    /// The outcome carrying the most weight. Ties break to the lowest
    /// `seller_gets_bps`, which favours the buyer.
    ///
    /// Quadratic in the vote count, which is bounded by the size of the
    /// mediator set — a handful of entries, not a growing list.
    fn plurality_outcome(votes: &Vec<MediatorVote>) -> (u32, u32) {
        let mut best_bps = 0u32;
        let mut best_weight = 0u32;
        let mut seen_any = false;

        for candidate in votes.iter() {
            let bps = candidate.seller_gets_bps;
            let weight = Self::weight_for_outcome(votes, bps);
            let wins = !seen_any
                || weight > best_weight
                || (weight == best_weight && bps < best_bps);
            if wins {
                best_bps = bps;
                best_weight = weight;
                seen_any = true;
            }
        }

        (best_bps, best_weight)
    }

    // -----------------------------------------------------------------------
    // Evidence
    // -----------------------------------------------------------------------

    /// Submit evidence for an active dispute. Buyer, seller, or any mediator
    /// may call this any number of times while the trade is Disputed.
    /// All evidence submissions are stored as an append-only list on-chain,
    /// creating an immutable audit trail.
    ///
    /// `ipfs_hash` is typically an IPFS CID pointing to the evidence content.
    /// `description_hash` is an optional IPFS CID or hash describing the evidence.
    pub fn submit_evidence(
        env: Env,
        trade_id: u64,
        caller: Address,
        ipfs_hash: String,
        description_hash: String,
    ) {
        caller.require_auth();

        // Reject malformed payloads: the evidence pointer must be present, and
        // neither caller-supplied string may exceed the storage bound.
        // `description_hash` is optional and so is only length-bounded.
        assert!(!ipfs_hash.is_empty(), "ipfs_hash must not be empty");
        assert!(
            ipfs_hash.len() <= MAX_HASH_LEN,
            "ipfs_hash exceeds max length"
        );
        assert!(
            description_hash.len() <= MAX_HASH_LEN,
            "description_hash exceeds max length"
        );

        let key = DataKey::Trade(trade_id);
        let trade: Trade = Self::load_trade(&env, &key);

        assert!(
            matches!(trade.status, TradeStatus::Disputed),
            "Evidence can only be submitted for a Disputed trade"
        );

        // Allow buyer, seller, or any mediator to submit evidence
        let is_party = caller == trade.buyer || caller == trade.seller;
        let is_mediator = Self::is_mediator(env.clone(), caller.clone());

        assert!(
            is_party || is_mediator,
            "Only buyer, seller, or mediator can submit evidence"
        );

        // Get existing evidence list or create new one
        let evidence_key = DataKey::EvidenceList(trade_id);
        let mut evidence_list: Vec<EvidenceRecord> = env
            .storage()
            .persistent()
            .get(&evidence_key)
            .unwrap_or(Vec::new(&env));

        // Create new evidence record
        let now = env.ledger().timestamp();
        let record = EvidenceRecord {
            submitter: caller.clone(),
            ipfs_hash: ipfs_hash.clone(),
            description_hash: description_hash.clone(),
            submitted_at: now,
        };

        // Append to list
        evidence_list.push_back(record);

        // Store updated list
        env.storage()
            .persistent()
            .set(&evidence_key, &evidence_list);

        // For backward compatibility with legacy get_evidence API, we'll create
        // a simple Bytes representation. Since Soroban String doesn't easily convert
        // to Bytes, we'll use a placeholder approach or store the string length.
        // In practice, clients should use get_evidence_list() for the new API.
        let legacy_bytes = Bytes::new(&env);
        env.storage()
            .persistent()
            .set(&DataKey::Evidence(trade_id, caller.clone()), &legacy_bytes);

        EvidenceSubmittedEvent {
            trade_id,
            submitter: caller,
            evidence_hash: legacy_bytes,
        }
        .publish(&env);
    }

    /// Return all evidence records submitted for a trade, in chronological order.
    /// Returns an empty vector if no evidence has been submitted yet.
    pub fn get_evidence_list(env: Env, trade_id: u64) -> Vec<EvidenceRecord> {
        env.storage()
            .persistent()
            .get(&DataKey::EvidenceList(trade_id))
            .unwrap_or(Vec::new(&env))
    }

    /// Return the evidence hash most recently submitted by `submitter` (legacy).
    /// Returns `None` if no evidence has been submitted yet.
    pub fn get_evidence(env: Env, trade_id: u64, submitter: Address) -> Option<Bytes> {
        env.storage()
            .persistent()
            .get(&DataKey::Evidence(trade_id, submitter))
    }

    // -----------------------------------------------------------------------
    // Video proof
    // -----------------------------------------------------------------------

    /// Anchor a delivery video's IPFS CID on-chain for a specific trade.
    ///
    /// Either the buyer or the seller may submit video proof.
    /// The trade must be in `Funded` or `Disputed` status.
    /// Only one video proof is allowed per trade — attempting to overwrite panics.
    ///
    /// `ipfs_cid` must be a non-empty IPFS content identifier.
    pub fn submit_video_proof(env: Env, trade_id: u64, submitter: Address, ipfs_cid: String) {
        submitter.require_auth();

        assert!(!ipfs_cid.is_empty(), "ipfs_cid must not be empty");
        assert!(
            ipfs_cid.len() <= MAX_HASH_LEN,
            "ipfs_cid exceeds max length"
        );

        let key = DataKey::Trade(trade_id);
        let trade: Trade = Self::load_trade(&env, &key);

        assert!(
            matches!(trade.status, TradeStatus::Funded | TradeStatus::Disputed),
            "Video proof can only be submitted for a Funded or Disputed trade"
        );

        assert!(
            submitter == trade.buyer || submitter == trade.seller,
            "Only the buyer or seller can submit video proof"
        );

        let proof_key = DataKey::VideoProof(trade_id);
        assert!(
            !env.storage().persistent().has(&proof_key),
            "Video proof already submitted for this trade"
        );

        let now = env.ledger().timestamp();
        let record = VideoProofRecord {
            submitter: submitter.clone(),
            ipfs_cid: ipfs_cid.clone(),
            submitted_at: now,
        };

        env.storage().persistent().set(&proof_key, &record);

        VideoProofSubmittedEvent {
            trade_id,
            submitter,
            ipfs_cid,
            timestamp: now,
        }
        .publish(&env);
    }

    /// Submit hashed delivery manifest fields for a funded trade.
    /// Only seller may submit, and only once per trade.
    pub fn submit_manifest(
        env: Env,
        trade_id: u64,
        seller: Address,
        driver_name_hash: String,
        driver_id_hash: String,
    ) {
        seller.require_auth();
        assert!(
            !driver_name_hash.is_empty(),
            "driver_name_hash must not be empty"
        );
        assert!(
            !driver_id_hash.is_empty(),
            "driver_id_hash must not be empty"
        );
        assert!(
            driver_name_hash.len() <= MAX_HASH_LEN,
            "driver_name_hash exceeds max length"
        );
        assert!(
            driver_id_hash.len() <= MAX_HASH_LEN,
            "driver_id_hash exceeds max length"
        );

        let key = DataKey::Trade(trade_id);
        let trade: Trade = Self::load_trade(&env, &key);

        assert!(
            matches!(trade.status, TradeStatus::Funded),
            "Trade must be funded"
        );
        assert!(seller == trade.seller, "Only seller can submit manifest");

        let manifest_key = DataKey::Manifest(trade_id);
        assert!(
            !env.storage().persistent().has(&manifest_key),
            "Manifest already submitted"
        );

        let record = DeliveryManifestRecord {
            seller: seller.clone(),
            driver_name_hash: driver_name_hash.clone(),
            driver_id_hash: driver_id_hash.clone(),
            submitted_at: env.ledger().timestamp(),
        };
        env.storage().persistent().set(&manifest_key, &record);
        Self::update_release_sequence(&env, &trade, |sequence, at| {
            sequence.manifest_submitted_at = Some(at);
        });

        ManifestSubmittedEvent {
            trade_id,
            seller,
            driver_name_hash,
            driver_id_hash,
            timestamp: env.ledger().timestamp(),
        }
        .publish(&env);
    }

    /// Fetch manifest record for a trade, if present.
    pub fn get_manifest(env: Env, trade_id: u64) -> Option<DeliveryManifestRecord> {
        env.storage().persistent().get(&DataKey::Manifest(trade_id))
    }

    /// Fetch on-chain release sequence timestamps for a trade.
    pub fn get_release_sequence(env: Env, trade_id: u64) -> ReleaseSequence {
        if let Some(sequence) = env
            .storage()
            .persistent()
            .get::<_, ReleaseSequence>(&DataKey::ReleaseSequence(trade_id))
        {
            return sequence;
        }

        let trade: Trade = Self::load_trade(&env, &DataKey::Trade(trade_id));
        Self::default_release_sequence(&trade)
    }

    /// Retrieve the video proof record for a trade, if any.
    pub fn get_video_proof(env: Env, trade_id: u64) -> Option<VideoProofRecord> {
        env.storage()
            .persistent()
            .get(&DataKey::VideoProof(trade_id))
    }

    // -----------------------------------------------------------------------
    // Views
    // -----------------------------------------------------------------------

    /// Fetches the full trade record and current state for a given trade ID.
    ///
    /// # Parameters
    /// - `env`: Soroban environment.
    /// - `trade_id`: Unique identifier of the trade.
    ///
    /// # Panics
    /// - Panics if trade does not exist.
    ///
    /// # State Effects
    /// - Read-only query; bumps instance/entry TTL where applicable.
    pub fn get_trade(env: Env, trade_id: u64) -> Trade {
        let key = DataKey::Trade(trade_id);
        Self::load_trade(&env, &key)
    }

    /// Returns the chronological list of stored events for a trade.
    /// Returns an empty Vec if the trade has no recorded events or does not exist.
    pub fn get_trade_history(env: Env, trade_id: u64) -> soroban_sdk::Vec<TradeEvent> {
        env.storage()
            .persistent()
            .get(&DataKey::TradeHistory(trade_id))
            .unwrap_or_else(|| soroban_sdk::Vec::new(&env))
    }

    /// Appends a TradeEvent to the persistent history for trade_id.
    fn record_trade_event(env: &Env, trade_id: u64, event_type: &str, actor: Address, data: &str) {
        let key = DataKey::TradeHistory(trade_id);
        let mut history: soroban_sdk::Vec<TradeEvent> = env
            .storage()
            .persistent()
            .get(&key)
            .unwrap_or_else(|| soroban_sdk::Vec::new(env));
        history.push_back(TradeEvent {
            event_type: soroban_sdk::String::from_str(env, event_type),
            timestamp: env.ledger().timestamp(),
            actor,
            data: soroban_sdk::String::from_str(env, data),
        });
        env.storage().persistent().set(&key, &history);
    }

    /// Retrieves contract-level summary metrics (active trades, completed trades, disputed trades).
    ///
    /// # Parameters
    /// - `env`: Soroban environment.
    ///
    /// # Panics
    /// - Does not panic.
    ///
    /// # State Effects
    /// - Read-only query; returns `(active_trades, completed_trades, disputed_trades)`.
    pub fn get_contract_metrics(env: Env) -> (u64, u64, u64) {
        let total_trades: u64 = env
            .storage()
            .instance()
            .get(&DataKey::TotalTrades)
            .unwrap_or(0);
        let total_disputes: u64 = env
            .storage()
            .instance()
            .get(&DataKey::TotalDisputes)
            .unwrap_or(0);
        let total_resolved: u64 = env
            .storage()
            .instance()
            .get(&DataKey::TotalResolved)
            .unwrap_or(0);
        (total_trades, total_disputes, total_resolved)
    }


}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------


// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod test;

#[cfg(test)]
mod integration_tests;

#[cfg(test)]
mod property_tests;

#[cfg(test)]
mod fee_and_evidence_tests;
