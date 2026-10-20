use soroban_sdk::{contractevent, Address, Bytes, BytesN, String, Vec};
use crate::types::*;
use crate::EVENT_SCHEMA_VERSION;

#[contractevent(topics = ["amana", "initialized"])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct InitializedEvent {
    pub admin: Address,
    pub fee_bps: u32,
    pub timestamp: u64,
}

#[contractevent(topics = ["TRDCRT"])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TradeCreatedEvent {
    pub trade_id: u64,
    pub buyer: Address,
    pub seller: Address,
    pub amount: i128,
}

#[contractevent(topics = ["TRDFND"])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TradeFundedEvent {
    pub trade_id: u64,
    pub amount: i128,
}

#[contractevent(topics = ["TRDCAN"])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TradeCancelledEvent {
    pub trade_id: u64,
    pub refund_amount: i128,
    pub caller: Address,
    pub timestamp: u64,
}

#[contractevent(topics = ["TCNBYR"])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TradeCancelledByBuyerEvent {
    pub trade_id: u64,
    pub buyer: Address,
}

#[contractevent(topics = ["UPGRAD"])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ContractUpgradedEvent {
    pub admin: Address,
    pub new_wasm_hash: BytesN<32>,
}

#[contractevent(topics = ["DELCNF"])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DeliveryConfirmedEvent {
    pub trade_id: u64,
    pub delivered_at: u64,
}

#[contractevent(topics = ["RELSD"])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FundsReleasedEvent {
    pub trade_id: u64,
    pub seller_amount: i128,
    pub fee_amount: i128,
}

/// Emitted when a mediator resolves a dispute.
///
/// # Math Example (total = 10_000, seller_payout_bps = 7_000, fee_bps = 100):
///   seller_raw   = 10_000 * 7_000 / 10_000 = 7_000
///   fee          =  7_000 *   100 / 10_000 =    70
///   seller_net   =  7_000 -    70          = 6_930
///   buyer_refund = 10_000 -  7_000         = 3_000
#[contractevent(topics = ["DISRES"])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DisputeResolvedEvent {
    pub trade_id: u64,
    pub seller_payout: i128,
    pub buyer_refund: i128,
    pub mediator: Address,
}

/// Emitted for every vote cast on a quorum dispute (#195).
///
/// One event per vote, carrying that mediator's rationale hash, so the audit
/// trail records who voted for what and on what stated grounds — including the
/// votes that did not prevail.
#[contractevent(topics = ["DVOTE"])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DisputeVoteCastEvent {
    pub trade_id: u64,
    pub mediator: Address,
    pub seller_gets_bps: u32,
    pub weight: u32,
    pub rationale_hash: String,
    /// Weight backing this mediator's chosen outcome after the vote lands.
    pub outcome_weight: u32,
    /// Weight still needed for that outcome to reach quorum. Zero once met.
    pub weight_to_quorum: u32,
    pub voted_at: u64,
    pub schema_version: u32,
}

/// Emitted when a quorum dispute reaches a decision (#195).
///
/// `DisputeResolvedEvent` still fires alongside this one with the payout
/// figures, so listeners that only track settlement need no change.
#[contractevent(topics = ["DQURES"])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DisputeQuorumResolvedEvent {
    pub trade_id: u64,
    pub seller_gets_bps: u32,
    /// Whether quorum was reached or the deadline fallback applied.
    pub outcome: QuorumOutcome,
    /// Weight backing the winning outcome.
    pub winning_weight: u32,
    /// Total weight cast across all outcomes.
    pub total_weight: u32,
    pub vote_count: u32,
    pub schema_version: u32,
}

/// Emitted when the admin changes the quorum policy (#195).
#[contractevent(topics = ["QURCFG"])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct QuorumConfigUpdatedEvent {
    pub enabled: bool,
    pub value_threshold: i128,
    pub required_weight: u32,
    pub vote_window_secs: u64,
    pub fallback_min_weight: u32,
    pub schema_version: u32,
}

/// Emitted when the admin changes a mediator's vote weight (#195).
#[contractevent(topics = ["MEDWGT"])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct MediatorWeightUpdatedEvent {
    pub mediator: Address,
    pub weight: u32,
    pub schema_version: u32,
}

/// Emitted when a party submits evidence during a live dispute.
#[contractevent(topics = ["EVDSUB"])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct EvidenceSubmittedEvent {
    pub trade_id: u64,
    pub submitter: Address,
    pub evidence_hash: Bytes,
}

/// Emitted when a buyer or seller formally initiates a dispute.
/// `reason_hash` is an IPFS CID or human-readable string hash describing the
/// grounds for the dispute, recorded immutably on-chain.
#[contractevent(topics = ["DISINI"])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DisputeInitiatedEvent {
    pub trade_id: u64,
    pub initiator: Address,
    pub reason_hash: String,
}

/// Emitted when a video proof is submitted for a trade.
#[contractevent(topics = ["VIDPRF"])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct VideoProofSubmittedEvent {
    pub trade_id: u64,
    pub submitter: Address,
    pub ipfs_cid: String,
    pub timestamp: u64,
}

/// Emitted when a trade's expiry deadline is reached and a refund is claimed.
#[contractevent(topics = ["TRDEXP"])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TradeExpiredEvent {
    pub trade_id: u64,
    pub refund_amount: i128,
    pub caller: Address,
}

/// Emitted when both parties agree to extend the delivery deadline.
#[contractevent(topics = ["DEDEXT"])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DeadlineExtendedEvent {
    pub trade_id: u64,
    pub old_deadline: u64,
    pub new_deadline: u64,
}

/// Emitted alongside `DeadlineExtendedEvent`, reporting how much of the
/// extension budget the trade has left (#194).
///
/// This is a separate event rather than extra fields on `DeadlineExtendedEvent`
/// deliberately: the v1 event shapes are locked by `event_schema_tests.rs` and
/// consumed by deployed listeners, and the schema policy on
/// [`EVENT_SCHEMA_VERSION`] admits new event types without disturbing existing
/// ones. Listeners that want the budget subscribe to `DEDBGT`; listeners that
/// do not are unaffected.
#[contractevent(topics = ["DEDBGT"])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DeadlineExtensionBudgetEvent {
    pub trade_id: u64,
    /// Extensions applied so far, including the one just applied.
    pub extensions_used: u32,
    /// Extensions still permitted. Zero means this was the final extension.
    pub extensions_remaining: u32,
    /// The trade's first deadline, which the lifetime cap is measured from.
    pub original_deadline: u64,
    /// Seconds the deadline has moved past `original_deadline` in total.
    pub extended_by_secs: u64,
    /// Seconds of extension still available under the lifetime cap.
    pub extension_secs_remaining: u64,
    pub schema_version: u32,
}

/// Emitted when the admin changes the extension policy (#194).
#[contractevent(topics = ["EXTPOL"])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ExtensionPolicyUpdatedEvent {
    pub max_extensions: u32,
    pub max_total_extension_secs: u64,
    pub schema_version: u32,
}

/// Emitted when seller submits hashed delivery manifest fields.
#[contractevent(topics = ["MNFST"])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ManifestSubmittedEvent {
    pub trade_id: u64,
    pub seller: Address,
    pub driver_name_hash: String,
    pub driver_id_hash: String,
    pub timestamp: u64,
}

/// Emitted when a mediator address is added to the registry by the admin.
#[contractevent(topics = ["MEDADD"])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct MediatorAddedEvent {
    pub mediator: Address,
}

/// Emitted when a mediator address is removed from the registry by the admin.
#[contractevent(topics = ["MEDREM"])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct MediatorRemovedEvent {
    pub mediator: Address,
}

/// Emitted when the admin updates the platform fee rate.
#[contractevent(topics = ["FEEUPD"])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FeeRateUpdatedEvent {
    pub old_fee_bps: u32,
    pub new_fee_bps: u32,
}

/// Emitted when the admin withdraws accrued platform fees from the contract.
#[contractevent(topics = ["FEEWTH"])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FeesWithdrawnEvent {
    pub amount: i128,
    pub destination: Address,
}

/// Emitted when a buyer initiates a path payment deposit.
#[contractevent(topics = ["PTHINT"])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PathPaymentInitiatedEvent {
    pub trade_id: u64,
    pub buyer: Address,
    pub source_token: Address,
    pub source_amount: i128,
    pub dest_min: i128,
    pub path: Vec<Address>,
}

/// Emitted when a path payment is executed to convert source token to cNGN.
#[contractevent(topics = ["PTHPAY"])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PathPaymentExecutedEvent {
    pub trade_id: u64,
    pub buyer: Address,
    pub source_token: Address,
    pub source_amount: i128,
    pub dest_token: Address,
    pub dest_amount: i128,
}

/// Emitted when an admin performs a clawback on an escrowed trade.
/// The full trade amount is returned to the buyer; the trade transitions to Cancelled.
#[contractevent(topics = ["ADMCLW"])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AdminClawbackEvent {
    pub trade_id: u64,
    pub amount: i128,
    pub admin: Address,
    pub timestamp: u64,
}


/// Emitted when the admin performs a partial or full clawback on an escrowed trade.
///
/// A clawback recovers `clawback_amount` from the escrow, crediting it to `destination`.
/// The remaining funds (`trade_amount - clawback_amount`) stay in escrow under the same
/// trade and may be released or refunded through normal channels. A clawback that leaves
/// zero funds in escrow also transitions the trade to `Cancelled`.
///
/// # Schema versioning
/// This event includes `schema_version` so downstream listeners can detect structural
/// additions in future releases.  See [`EVENT_SCHEMA_VERSION`] and
/// `docs/event-schema-migration-plan.md` for the versioning policy.
///
/// # Safety
/// - Only the admin may call `admin_clawback`.
/// - `clawback_amount` must be ≤ the currently escrowed `trade.amount`.
/// - The trade must be in `Funded` or `Disputed` status.
#[contractevent(topics = ["CLWBCK"])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ClawbackExecutedEvent {
    pub trade_id: u64,
    pub clawback_amount: i128,
    pub remaining_amount: i128,
    pub destination: Address,
    pub admin: Address,
    pub schema_version: u32,
}

// ---------------------------------------------------------------------------
// Timelock events (Issue #189)
// ---------------------------------------------------------------------------

#[contractevent(topics = ["TLKQUE"])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TimelockOperationQueued {
    pub operation_id: u64,
    pub operation_type: soroban_sdk::String,
    pub queued_at: u64,
    pub execute_after: u64,
    pub admin: Address,
}

#[contractevent(topics = ["TLKEXE"])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TimelockOperationExecuted {
    pub operation_id: u64,
    pub executed_at: u64,
}

#[contractevent(topics = ["TLKCAN"])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TimelockOperationCancelled {
    pub operation_id: u64,
    pub cancelled_at: u64,
    pub admin: Address,
}

// ---------------------------------------------------------------------------
// Upgrade events (Issue #193)
// ---------------------------------------------------------------------------

#[contractevent(topics = ["UPGQUE"])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ContractUpgradeQueued {
    pub operation_id: u64,
    pub new_wasm_hash: BytesN<32>,
    pub queued_at: u64,
    pub execute_after: u64,
}
