use soroban_sdk::{contracttype, Address, BytesN, String, Vec};
use crate::{DEFAULT_MAX_DEADLINE_EXTENSIONS, DEFAULT_MAX_TOTAL_EXTENSION_SECS};


// ---------------------------------------------------------------------------
// Trade history — stored event record
// ---------------------------------------------------------------------------

#[contracttype]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TradeEvent {
    pub event_type: soroban_sdk::String,
    pub timestamp: u64,
    pub actor: Address,
    pub data: soroban_sdk::String,
}

// ---------------------------------------------------------------------------
// Types & Storage
// ---------------------------------------------------------------------------

#[contracttype]
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum TradeStatus {
    Created,
    Funded,
    Delivered,
    Completed,
    Disputed,
    Cancelled,
}

#[contracttype]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TradeV0 {
    pub trade_id: u64,
    pub buyer: Address,
    pub seller: Address,
    pub token: Address,
    pub amount: i128,
    pub status: TradeStatus,
    pub created_at: u64,
    pub updated_at: u64,
    pub funded_at: Option<u64>,
    pub delivered_at: Option<u64>,
    pub buyer_loss_bps: u32,
    pub seller_loss_bps: u32,
    /// Optional Unix timestamp (seconds) after which either party may claim an
    /// auto-refund via `claim_expiry_refund()`. `None` means no deadline.
    pub expires_at: Option<u64>,
}

/// Versioned enum wrapping trade storage payloads.
/// V0 is the current layout; V1 (and later) can be appended without migrating existing entries.
#[contracttype]
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum TradeData {
    V0(TradeV0),
}

/// Type alias kept for backward compatibility with callers that use `Trade`.
pub type Trade = TradeV0;

/// Admin-configurable caps on deadline extensions (#194).
///
/// Both limits apply together — an extension must satisfy the count cap *and*
/// the lifetime cap. Stored under `DataKey::ExtensionPolicy`; when absent the
/// contract falls back to [`DEFAULT_MAX_DEADLINE_EXTENSIONS`] and
/// [`DEFAULT_MAX_TOTAL_EXTENSION_SECS`], so trades created before this policy
/// existed are governed by the defaults rather than being uncapped.
#[contracttype]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ExtensionPolicy {
    /// Maximum number of extensions permitted per trade.
    pub max_extensions: u32,
    /// Maximum total seconds a deadline may move past its original value.
    pub max_total_extension_secs: u64,
}

/// The remaining extension budget for one trade — the read model behind the
/// "final extension" warning surfaced to both parties (#194).
#[contracttype]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ExtensionStatus {
    pub trade_id: u64,
    pub extensions_used: u32,
    pub extensions_remaining: u32,
    /// `None` when the trade has no deadline, and so nothing to extend.
    pub original_deadline: Option<u64>,
    pub extended_by_secs: u64,
    pub extension_secs_remaining: u64,
    /// True when one extension remains — the caller should warn before use.
    pub is_final_extension: bool,
    /// True when no further extension is possible under either cap.
    pub is_exhausted: bool,
}

/// Admin-configurable mediator quorum policy for high-value disputes (#195).
///
/// Resolving a large escrow on one mediator's signature concentrates both trust
/// and bribery risk on exactly the trades where the stakes are highest. Above
/// `value_threshold` the contract instead collects weighted votes and resolves
/// only when enough weight backs a single outcome.
///
/// Disabled by default: `enabled == false` leaves every dispute on the existing
/// single-mediator path, so enabling quorum is a deliberate governance action
/// rather than a silent change in how deployed trades resolve.
#[contracttype]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct QuorumConfig {
    /// When false, `resolve_dispute()` handles every dispute regardless of value.
    pub enabled: bool,
    /// Escrow value at or above which quorum is required.
    pub value_threshold: i128,
    /// Total vote weight that must back one outcome to resolve (the "N").
    pub required_weight: u32,
    /// Seconds from the first vote until fallback resolution becomes available.
    pub vote_window_secs: u64,
    /// Minimum weight that must have voted for fallback resolution to proceed.
    pub fallback_min_weight: u32,
}

/// A single mediator's weighted vote on a disputed trade (#195).
#[contracttype]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct MediatorVote {
    pub mediator: Address,
    /// The outcome this mediator voted for, in basis points to the seller.
    pub seller_gets_bps: u32,
    /// The mediator's weight at the time of voting.
    pub weight: u32,
    /// IPFS CID or hash of the mediator's written rationale. Required, so every
    /// vote in the audit trail is accountable to a stated reason.
    pub rationale_hash: String,
    pub voted_at: u64,
}

/// Accumulated votes for one disputed trade (#195).
#[contracttype]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct QuorumState {
    pub trade_id: u64,
    pub votes: Vec<MediatorVote>,
    /// Timestamp of the first vote — the fallback window is measured from here.
    pub opened_at: u64,
}

/// How a quorum dispute was ultimately decided (#195).
#[contracttype]
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum QuorumOutcome {
    /// Enough weight backed one outcome within the window.
    Quorum,
    /// The window closed without quorum; the plurality outcome was applied.
    Fallback,
}

/// Persistent record of a dispute created by `initiate_dispute()`.
#[contracttype]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DisputeRecord {
    /// Address of the party (buyer or seller) who initiated the dispute.
    pub initiator: Address,
    /// IPFS CID or descriptive hash of the dispute grounds, supplied at initiation.
    pub reason_hash: String,
    /// Ledger timestamp when the dispute was raised.
    pub disputed_at: u64,
}

/// Record of a video proof submitted for a trade.
/// Only one video proof is allowed per trade (stored under DataKey::VideoProof).
#[contracttype]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct VideoProofRecord {
    /// Address of the party who submitted the video proof.
    pub submitter: Address,
    /// IPFS CID of the video content.
    pub ipfs_cid: String,
    /// Ledger timestamp when the proof was submitted.
    pub submitted_at: u64,
}

/// Record of a single piece of evidence submitted during a dispute.
/// Multiple evidence records can be submitted by any party or mediator.
#[contracttype]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct EvidenceRecord {
    /// Address of the party or mediator who submitted this evidence.
    pub submitter: Address,
    /// IPFS CID or hash pointing to the evidence content.
    pub ipfs_hash: String,
    /// Optional IPFS CID or hash describing the evidence.
    pub description_hash: String,
    /// Ledger timestamp when this evidence was submitted.
    pub submitted_at: u64,
}

/// Hash-only delivery manifest payload anchored on-chain.
#[contracttype]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DeliveryManifestRecord {
    pub seller: Address,
    pub driver_name_hash: String,
    pub driver_id_hash: String,
    pub submitted_at: u64,
}

/// On-chain release sequence state for a trade.
/// Kept separate from `Trade` so existing trade storage layout remains stable.
#[contracttype]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ReleaseSequence {
    pub trade_id: u64,
    pub created_at: u64,
    pub funded_at: Option<u64>,
    pub manifest_submitted_at: Option<u64>,
    pub delivered_at: Option<u64>,
    pub disputed_at: Option<u64>,
    pub released_at: Option<u64>,
    pub resolved_at: Option<u64>,
    pub cancelled_at: Option<u64>,
    /// Set when `claim_expiry_refund()` successfully refunds an expired trade.
    pub expired_at: Option<u64>,
}

#[contracttype]
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum DataKey {
    Trade(u64),
    /// Ordered list of TradeEvent records for a given trade, appended on each state transition.
    TradeHistory(u64),
    Initialized,
    Admin,
    CngnContract,
    FeeBps,
    Treasury,
    /// Legacy single-mediator slot — used by set_mediator() / require_mediator().
    Mediator,
    /// Per-address registry slot. Stores `true` when an address is an approved mediator.
    /// Used by add_mediator() / remove_mediator() / is_mediator().
    MediatorRegistry(Address),
    CancelRequest(u64),
    /// Stores the most-recent evidence hash submitted by each party (legacy).
    Evidence(u64, Address),
    /// Stores the DisputeRecord created by initiate_dispute() for a given trade.
    DisputeData(u64),
    /// Stores the list of all evidence records submitted for a trade.
    EvidenceList(u64),
    /// Stores the single VideoProofRecord for a trade (one per trade, immutable once set).
    VideoProof(u64),
    /// Stores the single DeliveryManifestRecord for a trade.
    Manifest(u64),
    /// Address of the source token contract (e.g., NGN) used for path payments.
    SourceToken,
    /// Stores active path payment intents pending conversion.
    PathPaymentIntent(u64),
    /// Stores release sequencing timestamps for a trade.
    ReleaseSequence(u64),
    /// Aggregate number of trades ever created.
    TotalTrades,
    /// Aggregate number of disputes ever initiated.
    TotalDisputes,
    /// Aggregate number of disputes ever resolved.
    TotalResolved,
    /// Cumulative platform fees accrued from trade completions and dispute
    /// resolutions. Admin may withdraw any portion via `withdraw_fees()`.
    AccruedFees,
    /// Monotonic storage-schema version, written at initialize() and read via
    /// get_schema_version(). Enables forward-compatible migrations without
    /// disturbing any existing key. Appended last so the XDR encoding of every
    /// pre-existing variant is unchanged (variants are keyed by name).
    SchemaVersion,
    /// Cumulative amount clawed back from a given trade by the admin.
    /// Used to prevent over-clawback: all partial clawbacks summed must not
    /// exceed the original escrowed amount.
    ClawbackTotal(u64),
    /// Stores the timelock configuration (delay periods for different operation types).
    TimelockConfig,
    /// Stores a queued privileged operation awaiting execution after a delay.
    TimelockOperation(u64),
    /// Monotonic counter for timelock operation IDs.
    NextTimelockId,
    /// Global pause flag — when true, all state-changing entrypoints are blocked.
    Paused,
    /// Per-address guardian registry. Stores `true` when the address is an authorized guardian.
    GuardianRegistry(Address),
    /// Allowlisted asset contract address for multi-asset escrow support.
    AllowedAsset(Address),
    /// Per-asset decimal precision (u32), stored alongside AllowedAsset.
    AssetDecimals(Address),
    /// Admin-configured `ExtensionPolicy`. Absent until an admin sets one, in
    /// which case the DEFAULT_MAX_* constants apply (#194).
    ExtensionPolicy,
    /// Number of deadline extensions already applied to a trade (#194).
    /// Absent means zero.
    ExtensionCount(u64),
    /// A trade's first deadline, captured on its first extension. The lifetime
    /// cap is measured from here so that repeated small extensions cannot
    /// outflank a limit that one large extension would hit (#194).
    OriginalDeadline(u64),
    /// Admin-configured `QuorumConfig`. Absent until an admin sets one, in
    /// which case quorum is disabled and every dispute uses the single-mediator
    /// path (#195).
    QuorumConfig,
    /// Accumulated `QuorumState` for a disputed trade (#195).
    DisputeVotes(u64),
    /// Per-mediator vote weight. Absent means `DEFAULT_MEDIATOR_WEIGHT` (#195).
    MediatorWeight(Address),
    /// Deployment-time enablement switch for `admin_clawback` (Issue #113).
    /// Absent (post-upgrade default) is treated as enabled to preserve
    /// existing behavior; an admin can explicitly disable/re-enable via
    /// `set_clawback_enabled()` to stage a rollout or freeze the feature.
    ClawbackEnabled,
}

#[contracttype]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PathPaymentIntent {
    pub buyer: Address,
    pub source_amount: i128,
    pub dest_min: i128,
    pub path: Vec<Address>,
    pub cngn_balance_before: i128,
}

// ---------------------------------------------------------------------------
// Timelock operation payload (Issue #189)
// ---------------------------------------------------------------------------

#[contracttype]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TimelockClawbackOp {
    pub trade_id: u64,
    pub clawback_amount: i128,
    pub destination: Address,
}

#[contracttype]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TimelockUpgradeOp {
    pub new_wasm_hash: BytesN<32>,
}

#[contracttype]
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum TimelockOpPayload {
    Clawback(TimelockClawbackOp),
    Upgrade(TimelockUpgradeOp),
}

#[contracttype]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct QueuedOperation {
    pub operation_id: u64,
    pub operation_type: soroban_sdk::String,
    pub payload: TimelockOpPayload,
    pub queued_at: u64,
    pub execute_after: u64,
    pub executed: bool,
    pub cancelled: bool,
    pub admin: Address,
}

#[contracttype]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TimelockConfig {
    pub clawback_delay_seconds: u64,
    pub upgrade_delay_seconds: u64,
}

