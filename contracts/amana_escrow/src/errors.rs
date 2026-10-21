/// Structured error code constants for admin and timelock operations.
/// Structured error code constants for admin clawback operations.
/// These strings are emitted in panic messages so the backend can parse them
/// deterministically and map them to structured AppError responses.
pub mod clawback_errors {
    /// Caller is not the registered contract admin.
    pub const UNAUTHORIZED: &str = "CLAWBACK_UNAUTHORIZED";
    /// The vested (escrowed) amount is less than the requested clawback amount.
    pub const INSUFFICIENT_VESTED: &str = "CLAWBACK_INSUFFICIENT_VESTED";
    /// The requested clawback amount is zero or negative.
    pub const INVALID_AMOUNT: &str = "CLAWBACK_INVALID_AMOUNT";
    /// No trade record was found for the given trade ID (stream not found).
    pub const STREAM_NOT_FOUND: &str = "CLAWBACK_STREAM_NOT_FOUND";
    /// The trade is not in a clawback-eligible status (must be Funded).
    pub const INVALID_STATUS: &str = "CLAWBACK_INVALID_STATUS";
}

// ---------------------------------------------------------------------------
// Timelock error codes (Issue #189)
// ---------------------------------------------------------------------------

pub mod timelock_errors {
    pub const UNAUTHORIZED: &str = "TIMELOCK_UNAUTHORIZED";
    pub const NOT_READY: &str = "TIMELOCK_NOT_READY";
    pub const OPERATION_NOT_FOUND: &str = "TIMELOCK_OP_NOT_FOUND";
    pub const INVALID_OPERATION: &str = "TIMELOCK_INVALID_OP";
}
