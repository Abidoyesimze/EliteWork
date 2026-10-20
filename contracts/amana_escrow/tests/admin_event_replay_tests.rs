/// Issue #103 — Contract event replay guard for admin clawback events.
///
/// Verifies clawback events carry identifiers needed for backend dedupe.
/// Uses the shared [`AdminSignerFixture`] (#108).
///
/// Issue #298 — Review edge-case coverage:
/// Boundary amounts, unauthorized-caller attempts, and repeated/duplicate calls.
///
/// Note: Soroban testutils `env.events().all()` reflects events from the
/// latest host invocation, so multi-step suites assert per-call.
extern crate std;

use amana_escrow::{
    auth_invoke,
    test_fixture::{clawback_auth_args, AdminSignerFixture},
    EVENT_SCHEMA_VERSION, TradeStatus,
};
use soroban_sdk::{
    testutils::{Address as _, Events},
    xdr::{ContractEventBody, ScVal},
    Address, IntoVal, Symbol, TryIntoVal, Val,
};

fn clawback_event_payloads(env: &soroban_sdk::Env) -> std::vec::Vec<std::vec::Vec<ScVal>> {
    let all = env.events().all();
    let expected_topic: ScVal =
        IntoVal::<soroban_sdk::Env, Val>::into_val(&Symbol::new(env, "CLWBCK"), env)
            .try_into_val(env)
            .unwrap();

    all.events()
        .iter()
        .filter_map(|event| {
            let ContractEventBody::V0(v0) = &event.body;
            let topic = v0.topics.first()?;
            if topic != &expected_topic {
                return None;
            }
            Some(match &v0.data {
                ScVal::Map(Some(map)) => map.iter().map(|e| e.val.clone()).collect(),
                ScVal::Vec(Some(fields)) => fields.to_vec(),
                _ => return None,
            })
        })
        .collect()
}

fn payload_has_u64(data: &[ScVal], value: u64) -> bool {
    data.iter().any(|v| matches!(v, ScVal::U64(n) if *n == value))
}

fn payload_has_schema_version(data: &[ScVal]) -> bool {
    data.iter()
        .any(|v| matches!(v, ScVal::U32(n) if *n == EVENT_SCHEMA_VERSION))
}

#[test]
fn test_clawback_event_contains_unique_identifiers() {
    let h = AdminSignerFixture::new();
    let amount = 5_000_i128;
    let trade_id = h.funded_trade(amount);

    h.client().admin_clawback(&trade_id, &amount, &h.buyer);

    let events = clawback_event_payloads(&h.env);
    assert_eq!(events.len(), 1);
    assert!(payload_has_u64(&events[0], trade_id));
    assert!(payload_has_schema_version(&events[0]));
    assert_eq!(events[0].len(), 6);
}

#[test]
fn test_multiple_partial_clawbacks_emit_distinct_events() {
    let h = AdminSignerFixture::new();
    let trade_id = h.funded_trade(9_000);

    h.client().admin_clawback(&trade_id, &3_000, &h.buyer);
    let after_first = clawback_event_payloads(&h.env);
    assert_eq!(after_first.len(), 1);
    assert!(payload_has_u64(&after_first[0], trade_id));

    h.client().admin_clawback(&trade_id, &3_000, &h.buyer);
    let after_second = clawback_event_payloads(&h.env);
    assert_eq!(after_second.len(), 1);
    assert!(payload_has_u64(&after_second[0], trade_id));
    assert!(payload_has_schema_version(&after_second[0]));

    h.client().admin_clawback(&trade_id, &3_000, &h.buyer);
    let after_third = clawback_event_payloads(&h.env);
    assert_eq!(after_third.len(), 1);
    assert_eq!(h.client().get_clawback_total(&trade_id), 9_000);
}

#[test]
fn test_clawback_events_include_schema_version_for_compat() {
    let h = AdminSignerFixture::new();
    let trade_id = h.funded_trade(4_000);
    h.client().admin_clawback(&trade_id, &4_000, &h.buyer);

    let events = clawback_event_payloads(&h.env);
    assert_eq!(events.len(), 1);
    assert!(payload_has_schema_version(&events[0]));
}

#[test]
fn test_clawbacks_on_distinct_trades_are_distinguishable() {
    let h = AdminSignerFixture::new();
    let trade_id_1 = h.funded_trade(4_000);
    let trade_id_2 = h.funded_trade(6_000);

    h.client().admin_clawback(&trade_id_1, &4_000, &h.buyer);
    let events_1 = clawback_event_payloads(&h.env);
    assert_eq!(events_1.len(), 1);
    assert!(payload_has_u64(&events_1[0], trade_id_1));

    h.client().admin_clawback(&trade_id_2, &6_000, &h.buyer);
    let events_2 = clawback_event_payloads(&h.env);
    assert_eq!(events_2.len(), 1);
    assert!(payload_has_u64(&events_2[0], trade_id_2));
    assert!(!payload_has_u64(&events_2[0], trade_id_1));
}

#[test]
fn test_clawback_event_payload_stable_field_count() {
    let h = AdminSignerFixture::new();
    let trade_id = h.funded_trade(2_000);
    h.client().admin_clawback(&trade_id, &2_000, &h.buyer);

    let events = clawback_event_payloads(&h.env);
    assert_eq!(events[0].len(), 6);
}

#[test]
fn test_repeated_partial_clawbacks_preserve_identifiers() {
    let h = AdminSignerFixture::new();
    let trade_id = h.funded_trade(6_000);
    h.client().admin_clawback(&trade_id, &3_000, &h.buyer);
    let first = clawback_event_payloads(&h.env);
    assert!(payload_has_u64(&first[0], trade_id));
    assert!(payload_has_schema_version(&first[0]));

    h.client().admin_clawback(&trade_id, &3_000, &h.buyer);
    let second = clawback_event_payloads(&h.env);
    assert!(payload_has_u64(&second[0], trade_id));
    assert!(payload_has_schema_version(&second[0]));
}

#[test]
fn test_custom_destination_still_emits_clawback_event() {
    let h = AdminSignerFixture::new();
    let custom_dest = Address::generate(&h.env);
    let trade_id = h.funded_trade(5_000);
    h.client().admin_clawback(&trade_id, &5_000, &custom_dest);

    let events = clawback_event_payloads(&h.env);
    assert_eq!(events.len(), 1);
    assert!(payload_has_u64(&events[0], trade_id));
}

#[test]
fn test_full_clawback_emits_single_event() {
    let h = AdminSignerFixture::new();
    let amount = 7_000_i128;
    let trade_id = h.funded_trade(amount);
    h.client().admin_clawback(&trade_id, &amount, &h.buyer);

    assert_eq!(clawback_event_payloads(&h.env).len(), 1);
}

#[test]
fn test_event_schema_version_constant_matches_payload() {
    let h = AdminSignerFixture::new();
    let trade_id = h.funded_trade(4_000);
    h.client().admin_clawback(&trade_id, &4_000, &h.buyer);

    let events = clawback_event_payloads(&h.env);
    assert!(payload_has_schema_version(&events[0]));
    assert_eq!(EVENT_SCHEMA_VERSION, 1);
}

#[test]
fn test_disputed_trade_clawback_emits_event() {
    let h = AdminSignerFixture::new();
    let amount = 6_000_i128;
    let trade_id = h.funded_trade(amount);
    let reason = soroban_sdk::String::from_str(&h.env, "QmDisputeReason");
    h.client().initiate_dispute(&trade_id, &h.buyer, &reason);
    h.client().admin_clawback(&trade_id, &amount, &h.buyer);

    assert_eq!(clawback_event_payloads(&h.env).len(), 1);
}

// -----------------------------------------------------------------------------
// Issue #298: Boundary Amounts and Event Verification
// -----------------------------------------------------------------------------

#[test]
#[should_panic(expected = "CLAWBACK_INVALID_AMOUNT")]
fn test_boundary_zero_amount_clawback_emits_no_event() {
    let h = AdminSignerFixture::new();
    let trade_id = h.funded_trade(5_000);

    // Zero amount must panic before event publication
    h.client().admin_clawback(&trade_id, &0i128, &h.buyer);
}

#[test]
#[should_panic(expected = "CLAWBACK_INVALID_AMOUNT")]
fn test_boundary_negative_amount_clawback_emits_no_event() {
    let h = AdminSignerFixture::new();
    let trade_id = h.funded_trade(5_000);

    // Negative amount must panic before event publication
    h.client().admin_clawback(&trade_id, &-500i128, &h.buyer);
}

#[test]
#[should_panic(expected = "clawback_amount exceeds remaining escrowed amount")]
fn test_boundary_amount_exceeding_balance_emits_no_event() {
    let h = AdminSignerFixture::new();
    let amount = 3_000_i128;
    let trade_id = h.funded_trade(amount);

    // Over-clawback must panic before event publication
    h.client().admin_clawback(&trade_id, &(amount + 1), &h.buyer);
}

#[test]
fn test_boundary_minimum_amount_one_emits_valid_event() {
    let h = AdminSignerFixture::new();
    let amount = 2_000_i128;
    let trade_id = h.funded_trade(amount);

    // Smallest valid boundary amount
    h.client().admin_clawback(&trade_id, &1i128, &h.buyer);

    let events = clawback_event_payloads(&h.env);
    assert_eq!(events.len(), 1);
    assert!(payload_has_u64(&events[0], trade_id));
    assert!(payload_has_schema_version(&events[0]));
    assert_eq!(events[0].len(), 6);
}

#[test]
fn test_boundary_exact_remaining_amount_cancels_and_emits_event() {
    let h = AdminSignerFixture::new();
    let amount = 5_000_i128;
    let trade_id = h.funded_trade(amount);

    h.client().admin_clawback(&trade_id, &amount, &h.buyer);

    let events = clawback_event_payloads(&h.env);
    assert_eq!(events.len(), 1);
    assert!(payload_has_u64(&events[0], trade_id));
    assert_eq!(h.client().get_trade(&trade_id).status, TradeStatus::Cancelled);
}

// -----------------------------------------------------------------------------
// Issue #298: Unauthorized-Caller Attempts
// -----------------------------------------------------------------------------

#[test]
#[should_panic(expected = "Error(Auth, InvalidAction)")]
fn test_unauthorized_stranger_clawback_fails_before_event() {
    let h = AdminSignerFixture::new();
    let amount = 4_000_i128;
    let trade_id = h.funded_trade(amount);
    let args = clawback_auth_args(&h.env, trade_id, amount, &h.buyer);

    h.client()
        .mock_auths(&[auth_invoke!(&h, &h.stranger, "admin_clawback", args)])
        .admin_clawback(&trade_id, &amount, &h.buyer);
}

#[test]
#[should_panic(expected = "Error(Auth, InvalidAction)")]
fn test_unauthorized_seller_clawback_fails_before_event() {
    let h = AdminSignerFixture::new();
    let amount = 4_000_i128;
    let trade_id = h.funded_trade(amount);
    let args = clawback_auth_args(&h.env, trade_id, amount, &h.buyer);

    h.client()
        .mock_auths(&[auth_invoke!(&h, &h.seller, "admin_clawback", args)])
        .admin_clawback(&trade_id, &amount, &h.buyer);
}

// -----------------------------------------------------------------------------
// Issue #298: Repeated / Duplicate Calls
// -----------------------------------------------------------------------------

#[test]
#[should_panic(expected = "Trade must be in Funded or Disputed status for clawback")]
fn test_duplicate_clawback_on_cancelled_trade_fails_and_emits_no_event() {
    let h = AdminSignerFixture::new();
    let amount = 3_000_i128;
    let trade_id = h.funded_trade(amount);

    // First call succeeds and cancels the trade
    h.client().admin_clawback(&trade_id, &amount, &h.buyer);
    assert_eq!(h.client().get_trade(&trade_id).status, TradeStatus::Cancelled);

    // Duplicate call must panic and not publish another clawback event
    h.client().admin_clawback(&trade_id, &amount, &h.buyer);
}
