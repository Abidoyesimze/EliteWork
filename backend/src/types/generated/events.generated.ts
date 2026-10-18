/**
 * GENERATED FILE - DO NOT EDIT.
 *
 * Source: schemas/events/amana_escrow.events.json
 * Regenerate: node scripts/codegen-events.mjs
 */

/** Event schema version this file was generated from. */
export const EVENT_SCHEMA_VERSION = 1;

/** Every event the contract emits. */
export enum GeneratedEventType {
  Initialized = "Initialized",
  TradeCreated = "TradeCreated",
  TradeFunded = "TradeFunded",
  TradeCancelled = "TradeCancelled",
  TradeCancelledByBuyer = "TradeCancelledByBuyer",
  ContractUpgraded = "ContractUpgraded",
  DeliveryConfirmed = "DeliveryConfirmed",
  FundsReleased = "FundsReleased",
  DisputeResolved = "DisputeResolved",
  EvidenceSubmitted = "EvidenceSubmitted",
  DisputeInitiated = "DisputeInitiated",
  VideoProofSubmitted = "VideoProofSubmitted",
  TradeExpired = "TradeExpired",
  DeadlineExtended = "DeadlineExtended",
  ManifestSubmitted = "ManifestSubmitted",
  MediatorAdded = "MediatorAdded",
  MediatorRemoved = "MediatorRemoved",
  FeeRateUpdated = "FeeRateUpdated",
  FeesWithdrawn = "FeesWithdrawn",
  PathPaymentInitiated = "PathPaymentInitiated",
  PathPaymentExecuted = "PathPaymentExecuted",
  AdminClawback = "AdminClawback",
  ClawbackExecuted = "ClawbackExecuted",
  TimelockOperationQueued = "TimelockOperationQueued",
  TimelockOperationExecuted = "TimelockOperationExecuted",
  TimelockOperationCancelled = "TimelockOperationCancelled",
  ContractUpgradeQueued = "ContractUpgradeQueued",
  DisputeVoteCast = "DisputeVoteCast",
  DisputeQuorumResolved = "DisputeQuorumResolved",
  QuorumConfigUpdated = "QuorumConfigUpdated",
  MediatorWeightUpdated = "MediatorWeightUpdated",
  DeadlineExtensionBudget = "DeadlineExtensionBudget",
  ExtensionPolicyUpdated = "ExtensionPolicyUpdated",
}

/**
 * First topic symbol -> event type.
 *
 * The decoder dispatches on this. Hand-written before, it drifted from
 * the contract's actual topics; it is now generated from the schema.
 */
export const TOPIC_TO_EVENT_TYPE: Readonly<Record<string, GeneratedEventType>> = {
  "amana": GeneratedEventType.Initialized,
  "TRDCRT": GeneratedEventType.TradeCreated,
  "TRDFND": GeneratedEventType.TradeFunded,
  "TRDCAN": GeneratedEventType.TradeCancelled,
  "TCNBYR": GeneratedEventType.TradeCancelledByBuyer,
  "UPGRAD": GeneratedEventType.ContractUpgraded,
  "DELCNF": GeneratedEventType.DeliveryConfirmed,
  "RELSD": GeneratedEventType.FundsReleased,
  "DISRES": GeneratedEventType.DisputeResolved,
  "EVDSUB": GeneratedEventType.EvidenceSubmitted,
  "DISINI": GeneratedEventType.DisputeInitiated,
  "VIDPRF": GeneratedEventType.VideoProofSubmitted,
  "TRDEXP": GeneratedEventType.TradeExpired,
  "DEDEXT": GeneratedEventType.DeadlineExtended,
  "MNFST": GeneratedEventType.ManifestSubmitted,
  "MEDADD": GeneratedEventType.MediatorAdded,
  "MEDREM": GeneratedEventType.MediatorRemoved,
  "FEEUPD": GeneratedEventType.FeeRateUpdated,
  "FEEWTH": GeneratedEventType.FeesWithdrawn,
  "PTHINT": GeneratedEventType.PathPaymentInitiated,
  "PTHPAY": GeneratedEventType.PathPaymentExecuted,
  "ADMCLW": GeneratedEventType.AdminClawback,
  "CLWBCK": GeneratedEventType.ClawbackExecuted,
  "TLKQUE": GeneratedEventType.TimelockOperationQueued,
  "TLKEXE": GeneratedEventType.TimelockOperationExecuted,
  "TLKCAN": GeneratedEventType.TimelockOperationCancelled,
  "UPGQUE": GeneratedEventType.ContractUpgradeQueued,
  "DVOTE": GeneratedEventType.DisputeVoteCast,
  "DQURES": GeneratedEventType.DisputeQuorumResolved,
  "QURCFG": GeneratedEventType.QuorumConfigUpdated,
  "MEDWGT": GeneratedEventType.MediatorWeightUpdated,
  "DEDBGT": GeneratedEventType.DeadlineExtensionBudget,
  "EXTPOL": GeneratedEventType.ExtensionPolicyUpdated,
};

/** Full topic tuple each event is published under. */
export const EVENT_TOPICS: Readonly<Record<GeneratedEventType, readonly string[]>> = {
  [GeneratedEventType.Initialized]: ["amana", "initialized"],
  [GeneratedEventType.TradeCreated]: ["TRDCRT"],
  [GeneratedEventType.TradeFunded]: ["TRDFND"],
  [GeneratedEventType.TradeCancelled]: ["TRDCAN"],
  [GeneratedEventType.TradeCancelledByBuyer]: ["TCNBYR"],
  [GeneratedEventType.ContractUpgraded]: ["UPGRAD"],
  [GeneratedEventType.DeliveryConfirmed]: ["DELCNF"],
  [GeneratedEventType.FundsReleased]: ["RELSD"],
  [GeneratedEventType.DisputeResolved]: ["DISRES"],
  [GeneratedEventType.EvidenceSubmitted]: ["EVDSUB"],
  [GeneratedEventType.DisputeInitiated]: ["DISINI"],
  [GeneratedEventType.VideoProofSubmitted]: ["VIDPRF"],
  [GeneratedEventType.TradeExpired]: ["TRDEXP"],
  [GeneratedEventType.DeadlineExtended]: ["DEDEXT"],
  [GeneratedEventType.ManifestSubmitted]: ["MNFST"],
  [GeneratedEventType.MediatorAdded]: ["MEDADD"],
  [GeneratedEventType.MediatorRemoved]: ["MEDREM"],
  [GeneratedEventType.FeeRateUpdated]: ["FEEUPD"],
  [GeneratedEventType.FeesWithdrawn]: ["FEEWTH"],
  [GeneratedEventType.PathPaymentInitiated]: ["PTHINT"],
  [GeneratedEventType.PathPaymentExecuted]: ["PTHPAY"],
  [GeneratedEventType.AdminClawback]: ["ADMCLW"],
  [GeneratedEventType.ClawbackExecuted]: ["CLWBCK"],
  [GeneratedEventType.TimelockOperationQueued]: ["TLKQUE"],
  [GeneratedEventType.TimelockOperationExecuted]: ["TLKEXE"],
  [GeneratedEventType.TimelockOperationCancelled]: ["TLKCAN"],
  [GeneratedEventType.ContractUpgradeQueued]: ["UPGQUE"],
  [GeneratedEventType.DisputeVoteCast]: ["DVOTE"],
  [GeneratedEventType.DisputeQuorumResolved]: ["DQURES"],
  [GeneratedEventType.QuorumConfigUpdated]: ["QURCFG"],
  [GeneratedEventType.MediatorWeightUpdated]: ["MEDWGT"],
  [GeneratedEventType.DeadlineExtensionBudget]: ["DEDBGT"],
  [GeneratedEventType.ExtensionPolicyUpdated]: ["EXTPOL"],
};

/** Field names of each event, in declaration order. */
export const EVENT_FIELDS: Readonly<Record<GeneratedEventType, readonly string[]>> = {
  [GeneratedEventType.Initialized]: ["admin", "fee_bps", "timestamp"],
  [GeneratedEventType.TradeCreated]: ["trade_id", "buyer", "seller", "amount"],
  [GeneratedEventType.TradeFunded]: ["trade_id", "amount"],
  [GeneratedEventType.TradeCancelled]: ["trade_id", "refund_amount", "caller", "timestamp"],
  [GeneratedEventType.TradeCancelledByBuyer]: ["trade_id", "buyer"],
  [GeneratedEventType.ContractUpgraded]: ["admin", "new_wasm_hash"],
  [GeneratedEventType.DeliveryConfirmed]: ["trade_id", "delivered_at"],
  [GeneratedEventType.FundsReleased]: ["trade_id", "seller_amount", "fee_amount"],
  [GeneratedEventType.DisputeResolved]: ["trade_id", "seller_payout", "buyer_refund", "mediator"],
  [GeneratedEventType.EvidenceSubmitted]: ["trade_id", "submitter", "evidence_hash"],
  [GeneratedEventType.DisputeInitiated]: ["trade_id", "initiator", "reason_hash"],
  [GeneratedEventType.VideoProofSubmitted]: ["trade_id", "submitter", "ipfs_cid", "timestamp"],
  [GeneratedEventType.TradeExpired]: ["trade_id", "refund_amount", "caller"],
  [GeneratedEventType.DeadlineExtended]: ["trade_id", "old_deadline", "new_deadline"],
  [GeneratedEventType.ManifestSubmitted]: ["trade_id", "seller", "driver_name_hash", "driver_id_hash", "timestamp"],
  [GeneratedEventType.MediatorAdded]: ["mediator"],
  [GeneratedEventType.MediatorRemoved]: ["mediator"],
  [GeneratedEventType.FeeRateUpdated]: ["old_fee_bps", "new_fee_bps"],
  [GeneratedEventType.FeesWithdrawn]: ["amount", "destination"],
  [GeneratedEventType.PathPaymentInitiated]: ["trade_id", "buyer", "source_token", "source_amount", "dest_min", "path"],
  [GeneratedEventType.PathPaymentExecuted]: ["trade_id", "buyer", "source_token", "source_amount", "dest_token", "dest_amount"],
  [GeneratedEventType.AdminClawback]: ["trade_id", "amount", "admin", "timestamp"],
  [GeneratedEventType.ClawbackExecuted]: ["trade_id", "clawback_amount", "remaining_amount", "destination", "admin", "schema_version"],
  [GeneratedEventType.TimelockOperationQueued]: ["operation_id", "operation_type", "queued_at", "execute_after", "admin"],
  [GeneratedEventType.TimelockOperationExecuted]: ["operation_id", "executed_at"],
  [GeneratedEventType.TimelockOperationCancelled]: ["operation_id", "cancelled_at", "admin"],
  [GeneratedEventType.ContractUpgradeQueued]: ["operation_id", "new_wasm_hash", "queued_at", "execute_after"],
  [GeneratedEventType.DisputeVoteCast]: ["trade_id", "mediator", "seller_gets_bps", "weight", "rationale_hash", "outcome_weight", "weight_to_quorum", "voted_at", "schema_version"],
  [GeneratedEventType.DisputeQuorumResolved]: ["trade_id", "seller_gets_bps", "outcome", "winning_weight", "total_weight", "vote_count", "schema_version"],
  [GeneratedEventType.QuorumConfigUpdated]: ["enabled", "value_threshold", "required_weight", "vote_window_secs", "fallback_min_weight", "schema_version"],
  [GeneratedEventType.MediatorWeightUpdated]: ["mediator", "weight", "schema_version"],
  [GeneratedEventType.DeadlineExtensionBudget]: ["trade_id", "extensions_used", "extensions_remaining", "original_deadline", "extended_by_secs", "extension_secs_remaining", "schema_version"],
  [GeneratedEventType.ExtensionPolicyUpdated]: ["max_extensions", "max_total_extension_secs", "schema_version"],
};

/** Payload of the `amana/initialized` event. */
export interface InitializedPayload {
  admin: string;
  fee_bps: number;
  timestamp: bigint;
}

/** Payload of the `TRDCRT` event. */
export interface TradeCreatedPayload {
  trade_id: bigint;
  buyer: string;
  seller: string;
  amount: bigint;
}

/** Payload of the `TRDFND` event. */
export interface TradeFundedPayload {
  trade_id: bigint;
  amount: bigint;
}

/** Payload of the `TRDCAN` event. */
export interface TradeCancelledPayload {
  trade_id: bigint;
  refund_amount: bigint;
  caller: string;
  timestamp: bigint;
}

/** Payload of the `TCNBYR` event. */
export interface TradeCancelledByBuyerPayload {
  trade_id: bigint;
  buyer: string;
}

/** Payload of the `UPGRAD` event. */
export interface ContractUpgradedPayload {
  admin: string;
  new_wasm_hash: string;
}

/** Payload of the `DELCNF` event. */
export interface DeliveryConfirmedPayload {
  trade_id: bigint;
  delivered_at: bigint;
}

/** Payload of the `RELSD` event. */
export interface FundsReleasedPayload {
  trade_id: bigint;
  seller_amount: bigint;
  fee_amount: bigint;
}

/** Payload of the `DISRES` event. */
export interface DisputeResolvedPayload {
  trade_id: bigint;
  seller_payout: bigint;
  buyer_refund: bigint;
  mediator: string;
}

/** Payload of the `EVDSUB` event. */
export interface EvidenceSubmittedPayload {
  trade_id: bigint;
  submitter: string;
  evidence_hash: string;
}

/** Payload of the `DISINI` event. */
export interface DisputeInitiatedPayload {
  trade_id: bigint;
  initiator: string;
  reason_hash: string;
}

/** Payload of the `VIDPRF` event. */
export interface VideoProofSubmittedPayload {
  trade_id: bigint;
  submitter: string;
  ipfs_cid: string;
  timestamp: bigint;
}

/** Payload of the `TRDEXP` event. */
export interface TradeExpiredPayload {
  trade_id: bigint;
  refund_amount: bigint;
  caller: string;
}

/** Payload of the `DEDEXT` event. */
export interface DeadlineExtendedPayload {
  trade_id: bigint;
  old_deadline: bigint;
  new_deadline: bigint;
}

/** Payload of the `MNFST` event. */
export interface ManifestSubmittedPayload {
  trade_id: bigint;
  seller: string;
  driver_name_hash: string;
  driver_id_hash: string;
  timestamp: bigint;
}

/** Payload of the `MEDADD` event. */
export interface MediatorAddedPayload {
  mediator: string;
}

/** Payload of the `MEDREM` event. */
export interface MediatorRemovedPayload {
  mediator: string;
}

/** Payload of the `FEEUPD` event. */
export interface FeeRateUpdatedPayload {
  old_fee_bps: number;
  new_fee_bps: number;
}

/** Payload of the `FEEWTH` event. */
export interface FeesWithdrawnPayload {
  amount: bigint;
  destination: string;
}

/** Payload of the `PTHINT` event. */
export interface PathPaymentInitiatedPayload {
  trade_id: bigint;
  buyer: string;
  source_token: string;
  source_amount: bigint;
  dest_min: bigint;
  path: string[];
}

/** Payload of the `PTHPAY` event. */
export interface PathPaymentExecutedPayload {
  trade_id: bigint;
  buyer: string;
  source_token: string;
  source_amount: bigint;
  dest_token: string;
  dest_amount: bigint;
}

/** Payload of the `ADMCLW` event. */
export interface AdminClawbackPayload {
  trade_id: bigint;
  amount: bigint;
  admin: string;
  timestamp: bigint;
}

/** Payload of the `CLWBCK` event. */
export interface ClawbackExecutedPayload {
  trade_id: bigint;
  clawback_amount: bigint;
  remaining_amount: bigint;
  destination: string;
  admin: string;
  schema_version: number;
}

/** Payload of the `TLKQUE` event. */
export interface TimelockOperationQueuedPayload {
  operation_id: bigint;
  operation_type: string;
  queued_at: bigint;
  execute_after: bigint;
  admin: string;
}

/** Payload of the `TLKEXE` event. */
export interface TimelockOperationExecutedPayload {
  operation_id: bigint;
  executed_at: bigint;
}

/** Payload of the `TLKCAN` event. */
export interface TimelockOperationCancelledPayload {
  operation_id: bigint;
  cancelled_at: bigint;
  admin: string;
}

/** Payload of the `UPGQUE` event. */
export interface ContractUpgradeQueuedPayload {
  operation_id: bigint;
  new_wasm_hash: string;
  queued_at: bigint;
  execute_after: bigint;
}

/** Payload of the `DVOTE` event. */
export interface DisputeVoteCastPayload {
  trade_id: bigint;
  mediator: string;
  seller_gets_bps: number;
  weight: number;
  rationale_hash: string;
  outcome_weight: number;
  weight_to_quorum: number;
  voted_at: bigint;
  schema_version: number;
}

/** Payload of the `DQURES` event. */
export interface DisputeQuorumResolvedPayload {
  trade_id: bigint;
  seller_gets_bps: number;
  outcome: ["Quorum"] | ["Fallback"];
  winning_weight: number;
  total_weight: number;
  vote_count: number;
  schema_version: number;
}

/** Payload of the `QURCFG` event. */
export interface QuorumConfigUpdatedPayload {
  enabled: boolean;
  value_threshold: bigint;
  required_weight: number;
  vote_window_secs: bigint;
  fallback_min_weight: number;
  schema_version: number;
}

/** Payload of the `MEDWGT` event. */
export interface MediatorWeightUpdatedPayload {
  mediator: string;
  weight: number;
  schema_version: number;
}

/** Payload of the `DEDBGT` event. */
export interface DeadlineExtensionBudgetPayload {
  trade_id: bigint;
  extensions_used: number;
  extensions_remaining: number;
  original_deadline: bigint;
  extended_by_secs: bigint;
  extension_secs_remaining: bigint;
  schema_version: number;
}

/** Payload of the `EXTPOL` event. */
export interface ExtensionPolicyUpdatedPayload {
  max_extensions: number;
  max_total_extension_secs: bigint;
  schema_version: number;
}

/** Payload type for a given event type. */
export interface EventPayloadMap {
  [GeneratedEventType.Initialized]: InitializedPayload;
  [GeneratedEventType.TradeCreated]: TradeCreatedPayload;
  [GeneratedEventType.TradeFunded]: TradeFundedPayload;
  [GeneratedEventType.TradeCancelled]: TradeCancelledPayload;
  [GeneratedEventType.TradeCancelledByBuyer]: TradeCancelledByBuyerPayload;
  [GeneratedEventType.ContractUpgraded]: ContractUpgradedPayload;
  [GeneratedEventType.DeliveryConfirmed]: DeliveryConfirmedPayload;
  [GeneratedEventType.FundsReleased]: FundsReleasedPayload;
  [GeneratedEventType.DisputeResolved]: DisputeResolvedPayload;
  [GeneratedEventType.EvidenceSubmitted]: EvidenceSubmittedPayload;
  [GeneratedEventType.DisputeInitiated]: DisputeInitiatedPayload;
  [GeneratedEventType.VideoProofSubmitted]: VideoProofSubmittedPayload;
  [GeneratedEventType.TradeExpired]: TradeExpiredPayload;
  [GeneratedEventType.DeadlineExtended]: DeadlineExtendedPayload;
  [GeneratedEventType.ManifestSubmitted]: ManifestSubmittedPayload;
  [GeneratedEventType.MediatorAdded]: MediatorAddedPayload;
  [GeneratedEventType.MediatorRemoved]: MediatorRemovedPayload;
  [GeneratedEventType.FeeRateUpdated]: FeeRateUpdatedPayload;
  [GeneratedEventType.FeesWithdrawn]: FeesWithdrawnPayload;
  [GeneratedEventType.PathPaymentInitiated]: PathPaymentInitiatedPayload;
  [GeneratedEventType.PathPaymentExecuted]: PathPaymentExecutedPayload;
  [GeneratedEventType.AdminClawback]: AdminClawbackPayload;
  [GeneratedEventType.ClawbackExecuted]: ClawbackExecutedPayload;
  [GeneratedEventType.TimelockOperationQueued]: TimelockOperationQueuedPayload;
  [GeneratedEventType.TimelockOperationExecuted]: TimelockOperationExecutedPayload;
  [GeneratedEventType.TimelockOperationCancelled]: TimelockOperationCancelledPayload;
  [GeneratedEventType.ContractUpgradeQueued]: ContractUpgradeQueuedPayload;
  [GeneratedEventType.DisputeVoteCast]: DisputeVoteCastPayload;
  [GeneratedEventType.DisputeQuorumResolved]: DisputeQuorumResolvedPayload;
  [GeneratedEventType.QuorumConfigUpdated]: QuorumConfigUpdatedPayload;
  [GeneratedEventType.MediatorWeightUpdated]: MediatorWeightUpdatedPayload;
  [GeneratedEventType.DeadlineExtensionBudget]: DeadlineExtensionBudgetPayload;
  [GeneratedEventType.ExtensionPolicyUpdated]: ExtensionPolicyUpdatedPayload;
}

/** Events that move a trade's status, and where they move it to. */
export const EVENT_TO_TRADE_STATUS: Readonly<Partial<Record<GeneratedEventType, string>>> = {
  [GeneratedEventType.TradeCreated]: "CREATED",
  [GeneratedEventType.TradeFunded]: "FUNDED",
  [GeneratedEventType.TradeCancelled]: "CANCELLED",
  [GeneratedEventType.DeliveryConfirmed]: "DELIVERED",
  [GeneratedEventType.FundsReleased]: "COMPLETED",
  [GeneratedEventType.DisputeResolved]: "COMPLETED",
  [GeneratedEventType.DisputeInitiated]: "DISPUTED",
  [GeneratedEventType.TradeExpired]: "EXPIRED",
};
