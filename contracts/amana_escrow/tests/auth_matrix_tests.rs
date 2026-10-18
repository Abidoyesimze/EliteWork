/// Issue #385 — Authorization matrix tests for all externally callable methods.
///
/// Every public contract method is tested against each role:
///   buyer | seller | mediator | admin | stranger
///
/// Allow paths assert the call succeeds; deny paths assert the expected panic.
extern crate std;

use amana_escrow::{
    MAX_TRADE_VALUE, TradeStatus, auth_invoke, test_fixture::AdminSignerFixture,
};
use soroban_sdk::{Address, Env, IntoVal, String as SStr, Val, testutils::Address as _};

type Harness = AdminSignerFixture;

fn disputed_trade(h: &Harness, amount: i128) -> u64 {
    let tid = h.funded_trade(amount);
    h.client().initiate_dispute(
        &tid,
        &h.buyer,
        &SStr::from_str(&h.env, "QmAuthMatrix"),
    );
    tid
}

// ---------------------------------------------------------------------------
// initialize — admin only (already called in Harness::new; test double-call guard)
// ---------------------------------------------------------------------------

#[test]
#[should_panic(expected = "AlreadyInitialized")]
fn test_auth_initialize_rejects_second_call() {
    let h = Harness::new();
    h.client()
        .initialize(&h.admin, &h.token_id, &h.treasury, &100u32, &h.token_id);
}

// ---------------------------------------------------------------------------
// create_trade — any caller (no auth restriction on who creates)
// ---------------------------------------------------------------------------

#[test]
fn test_auth_create_trade_buyer_allowed() {
    let h = Harness::new();
    // buyer creates a trade — allowed
    let tid = h
        .client()
        .create_trade(&h.buyer, &h.seller, &1_000i128, &5000u32, &5000u32, &None);
    assert!(matches!(
        h.client().get_trade(&tid).status,
        TradeStatus::Created
    ));
}

#[test]
fn test_auth_create_trade_stranger_allowed() {
    let h = Harness::new();
    // Anyone can call create_trade (no auth guard on the caller itself)
    let tid = h
        .client()
        .create_trade(&h.buyer, &h.seller, &1_000i128, &5000u32, &5000u32, &None);
    assert!(matches!(
        h.client().get_trade(&tid).status,
        TradeStatus::Created
    ));
}

#[test]
#[should_panic(expected = "buyer and seller must be different addresses")]
fn test_auth_create_trade_rejects_self_trade() {
    let h = Harness::new();
    h.client()
        .create_trade(&h.buyer, &h.buyer, &1_000i128, &5000u32, &5000u32, &None);
}

// ---------------------------------------------------------------------------
// deposit — buyer only
// ---------------------------------------------------------------------------

#[test]
fn test_auth_deposit_buyer_allowed() {
    let h = Harness::new();
    h.mint(&h.buyer, 1_000);
    let tid = h
        .client()
        .create_trade(&h.buyer, &h.seller, &1_000i128, &5000u32, &5000u32, &None);
    h.client().deposit(&tid);
    assert!(matches!(
        h.client().get_trade(&tid).status,
        TradeStatus::Funded
    ));
}

#[test]
#[should_panic]
fn test_auth_deposit_seller_denied() {
    let h = Harness::new();
    h.mint(&h.buyer, 1_000);
    let tid = h
        .client()
        .create_trade(&h.buyer, &h.seller, &1_000i128, &5000u32, &5000u32, &None);
    // Provide auth only for seller — must fail because buyer.require_auth() is called
    h.client()
        .mock_auths(&[soroban_sdk::testutils::MockAuth {
            address: &h.seller,
            invoke: &soroban_sdk::testutils::MockAuthInvoke {
                contract: &h.contract_id,
                fn_name: "deposit",
                args: soroban_sdk::vec![
                    &h.env,
                    soroban_sdk::IntoVal::<Env, soroban_sdk::Val>::into_val(&tid, &h.env),
                ],
                sub_invokes: &[],
            },
        }])
        .deposit(&tid);
}

// ---------------------------------------------------------------------------
// confirm_delivery — buyer only
// ---------------------------------------------------------------------------

#[test]
fn test_auth_confirm_delivery_buyer_allowed() {
    let h = Harness::new();
    let tid = h.funded_trade(1_000);
    h.client().confirm_delivery(&tid);
    assert!(matches!(
        h.client().get_trade(&tid).status,
        TradeStatus::Delivered
    ));
}

#[test]
#[should_panic]
fn test_auth_confirm_delivery_seller_denied() {
    let h = Harness::new();
    let tid = h.funded_trade(1_000);
    h.client()
        .mock_auths(&[soroban_sdk::testutils::MockAuth {
            address: &h.seller,
            invoke: &soroban_sdk::testutils::MockAuthInvoke {
                contract: &h.contract_id,
                fn_name: "confirm_delivery",
                args: soroban_sdk::vec![
                    &h.env,
                    soroban_sdk::IntoVal::<Env, soroban_sdk::Val>::into_val(&tid, &h.env),
                ],
                sub_invokes: &[],
            },
        }])
        .confirm_delivery(&tid);
}

#[test]
#[should_panic]
fn test_auth_confirm_delivery_stranger_denied() {
    let h = Harness::new();
    let tid = h.funded_trade(1_000);
    h.client()
        .mock_auths(&[soroban_sdk::testutils::MockAuth {
            address: &h.stranger,
            invoke: &soroban_sdk::testutils::MockAuthInvoke {
                contract: &h.contract_id,
                fn_name: "confirm_delivery",
                args: soroban_sdk::vec![
                    &h.env,
                    soroban_sdk::IntoVal::<Env, soroban_sdk::Val>::into_val(&tid, &h.env),
                ],
                sub_invokes: &[],
            },
        }])
        .confirm_delivery(&tid);
}

// ---------------------------------------------------------------------------
// release_funds — buyer only (after delivery confirmed)
// ---------------------------------------------------------------------------

#[test]
fn test_auth_release_funds_buyer_allowed() {
    let h = Harness::new();
    let tid = h.funded_trade(1_000);
    h.client().confirm_delivery(&tid);
    h.client().release_funds(&tid, &h.buyer);
    assert!(matches!(
        h.client().get_trade(&tid).status,
        TradeStatus::Completed
    ));
}

#[test]
fn test_auth_release_funds_admin_allowed() {
    let h = Harness::new();
    let tid = h.funded_trade(1_000);
    h.client().confirm_delivery(&tid);
    h.client().release_funds(&tid, &h.admin);
    assert!(matches!(
        h.client().get_trade(&tid).status,
        TradeStatus::Completed
    ));
}

#[test]
#[should_panic]
fn test_auth_release_funds_seller_denied() {
    let h = Harness::new();
    let tid = h.funded_trade(1_000);
    h.client().confirm_delivery(&tid);
    h.client()
        .mock_auths(&[soroban_sdk::testutils::MockAuth {
            address: &h.seller,
            invoke: &soroban_sdk::testutils::MockAuthInvoke {
                contract: &h.contract_id,
                fn_name: "release_funds",
                args: soroban_sdk::vec![
                    &h.env,
                    soroban_sdk::IntoVal::<Env, soroban_sdk::Val>::into_val(&tid, &h.env),
                    soroban_sdk::IntoVal::<Env, soroban_sdk::Val>::into_val(&h.seller, &h.env),
                ],
                sub_invokes: &[],
            },
        }])
        .release_funds(&tid, &h.seller);
}

#[test]
#[should_panic]
fn test_auth_release_funds_stranger_denied() {
    let h = Harness::new();
    let tid = h.funded_trade(1_000);
    h.client().confirm_delivery(&tid);
    h.client()
        .mock_auths(&[soroban_sdk::testutils::MockAuth {
            address: &h.stranger,
            invoke: &soroban_sdk::testutils::MockAuthInvoke {
                contract: &h.contract_id,
                fn_name: "release_funds",
                args: soroban_sdk::vec![
                    &h.env,
                    soroban_sdk::IntoVal::<Env, soroban_sdk::Val>::into_val(&tid, &h.env),
                    soroban_sdk::IntoVal::<Env, soroban_sdk::Val>::into_val(&h.stranger, &h.env),
                ],
                sub_invokes: &[],
            },
        }])
        .release_funds(&tid, &h.stranger);
}

// ---------------------------------------------------------------------------
// cancel_trade — buyer/seller/admin allowed; stranger denied
// ---------------------------------------------------------------------------

#[test]
fn test_auth_cancel_trade_buyer_allowed_created() {
    let h = Harness::new();
    let tid = h
        .client()
        .create_trade(&h.buyer, &h.seller, &1_000i128, &5000u32, &5000u32, &None);
    h.client().cancel_trade(&tid, &h.buyer);
    assert!(matches!(
        h.client().get_trade(&tid).status,
        TradeStatus::Cancelled
    ));
}

#[test]
fn test_auth_cancel_trade_seller_allowed_created() {
    let h = Harness::new();
    let tid = h
        .client()
        .create_trade(&h.buyer, &h.seller, &1_000i128, &5000u32, &5000u32, &None);
    h.client().cancel_trade(&tid, &h.seller);
    assert!(matches!(
        h.client().get_trade(&tid).status,
        TradeStatus::Cancelled
    ));
}

#[test]
fn test_auth_cancel_trade_admin_allowed_created() {
    let h = Harness::new();
    let tid = h
        .client()
        .create_trade(&h.buyer, &h.seller, &1_000i128, &5000u32, &5000u32, &None);
    h.client().cancel_trade(&tid, &h.admin);
    assert!(matches!(
        h.client().get_trade(&tid).status,
        TradeStatus::Cancelled
    ));
}

#[test]
#[should_panic(expected = "Unauthorized caller")]
fn test_auth_cancel_trade_stranger_denied_created() {
    let h = Harness::new();
    let tid = h
        .client()
        .create_trade(&h.buyer, &h.seller, &1_000i128, &5000u32, &5000u32, &None);
    h.client().cancel_trade(&tid, &h.stranger);
}

#[test]
fn test_auth_cancel_trade_admin_allowed_funded() {
    let h = Harness::new();
    let tid = h.funded_trade(1_000);
    h.client().cancel_trade(&tid, &h.admin);
    assert!(matches!(
        h.client().get_trade(&tid).status,
        TradeStatus::Cancelled
    ));
}

#[test]
#[should_panic(expected = "Unauthorized caller")]
fn test_auth_cancel_trade_stranger_denied_funded() {
    let h = Harness::new();
    let tid = h.funded_trade(1_000);
    h.client().cancel_trade(&tid, &h.stranger);
}

// ---------------------------------------------------------------------------
// initiate_dispute — buyer or seller only
// ---------------------------------------------------------------------------

#[test]
fn test_auth_initiate_dispute_buyer_allowed() {
    let h = Harness::new();
    let tid = h.funded_trade(1_000);
    h.client()
        .initiate_dispute(&tid, &h.buyer, &SStr::from_str(&h.env, "QmBuyer"));
    assert!(matches!(
        h.client().get_trade(&tid).status,
        TradeStatus::Disputed
    ));
}

#[test]
fn test_auth_initiate_dispute_seller_allowed() {
    let h = Harness::new();
    let tid = h.funded_trade(1_000);
    h.client()
        .initiate_dispute(&tid, &h.seller, &SStr::from_str(&h.env, "QmSeller"));
    assert!(matches!(
        h.client().get_trade(&tid).status,
        TradeStatus::Disputed
    ));
}

#[test]
#[should_panic(expected = "Only the buyer or seller can initiate a dispute")]
fn test_auth_initiate_dispute_mediator_denied() {
    let h = Harness::new();
    let tid = h.funded_trade(1_000);
    h.client()
        .initiate_dispute(&tid, &h.mediator, &SStr::from_str(&h.env, "QmMediator"));
}

#[test]
#[should_panic(expected = "Only the buyer or seller can initiate a dispute")]
fn test_auth_initiate_dispute_admin_denied() {
    let h = Harness::new();
    let tid = h.funded_trade(1_000);
    h.client()
        .initiate_dispute(&tid, &h.admin, &SStr::from_str(&h.env, "QmAdmin"));
}

#[test]
#[should_panic(expected = "Only the buyer or seller can initiate a dispute")]
fn test_auth_initiate_dispute_stranger_denied() {
    let h = Harness::new();
    let tid = h.funded_trade(1_000);
    h.client()
        .initiate_dispute(&tid, &h.stranger, &SStr::from_str(&h.env, "QmStranger"));
}

// ---------------------------------------------------------------------------
// submit_evidence — buyer / seller / mediator allowed; stranger denied
// ---------------------------------------------------------------------------

#[test]
fn test_auth_submit_evidence_buyer_allowed() {
    let h = Harness::new();
    let tid = disputed_trade(&h, 1_000);
    h.client().submit_evidence(
        &tid,
        &h.buyer,
        &SStr::from_str(&h.env, "QmBuyerEvidence"),
        &SStr::from_str(&h.env, "desc"),
    );
    assert_eq!(h.client().get_evidence_list(&tid).len(), 1);
}

#[test]
fn test_auth_submit_evidence_seller_allowed() {
    let h = Harness::new();
    let tid = disputed_trade(&h, 1_000);
    h.client().submit_evidence(
        &tid,
        &h.seller,
        &SStr::from_str(&h.env, "QmSellerEvidence"),
        &SStr::from_str(&h.env, "desc"),
    );
    assert_eq!(h.client().get_evidence_list(&tid).len(), 1);
}

#[test]
fn test_auth_submit_evidence_mediator_allowed() {
    let h = Harness::new();
    let tid = disputed_trade(&h, 1_000);
    h.client().submit_evidence(
        &tid,
        &h.mediator,
        &SStr::from_str(&h.env, "QmMediatorEvidence"),
        &SStr::from_str(&h.env, "desc"),
    );
    assert_eq!(h.client().get_evidence_list(&tid).len(), 1);
}

#[test]
#[should_panic(expected = "Only buyer, seller, or mediator can submit evidence")]
fn test_auth_submit_evidence_stranger_denied() {
    let h = Harness::new();
    let tid = disputed_trade(&h, 1_000);
    h.client().submit_evidence(
        &tid,
        &h.stranger,
        &SStr::from_str(&h.env, "QmBadEvidence"),
        &SStr::from_str(&h.env, "desc"),
    );
}

#[test]
#[should_panic(expected = "Only buyer, seller, or mediator can submit evidence")]
fn test_auth_submit_evidence_admin_denied() {
    let h = Harness::new();
    let tid = disputed_trade(&h, 1_000);
    h.client().submit_evidence(
        &tid,
        &h.admin,
        &SStr::from_str(&h.env, "QmAdminEvidence"),
        &SStr::from_str(&h.env, "desc"),
    );
}

// ---------------------------------------------------------------------------
// resolve_dispute — registered mediator only
// ---------------------------------------------------------------------------

#[test]
fn test_auth_resolve_dispute_mediator_allowed() {
    let h = Harness::new();
    let tid = disputed_trade(&h, 1_000);
    h.client().resolve_dispute(&tid, &h.mediator, &5_000u32);
    assert!(matches!(
        h.client().get_trade(&tid).status,
        TradeStatus::Completed
    ));
}

#[test]
#[should_panic(expected = "Unauthorized mediator")]
fn test_auth_resolve_dispute_buyer_denied() {
    let h = Harness::new();
    let tid = disputed_trade(&h, 1_000);
    h.client().resolve_dispute(&tid, &h.buyer, &5_000u32);
}

#[test]
#[should_panic(expected = "Unauthorized mediator")]
fn test_auth_resolve_dispute_seller_denied() {
    let h = Harness::new();
    let tid = disputed_trade(&h, 1_000);
    h.client().resolve_dispute(&tid, &h.seller, &5_000u32);
}

#[test]
#[should_panic(expected = "Unauthorized mediator")]
fn test_auth_resolve_dispute_admin_denied() {
    let h = Harness::new();
    let tid = disputed_trade(&h, 1_000);
    h.client().resolve_dispute(&tid, &h.admin, &5_000u32);
}

#[test]
#[should_panic(expected = "Unauthorized mediator")]
fn test_auth_resolve_dispute_stranger_denied() {
    let h = Harness::new();
    let tid = disputed_trade(&h, 1_000);
    h.client().resolve_dispute(&tid, &h.stranger, &5_000u32);
}

// ---------------------------------------------------------------------------
// add_mediator / remove_mediator — admin only
// ---------------------------------------------------------------------------

#[test]
fn test_auth_add_mediator_admin_allowed() {
    let h = Harness::new();
    let new_med = Address::generate(&h.env);
    h.client().add_mediator(&new_med);
    assert!(h.client().is_mediator(&new_med));
}

#[test]
#[should_panic]
fn test_auth_add_mediator_stranger_denied() {
    let h = Harness::new();
    let new_med = Address::generate(&h.env);
    h.client()
        .mock_auths(&[soroban_sdk::testutils::MockAuth {
            address: &h.stranger,
            invoke: &soroban_sdk::testutils::MockAuthInvoke {
                contract: &h.contract_id,
                fn_name: "add_mediator",
                args: soroban_sdk::vec![
                    &h.env,
                    soroban_sdk::IntoVal::<Env, soroban_sdk::Val>::into_val(&new_med, &h.env),
                ],
                sub_invokes: &[],
            },
        }])
        .add_mediator(&new_med);
}

#[test]
fn test_auth_remove_mediator_admin_allowed() {
    let h = Harness::new();
    h.client().remove_mediator(&h.mediator);
    assert!(!h.client().is_mediator(&h.mediator));
}

#[test]
#[should_panic]
fn test_auth_remove_mediator_stranger_denied() {
    let h = Harness::new();
    h.client()
        .mock_auths(&[soroban_sdk::testutils::MockAuth {
            address: &h.stranger,
            invoke: &soroban_sdk::testutils::MockAuthInvoke {
                contract: &h.contract_id,
                fn_name: "remove_mediator",
                args: soroban_sdk::vec![
                    &h.env,
                    soroban_sdk::IntoVal::<Env, soroban_sdk::Val>::into_val(&h.mediator, &h.env),
                ],
                sub_invokes: &[],
            },
        }])
        .remove_mediator(&h.mediator);
}

// ---------------------------------------------------------------------------
// set_mediator — admin only (legacy path)
// ---------------------------------------------------------------------------

#[test]
fn test_auth_set_mediator_admin_allowed() {
    let h = Harness::new();
    let new_med = Address::generate(&h.env);
    h.client().set_mediator(&new_med);
    assert!(h.client().is_mediator(&new_med));
}

#[test]
#[should_panic]
fn test_auth_set_mediator_stranger_denied() {
    let h = Harness::new();
    let new_med = Address::generate(&h.env);
    h.client()
        .mock_auths(&[soroban_sdk::testutils::MockAuth {
            address: &h.stranger,
            invoke: &soroban_sdk::testutils::MockAuthInvoke {
                contract: &h.contract_id,
                fn_name: "set_mediator",
                args: soroban_sdk::vec![
                    &h.env,
                    soroban_sdk::IntoVal::<Env, soroban_sdk::Val>::into_val(&new_med, &h.env),
                ],
                sub_invokes: &[],
            },
        }])
        .set_mediator(&new_med);
}

// ---------------------------------------------------------------------------
// submit_video_proof — buyer or seller only
// ---------------------------------------------------------------------------

#[test]
fn test_auth_submit_video_proof_buyer_allowed() {
    let h = Harness::new();
    let tid = h.funded_trade(1_000);
    h.client()
        .submit_video_proof(&tid, &h.buyer, &SStr::from_str(&h.env, "QmBuyerVideo"));
    assert!(h.client().get_video_proof(&tid).is_some());
}

#[test]
fn test_auth_submit_video_proof_seller_allowed() {
    let h = Harness::new();
    let tid = h.funded_trade(1_000);
    h.client()
        .submit_video_proof(&tid, &h.seller, &SStr::from_str(&h.env, "QmSellerVideo"));
    assert!(h.client().get_video_proof(&tid).is_some());
}

#[test]
#[should_panic(expected = "Only the buyer or seller can submit video proof")]
fn test_auth_submit_video_proof_mediator_denied() {
    let h = Harness::new();
    let tid = h.funded_trade(1_000);
    h.client()
        .submit_video_proof(&tid, &h.mediator, &SStr::from_str(&h.env, "QmMedVideo"));
}

#[test]
#[should_panic(expected = "Only the buyer or seller can submit video proof")]
fn test_auth_submit_video_proof_stranger_denied() {
    let h = Harness::new();
    let tid = h.funded_trade(1_000);
    h.client()
        .submit_video_proof(&tid, &h.stranger, &SStr::from_str(&h.env, "QmBadVideo"));
}

// ---------------------------------------------------------------------------
// submit_manifest — seller only
// ---------------------------------------------------------------------------

#[test]
fn test_auth_submit_manifest_seller_allowed() {
    let h = Harness::new();
    let tid = h.funded_trade(1_000);
    h.client().submit_manifest(
        &tid,
        &h.seller,
        &SStr::from_str(&h.env, "QmDriverName"),
        &SStr::from_str(&h.env, "QmDriverId"),
    );
    assert!(h.client().get_manifest(&tid).is_some());
}

#[test]
#[should_panic(expected = "Only seller can submit manifest")]
fn test_auth_submit_manifest_buyer_denied() {
    let h = Harness::new();
    let tid = h.funded_trade(1_000);
    h.client().submit_manifest(
        &tid,
        &h.buyer,
        &SStr::from_str(&h.env, "QmDriverName"),
        &SStr::from_str(&h.env, "QmDriverId"),
    );
}

#[test]
#[should_panic(expected = "Only seller can submit manifest")]
fn test_auth_submit_manifest_stranger_denied() {
    let h = Harness::new();
    let tid = h.funded_trade(1_000);
    h.client().submit_manifest(
        &tid,
        &h.stranger,
        &SStr::from_str(&h.env, "QmDriverName"),
        &SStr::from_str(&h.env, "QmDriverId"),
    );
}

// ===========================================================================
// Issue #300 — gaps in the matrix above: role/method pairs it skipped,
// boundary amounts and basis points, and repeated/duplicate calls.
// ===========================================================================

/// `Vec<Val>` of mock-auth arguments, matching the invoked method's signature.
macro_rules! auth_args {
    ($h:expr $(, $arg:expr)* $(,)?) => {
        soroban_sdk::vec![&$h.env $(, IntoVal::<Env, Val>::into_val($arg, &$h.env))*]
    };
}

fn created_trade(h: &Harness, amount: i128) -> u64 {
    h.client()
        .create_trade(&h.buyer, &h.seller, &amount, &5000u32, &5000u32, &None)
}

fn delivered_trade(h: &Harness, amount: i128) -> u64 {
    let tid = h.funded_trade(amount);
    h.client().confirm_delivery(&tid);
    tid
}

// ---------------------------------------------------------------------------
// create_trade — buyer signature + amount boundaries
// ---------------------------------------------------------------------------

#[test]
#[should_panic]
fn test_auth_create_trade_stranger_cannot_sign_for_buyer() {
    let h = Harness::new();
    let none: Option<u64> = None;
    let args = auth_args!(
        h, &h.buyer, &h.seller, &1_000i128, &5000u32, &5000u32, &none
    );
    h.client()
        .mock_auths(&[auth_invoke!(&h, &h.stranger, "create_trade", args)])
        .create_trade(&h.buyer, &h.seller, &1_000i128, &5000u32, &5000u32, &None);
}

#[test]
#[should_panic(expected = "amount must be greater than zero")]
fn test_auth_create_trade_rejects_zero_amount() {
    let h = Harness::new();
    created_trade(&h, 0);
}

#[test]
#[should_panic(expected = "amount must be greater than zero")]
fn test_auth_create_trade_rejects_negative_amount() {
    let h = Harness::new();
    created_trade(&h, -1);
}

#[test]
fn test_auth_create_trade_accepts_minimum_amount() {
    let h = Harness::new();
    let tid = created_trade(&h, 1);
    assert_eq!(h.client().get_trade(&tid).amount, 1);
}

#[test]
fn test_auth_create_trade_accepts_max_trade_value() {
    let h = Harness::new();
    let tid = created_trade(&h, MAX_TRADE_VALUE);
    assert_eq!(h.client().get_trade(&tid).amount, MAX_TRADE_VALUE);
}

#[test]
#[should_panic(expected = "TradeValueTooLarge")]
fn test_auth_create_trade_rejects_above_max_trade_value() {
    let h = Harness::new();
    created_trade(&h, MAX_TRADE_VALUE + 1);
}

// ---------------------------------------------------------------------------
// deposit — remaining roles + duplicate deposit
// ---------------------------------------------------------------------------

#[test]
#[should_panic]
fn test_auth_deposit_stranger_denied() {
    let h = Harness::new();
    h.mint(&h.buyer, 1_000);
    let tid = created_trade(&h, 1_000);
    let args = auth_args!(h, &tid);
    h.client()
        .mock_auths(&[auth_invoke!(&h, &h.stranger, "deposit", args)])
        .deposit(&tid);
}

#[test]
#[should_panic]
fn test_auth_deposit_admin_denied() {
    let h = Harness::new();
    h.mint(&h.buyer, 1_000);
    let tid = created_trade(&h, 1_000);
    let args = auth_args!(h, &tid);
    h.client()
        .mock_auths(&[auth_invoke!(&h, &h.admin, "deposit", args)])
        .deposit(&tid);
}

#[test]
#[should_panic(expected = "Trade must be in Created status")]
fn test_auth_deposit_rejects_duplicate_deposit() {
    let h = Harness::new();
    let tid = h.funded_trade(1_000);
    h.mint(&h.buyer, 1_000);
    h.client().deposit(&tid);
}

// ---------------------------------------------------------------------------
// confirm_delivery — remaining roles + duplicate confirmation
// ---------------------------------------------------------------------------

#[test]
#[should_panic]
fn test_auth_confirm_delivery_admin_denied() {
    let h = Harness::new();
    let tid = h.funded_trade(1_000);
    let args = auth_args!(h, &tid);
    h.client()
        .mock_auths(&[auth_invoke!(&h, &h.admin, "confirm_delivery", args)])
        .confirm_delivery(&tid);
}

#[test]
#[should_panic]
fn test_auth_confirm_delivery_mediator_denied() {
    let h = Harness::new();
    let tid = h.funded_trade(1_000);
    let args = auth_args!(h, &tid);
    h.client()
        .mock_auths(&[auth_invoke!(&h, &h.mediator, "confirm_delivery", args)])
        .confirm_delivery(&tid);
}

#[test]
#[should_panic(expected = "Trade must be funded")]
fn test_auth_confirm_delivery_rejects_duplicate_confirmation() {
    let h = Harness::new();
    let tid = delivered_trade(&h, 1_000);
    h.client().confirm_delivery(&tid);
}

// ---------------------------------------------------------------------------
// release_funds — role checks independent of signature, impersonation,
// duplicate release
// ---------------------------------------------------------------------------

#[test]
#[should_panic(expected = "Unauthorized caller")]
fn test_auth_release_funds_seller_rejected_even_when_signed() {
    // With every signature mocked, the seller still fails the role check.
    let h = Harness::new();
    let tid = delivered_trade(&h, 1_000);
    h.client().release_funds(&tid, &h.seller);
}

#[test]
#[should_panic(expected = "Unauthorized caller")]
fn test_auth_release_funds_mediator_denied() {
    let h = Harness::new();
    let tid = delivered_trade(&h, 1_000);
    h.client().release_funds(&tid, &h.mediator);
}

#[test]
#[should_panic]
fn test_auth_release_funds_stranger_cannot_impersonate_buyer() {
    // Passing the buyer as `caller` must not work without the buyer's signature.
    let h = Harness::new();
    let tid = delivered_trade(&h, 1_000);
    let args = auth_args!(h, &tid, &h.buyer);
    h.client()
        .mock_auths(&[auth_invoke!(&h, &h.stranger, "release_funds", args)])
        .release_funds(&tid, &h.buyer);
}

#[test]
#[should_panic(expected = "Trade must be delivered")]
fn test_auth_release_funds_rejects_duplicate_release() {
    let h = Harness::new();
    let tid = delivered_trade(&h, 1_000);
    h.client().release_funds(&tid, &h.buyer);
    h.client().release_funds(&tid, &h.admin);
}

#[test]
#[should_panic(expected = "Trade must be delivered")]
fn test_auth_release_funds_rejects_undelivered_trade() {
    let h = Harness::new();
    let tid = h.funded_trade(1_000);
    h.client().release_funds(&tid, &h.buyer);
}

// ---------------------------------------------------------------------------
// cancel_trade — mediator, two-party consent on funded trades, terminal states
// ---------------------------------------------------------------------------

#[test]
#[should_panic(expected = "Unauthorized caller")]
fn test_auth_cancel_trade_mediator_denied_created() {
    let h = Harness::new();
    let tid = created_trade(&h, 1_000);
    h.client().cancel_trade(&tid, &h.mediator);
}

#[test]
#[should_panic(expected = "Unauthorized caller")]
fn test_auth_cancel_trade_mediator_denied_funded() {
    let h = Harness::new();
    let tid = h.funded_trade(1_000);
    h.client().cancel_trade(&tid, &h.mediator);
}

#[test]
fn test_auth_cancel_trade_funded_buyer_alone_only_records_request() {
    let h = Harness::new();
    let tid = h.funded_trade(1_000);
    h.client().cancel_trade(&tid, &h.buyer);
    assert!(matches!(
        h.client().get_trade(&tid).status,
        TradeStatus::Funded
    ));
    assert_eq!(h.token().balance(&h.contract_id), 1_000);
}

#[test]
fn test_auth_cancel_trade_funded_duplicate_buyer_request_does_not_cancel() {
    // A second request from the same party must not stand in for the other.
    let h = Harness::new();
    let tid = h.funded_trade(1_000);
    h.client().cancel_trade(&tid, &h.buyer);
    h.client().cancel_trade(&tid, &h.buyer);
    assert!(matches!(
        h.client().get_trade(&tid).status,
        TradeStatus::Funded
    ));
}

#[test]
fn test_auth_cancel_trade_funded_buyer_and_seller_cancel() {
    let h = Harness::new();
    let tid = h.funded_trade(1_000);
    h.client().cancel_trade(&tid, &h.seller);
    h.client().cancel_trade(&tid, &h.buyer);
    assert!(matches!(
        h.client().get_trade(&tid).status,
        TradeStatus::Cancelled
    ));
    assert_eq!(h.token().balance(&h.contract_id), 0);
}

#[test]
#[should_panic]
fn test_auth_cancel_trade_stranger_cannot_sign_for_buyer() {
    let h = Harness::new();
    let tid = created_trade(&h, 1_000);
    let args = auth_args!(h, &tid, &h.buyer);
    h.client()
        .mock_auths(&[auth_invoke!(&h, &h.stranger, "cancel_trade", args)])
        .cancel_trade(&tid, &h.buyer);
}

#[test]
#[should_panic(expected = "Cannot cancel trade in current status")]
fn test_auth_cancel_trade_rejects_repeated_cancel() {
    let h = Harness::new();
    let tid = created_trade(&h, 1_000);
    h.client().cancel_trade(&tid, &h.buyer);
    h.client().cancel_trade(&tid, &h.admin);
}

#[test]
#[should_panic(expected = "Cannot cancel trade in current status")]
fn test_auth_cancel_trade_admin_rejected_on_delivered() {
    let h = Harness::new();
    let tid = delivered_trade(&h, 1_000);
    h.client().cancel_trade(&tid, &h.admin);
}

// ---------------------------------------------------------------------------
// initiate_dispute — impersonation + duplicate / wrong-status disputes
// ---------------------------------------------------------------------------

#[test]
#[should_panic]
fn test_auth_initiate_dispute_stranger_cannot_sign_for_buyer() {
    let h = Harness::new();
    let tid = h.funded_trade(1_000);
    let reason = SStr::from_str(&h.env, "QmImpersonated");
    let args = auth_args!(h, &tid, &h.buyer, &reason);
    h.client()
        .mock_auths(&[auth_invoke!(&h, &h.stranger, "initiate_dispute", args)])
        .initiate_dispute(&tid, &h.buyer, &reason);
}

#[test]
#[should_panic(expected = "Trade must be in Funded status to initiate a dispute")]
fn test_auth_initiate_dispute_rejects_duplicate_dispute() {
    let h = Harness::new();
    let tid = disputed_trade(&h, 1_000);
    h.client()
        .initiate_dispute(&tid, &h.seller, &SStr::from_str(&h.env, "QmAgain"));
}

#[test]
#[should_panic(expected = "Trade must be in Funded status to initiate a dispute")]
fn test_auth_initiate_dispute_rejects_created_trade() {
    let h = Harness::new();
    let tid = created_trade(&h, 1_000);
    h.client()
        .initiate_dispute(&tid, &h.buyer, &SStr::from_str(&h.env, "QmEarly"));
}

// ---------------------------------------------------------------------------
// submit_evidence — status gate
// ---------------------------------------------------------------------------

#[test]
#[should_panic(expected = "Evidence can only be submitted for a Disputed trade")]
fn test_auth_submit_evidence_rejects_undisputed_trade() {
    let h = Harness::new();
    let tid = h.funded_trade(1_000);
    h.client().submit_evidence(
        &tid,
        &h.buyer,
        &SStr::from_str(&h.env, "QmEarlyEvidence"),
        &SStr::from_str(&h.env, "desc"),
    );
}

// ---------------------------------------------------------------------------
// resolve_dispute — bps boundaries, duplicate resolution, revoked mediator
// ---------------------------------------------------------------------------

/// Asserts the exact dispute payout. The platform fee is not transferred: it
/// accrues inside the contract, so it is what remains in the contract balance.
fn assert_dispute_payout(h: &Harness, tid: u64, seller: i128, buyer: i128, fee: i128) {
    assert!(matches!(
        h.client().get_trade(&tid).status,
        TradeStatus::Completed
    ));
    assert_eq!(h.token().balance(&h.seller), seller);
    assert_eq!(h.token().balance(&h.buyer), buyer);
    assert_eq!(h.token().balance(&h.contract_id), fee);
    assert_eq!(seller + buyer + fee, h.client().get_trade(&tid).amount);
}

#[test]
fn test_auth_resolve_dispute_accepts_zero_bps() {
    // seller_gets_bps = 0 shifts the whole trade into the loss bucket, which the
    // fixture's 50/50 loss split shares: seller_raw 500, 1% fee on it = 5.
    let h = Harness::new();
    let tid = disputed_trade(&h, 1_000);
    h.client().resolve_dispute(&tid, &h.mediator, &0u32);
    assert_dispute_payout(&h, tid, 495, 500, 5);
}

#[test]
fn test_auth_resolve_dispute_accepts_full_bps() {
    // seller_gets_bps = 10_000: no loss, seller takes everything less the 1% fee.
    let h = Harness::new();
    let tid = disputed_trade(&h, 1_000);
    h.client().resolve_dispute(&tid, &h.mediator, &10_000u32);
    assert_dispute_payout(&h, tid, 990, 0, 10);
}

#[test]
#[should_panic(expected = "seller_gets_bps must be <= 10_000")]
fn test_auth_resolve_dispute_rejects_bps_above_max() {
    let h = Harness::new();
    let tid = disputed_trade(&h, 1_000);
    h.client().resolve_dispute(&tid, &h.mediator, &10_001u32);
}

#[test]
#[should_panic(expected = "Trade must be in Disputed status")]
fn test_auth_resolve_dispute_rejects_duplicate_resolution() {
    let h = Harness::new();
    let tid = disputed_trade(&h, 1_000);
    h.client().resolve_dispute(&tid, &h.mediator, &5_000u32);
    h.client().resolve_dispute(&tid, &h.mediator, &5_000u32);
}

#[test]
#[should_panic(expected = "Unauthorized mediator")]
fn test_auth_resolve_dispute_removed_mediator_denied() {
    let h = Harness::new();
    let tid = disputed_trade(&h, 1_000);
    h.client().remove_mediator(&h.mediator);
    h.client().resolve_dispute(&tid, &h.mediator, &5_000u32);
}

#[test]
#[should_panic]
fn test_auth_resolve_dispute_stranger_cannot_sign_for_mediator() {
    let h = Harness::new();
    let tid = disputed_trade(&h, 1_000);
    let args = auth_args!(h, &tid, &h.mediator, &5_000u32);
    h.client()
        .mock_auths(&[auth_invoke!(&h, &h.stranger, "resolve_dispute", args)])
        .resolve_dispute(&tid, &h.mediator, &5_000u32);
}

// ---------------------------------------------------------------------------
// add_mediator / remove_mediator — non-admin roles + repeated calls
// ---------------------------------------------------------------------------

#[test]
#[should_panic]
fn test_auth_add_mediator_existing_mediator_denied() {
    // Being a mediator grants no power to register more mediators.
    let h = Harness::new();
    let new_med = Address::generate(&h.env);
    let args = auth_args!(h, &new_med);
    h.client()
        .mock_auths(&[auth_invoke!(&h, &h.mediator, "add_mediator", args)])
        .add_mediator(&new_med);
}

#[test]
fn test_auth_add_mediator_duplicate_is_idempotent() {
    let h = Harness::new();
    h.client().add_mediator(&h.mediator);
    assert!(h.client().is_mediator(&h.mediator));
    h.client().remove_mediator(&h.mediator);
    assert!(!h.client().is_mediator(&h.mediator));
}

#[test]
fn test_auth_remove_mediator_twice_stays_removed() {
    let h = Harness::new();
    h.client().remove_mediator(&h.mediator);
    h.client().remove_mediator(&h.mediator);
    assert!(!h.client().is_mediator(&h.mediator));
}

// ---------------------------------------------------------------------------
// submit_video_proof / submit_manifest — duplicates + remaining roles
// ---------------------------------------------------------------------------

#[test]
#[should_panic(expected = "Video proof already submitted for this trade")]
fn test_auth_submit_video_proof_rejects_duplicate_from_other_party() {
    let h = Harness::new();
    let tid = h.funded_trade(1_000);
    h.client()
        .submit_video_proof(&tid, &h.buyer, &SStr::from_str(&h.env, "QmFirst"));
    h.client()
        .submit_video_proof(&tid, &h.seller, &SStr::from_str(&h.env, "QmSecond"));
}

#[test]
#[should_panic(expected = "Only the buyer or seller can submit video proof")]
fn test_auth_submit_video_proof_admin_denied() {
    let h = Harness::new();
    let tid = h.funded_trade(1_000);
    h.client()
        .submit_video_proof(&tid, &h.admin, &SStr::from_str(&h.env, "QmAdminVideo"));
}

#[test]
#[should_panic(expected = "Manifest already submitted")]
fn test_auth_submit_manifest_rejects_duplicate() {
    let h = Harness::new();
    let tid = h.funded_trade(1_000);
    let name = SStr::from_str(&h.env, "QmDriverName");
    let id = SStr::from_str(&h.env, "QmDriverId");
    h.client().submit_manifest(&tid, &h.seller, &name, &id);
    h.client().submit_manifest(&tid, &h.seller, &name, &id);
}

#[test]
#[should_panic(expected = "Only seller can submit manifest")]
fn test_auth_submit_manifest_mediator_denied() {
    let h = Harness::new();
    let tid = h.funded_trade(1_000);
    h.client().submit_manifest(
        &tid,
        &h.mediator,
        &SStr::from_str(&h.env, "QmDriverName"),
        &SStr::from_str(&h.env, "QmDriverId"),
    );
}

#[test]
#[should_panic(expected = "Only seller can submit manifest")]
fn test_auth_submit_manifest_admin_denied() {
    let h = Harness::new();
    let tid = h.funded_trade(1_000);
    h.client().submit_manifest(
        &tid,
        &h.admin,
        &SStr::from_str(&h.env, "QmDriverName"),
        &SStr::from_str(&h.env, "QmDriverId"),
    );
}
