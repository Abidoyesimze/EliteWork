extern crate std;

use amana_escrow::{TradeStatus, test_fixture::AdminSignerFixture};
use soroban_sdk::{
    Env, IntoVal, TryIntoVal, Val, symbol_short,
    testutils::{Events as _, Ledger as _},
    xdr::ContractEventBody,
};

type Harness = AdminSignerFixture;

fn create_trade(h: &Harness) -> u64 {
    h.client().create_trade(
        &h.buyer,
        &h.seller,
        &1_000i128,
        &5000u32,
        &5000u32,
        &None,
    )
}

#[test]
fn cancel_by_buyer_cancels_created_trade_and_emits_event() {
    let h = Harness::new();
    let trade_id = create_trade(&h);

    h.client().cancel_by_buyer(&trade_id);

    // Read events before any further host invoke (testutils keeps last-invoke events).
    let all_events = h.env.events().all();
    let events = all_events.events();
    let event = events.last().expect("cancel event should be emitted");
    match &event.body {
        ContractEventBody::V0(v0) => {
            let expected: soroban_sdk::xdr::ScVal =
                IntoVal::<Env, Val>::into_val(&symbol_short!("TCNBYR"), &h.env)
                    .try_into_val(&h.env)
                    .unwrap();
            assert_eq!(v0.topics.first().unwrap(), &expected);
            match &v0.data {
                soroban_sdk::xdr::ScVal::Vec(Some(payload)) => assert_eq!(payload.len(), 2),
                soroban_sdk::xdr::ScVal::Map(Some(payload)) => assert_eq!(payload.len(), 2),
                other => panic!("expected vec or map event payload, got {other:?}"),
            }
        }
    }

    let trade = h.client().get_trade(&trade_id);
    assert!(matches!(trade.status, TradeStatus::Cancelled));
}

#[test]
#[should_panic(expected = "Trade must be in Created status")]
fn cancel_by_buyer_rejects_funded_trade() {
    let h = Harness::new();
    let trade_id = create_trade(&h);
    h.mint(&h.buyer, 1_000);
    h.client().deposit(&trade_id);

    h.client().cancel_by_buyer(&trade_id);
}

#[test]
#[should_panic]
fn cancel_by_buyer_rejects_non_buyer_auth() {
    let h = Harness::new();
    let trade_id = create_trade(&h);

    h.client()
        .mock_auths(&[soroban_sdk::testutils::MockAuth {
            address: &h.stranger,
            invoke: &soroban_sdk::testutils::MockAuthInvoke {
                contract: &h.contract_id,
                fn_name: "cancel_by_buyer",
                args: soroban_sdk::vec![&h.env, IntoVal::<Env, Val>::into_val(&trade_id, &h.env),],
                sub_invokes: &[],
            },
        }])
        .cancel_by_buyer(&trade_id);
}

// ---------------------------------------------------------------------------
// Issue #301 — edge cases not covered above: unknown trades, every non-Created
// status, repeated calls, wrong-role signers, boundary amounts, and the
// guarantee that a Created-stage cancel never moves tokens.
// ---------------------------------------------------------------------------

fn create_trade_with_amount(h: &Harness, amount: i128) -> u64 {
    h.client()
        .create_trade(&h.buyer, &h.seller, &amount, &5000u32, &5000u32, &None)
}

/// Invoke `cancel_by_buyer` with auth supplied only by `signer`.
fn cancel_signed_by(h: &Harness, signer: &soroban_sdk::Address, trade_id: u64) {
    h.client()
        .mock_auths(&[soroban_sdk::testutils::MockAuth {
            address: signer,
            invoke: &soroban_sdk::testutils::MockAuthInvoke {
                contract: &h.contract_id,
                fn_name: "cancel_by_buyer",
                args: soroban_sdk::vec![&h.env, IntoVal::<Env, Val>::into_val(&trade_id, &h.env),],
                sub_invokes: &[],
            },
        }])
        .cancel_by_buyer(&trade_id);
}

#[test]
#[should_panic(expected = "Trade not found")]
fn cancel_by_buyer_rejects_unknown_trade() {
    let h = Harness::new();
    h.client().cancel_by_buyer(&999u64);
}

#[test]
#[should_panic(expected = "Trade must be in Created status")]
fn cancel_by_buyer_rejects_repeated_cancel() {
    let h = Harness::new();
    let trade_id = create_trade(&h);
    h.client().cancel_by_buyer(&trade_id);
    h.client().cancel_by_buyer(&trade_id);
}

#[test]
#[should_panic(expected = "Trade must be in Created status")]
fn cancel_by_buyer_rejects_trade_cancelled_via_cancel_trade() {
    let h = Harness::new();
    let trade_id = create_trade(&h);
    h.client().cancel_trade(&trade_id, &h.seller);
    h.client().cancel_by_buyer(&trade_id);
}

#[test]
#[should_panic(expected = "Trade must be in Created status")]
fn cancel_by_buyer_rejects_delivered_trade() {
    let h = Harness::new();
    let trade_id = h.funded_trade(1_000);
    h.client().confirm_delivery(&trade_id);
    h.client().cancel_by_buyer(&trade_id);
}

#[test]
#[should_panic(expected = "Trade must be in Created status")]
fn cancel_by_buyer_rejects_completed_trade() {
    let h = Harness::new();
    let trade_id = h.funded_trade(1_000);
    h.client().confirm_delivery(&trade_id);
    h.client().release_funds(&trade_id, &h.buyer);
    h.client().cancel_by_buyer(&trade_id);
}

#[test]
#[should_panic(expected = "Trade must be in Created status")]
fn cancel_by_buyer_rejects_disputed_trade() {
    let h = Harness::new();
    let trade_id = h.funded_trade(1_000);
    h.client().initiate_dispute(
        &trade_id,
        &h.buyer,
        &soroban_sdk::String::from_str(&h.env, "QmBuyerCancel"),
    );
    h.client().cancel_by_buyer(&trade_id);
}

#[test]
#[should_panic]
fn cancel_by_buyer_rejects_seller_auth() {
    let h = Harness::new();
    let trade_id = create_trade(&h);
    cancel_signed_by(&h, &h.seller.clone(), trade_id);
}

#[test]
#[should_panic]
fn cancel_by_buyer_rejects_admin_auth() {
    let h = Harness::new();
    let trade_id = create_trade(&h);
    cancel_signed_by(&h, &h.admin.clone(), trade_id);
}

#[test]
fn cancel_by_buyer_accepts_explicit_buyer_auth() {
    let h = Harness::new();
    let trade_id = create_trade(&h);
    cancel_signed_by(&h, &h.buyer.clone(), trade_id);
    assert!(matches!(
        h.client().get_trade(&trade_id).status,
        TradeStatus::Cancelled
    ));
}

#[test]
fn cancel_by_buyer_allows_minimum_amount_trade() {
    let h = Harness::new();
    let trade_id = create_trade_with_amount(&h, 1);
    h.client().cancel_by_buyer(&trade_id);
    assert!(matches!(
        h.client().get_trade(&trade_id).status,
        TradeStatus::Cancelled
    ));
}

#[test]
fn cancel_by_buyer_allows_max_value_trade() {
    let h = Harness::new();
    let trade_id = create_trade_with_amount(&h, amana_escrow::MAX_TRADE_VALUE);
    h.client().cancel_by_buyer(&trade_id);
    let trade = h.client().get_trade(&trade_id);
    assert!(matches!(trade.status, TradeStatus::Cancelled));
    assert_eq!(trade.amount, amana_escrow::MAX_TRADE_VALUE);
}

#[test]
fn cancel_by_buyer_moves_no_tokens() {
    let h = Harness::new();
    // The buyer holds funds but has not deposited them, so nothing is in
    // escrow and a Created-stage cancel must leave every balance untouched.
    h.mint(&h.buyer, 5_000);
    let trade_id = create_trade(&h);

    h.client().cancel_by_buyer(&trade_id);

    assert_eq!(h.token().balance(&h.buyer), 5_000);
    assert_eq!(h.token().balance(&h.seller), 0);
    assert_eq!(h.token().balance(&h.treasury), 0);
    assert_eq!(h.token().balance(&h.contract_id), 0);
}

#[test]
#[should_panic(expected = "Trade must be in Created status")]
fn deposit_rejected_after_cancel_by_buyer() {
    let h = Harness::new();
    let trade_id = create_trade(&h);
    h.mint(&h.buyer, 1_000);
    h.client().cancel_by_buyer(&trade_id);
    h.client().deposit(&trade_id);
}

#[test]
fn cancel_by_buyer_leaves_other_trades_untouched() {
    let h = Harness::new();
    let cancelled = create_trade(&h);
    let sibling = create_trade(&h);

    h.client().cancel_by_buyer(&cancelled);

    assert!(matches!(
        h.client().get_trade(&cancelled).status,
        TradeStatus::Cancelled
    ));
    assert!(matches!(
        h.client().get_trade(&sibling).status,
        TradeStatus::Created
    ));
}

#[test]
fn cancel_by_buyer_records_cancel_timestamp() {
    let h = Harness::new();
    h.env
        .ledger()
        .with_mut(|ledger| ledger.timestamp = 1_700_000_000);
    let trade_id = create_trade(&h);

    h.env
        .ledger()
        .with_mut(|ledger| ledger.timestamp = 1_700_000_500);
    h.client().cancel_by_buyer(&trade_id);

    assert_eq!(h.client().get_trade(&trade_id).updated_at, 1_700_000_500);
    let sequence = h.client().get_release_sequence(&trade_id);
    assert_eq!(sequence.cancelled_at, Some(1_700_000_500));
    assert_eq!(sequence.funded_at, None);
}
