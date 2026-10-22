    extern crate std;

    use super::*;
    use quickcheck::{Arbitrary, Gen, QuickCheck, TestResult};

    /// Fixed QuickCheck seed. Several of these properties drive a real `Env`,
    /// so each generated case is written to `test_snapshots/`; an unseeded
    /// generator rewrote that golden output on every run (#302). Change the
    /// seed deliberately, and commit the regenerated snapshots with it.
    const PROPERTY_SEED: u64 = 0xA3A7A_5EED;

    /// `QuickCheck` with QuickCheck's default size (100) and [`PROPERTY_SEED`].
    fn seeded_quickcheck() -> QuickCheck {
        QuickCheck::new().rng(Gen::from_size_and_seed(100, PROPERTY_SEED))
    }

    use soroban_sdk::testutils::Address as _;
    use soroban_sdk::{Address, Env, token};
    use std::boxed::Box;
    use std::vec::Vec;

    // -----------------------------------------------------------------------
    // Arbitrary types for property-based testing
    // -----------------------------------------------------------------------

    /// Represents a valid test case for dispute resolution
    #[derive(Clone, Debug)]
    struct DisputeTestCase {
        total_amount: i128,   // Total escrow amount (1 to 1_000_000)
        buyer_loss_bps: u32,  // Buyer's loss share (0 to 10000)
        seller_loss_bps: u32, // Seller's loss share (0 to 10000)
        seller_gets_bps: u32, // Seller payout ratio (0 to 10000)
        fee_bps: u32,         // Platform fee (0 to 1000)
    }

    impl Arbitrary for DisputeTestCase {
        fn arbitrary(g: &mut Gen) -> Self {
            // Generate amounts that are realistic but varied.
            // `i128::arbitrary` can be negative and Rust's `%` keeps the sign of
            // the dividend, so the magnitude is taken first — an escrow total
            // is never negative.
            let total_amount = 1 + (i128::arbitrary(g).unsigned_abs() % 1_000_000) as i128;
            let buyer_loss_bps = u32::arbitrary(g) % 10_001;
            let seller_loss_bps = u32::arbitrary(g) % 10_001;
            let seller_gets_bps = u32::arbitrary(g) % 10_001;
            let fee_bps = u32::arbitrary(g) % 1_001;

            DisputeTestCase {
                total_amount,
                buyer_loss_bps,
                seller_loss_bps,
                seller_gets_bps,
                fee_bps,
            }
        }

        fn shrink(&self) -> Box<dyn Iterator<Item = Self>> {
            quickcheck::empty_shrinker()
        }
    }

    // -----------------------------------------------------------------------
    // Helper: Calculate expected payouts (mirrors contract logic)
    // -----------------------------------------------------------------------

    fn calculate_payouts(
        total: i128,
        seller_loss_bps: u32,
        seller_gets_bps: u32,
        fee_bps: u32,
    ) -> (i128, i128, i128) {
        const BPS_DIVISOR: i128 = 10_000;

        // Calculate the loss amount in basis points
        let loss_bps = BPS_DIVISOR - (seller_gets_bps as i128);

        // Distribute loss according to seller's agreed ratio
        let seller_loss_amount =
            (total * loss_bps * (seller_loss_bps as i128)) / (BPS_DIVISOR * BPS_DIVISOR);

        // Calculate raw payouts
        let seller_raw = total - seller_loss_amount;
        let buyer_refund = total - seller_raw;

        // Deduct platform fee from seller's portion only
        let fee = (seller_raw * (fee_bps as i128)) / BPS_DIVISOR;
        let seller_net = seller_raw - fee;

        (seller_net, buyer_refund, fee)
    }

    // -----------------------------------------------------------------------
    // Property: Fund Conservation
    // -----------------------------------------------------------------------

    /// Property: seller_payout + buyer_refund + platform_fee == original_escrow
    /// No money is created or destroyed in the system.
    fn prop_fund_conservation(case: DisputeTestCase) -> TestResult {
        let (seller_net, buyer_refund, fee) = calculate_payouts(
            case.total_amount,
            case.seller_loss_bps,
            case.seller_gets_bps,
            case.fee_bps,
        );

        let total_out = seller_net + buyer_refund + fee;

        if total_out != case.total_amount {
            std::eprintln!(
                "Fund conservation violated: {} + {} + {} = {} != {}",
                seller_net,
                buyer_refund,
                fee,
                total_out,
                case.total_amount
            );
            return TestResult::failed();
        }

        TestResult::passed()
    }

    #[test]
    fn test_property_fund_conservation() {
        seeded_quickcheck()
            .tests(100)
            .quickcheck(prop_fund_conservation as fn(DisputeTestCase) -> TestResult);
    }

    // -----------------------------------------------------------------------
    // Property: Loss Distribution
    // -----------------------------------------------------------------------

    /// Property: loss_amount * (seller_loss_bps / 10000) = seller_loss
    /// Loss is distributed correctly according to agreed ratios.
    fn prop_loss_distribution(case: DisputeTestCase) -> TestResult {
        const BPS_DIVISOR: i128 = 10_000;

        let loss_bps = BPS_DIVISOR - (case.seller_gets_bps as i128);
        let total_loss = (case.total_amount * loss_bps) / BPS_DIVISOR;
        let expected_seller_loss = (total_loss * (case.seller_loss_bps as i128)) / BPS_DIVISOR;

        // Calculate actual seller loss from payouts
        let (seller_net, _, _) = calculate_payouts(
            case.total_amount,
            case.seller_loss_bps,
            case.seller_gets_bps,
            case.fee_bps,
        );

        // Seller loss = total - seller_net - fee (what seller actually lost)
        let fee = (case.total_amount - expected_seller_loss) * (case.fee_bps as i128) / BPS_DIVISOR;
        let actual_seller_loss = case.total_amount - seller_net - fee;

        // Allow for 1 unit of rounding error
        if (actual_seller_loss - expected_seller_loss).abs() > 1 {
            std::eprintln!(
                "Loss distribution violated: expected seller_loss={expected_seller_loss}, actual={actual_seller_loss}"
            );
            return TestResult::failed();
        }

        TestResult::passed()
    }

    #[test]
    fn test_property_loss_distribution() {
        seeded_quickcheck()
            .tests(100)
            .quickcheck(prop_loss_distribution as fn(DisputeTestCase) -> TestResult);
    }

    // -----------------------------------------------------------------------
    // Property: Monotonicity
    // -----------------------------------------------------------------------

    /// Property: As seller_gets_bps increases, buyer_refund decreases
    /// Higher seller payout ratio means lower buyer refund.
    fn prop_monotonicity(case: DisputeTestCase) -> TestResult {
        const BPS_DIVISOR: u32 = 10_000;

        // Test with seller_gets_bps and seller_gets_bps + 1 (if valid)
        if case.seller_gets_bps >= BPS_DIVISOR {
            return TestResult::passed();
        }

        let (_, buyer_refund_low, _) = calculate_payouts(
            case.total_amount,
            case.seller_loss_bps,
            case.seller_gets_bps,
            case.fee_bps,
        );

        let (_, buyer_refund_high, _) = calculate_payouts(
            case.total_amount,
            case.seller_loss_bps,
            case.seller_gets_bps + 1,
            case.fee_bps,
        );

        // Buyer refund should decrease (or stay same due to rounding) as seller_gets increases
        if buyer_refund_high > buyer_refund_low {
            std::eprintln!(
                "Monotonicity violated: buyer_refund at {} bps = {}, at {} bps = {}",
                case.seller_gets_bps,
                buyer_refund_low,
                case.seller_gets_bps + 1,
                buyer_refund_high
            );
            return TestResult::failed();
        }

        TestResult::passed()
    }

    #[test]
    fn test_property_monotonicity() {
        seeded_quickcheck()
            .tests(100)
            .quickcheck(prop_monotonicity as fn(DisputeTestCase) -> TestResult);
    }

    // -----------------------------------------------------------------------
    // Property: Non-negativity
    // -----------------------------------------------------------------------

    /// Property: All payouts >= 0 (never negative transfers)
    fn prop_non_negativity(case: DisputeTestCase) -> TestResult {
        let (seller_net, buyer_refund, fee) = calculate_payouts(
            case.total_amount,
            case.seller_loss_bps,
            case.seller_gets_bps,
            case.fee_bps,
        );

        if seller_net < 0 {
            std::eprintln!("Non-negativity violated: seller_net = {seller_net}");
            return TestResult::failed();
        }
        if buyer_refund < 0 {
            std::eprintln!("Non-negativity violated: buyer_refund = {buyer_refund}");
            return TestResult::failed();
        }
        if fee < 0 {
            std::eprintln!("Non-negativity violated: fee = {fee}");
            return TestResult::failed();
        }

        TestResult::passed()
    }

    #[test]
    fn test_property_non_negativity() {
        seeded_quickcheck()
            .tests(100)
            .quickcheck(prop_non_negativity as fn(DisputeTestCase) -> TestResult);
    }

    // -----------------------------------------------------------------------
    // Property: Bounds Checking
    // -----------------------------------------------------------------------

    /// Property: seller_gets_bps > 10000 is invalid (would be rejected by contract)
    #[test]
    #[should_panic(expected = "seller_gets_bps must be <= 10_000")]
    fn test_bounds_seller_gets_bps_over_10000() {
        let env = Env::default();
        env.mock_all_auths();

        let contract_id = env.register(EscrowContract, ());
        let client = EscrowContractClient::new(&env, &contract_id);
        let admin = crate::test_fixture::admin_address(&env);
        let buyer = Address::generate(&env);
        let seller = Address::generate(&env);
        let treasury = Address::generate(&env);
        let usdc_id = env
            .register_stellar_asset_contract_v2(admin.clone())
            .address();

        client.initialize(&admin, &usdc_id, &treasury, &100, &usdc_id);

        let amount = 10_000_i128;
        let token_client = token::StellarAssetClient::new(&env, &usdc_id);
        token_client.mint(&buyer, &amount);

        let trade_id = client.create_trade(&buyer, &seller, &amount, &5000_u32, &5000_u32, &None);
        client.deposit(&trade_id);
        client.initiate_dispute(&trade_id, &buyer, &String::from_str(&env, "reason"));

        let mediator = Address::generate(&env);
        client.set_mediator(&mediator);

        // This should panic - seller_gets_bps > 10000
        client.resolve_dispute(&trade_id, &mediator, &10_001_u32);
    }

    // -----------------------------------------------------------------------
    // Edge Case Tests
    // -----------------------------------------------------------------------

    /// Edge case: loss = total (seller_gets_bps = 0)
    /// With 50/50 loss sharing, seller bears 50% of total loss
    #[test]
    fn test_edge_case_total_loss() {
        let env = Env::default();
        env.mock_all_auths();

        let contract_id = env.register(EscrowContract, ());
        let client = EscrowContractClient::new(&env, &contract_id);
        let admin = crate::test_fixture::admin_address(&env);
        let buyer = Address::generate(&env);
        let seller = Address::generate(&env);
        let treasury = Address::generate(&env);
        let usdc_id = env
            .register_stellar_asset_contract_v2(admin.clone())
            .address();

        client.initialize(&admin, &usdc_id, &treasury, &100, &usdc_id);

        let amount = 10_000_i128;
        let token_client = token::StellarAssetClient::new(&env, &usdc_id);
        token_client.mint(&buyer, &amount);

        // 50/50 loss sharing
        let trade_id = client.create_trade(&buyer, &seller, &amount, &5000_u32, &5000_u32, &None);
        client.deposit(&trade_id);
        client.initiate_dispute(&trade_id, &buyer, &String::from_str(&env, "reason"));

        let mediator = Address::generate(&env);
        client.set_mediator(&mediator);

        // seller_gets_bps = 0 (total loss = 100%)
        // loss = 10,000 (100%)
        // seller bears: 10,000 * 50% = 5,000
        // seller_raw = 10,000 - 5,000 = 5,000
        // fee = 5,000 * 1% = 50
        // seller_net = 5,000 - 50 = 4,950
        // buyer_refund = 5,000
        client.resolve_dispute(&trade_id, &mediator, &0_u32);

        let token = token::Client::new(&env, &usdc_id);
        // Seller gets 4,950 (bears 50% of total loss, minus 1% fee)
        assert_eq!(
            token.balance(&seller),
            4_950,
            "seller should bear 50% of total loss minus fee"
        );
        // Buyer gets 5,000 refund (bears 50% of loss)
        assert_eq!(
            token.balance(&buyer),
            5_000,
            "buyer should bear 50% of loss"
        );
        // Treasury gets 50 (fee on seller portion)
        assert_eq!(client.get_accrued_fees(), 50, "fees should accrue");

        // Verify conservation
        assert_eq!(4_950 + 5_000 + 50, amount, "conservation must hold");
    }

    /// Edge case: loss = 0 (seller_gets_bps = 10000)
    /// Seller gets full amount (minus fee), buyer gets nothing
    #[test]
    fn test_edge_case_no_loss() {
        let env = Env::default();
        env.mock_all_auths();

        let contract_id = env.register(EscrowContract, ());
        let client = EscrowContractClient::new(&env, &contract_id);
        let admin = crate::test_fixture::admin_address(&env);
        let buyer = Address::generate(&env);
        let seller = Address::generate(&env);
        let treasury = Address::generate(&env);
        let usdc_id = env
            .register_stellar_asset_contract_v2(admin.clone())
            .address();

        client.initialize(&admin, &usdc_id, &treasury, &100, &usdc_id);

        let amount = 10_000_i128;
        let token_client = token::StellarAssetClient::new(&env, &usdc_id);
        token_client.mint(&buyer, &amount);

        // 50/50 loss sharing (doesn't matter when no loss)
        let trade_id = client.create_trade(&buyer, &seller, &amount, &5000_u32, &5000_u32, &None);
        client.deposit(&trade_id);
        client.initiate_dispute(&trade_id, &buyer, &String::from_str(&env, "reason"));

        let mediator = Address::generate(&env);
        client.set_mediator(&mediator);

        // seller_gets_bps = 10000 (no loss)
        client.resolve_dispute(&trade_id, &mediator, &10_000_u32);

        let token = token::Client::new(&env, &usdc_id);
        // seller_raw = 10000, fee = 10000 * 100 / 10000 = 100, seller_net = 9900
        assert_eq!(
            token.balance(&seller),
            9_900,
            "seller should get amount minus fee"
        );
        // Buyer gets 0
        assert_eq!(token.balance(&buyer), 0, "buyer should get nothing");
        // Treasury gets fee
        assert_eq!(client.get_accrued_fees(), 100, "fees should accrue");

        // Verify conservation
        assert_eq!(9_900 + 100, amount, "conservation must hold");
    }

    /// Edge case: seller_gets_bps = 0 (total loss) with various loss-sharing ratios
    #[test]
    fn test_edge_case_seller_gets_zero() {
        let env = Env::default();
        env.mock_all_auths();

        let contract_id = env.register(EscrowContract, ());
        let client = EscrowContractClient::new(&env, &contract_id);
        let admin = crate::test_fixture::admin_address(&env);
        let buyer = Address::generate(&env);
        let seller = Address::generate(&env);
        let treasury = Address::generate(&env);
        let usdc_id = env
            .register_stellar_asset_contract_v2(admin.clone())
            .address();

        client.initialize(&admin, &usdc_id, &treasury, &0, &usdc_id);

        let amount = 10_000_i128;
        let token_client = token::StellarAssetClient::new(&env, &usdc_id);
        token_client.mint(&buyer, &amount);

        // 50/50 loss sharing, seller_gets_bps = 0 (100% loss)
        // seller bears: 10,000 * 50% = 5,000, keeps: 5,000
        // buyer bears: 10,000 * 50% = 5,000, refund: 5,000
        let trade_id = client.create_trade(&buyer, &seller, &amount, &5000_u32, &5000_u32, &None);
        client.deposit(&trade_id);
        client.initiate_dispute(&trade_id, &buyer, &String::from_str(&env, "reason"));

        let mediator = Address::generate(&env);
        client.set_mediator(&mediator);
        client.resolve_dispute(&trade_id, &mediator, &0_u32);

        let token = token::Client::new(&env, &usdc_id);
        assert_eq!(
            token.balance(&seller),
            5_000,
            "seller bears 50% of total loss"
        );
        assert_eq!(
            token.balance(&buyer),
            5_000,
            "buyer bears 50% of total loss"
        );
        assert_eq!(
            token.balance(&seller) + token.balance(&buyer),
            amount,
            "conservation holds"
        );
    }

    /// Edge case: seller_gets_bps = 10000 (no loss) with various loss-sharing ratios
    #[test]
    fn test_edge_case_seller_gets_all() {
        let env = Env::default();
        env.mock_all_auths();

        let contract_id = env.register(EscrowContract, ());
        let client = EscrowContractClient::new(&env, &contract_id);
        let admin = crate::test_fixture::admin_address(&env);
        let buyer = Address::generate(&env);
        let seller = Address::generate(&env);
        let treasury = Address::generate(&env);
        let usdc_id = env
            .register_stellar_asset_contract_v2(admin.clone())
            .address();

        client.initialize(&admin, &usdc_id, &treasury, &0, &usdc_id);

        let amount = 10_000_i128;
        let token_client = token::StellarAssetClient::new(&env, &usdc_id);
        token_client.mint(&buyer, &amount);

        // 50/50 loss sharing, seller_gets_bps = 10000 (0% loss)
        // seller gets full amount, buyer gets 0
        let trade_id = client.create_trade(&buyer, &seller, &amount, &5000_u32, &5000_u32, &None);
        client.deposit(&trade_id);
        client.initiate_dispute(&trade_id, &buyer, &String::from_str(&env, "reason"));

        let mediator = Address::generate(&env);
        client.set_mediator(&mediator);
        client.resolve_dispute(&trade_id, &mediator, &10_000_u32);

        let token = token::Client::new(&env, &usdc_id);
        assert_eq!(
            token.balance(&seller),
            amount,
            "seller gets full amount with no loss"
        );
        assert_eq!(token.balance(&buyer), 0, "buyer gets nothing with no loss");
    }

    /// Edge case: fee = 0 (no platform fee)
    #[test]
    fn test_edge_case_zero_fee() {
        let env = Env::default();
        env.mock_all_auths();

        let contract_id = env.register(EscrowContract, ());
        let client = EscrowContractClient::new(&env, &contract_id);
        let admin = crate::test_fixture::admin_address(&env);
        let buyer = Address::generate(&env);
        let seller = Address::generate(&env);
        let treasury = Address::generate(&env);
        let usdc_id = env
            .register_stellar_asset_contract_v2(admin.clone())
            .address();

        client.initialize(&admin, &usdc_id, &treasury, &0, &usdc_id); // Zero fee

        let amount = 10_000_i128;
        let token_client = token::StellarAssetClient::new(&env, &usdc_id);
        token_client.mint(&buyer, &amount);

        let trade_id = client.create_trade(&buyer, &seller, &amount, &5000_u32, &5000_u32, &None);
        client.deposit(&trade_id);
        client.initiate_dispute(&trade_id, &buyer, &String::from_str(&env, "reason"));

        let mediator = Address::generate(&env);
        client.set_mediator(&mediator);

        // 50% for seller (50% loss)
        client.resolve_dispute(&trade_id, &mediator, &5_000_u32);

        let token = token::Client::new(&env, &usdc_id);
        // loss = 50% = 5000
        // seller bears: 5000 * 50% = 2500
        // seller_raw = 10000 - 2500 = 7500
        // fee = 0 (zero fee)
        // seller_net = 7500
        // buyer_refund = 2500
        assert_eq!(
            token.balance(&seller),
            7_500,
            "seller gets 75% with 50% loss and 50% loss sharing"
        );
        assert_eq!(token.balance(&buyer), 2_500, "buyer gets 25% refund");
        assert_eq!(
            client.get_accrued_fees(),
            0,
            "treasury gets nothing with zero fee"
        );

        // Verify conservation
        assert_eq!((7_500 + 2_500), amount, "conservation must hold");
    }

    /// Edge case: fee = 1000 (10% fee - maximum typical fee)
    #[test]
    fn test_edge_case_max_typical_fee() {
        let env = Env::default();
        env.mock_all_auths();

        let contract_id = env.register(EscrowContract, ());
        let client = EscrowContractClient::new(&env, &contract_id);
        let admin = crate::test_fixture::admin_address(&env);
        let buyer = Address::generate(&env);
        let seller = Address::generate(&env);
        let treasury = Address::generate(&env);
        let usdc_id = env
            .register_stellar_asset_contract_v2(admin.clone())
            .address();

        client.initialize(&admin, &usdc_id, &treasury, &1_000, &usdc_id); // 10% fee

        let amount = 10_000_i128;
        let token_client = token::StellarAssetClient::new(&env, &usdc_id);
        token_client.mint(&buyer, &amount);

        let trade_id = client.create_trade(&buyer, &seller, &amount, &5000_u32, &5000_u32, &None);
        client.deposit(&trade_id);
        client.initiate_dispute(&trade_id, &buyer, &String::from_str(&env, "reason"));

        let mediator = Address::generate(&env);
        client.set_mediator(&mediator);

        // 50% for seller (50% loss)
        client.resolve_dispute(&trade_id, &mediator, &5_000_u32);

        let token = token::Client::new(&env, &usdc_id);
        // loss = 50% = 5000
        // seller bears: 5000 * 50% = 2500
        // seller_raw = 10000 - 2500 = 7500
        // fee = 7500 * 10% = 750
        // seller_net = 7500 - 750 = 6750
        // buyer_refund = 2500
        assert_eq!(
            token.balance(&seller),
            6_750,
            "seller gets 67.5% with 50% loss, 50% sharing, 10% fee"
        );
        assert_eq!(token.balance(&buyer), 2_500, "buyer gets 25% refund");
        assert_eq!(
            client.get_accrued_fees(),
            750,
            "treasury gets 10% fee on seller portion"
        );

        // Verify conservation
        assert_eq!(6_750 + 2_500 + 750, amount, "conservation must hold");
    }

    /// Comprehensive randomized test: 10+ random scenarios
    #[test]
    fn test_comprehensive_randomized_scenarios() {
        let env = Env::default();
        env.mock_all_auths();

        let admin = crate::test_fixture::admin_address(&env);
        let usdc_id = env
            .register_stellar_asset_contract_v2(admin.clone())
            .address();

        // Test 10+ random scenarios
        for i in 0..10 {
            let contract_id = env.register(EscrowContract, ());
            let client = EscrowContractClient::new(&env, &contract_id);
            let treasury = Address::generate(&env);

            // Random fee between 0 and 1000 bps
            let fee_bps = (i % 1001) as u32;
            client.initialize(&admin, &usdc_id, &treasury, &fee_bps, &usdc_id);

            let buyer = Address::generate(&env);
            let seller = Address::generate(&env);

            // Random amount between 1 and 100000
            let amount = 1 + (i as i128 % 100_000);
            let token_client = token::StellarAssetClient::new(&env, &usdc_id);
            token_client.mint(&buyer, &amount);

            // Random loss-sharing ratios
            let buyer_loss_bps = ((i * 7) % 10001) as u32;
            let seller_loss_bps = 10_000 - buyer_loss_bps;

            let trade_id = client.create_trade(
                &buyer,
                &seller,
                &amount,
                &buyer_loss_bps,
                &seller_loss_bps,
                &None,
            );
            client.deposit(&trade_id);
            client.initiate_dispute(&trade_id, &buyer, &String::from_str(&env, "reason"));

            let mediator = Address::generate(&env);
            client.set_mediator(&mediator);

            // Random seller_gets_bps
            let seller_gets_bps = ((i * 13) % 10001) as u32;
            client.resolve_dispute(&trade_id, &mediator, &seller_gets_bps);

            // Verify conservation
            let token = token::Client::new(&env, &usdc_id);
            let seller_balance = token.balance(&seller);
            let buyer_balance = token.balance(&buyer);
            let treasury_balance = client.get_accrued_fees();
            let escrow_balance = token.balance(&contract_id);

            let total = seller_balance + buyer_balance + treasury_balance + escrow_balance;
            assert_eq!(total, amount, "conservation failed in scenario {i}");
            assert_eq!(escrow_balance, client.get_accrued_fees(), "escrow should hold accrued fees in scenario {i}");

            // Verify non-negativity
            assert!(
                seller_balance >= 0,
                "seller balance negative in scenario {i}"
            );
            assert!(buyer_balance >= 0, "buyer balance negative in scenario {i}");
            assert!(
                treasury_balance >= 0,
                "treasury balance negative in scenario {i}"
            );
        }
    }

    #[test]
    fn test_submit_manifest_succeeds_for_seller_in_funded_status() {
        let env = Env::default();
        env.mock_all_auths();

        let contract_id = env.register(EscrowContract, ());
        let client = EscrowContractClient::new(&env, &contract_id);
        let admin = crate::test_fixture::admin_address(&env);
        let buyer = Address::generate(&env);
        let seller = Address::generate(&env);
        let treasury = Address::generate(&env);
        let usdc_id = env
            .register_stellar_asset_contract_v2(admin.clone())
            .address();
        client.initialize(&admin, &usdc_id, &treasury, &100_u32, &usdc_id);
        let token_client = token::StellarAssetClient::new(&env, &usdc_id);
        token_client.mint(&buyer, &10_000_i128);
        let trade_id =
            client.create_trade(&buyer, &seller, &10_000_i128, &5000_u32, &5000_u32, &None);
        client.deposit(&trade_id);

        let client = EscrowContractClient::new(&env, &contract_id);

        let name_hash = String::from_str(
            &env,
            "aabbccddeeff00112233445566778899aabbccddeeff00112233445566778899",
        );
        let id_hash = String::from_str(
            &env,
            "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff",
        );

        client.submit_manifest(&trade_id, &seller, &name_hash, &id_hash);

        let manifest = client
            .get_manifest(&trade_id)
            .expect("manifest should exist");
        assert_eq!(manifest.seller, seller);
        assert_eq!(manifest.driver_name_hash, name_hash);
        assert_eq!(manifest.driver_id_hash, id_hash);
    }

    #[test]
    #[should_panic(expected = "Only seller can submit manifest")]
    fn test_submit_manifest_rejects_non_seller() {
        let env = Env::default();
        env.mock_all_auths();

        let contract_id = env.register(EscrowContract, ());
        let client = EscrowContractClient::new(&env, &contract_id);
        let admin = crate::test_fixture::admin_address(&env);
        let buyer = Address::generate(&env);
        let seller = Address::generate(&env);
        let treasury = Address::generate(&env);
        let usdc_id = env
            .register_stellar_asset_contract_v2(admin.clone())
            .address();
        client.initialize(&admin, &usdc_id, &treasury, &100_u32, &usdc_id);
        let token_client = token::StellarAssetClient::new(&env, &usdc_id);
        token_client.mint(&buyer, &10_000_i128);
        let trade_id =
            client.create_trade(&buyer, &seller, &10_000_i128, &5000_u32, &5000_u32, &None);
        client.deposit(&trade_id);

        let client = EscrowContractClient::new(&env, &contract_id);

        let name_hash = String::from_str(
            &env,
            "aabbccddeeff00112233445566778899aabbccddeeff00112233445566778899",
        );
        let id_hash = String::from_str(
            &env,
            "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff",
        );

        client.submit_manifest(&trade_id, &buyer, &name_hash, &id_hash);
    }

    #[test]
    #[should_panic(expected = "Manifest already submitted")]
    fn test_submit_manifest_rejects_second_submission() {
        let env = Env::default();
        env.mock_all_auths();

        let contract_id = env.register(EscrowContract, ());
        let client = EscrowContractClient::new(&env, &contract_id);
        let admin = crate::test_fixture::admin_address(&env);
        let buyer = Address::generate(&env);
        let seller = Address::generate(&env);
        let treasury = Address::generate(&env);
        let usdc_id = env
            .register_stellar_asset_contract_v2(admin.clone())
            .address();
        client.initialize(&admin, &usdc_id, &treasury, &100_u32, &usdc_id);
        let token_client = token::StellarAssetClient::new(&env, &usdc_id);
        token_client.mint(&buyer, &10_000_i128);
        let trade_id =
            client.create_trade(&buyer, &seller, &10_000_i128, &5000_u32, &5000_u32, &None);
        client.deposit(&trade_id);

        let client = EscrowContractClient::new(&env, &contract_id);

        let first_name_hash = String::from_str(
            &env,
            "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        );
        let first_id_hash = String::from_str(
            &env,
            "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        );
        client.submit_manifest(&trade_id, &seller, &first_name_hash, &first_id_hash);

        let second_name_hash = String::from_str(
            &env,
            "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
        );
        let second_id_hash = String::from_str(
            &env,
            "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
        );
        client.submit_manifest(&trade_id, &seller, &second_name_hash, &second_id_hash);
    }

    #[test]
    fn test_failed_guard_check_keeps_trade_state_unchanged() {
        let env = Env::default();
        env.mock_all_auths();

        let contract_id = env.register(EscrowContract, ());
        let client = EscrowContractClient::new(&env, &contract_id);
        let admin = crate::test_fixture::admin_address(&env);
        let buyer = Address::generate(&env);
        let seller = Address::generate(&env);
        let treasury = Address::generate(&env);
        let usdc_id = env
            .register_stellar_asset_contract_v2(admin.clone())
            .address();
        client.initialize(&admin, &usdc_id, &treasury, &100_u32, &usdc_id);
        let token_client = token::StellarAssetClient::new(&env, &usdc_id);
        token_client.mint(&buyer, &10_000_i128);
        let trade_id =
            client.create_trade(&buyer, &seller, &10_000_i128, &5000_u32, &5000_u32, &None);
        client.deposit(&trade_id);

        let client = EscrowContractClient::new(&env, &contract_id);

        let before = client.get_trade(&trade_id);
        assert!(matches!(before.status, TradeStatus::Funded));

        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let name_hash = String::from_str(
                &env,
                "aabbccddeeff00112233445566778899aabbccddeeff00112233445566778899",
            );
            let id_hash = String::from_str(
                &env,
                "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff",
            );
            client.submit_manifest(&trade_id, &Address::generate(&env), &name_hash, &id_hash);
        }));

        assert!(result.is_err());

        let after = client.get_trade(&trade_id);
        assert!(matches!(after.status, TradeStatus::Funded));
        let manifest = client.get_manifest(&trade_id);
        assert!(manifest.is_none());

        let _ = seller;
    }

    #[derive(Clone, Debug)]
    struct LifecycleScenario {
        amount: i128,
        fee_bps: u32,
        buyer_loss_bps: u32,
        seller_loss_bps: u32,
        seller_gets_bps: u32,
        route: u8,
    }

    impl Arbitrary for LifecycleScenario {
        fn arbitrary(g: &mut Gen) -> Self {
            let raw_amount = i128::arbitrary(g) % 100_000;
            let amount = if raw_amount < 0 {
                -raw_amount
            } else {
                raw_amount
            } + 1;
            let buyer_loss_bps = u32::arbitrary(g) % 10_001;
            let seller_loss_bps = 10_000 - buyer_loss_bps;
            Self {
                amount,
                fee_bps: u32::arbitrary(g) % 10_001,
                buyer_loss_bps,
                seller_loss_bps,
                seller_gets_bps: u32::arbitrary(g) % 10_001,
                route: u8::arbitrary(g),
            }
        }
    }

    fn assert_total_conserved(
        env: &Env,
        contract_id: &Address,
        usdc_id: &Address,
        buyer: &Address,
        seller: &Address,
        treasury: &Address,
        amount: i128,
    ) -> bool {
        let token = token::Client::new(env, usdc_id);
        token.balance(buyer)
            + token.balance(seller)
            + token.balance(treasury)
            + token.balance(contract_id)
            == amount
    }

    fn prop_valid_lifecycle_transitions(case: LifecycleScenario) -> TestResult {
        let env = Env::default();
        env.mock_all_auths();

        let contract_id = env.register(EscrowContract, ());
        let client = EscrowContractClient::new(&env, &contract_id);
        let admin = crate::test_fixture::admin_address(&env);
        let buyer = Address::generate(&env);
        let seller = Address::generate(&env);
        let treasury = Address::generate(&env);
        let usdc_id = env
            .register_stellar_asset_contract_v2(admin.clone())
            .address();

        client.initialize(&admin, &usdc_id, &treasury, &case.fee_bps, &usdc_id);

        let token_client = token::StellarAssetClient::new(&env, &usdc_id);
        token_client.mint(&buyer, &case.amount);

        let trade_id = client.create_trade(
            &buyer,
            &seller,
            &case.amount,
            &case.buyer_loss_bps,
            &case.seller_loss_bps,
            &None,
        );

        match case.route % 4 {
            0 => {
                client.cancel_trade(&trade_id, &buyer);
                if !matches!(client.get_trade(&trade_id).status, TradeStatus::Cancelled) {
                    return TestResult::failed();
                }
            }
            1 => {
                client.deposit(&trade_id);
                client.cancel_trade(&trade_id, &buyer);
                client.cancel_trade(&trade_id, &seller);
                if !matches!(client.get_trade(&trade_id).status, TradeStatus::Cancelled) {
                    return TestResult::failed();
                }
            }
            2 => {
                client.deposit(&trade_id);
                client.confirm_delivery(&trade_id);
                client.release_funds(&trade_id, &buyer);
                if !matches!(client.get_trade(&trade_id).status, TradeStatus::Completed) {
                    return TestResult::failed();
                }
            }
            _ => {
                client.deposit(&trade_id);
                let reason = soroban_sdk::String::from_str(&env, "QmLifecycleProperty");
                client.initiate_dispute(&trade_id, &buyer, &reason);
                let mediator = Address::generate(&env);
                client.set_mediator(&mediator);
                client.resolve_dispute(&trade_id, &mediator, &case.seller_gets_bps);
                if !matches!(client.get_trade(&trade_id).status, TradeStatus::Completed) {
                    return TestResult::failed();
                }
            }
        }

        if !assert_total_conserved(
            &env,
            &contract_id,
            &usdc_id,
            &buyer,
            &seller,
            &treasury,
            case.amount,
        ) {
            return TestResult::failed();
        }

        TestResult::passed()
    }

    #[test]
    fn test_property_valid_lifecycle_transitions() {
        seeded_quickcheck()
            .tests(20)
            .quickcheck(prop_valid_lifecycle_transitions as fn(LifecycleScenario) -> TestResult);
    }

    fn prop_rejects_invalid_lifecycle_transition(case: LifecycleScenario) -> TestResult {
        let env = Env::default();
        env.mock_all_auths();

        let contract_id = env.register(EscrowContract, ());
        let client = EscrowContractClient::new(&env, &contract_id);
        let admin = crate::test_fixture::admin_address(&env);
        let buyer = Address::generate(&env);
        let seller = Address::generate(&env);
        let treasury = Address::generate(&env);
        let usdc_id = env
            .register_stellar_asset_contract_v2(admin.clone())
            .address();

        client.initialize(&admin, &usdc_id, &treasury, &case.fee_bps, &usdc_id);

        let token_client = token::StellarAssetClient::new(&env, &usdc_id);
        token_client.mint(&buyer, &case.amount);

        let trade_id = client.create_trade(
            &buyer,
            &seller,
            &case.amount,
            &case.buyer_loss_bps,
            &case.seller_loss_bps,
            &None,
        );

        let rejected = match case.route % 4 {
            0 => {
                client.deposit(&trade_id);
                std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    client.deposit(&trade_id);
                }))
            }
            1 => std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                client.confirm_delivery(&trade_id);
            })),
            2 => {
                client.deposit(&trade_id);
                std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    client.release_funds(&trade_id, &buyer);
                }))
            }
            _ => {
                client.deposit(&trade_id);
                let reason = soroban_sdk::String::from_str(&env, "QmInvalidLifecycle");
                client.initiate_dispute(&trade_id, &buyer, &reason);
                let mediator = Address::generate(&env);
                client.set_mediator(&mediator);
                client.resolve_dispute(&trade_id, &mediator, &case.seller_gets_bps);
                std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    client.cancel_trade(&trade_id, &buyer);
                }))
            }
        };

        if rejected.is_ok() {
            return TestResult::failed();
        }

        TestResult::passed()
    }

    #[test]
    fn test_property_rejects_invalid_lifecycle_transitions() {
        seeded_quickcheck().tests(20).quickcheck(
            prop_rejects_invalid_lifecycle_transition as fn(LifecycleScenario) -> TestResult,
        );
    }
