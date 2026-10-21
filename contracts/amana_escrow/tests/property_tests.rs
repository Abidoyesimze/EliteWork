/// Issue #382 — Make property tests reproducible and time-bounded.
///
/// Seeds are printed on every run so a failing case can be replayed with:
///   AMANA_PROP_SEED=<seed> cargo test
///
/// Iteration count is controlled by AMANA_PROP_TESTS (default 64).
extern crate std;

use amana_escrow::{EscrowContract, EscrowContractClient};
use rand::rngs::StdRng;
use rand::{Rng, SeedableRng};
use soroban_sdk::{Address, Env, String as SStr, testutils::Address as _, token};
use std::env as stdenv;

// ---------------------------------------------------------------------------
// Seed / iteration helpers
// ---------------------------------------------------------------------------

fn get_seed() -> u64 {
    stdenv::var("AMANA_PROP_SEED")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or_else(|| {
            // Derive a stable-ish seed from the wall clock so different CI runs
            // still vary, but the value is always printed for replay.
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_secs())
                .unwrap_or(42)
        })
}

fn get_iterations() -> usize {
    stdenv::var("AMANA_PROP_TESTS")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(64)
}

// ---------------------------------------------------------------------------
// Shared setup
// ---------------------------------------------------------------------------

struct PropEnv {
    env: Env,
    contract_id: Address,
    usdc_id: Address,
    #[allow(dead_code)]
    admin: Address,
}

impl PropEnv {
    fn new(fee_bps: u32) -> Self {
        let env = Env::default();
        env.mock_all_auths();
        let admin = Address::generate(&env);
        let treasury = Address::generate(&env);
        let usdc_id = env
            .register_stellar_asset_contract_v2(admin.clone())
            .address();
        let contract_id = env.register(EscrowContract, ());
        EscrowContractClient::new(&env, &contract_id)
            .initialize(&admin, &usdc_id, &treasury, &fee_bps, &usdc_id);
        PropEnv {
            env,
            contract_id,
            usdc_id,
            admin,
        }
    }

    fn client(&self) -> EscrowContractClient<'_> {
        EscrowContractClient::new(&self.env, &self.contract_id)
    }

    fn resolve(
        &self,
        buyer_loss_bps: u32,
        seller_loss_bps: u32,
        seller_gets_bps: u32,
        amount: i128,
    ) -> (i128, i128, i128) {
        let buyer = Address::generate(&self.env);
        let seller = Address::generate(&self.env);
        let mediator = Address::generate(&self.env);
        let client = self.client();

        token::StellarAssetClient::new(&self.env, &self.usdc_id).mint(&buyer, &amount);
        let trade_id = client.create_trade(
            &buyer,
            &seller,
            &amount,
            &buyer_loss_bps,
            &seller_loss_bps,
            &None,
        );
        client.deposit(&trade_id);
        client.initiate_dispute(&trade_id, &buyer, &SStr::from_str(&self.env, "QmPropTest"));
        client.set_mediator(&mediator);
        client.resolve_dispute(&trade_id, &mediator, &seller_gets_bps);

        let tok = token::Client::new(&self.env, &self.usdc_id);
        // The platform fee is accrued in contract storage and stays in the
        // escrow until the admin withdraws it (`withdraw_fees`), so it is not
        // paid to the treasury during settlement. It is therefore reported as
        // the accrued fee, and the escrow must still hold exactly that much.
        let fee = client.get_accrued_fees();
        assert_eq!(
            tok.balance(&self.contract_id),
            fee,
            "[#382] escrow must hold exactly the accrued platform fee"
        );
        (tok.balance(&seller), tok.balance(&buyer), fee)
    }
}

// ---------------------------------------------------------------------------
// Property: fund conservation  seller + buyer + fee == total
// ---------------------------------------------------------------------------

#[test]
fn test_prop_fund_conservation_seeded() {
    let seed = get_seed();
    let iters = get_iterations();
    std::eprintln!(
        "[#382] fund_conservation seed={seed} iters={iters}  replay: AMANA_PROP_SEED={seed} AMANA_PROP_TESTS={iters} cargo test test_prop_fund_conservation_seeded"
    );

    let mut rng = StdRng::seed_from_u64(seed);

    for case in 0..iters {
        let fee_bps = rng.gen_range(0u32..=1_000);
        let amount = rng.gen_range(1i128..=1_000_000);
        let buyer_loss_bps = rng.gen_range(0u32..=10_000);
        let seller_loss_bps = 10_000 - buyer_loss_bps;
        let seller_gets_bps = rng.gen_range(0u32..=10_000);

        let pe = PropEnv::new(fee_bps);
        let (s, b, f) = pe.resolve(buyer_loss_bps, seller_loss_bps, seller_gets_bps, amount);

        assert_eq!(
            s + b + f,
            amount,
            "[#382] fund_conservation FAILED  seed={seed} case={case} \
             fee_bps={fee_bps} amount={amount} buyer_loss_bps={buyer_loss_bps} \
             seller_gets_bps={seller_gets_bps}  replay: AMANA_PROP_SEED={seed}"
        );
    }
}

// ---------------------------------------------------------------------------
// Property: non-negativity  no payout component < 0
// ---------------------------------------------------------------------------

#[test]
fn test_prop_non_negativity_seeded() {
    let seed = get_seed();
    let iters = get_iterations();
    std::eprintln!("[#382] non_negativity seed={seed} iters={iters}");

    let mut rng = StdRng::seed_from_u64(seed);

    for case in 0..iters {
        let fee_bps = rng.gen_range(0u32..=10_000);
        let amount = rng.gen_range(1i128..=1_000_000);
        let buyer_loss_bps = rng.gen_range(0u32..=10_000);
        let seller_loss_bps = 10_000 - buyer_loss_bps;
        let seller_gets_bps = rng.gen_range(0u32..=10_000);

        let pe = PropEnv::new(fee_bps);
        let (s, b, f) = pe.resolve(buyer_loss_bps, seller_loss_bps, seller_gets_bps, amount);

        assert!(
            s >= 0 && b >= 0 && f >= 0,
            "[#382] non_negativity FAILED  seed={seed} case={case} \
             s={s} b={b} f={f}  replay: AMANA_PROP_SEED={seed}"
        );
    }
}

// ---------------------------------------------------------------------------
// Property: seller monotonicity  higher seller_gets_bps => seller payout non-decreasing
// ---------------------------------------------------------------------------

#[test]
fn test_prop_seller_monotonicity_seeded() {
    let seed = get_seed();
    let iters = get_iterations();
    std::eprintln!("[#382] seller_monotonicity seed={seed} iters={iters}");

    let mut rng = StdRng::seed_from_u64(seed);

    for case in 0..iters {
        let fee_bps = rng.gen_range(0u32..=1_000);
        let amount = rng.gen_range(100i128..=1_000_000);
        let buyer_loss_bps = rng.gen_range(0u32..=10_000);
        let seller_loss_bps = 10_000 - buyer_loss_bps;
        let sgb_lo = rng.gen_range(0u32..10_000);
        let sgb_hi = rng.gen_range(sgb_lo..=10_000);

        let pe_lo = PropEnv::new(fee_bps);
        let (s_lo, _, _) = pe_lo.resolve(buyer_loss_bps, seller_loss_bps, sgb_lo, amount);

        let pe_hi = PropEnv::new(fee_bps);
        let (s_hi, _, _) = pe_hi.resolve(buyer_loss_bps, seller_loss_bps, sgb_hi, amount);

        assert!(
            s_hi >= s_lo,
            "[#382] seller_monotonicity FAILED  seed={seed} case={case} \
             sgb_lo={sgb_lo} s_lo={s_lo} sgb_hi={sgb_hi} s_hi={s_hi}  \
             replay: AMANA_PROP_SEED={seed}"
        );
    }
}

// ---------------------------------------------------------------------------
// Property: invalid lifecycle transitions are always rejected
// ---------------------------------------------------------------------------

#[test]
fn test_prop_invalid_lifecycle_transitions_seeded() {
    let seed = get_seed();
    let iters = get_iterations();
    std::eprintln!("[#382] invalid_lifecycle seed={seed} iters={iters}");

    let mut rng = StdRng::seed_from_u64(seed);

    for case in 0..iters {
        let env = Env::default();
        env.mock_all_auths();
        let admin = Address::generate(&env);
        let buyer = Address::generate(&env);
        let seller = Address::generate(&env);
        let treasury = Address::generate(&env);
        let usdc_id = env
            .register_stellar_asset_contract_v2(admin.clone())
            .address();
        let contract_id = env.register(EscrowContract, ());
        let client = EscrowContractClient::new(&env, &contract_id);
        client.initialize(&admin, &usdc_id, &treasury, &100u32, &usdc_id);

        let amount = rng.gen_range(1i128..=100_000);
        token::StellarAssetClient::new(&env, &usdc_id).mint(&buyer, &amount);
        let trade_id = client.create_trade(&buyer, &seller, &amount, &5000u32, &5000u32, &None);
        client.deposit(&trade_id);

        // Attempting to deposit again must panic (trade is Funded, not Created)
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let env2 = Env::default();
            env2.mock_all_auths();
            let admin2 = Address::generate(&env2);
            let buyer2 = Address::generate(&env2);
            let seller2 = Address::generate(&env2);
            let treasury2 = Address::generate(&env2);
            let usdc2 = env2
                .register_stellar_asset_contract_v2(admin2.clone())
                .address();
            let cid2 = env2.register(EscrowContract, ());
            let c2 = EscrowContractClient::new(&env2, &cid2);
            c2.initialize(&admin2, &usdc2, &treasury2, &100u32, &usdc2);
            let amt2 = 1_000i128;
            token::StellarAssetClient::new(&env2, &usdc2).mint(&buyer2, &(amt2 * 2));
            let tid2 = c2.create_trade(&buyer2, &seller2, &amt2, &5000u32, &5000u32, &None);
            c2.deposit(&tid2);
            c2.deposit(&tid2); // must panic
        }));

        assert!(
            result.is_err(),
            "[#382] invalid_lifecycle FAILED: double-deposit did not panic  \
             seed={seed} case={case}  replay: AMANA_PROP_SEED={seed}"
        );
    }
}

// ---------------------------------------------------------------------------
// Boundary testing for i128 extremes (Issue #191)
// ---------------------------------------------------------------------------

#[test]
fn test_boundary_zero_amount_rejected() {
    let env = Env::default();
    env.mock_all_auths();
    let admin = Address::generate(&env);
    let buyer = Address::generate(&env);
    let seller = Address::generate(&env);
    let treasury = Address::generate(&env);
    let usdc_id = env
        .register_stellar_asset_contract_v2(admin.clone())
        .address();
    let contract_id = env.register(EscrowContract, ());
    let client = EscrowContractClient::new(&env, &contract_id);
    client.initialize(&admin, &usdc_id, &treasury, &100u32, &usdc_id);

    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        client.create_trade(&buyer, &seller, &0i128, &5000u32, &5000u32, &None);
    }));

    assert!(result.is_err(), "zero amount should be rejected");
}

#[test]
fn test_boundary_negative_amount_rejected() {
    let env = Env::default();
    env.mock_all_auths();
    let admin = Address::generate(&env);
    let buyer = Address::generate(&env);
    let seller = Address::generate(&env);
    let treasury = Address::generate(&env);
    let usdc_id = env
        .register_stellar_asset_contract_v2(admin.clone())
        .address();
    let contract_id = env.register(EscrowContract, ());
    let client = EscrowContractClient::new(&env, &contract_id);
    client.initialize(&admin, &usdc_id, &treasury, &100u32, &usdc_id);

    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        client.create_trade(&buyer, &seller, &-1000i128, &5000u32, &5000u32, &None);
    }));

    assert!(result.is_err(), "negative amount should be rejected");
}

#[test]
fn test_boundary_max_amount_accepted() {
    use amana_escrow::MAX_TRADE_VALUE;
    let env = Env::default();
    env.mock_all_auths();
    let admin = Address::generate(&env);
    let buyer = Address::generate(&env);
    let seller = Address::generate(&env);
    let treasury = Address::generate(&env);
    let usdc_id = env
        .register_stellar_asset_contract_v2(admin.clone())
        .address();
    let contract_id = env.register(EscrowContract, ());
    let client = EscrowContractClient::new(&env, &contract_id);
    client.initialize(&admin, &usdc_id, &treasury, &100u32, &usdc_id);

    token::StellarAssetClient::new(&env, &usdc_id).mint(&buyer, &MAX_TRADE_VALUE);
    let trade_id = client.create_trade(&buyer, &seller, &MAX_TRADE_VALUE, &5000u32, &5000u32, &None);
    assert!(trade_id > 0, "max amount trade should be created successfully");
}

#[test]
fn test_boundary_exceeds_max_amount_rejected() {
    use amana_escrow::MAX_TRADE_VALUE;
    let env = Env::default();
    env.mock_all_auths();
    let admin = Address::generate(&env);
    let buyer = Address::generate(&env);
    let seller = Address::generate(&env);
    let treasury = Address::generate(&env);
    let usdc_id = env
        .register_stellar_asset_contract_v2(admin.clone())
        .address();
    let contract_id = env.register(EscrowContract, ());
    let client = EscrowContractClient::new(&env, &contract_id);
    client.initialize(&admin, &usdc_id, &treasury, &100u32, &usdc_id);

    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        client.create_trade(
            &buyer,
            &seller,
            &(MAX_TRADE_VALUE + 1),
            &5000u32,
            &5000u32,
            &None,
        );
    }));

    assert!(
        result.is_err(),
        "amount exceeding MAX_TRADE_VALUE should be rejected"
    );
}

#[test]
fn test_boundary_loss_ratio_min_max() {
    let seed = get_seed();
    let iters = get_iterations();
    std::eprintln!("[#191] loss_ratio_min_max seed={seed} iters={iters}");

    let mut rng = StdRng::seed_from_u64(seed);

    for case in 0..iters {
        let env = Env::default();
        env.mock_all_auths();
        let admin = Address::generate(&env);
        let buyer = Address::generate(&env);
        let seller = Address::generate(&env);
        let treasury = Address::generate(&env);
        let usdc_id = env
            .register_stellar_asset_contract_v2(admin.clone())
            .address();
        let contract_id = env.register(EscrowContract, ());
        let client = EscrowContractClient::new(&env, &contract_id);
        client.initialize(&admin, &usdc_id, &treasury, &100u32, &usdc_id);

        let amount = rng.gen_range(1i128..=1_000_000);

        token::StellarAssetClient::new(&env, &usdc_id).mint(&buyer, &amount);

        let mut test_cases = vec![(0u32, 10000u32), (10000u32, 0u32)];
        if rng.gen_bool(0.5) {
            test_cases.push((5000u32, 5000u32));
        }

        for (buyer_loss, seller_loss) in test_cases {
            let trade_id = client.create_trade(&buyer, &seller, &amount, &buyer_loss, &seller_loss, &None);
            let trade = client.get_trade(&trade_id);
            assert!(
                trade.buyer_loss_bps + trade.seller_loss_bps == 10_000,
                "[#191] loss_ratio_min_max FAILED  case={case} buyer_loss={buyer_loss} seller_loss={seller_loss}"
            );
        }
    }
}

#[test]
fn test_boundary_zero_loss_bps() {
    let env = Env::default();
    env.mock_all_auths();
    let admin = Address::generate(&env);
    let buyer = Address::generate(&env);
    let seller = Address::generate(&env);
    let treasury = Address::generate(&env);
    let usdc_id = env
        .register_stellar_asset_contract_v2(admin.clone())
        .address();
    let contract_id = env.register(EscrowContract, ());
    let client = EscrowContractClient::new(&env, &contract_id);
    client.initialize(&admin, &usdc_id, &treasury, &100u32, &usdc_id);

    token::StellarAssetClient::new(&env, &usdc_id).mint(&buyer, &1_000i128);

    let trade_id = client.create_trade(&buyer, &seller, &1_000i128, &10000u32, &0u32, &None);
    let trade = client.get_trade(&trade_id);
    assert_eq!(trade.buyer_loss_bps, 10000u32);
    assert_eq!(trade.seller_loss_bps, 0u32);
}

#[test]
fn test_boundary_fee_calculation_extremes() {
    let seed = get_seed();
    let iters = get_iterations();
    std::eprintln!("[#191] fee_calculation_extremes seed={seed} iters={iters}");

    let mut rng = StdRng::seed_from_u64(seed);

    for case in 0..iters {
        let fee_bps = rng.gen_range(0u32..=500);
        let amount = rng.gen_range(1i128..=1_000_000);

        let pe = PropEnv::new(fee_bps);
        let (_, _, fee) = pe.resolve(5000u32, 5000u32, 10_000u32, amount);

        let expected_fee = amount.saturating_mul(fee_bps as i128) / 10_000i128;
        assert_eq!(
            fee, expected_fee,
            "[#191] fee_calculation_extremes FAILED  case={case} fee_bps={fee_bps} amount={amount} expected={expected_fee} got={fee}"
        );
    }
}

#[test]
fn test_boundary_split_then_merge_metamorphic() {
    let seed = get_seed();
    let iters = get_iterations();
    std::eprintln!("[#191] split_then_merge_metamorphic seed={seed} iters={iters}");

    let mut rng = StdRng::seed_from_u64(seed);

    for case in 0..iters {
        let amount = rng.gen_range(1_000i128..=10_000_000);
        let buyer_loss_bps = rng.gen_range(0u32..=10_000);
        let seller_loss_bps = 10_000 - buyer_loss_bps;
        let fee_bps = rng.gen_range(1u32..=500);

        let pe2 = PropEnv::new(fee_bps);
        let (s_half1, b_half1, f_half1) = pe2.resolve(buyer_loss_bps, seller_loss_bps, 5000u32, amount / 2);

        let pe3 = PropEnv::new(fee_bps);
        let (s_half2, b_half2, f_half2) = pe3.resolve(buyer_loss_bps, seller_loss_bps, 5000u32, amount - amount / 2);

        let total_seller = s_half1 + s_half2;
        let total_buyer = b_half1 + b_half2;
        let total_fee = f_half1 + f_half2;

        assert_eq!(
            total_seller + total_buyer + total_fee,
            amount,
            "[#191] split_then_merge FAILED  case={case} amount={amount} \
             total={} expected={}  replay: AMANA_PROP_SEED={seed}",
            total_seller + total_buyer + total_fee,
            amount
        );
    }
}

#[test]
fn test_boundary_fee_zero_amount_deposit() {
    let env = Env::default();
    env.mock_all_auths();
    let admin = Address::generate(&env);
    let buyer = Address::generate(&env);
    let seller = Address::generate(&env);
    let treasury = Address::generate(&env);
    let usdc_id = env
        .register_stellar_asset_contract_v2(admin.clone())
        .address();
    let contract_id = env.register(EscrowContract, ());
    let client = EscrowContractClient::new(&env, &contract_id);
    client.initialize(&admin, &usdc_id, &treasury, &500u32, &usdc_id);

    token::StellarAssetClient::new(&env, &usdc_id).mint(&buyer, &100i128);

    let trade_id = client.create_trade(&buyer, &seller, &100i128, &5000u32, &5000u32, &None);
    client.deposit(&trade_id);
    client.confirm_delivery(&trade_id);
    client.release_funds(&trade_id, &buyer);

    let actual_fee = client.get_accrued_fees();
    let expected_fee = 100i128 * 500i128 / 10_000i128;
    assert_eq!(actual_fee, expected_fee, "fee calculation must be exact for edge amounts");
}

#[test]
fn test_boundary_one_stroops_min_amount() {
    let env = Env::default();
    env.mock_all_auths();
    let admin = Address::generate(&env);
    let buyer = Address::generate(&env);
    let seller = Address::generate(&env);
    let treasury = Address::generate(&env);
    let usdc_id = env
        .register_stellar_asset_contract_v2(admin.clone())
        .address();
    let contract_id = env.register(EscrowContract, ());
    let client = EscrowContractClient::new(&env, &contract_id);
    client.initialize(&admin, &usdc_id, &treasury, &100u32, &usdc_id);

    token::StellarAssetClient::new(&env, &usdc_id).mint(&buyer, &1i128);

    let trade_id = client.create_trade(&buyer, &seller, &1i128, &5000u32, &5000u32, &None);
    assert!(trade_id > 0, "min amount (1 stroops) should be accepted");
    let trade = client.get_trade(&trade_id);
    assert_eq!(trade.amount, 1i128);
}
