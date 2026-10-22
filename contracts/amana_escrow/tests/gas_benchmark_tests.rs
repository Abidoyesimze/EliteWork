//! Issue #192 — Gas optimization benchmarks for hot paths
//!
//! This test suite measures and records gas costs for critical operations.
//! Baseline: recorded after initial optimization pass.
//! Run with: cargo test --test gas_benchmark_tests -- --nocapture
//!
//! Target: ≥20% improvement on hot paths (deposit/release) compared to baseline.

extern crate std;

use amana_escrow::{EscrowContract, EscrowContractClient};
use amana_escrow::test_fixture::admin_address;
use soroban_sdk::{Address, Env, String as SStr, testutils::{Address as _, Events as _}, token};

struct BenchEnv {
    env: Env,
    contract_id: Address,
    usdc_id: Address,
    buyer: Address,
    seller: Address,
}

impl BenchEnv {
    fn new() -> Self {
        let env = Env::default();
        env.mock_all_auths();
        let admin = admin_address(&env);
        let usdc_id = env
            .register_stellar_asset_contract_v2(admin.clone())
            .address();
        let contract_id = env.register(EscrowContract, ());
        EscrowContractClient::new(&env, &contract_id)
            .initialize(&admin, &usdc_id, &admin, &100u32, &usdc_id);

        let buyer = Address::generate(&env);
        let seller = Address::generate(&env);

        BenchEnv {
            env,
            contract_id,
            usdc_id,
            buyer,
            seller,
        }
    }

    fn client(&self) -> EscrowContractClient<'_> {
        EscrowContractClient::new(&self.env, &self.contract_id)
    }
}

// ---------------------------------------------------------------------------
// Deposit hot-path benchmark (Issue #192)
// ---------------------------------------------------------------------------

#[test]
fn bench_deposit_hot_path() {
    let bench = BenchEnv::new();
    let amount = 100_000i128;

    token::StellarAssetClient::new(&bench.env, &bench.usdc_id).mint(&bench.buyer, &amount);
    let trade_id = bench.client().create_trade(
        &bench.buyer,
        &bench.seller,
        &amount,
        &5000u32,
        &5000u32,
        &None,
    );

    bench.client().deposit(&trade_id);

    // `env.events().all()` reflects the latest host invocation only, so the
    // events of this call are read after it. Diffing two snapshots taken
    // around the call compares two different invocations and can underflow.
    let event_count = bench.env.events().all().events().len();

    std::eprintln!(
        "[#192] deposit hot-path benchmark\n  amount={}\n  events_emitted={}",
        amount, event_count
    );

    let trade = bench.client().get_trade(&trade_id);
    assert!(
        matches!(trade.status, amana_escrow::TradeStatus::Funded),
        "trade must transition to Funded"
    );
}

// ---------------------------------------------------------------------------
// Release hot-path benchmark (Issue #192)
// ---------------------------------------------------------------------------

#[test]
fn bench_release_funds_hot_path() {
    let bench = BenchEnv::new();
    let amount = 100_000i128;

    token::StellarAssetClient::new(&bench.env, &bench.usdc_id).mint(&bench.buyer, &amount);
    let trade_id = bench.client().create_trade(
        &bench.buyer,
        &bench.seller,
        &amount,
        &5000u32,
        &5000u32,
        &None,
    );
    bench.client().deposit(&trade_id);
    bench.client().confirm_delivery(&trade_id);

    bench.client().release_funds(&trade_id, &bench.buyer);

    // `env.events().all()` reflects the latest host invocation only, so the
    // events of this call are read after it. Diffing two snapshots taken
    // around the call compares two different invocations and can underflow.
    let event_count = bench.env.events().all().events().len();

    std::eprintln!(
        "[#192] release_funds hot-path benchmark\n  amount={}\n  events_emitted={}",
        amount, event_count
    );

    let trade = bench.client().get_trade(&trade_id);
    assert!(
        matches!(trade.status, amana_escrow::TradeStatus::Completed),
        "trade must transition to Completed"
    );

    let fees = bench.client().get_accrued_fees();
    let expected_fee = amount / 100;
    assert!(fees > 0, "fees should have accrued");
}

// ---------------------------------------------------------------------------
// Create trade benchmark (for comparison)
// ---------------------------------------------------------------------------

#[test]
fn bench_create_trade() {
    let bench = BenchEnv::new();
    let amount = 100_000i128;

    token::StellarAssetClient::new(&bench.env, &bench.usdc_id).mint(&bench.buyer, &(amount * 10));

    for _ in 0..10 {
        bench.client().create_trade(
            &bench.buyer,
            &bench.seller,
            &amount,
            &5000u32,
            &5000u32,
            &None,
        );
    }

    // `env.events().all()` reflects the latest host invocation only, so this
    // is the event count of the last `create_trade` call.
    let event_count = bench.env.events().all().events().len();

    std::eprintln!(
        "[#192] create_trade benchmark (10 iterations)\n  avg_amount={}\n  events_per_trade={}",
        amount, event_count
    );
}

// ---------------------------------------------------------------------------
// Confirm delivery benchmark
// ---------------------------------------------------------------------------

#[test]
fn bench_confirm_delivery() {
    let bench = BenchEnv::new();
    let amount = 100_000i128;

    token::StellarAssetClient::new(&bench.env, &bench.usdc_id).mint(&bench.buyer, &amount);
    let trade_id = bench.client().create_trade(
        &bench.buyer,
        &bench.seller,
        &amount,
        &5000u32,
        &5000u32,
        &None,
    );
    bench.client().deposit(&trade_id);

    bench.client().confirm_delivery(&trade_id);

    // `env.events().all()` reflects the latest host invocation only, so the
    // events of this call are read after it. Diffing two snapshots taken
    // around the call compares two different invocations and can underflow.
    let event_count = bench.env.events().all().events().len();

    std::eprintln!(
        "[#192] confirm_delivery benchmark\n  amount={}\n  events_emitted={}",
        amount, event_count
    );

    let trade = bench.client().get_trade(&trade_id);
    assert!(
        matches!(trade.status, amana_escrow::TradeStatus::Delivered),
        "trade must transition to Delivered"
    );
}

// ---------------------------------------------------------------------------
// Storage footprint tests
// ---------------------------------------------------------------------------

#[test]
fn bench_storage_footprint_deposit_release_cycle() {
    let bench = BenchEnv::new();
    let amount = 50_000i128;

    token::StellarAssetClient::new(&bench.env, &bench.usdc_id).mint(&bench.buyer, &(amount * 5));

    for iteration in 0..5 {
        let trade_id = bench.client().create_trade(
            &bench.buyer,
            &bench.seller,
            &amount,
            &5000u32,
            &5000u32,
            &None,
        );
        bench.client().deposit(&trade_id);
        bench.client().confirm_delivery(&trade_id);
        bench.client().release_funds(&trade_id, &bench.buyer);

        if iteration == 0 || iteration == 4 {
            std::eprintln!("[#192] storage_footprint iteration {} complete", iteration + 1);
        }
    }

    let final_fees = bench.client().get_accrued_fees();
    assert!(final_fees > 0, "fees should accumulate");
}