//! Issue #108 — Shared admin signer fixture coverage.
//!
//! Verifies that [`AdminSignerFixture`] is the single source of truth for the
//! test admin identity and that both admin (allow) and non-admin (deny) caller
//! paths work through the fixture.
//!
//! Issue #299 — Review edge-case coverage:
//! Boundary amounts, unauthorized-caller attempts, and repeated/duplicate calls.

extern crate std;

use amana_escrow::{
    auth_invoke,
    test_fixture::{clawback_auth_args, AdminSignerFixture},
    TradeStatus,
};
use soroban_sdk::{IntoVal, Val, Vec};

#[test]
fn fixture_admin_matches_initialized_contract_admin() {
    let f = AdminSignerFixture::new();
    assert_eq!(
        f.client().get_admin(),
        f.admin,
        "fixture.admin must be the address stored by initialize"
    );
}

#[test]
fn fixture_admin_can_clawback_funded_trade() {
    let f = AdminSignerFixture::new();
    let amount = 1_000i128;
    let tid = f.funded_trade(amount);

    // Happy path: fixture enables mock_all_auths, so the stored admin may act.
    f.client().admin_clawback(&tid, &amount, &f.buyer);

    assert!(matches!(
        f.client().get_trade(&tid).status,
        TradeStatus::Cancelled
    ));
    assert_eq!(f.token().balance(&f.buyer), amount);
}

#[test]
#[should_panic(expected = "Error(Auth, InvalidAction)")]
fn fixture_non_admin_stranger_denied_clawback() {
    let f = AdminSignerFixture::new();
    let amount = 1_000i128;
    let tid = f.funded_trade(amount);
    let args = clawback_auth_args(&f.env, tid, amount, &f.buyer);

    // Deny path: only authorize the stranger; stored admin.require_auth fails.
    f.client()
        .mock_auths(&[auth_invoke!(&f, &f.stranger, "admin_clawback", args)])
        .admin_clawback(&tid, &amount, &f.buyer);
}

#[test]
#[should_panic(expected = "Error(Auth, InvalidAction)")]
fn fixture_non_admin_buyer_denied_clawback() {
    let f = AdminSignerFixture::new();
    let amount = 500i128;
    let tid = f.funded_trade(amount);
    let args = clawback_auth_args(&f.env, tid, amount, &f.buyer);

    f.client()
        .mock_auths(&[auth_invoke!(&f, &f.buyer, "admin_clawback", args)])
        .admin_clawback(&tid, &amount, &f.buyer);
}

// -----------------------------------------------------------------------------
// Issue #299: Boundary Amounts
// -----------------------------------------------------------------------------

#[test]
#[should_panic(expected = "CLAWBACK_INVALID_AMOUNT")]
fn fixture_boundary_amount_zero_clawback_rejected() {
    let f = AdminSignerFixture::new();
    let amount = 1_000i128;
    let tid = f.funded_trade(amount);

    // Zero clawback amount must be rejected.
    f.client().admin_clawback(&tid, &0i128, &f.buyer);
}

#[test]
#[should_panic(expected = "CLAWBACK_INVALID_AMOUNT")]
fn fixture_boundary_amount_negative_clawback_rejected() {
    let f = AdminSignerFixture::new();
    let amount = 1_000i128;
    let tid = f.funded_trade(amount);

    // Negative clawback amount must be rejected.
    f.client().admin_clawback(&tid, &-100i128, &f.buyer);
}

#[test]
#[should_panic(expected = "clawback_amount exceeds remaining escrowed amount")]
fn fixture_boundary_amount_exceeding_balance_rejected() {
    let f = AdminSignerFixture::new();
    let amount = 1_000i128;
    let tid = f.funded_trade(amount);

    // Clawback amount greater than escrowed balance must be rejected.
    f.client().admin_clawback(&tid, &(amount + 1), &f.buyer);
}

#[test]
fn fixture_boundary_partial_clawback_leaves_trade_funded() {
    let f = AdminSignerFixture::new();
    let amount = 1_000i128;
    let tid = f.funded_trade(amount);
    let partial_amount = 400i128;

    f.client().admin_clawback(&tid, &partial_amount, &f.buyer);

    let trade = f.client().get_trade(&tid);
    assert_eq!(trade.status, TradeStatus::Funded);
    assert_eq!(trade.amount, amount - partial_amount);
    assert_eq!(f.token().balance(&f.buyer), partial_amount);
}

#[test]
fn fixture_boundary_exact_remaining_clawback_transitions_to_cancelled() {
    let f = AdminSignerFixture::new();
    let amount = 1_000i128;
    let tid = f.funded_trade(amount);

    // Clawing back the exact full remaining balance must cancel the trade.
    f.client().admin_clawback(&tid, &amount, &f.buyer);

    let trade = f.client().get_trade(&tid);
    assert_eq!(trade.status, TradeStatus::Cancelled);
    assert_eq!(f.token().balance(&f.buyer), amount);
}

// -----------------------------------------------------------------------------
// Issue #299: Unauthorized-Caller Attempts
// -----------------------------------------------------------------------------

#[test]
#[should_panic(expected = "Error(Auth, InvalidAction)")]
fn fixture_unauthorized_seller_denied_clawback() {
    let f = AdminSignerFixture::new();
    let amount = 1_000i128;
    let tid = f.funded_trade(amount);
    let args = clawback_auth_args(&f.env, tid, amount, &f.buyer);

    f.client()
        .mock_auths(&[auth_invoke!(&f, &f.seller, "admin_clawback", args)])
        .admin_clawback(&tid, &amount, &f.buyer);
}

#[test]
#[should_panic(expected = "Error(Auth, InvalidAction)")]
fn fixture_unauthorized_mediator_denied_clawback() {
    let f = AdminSignerFixture::new();
    let amount = 1_000i128;
    let tid = f.funded_trade(amount);
    let args = clawback_auth_args(&f.env, tid, amount, &f.buyer);

    f.client()
        .mock_auths(&[auth_invoke!(&f, &f.mediator, "admin_clawback", args)])
        .admin_clawback(&tid, &amount, &f.buyer);
}

#[test]
#[should_panic(expected = "Error(Auth, InvalidAction)")]
fn fixture_unauthorized_stranger_denied_add_mediator() {
    let f = AdminSignerFixture::new();
    let new_med = f.stranger.clone();
    let args: Vec<Val> = soroban_sdk::vec![&f.env, new_med.into_val(&f.env)];

    f.client()
        .mock_auths(&[auth_invoke!(&f, &f.stranger, "add_mediator", args)])
        .add_mediator(&new_med);
}

#[test]
#[should_panic(expected = "Error(Auth, InvalidAction)")]
fn fixture_unauthorized_stranger_denied_add_guardian() {
    let f = AdminSignerFixture::new();
    let new_guardian = f.stranger.clone();
    let args: Vec<Val> = soroban_sdk::vec![&f.env, new_guardian.into_val(&f.env)];

    f.client()
        .mock_auths(&[auth_invoke!(&f, &f.stranger, "add_guardian", args)])
        .add_guardian(&new_guardian);
}

// -----------------------------------------------------------------------------
// Issue #299: Repeated / Duplicate Calls
// -----------------------------------------------------------------------------

#[test]
#[should_panic(expected = "Trade must be in Funded or Disputed status for clawback")]
fn fixture_repeated_clawback_on_cancelled_trade_rejected() {
    let f = AdminSignerFixture::new();
    let amount = 1_000i128;
    let tid = f.funded_trade(amount);

    // First clawback succeeds and transitions trade to Cancelled.
    f.client().admin_clawback(&tid, &amount, &f.buyer);
    assert_eq!(f.client().get_trade(&tid).status, TradeStatus::Cancelled);

    // Repeated clawback must fail because trade is already Cancelled.
    f.client().admin_clawback(&tid, &amount, &f.buyer);
}

#[test]
#[should_panic(expected = "AlreadyInitialized")]
fn fixture_duplicate_initialization_rejected() {
    let f = AdminSignerFixture::new();

    // Calling initialize a second time through the client must panic.
    f.client().initialize(
        &f.admin,
        &f.token_id,
        &f.treasury,
        &100u32,
        &f.token_id,
    );
}
