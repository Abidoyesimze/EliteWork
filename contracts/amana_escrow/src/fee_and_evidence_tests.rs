    use super::*;
    use soroban_sdk::testutils::{Address as _, Ledger as _};
    use soroban_sdk::{Address, Env, String, token};

    // =======================================================================
    // Issue #221: Fee calculations and rounding edge cases
    // =======================================================================

    /// Helper: set up a funded trade with configurable amount and fee_bps.
    fn setup_fee_trade(
        env: &Env,
        amount: i128,
        fee_bps: u32,
    ) -> (Address, Address, Address, Address, Address, u64) {
        let contract_id = env.register(EscrowContract, ());
        let client = EscrowContractClient::new(env, &contract_id);
        let admin = crate::test_fixture::admin_address(env);
        let buyer = Address::generate(env);
        let seller = Address::generate(env);
        let treasury = Address::generate(env);
        let usdc_id = env
            .register_stellar_asset_contract_v2(admin.clone())
            .address();
        client.initialize(&admin, &usdc_id, &treasury, &fee_bps, &usdc_id);
        let token_client = token::StellarAssetClient::new(env, &usdc_id);
        token_client.mint(&buyer, &amount);
        let trade_id = client.create_trade(&buyer, &seller, &amount, &5000_u32, &5000_u32, &None);
        client.deposit(&trade_id);
        (contract_id, buyer, seller, treasury, usdc_id, trade_id)
    }

    /// 1% fee on 100 stroops → seller gets 99, treasury gets 1.
    #[test]
    fn test_fee_100_stroops_1pct() {
        let env = Env::default();
        env.mock_all_auths();
        let (contract_id, buyer, seller, treasury, usdc_id, trade_id) =
            setup_fee_trade(&env, 100, 100);
        let client = EscrowContractClient::new(&env, &contract_id);
        client.confirm_delivery(&trade_id);
        client.release_funds(&trade_id, &buyer);
        let tok = token::Client::new(&env, &usdc_id);
        assert_eq!(tok.balance(&seller), 99);
        assert_eq!(client.get_accrued_fees(), 1);
        assert_eq!(tok.balance(&client.address), 1, "escrow holds accrued fees");
    }

    /// 1% fee on 1000 stroops → seller 990, treasury 10.
    #[test]
    fn test_fee_1000_stroops_1pct() {
        let env = Env::default();
        env.mock_all_auths();
        let (contract_id, buyer, seller, treasury, usdc_id, trade_id) =
            setup_fee_trade(&env, 1_000, 100);
        let client = EscrowContractClient::new(&env, &contract_id);
        client.confirm_delivery(&trade_id);
        client.release_funds(&trade_id, &buyer);
        let tok = token::Client::new(&env, &usdc_id);
        assert_eq!(tok.balance(&seller), 990);
        assert_eq!(client.get_accrued_fees(), 10);
        assert_eq!(tok.balance(&client.address), 10, "escrow holds accrued fees");
    }

    /// 1% fee on 1_000_000 stroops → seller 990_000, treasury 10_000.
    #[test]
    fn test_fee_1m_stroops_1pct() {
        let env = Env::default();
        env.mock_all_auths();
        let (contract_id, buyer, seller, treasury, usdc_id, trade_id) =
            setup_fee_trade(&env, 1_000_000, 100);
        let client = EscrowContractClient::new(&env, &contract_id);
        client.confirm_delivery(&trade_id);
        client.release_funds(&trade_id, &buyer);
        let tok = token::Client::new(&env, &usdc_id);
        assert_eq!(tok.balance(&seller), 990_000);
        assert_eq!(client.get_accrued_fees(), 10_000);
        assert_eq!(tok.balance(&client.address), 10_000, "escrow holds accrued fees");
    }

    /// Zero fee (fee_bps = 0) → seller gets full amount.
    #[test]
    fn test_fee_zero_bps_seller_gets_all() {
        let env = Env::default();
        env.mock_all_auths();
        let (contract_id, buyer, seller, treasury, usdc_id, trade_id) =
            setup_fee_trade(&env, 10_000, 0);
        let client = EscrowContractClient::new(&env, &contract_id);
        client.confirm_delivery(&trade_id);
        client.release_funds(&trade_id, &buyer);
        let tok = token::Client::new(&env, &usdc_id);
        assert_eq!(tok.balance(&seller), 10_000);
        assert_eq!(client.get_accrued_fees(), 0);
        assert_eq!(tok.balance(&client.address), 0, "escrow holds accrued fees");
    }

    /// Minimum amount: 1 stroop with 1% fee → fee rounds to 0, seller gets 1.
    #[test]
    fn test_fee_1_stroop_rounds_to_zero() {
        let env = Env::default();
        env.mock_all_auths();
        let (contract_id, buyer, seller, treasury, usdc_id, trade_id) =
            setup_fee_trade(&env, 1, 100);
        let client = EscrowContractClient::new(&env, &contract_id);
        client.confirm_delivery(&trade_id);
        client.release_funds(&trade_id, &buyer);
        let tok = token::Client::new(&env, &usdc_id);
        assert_eq!(tok.balance(&seller), 1);
        assert_eq!(client.get_accrued_fees(), 0);
        assert_eq!(tok.balance(&client.address), 0, "escrow holds accrued fees");
    }

    /// Fund conservation: seller + treasury = total for any valid amount.
    #[test]
    fn test_fee_fund_conservation_various_amounts() {
        let amounts: &[i128] = &[1, 7, 99, 100, 101, 999, 1_000, 9_999, 10_000, 100_001];
        for &amount in amounts {
            let env = Env::default();
            env.mock_all_auths();
            let (contract_id, buyer, seller, treasury, usdc_id, trade_id) =
                setup_fee_trade(&env, amount, 100);
            let client = EscrowContractClient::new(&env, &contract_id);
            client.confirm_delivery(&trade_id);
            client.release_funds(&trade_id, &buyer);
            let tok = token::Client::new(&env, &usdc_id);
            let total = tok.balance(&seller) + client.get_accrued_fees();
            assert_eq!(
                total, amount,
                "fund conservation failed for amount={amount}"
            );
            assert_eq!(
                tok.balance(&client.address),
                client.get_accrued_fees(),
                "escrow should hold fees for amount={amount}"
            );
        }
    }

    /// Fee never exceeds original amount (100 → fee ≤ 100).
    #[test]
    fn test_fee_never_exceeds_original_amount() {
        let env = Env::default();
        env.mock_all_auths();
        // Use max fee_bps = 10000 (100%)
        let (contract_id, buyer, _seller, treasury, usdc_id, trade_id) =
            setup_fee_trade(&env, 100, 10_000);
        let client = EscrowContractClient::new(&env, &contract_id);
        client.confirm_delivery(&trade_id);
        client.release_funds(&trade_id, &buyer);
        let tok = token::Client::new(&env, &usdc_id);
        let fee = client.get_accrued_fees();
        assert!(fee <= 100, "fee {fee} must not exceed original amount 100");
        assert_eq!(tok.balance(&client.address), fee, "escrow holds accrued fees");
    }

    /// Rounding always floors (never overpays): 99 stroops at 1% → fee = 0.
    #[test]
    fn test_fee_rounding_floors_not_ceiling() {
        let env = Env::default();
        env.mock_all_auths();
        let (contract_id, buyer, seller, treasury, usdc_id, trade_id) =
            setup_fee_trade(&env, 99, 100);
        let client = EscrowContractClient::new(&env, &contract_id);
        client.confirm_delivery(&trade_id);
        client.release_funds(&trade_id, &buyer);
        let tok = token::Client::new(&env, &usdc_id);
        // 99 * 100 / 10_000 = 0.99 → floors to 0
        assert_eq!(tok.balance(&treasury), 0);
        assert_eq!(tok.balance(&seller), 99);
    }

    #[test]
    fn test_release_fee_bps_boundaries_at_max_safe_amount() {
        // Cap at MAX_TRADE_VALUE; overflow safety is still covered relative to BPS math.
        let max_safe_amount = core::cmp::min(i128::MAX / BPS_DIVISOR, MAX_TRADE_VALUE);
        let fee_bps_cases = [0_u32, 1, 9_999, 10_000];

        for fee_bps in fee_bps_cases {
            let env = Env::default();
            env.mock_all_auths();
            let (contract_id, buyer, seller, _treasury, usdc_id, trade_id) =
                setup_fee_trade(&env, max_safe_amount, fee_bps);
            let client = EscrowContractClient::new(&env, &contract_id);

            client.confirm_delivery(&trade_id);
            client.release_funds(&trade_id, &buyer);

            let tok = token::Client::new(&env, &usdc_id);
            let expected_fee = (max_safe_amount * fee_bps as i128) / BPS_DIVISOR;
            let expected_seller = max_safe_amount - expected_fee;
            assert_eq!(tok.balance(&seller), expected_seller);
            assert_eq!(client.get_accrued_fees(), expected_fee);
            assert_eq!(
                tok.balance(&seller) + client.get_accrued_fees(),
                max_safe_amount
            );
            assert_eq!(tok.balance(&client.address), expected_fee);
        }
    }

    #[test]
    #[should_panic(expected = "TradeValueTooLarge")]
    fn test_release_fee_panics_above_max_safe_amount() {
        let env = Env::default();
        env.mock_all_auths();
        // Amounts above MAX_TRADE_VALUE are rejected at create_trade.
        let overflowing_amount = MAX_TRADE_VALUE + 1;
        let (_contract_id, _buyer, _seller, _treasury, _usdc_id, _trade_id) =
            setup_fee_trade(&env, overflowing_amount, 10_000);
    }

    #[test]
    fn test_dispute_payout_bps_boundaries_at_max_safe_amount() {
        let max_safe_amount = core::cmp::min(
            i128::MAX / (BPS_DIVISOR * BPS_DIVISOR),
            MAX_TRADE_VALUE,
        );
        let fee_bps_cases = [0_u32, 1, 9_999, 10_000];
        let seller_gets_bps_cases = [0_u32, 1, 9_999, 10_000];

        for fee_bps in fee_bps_cases {
            for seller_gets_bps in seller_gets_bps_cases {
                let env = Env::default();
                env.mock_all_auths();
                let (contract_id, buyer, seller, _treasury, usdc_id, trade_id) =
                    setup_fee_trade(&env, max_safe_amount, fee_bps);
                let client = EscrowContractClient::new(&env, &contract_id);
                let reason = String::from_str(&env, "QmBoundaryPayout");
                let mediator = Address::generate(&env);

                client.initiate_dispute(&trade_id, &buyer, &reason);
                client.set_mediator(&mediator);
                client.resolve_dispute(&trade_id, &mediator, &seller_gets_bps);

                let tok = token::Client::new(&env, &usdc_id);
                let loss_bps = BPS_DIVISOR - seller_gets_bps as i128;
                let seller_loss =
                    (max_safe_amount * loss_bps * 5_000_i128) / (BPS_DIVISOR * BPS_DIVISOR);
                let seller_raw = max_safe_amount - seller_loss;
                let buyer_refund = max_safe_amount - seller_raw;
                let expected_fee = (seller_raw * fee_bps as i128) / BPS_DIVISOR;
                let expected_seller = seller_raw - expected_fee;

                assert_eq!(tok.balance(&seller), expected_seller);
                assert_eq!(tok.balance(&buyer), buyer_refund);
                assert_eq!(client.get_accrued_fees(), expected_fee);
                assert_eq!(
                    tok.balance(&seller) + tok.balance(&buyer) + client.get_accrued_fees(),
                    max_safe_amount
                );
                assert_eq!(tok.balance(&client.address), expected_fee);
            }
        }
    }

    #[test]
    #[should_panic]
    fn test_dispute_payout_panics_above_max_safe_amount() {
        let env = Env::default();
        env.mock_all_auths();
        let overflowing_amount = (i128::MAX / (BPS_DIVISOR * BPS_DIVISOR)) + 1;

        let contract_id = env.register(EscrowContract, ());
        let client = EscrowContractClient::new(&env, &contract_id);
        let admin = crate::test_fixture::admin_address(&env);
        let buyer = Address::generate(&env);
        let seller = Address::generate(&env);
        let treasury = Address::generate(&env);
        let usdc_id = env
            .register_stellar_asset_contract_v2(admin.clone())
            .address();

        client.initialize(&admin, &usdc_id, &treasury, &10_000, &usdc_id);
        let token_client = token::StellarAssetClient::new(&env, &usdc_id);
        token_client.mint(&buyer, &overflowing_amount);
        let trade_id = client.create_trade(
            &buyer,
            &seller,
            &overflowing_amount,
            &0_u32,
            &10_000_u32,
            &None,
        );
        client.deposit(&trade_id);

        let reason = String::from_str(&env, "QmOverflowPayout");
        let mediator = Address::generate(&env);

        client.initiate_dispute(&trade_id, &buyer, &reason);
        client.set_mediator(&mediator);
        client.resolve_dispute(&trade_id, &mediator, &0_u32);
    }

    /// Loss ratio 3000/7000 with 50% seller ruling: verify exact math.
    #[test]
    fn test_loss_ratio_3000_7000_50pct_ruling() {
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
        let amount = 10_000_i128;
        let tok_client = token::StellarAssetClient::new(&env, &usdc_id);
        tok_client.mint(&buyer, &amount);
        // buyer_loss_bps=3000, seller_loss_bps=7000
        let trade_id = client.create_trade(&buyer, &seller, &amount, &3000_u32, &7000_u32, &None);
        client.deposit(&trade_id);
        let reason = String::from_str(&env, "QmFeeTest3070");
        client.initiate_dispute(&trade_id, &buyer, &reason);
        let mediator = Address::generate(&env);
        client.set_mediator(&mediator);
        // Mediator rules 50% for seller → loss_bps = 5000
        // seller_loss = 10_000 * 5000 * 7000 / 100_000_000 = 3_500
        // seller_raw  = 10_000 - 3_500 = 6_500
        // fee         = 6_500 * 100 / 10_000 = 65
        // seller_net  = 6_500 - 65 = 6_435
        // buyer_refund = 3_500
        client.resolve_dispute(&trade_id, &mediator, &5_000_u32);
        let tok = token::Client::new(&env, &usdc_id);
        assert_eq!(tok.balance(&seller), 6_435);
        assert_eq!(tok.balance(&buyer), 3_500);
        assert_eq!(client.get_accrued_fees(), 65);
        assert_eq!(tok.balance(&client.address), 65, "escrow holds accrued fees");
        assert_eq!(6_435 + 3_500 + 65, 10_000);
    }

    /// Loss ratio 9999/1 (extreme asymmetry): verify no overflow.
    #[test]
    fn test_loss_ratio_9999_1_no_overflow() {
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
        let amount = 10_000_i128;
        let tok_client = token::StellarAssetClient::new(&env, &usdc_id);
        tok_client.mint(&buyer, &amount);
        let trade_id = client.create_trade(&buyer, &seller, &amount, &9999_u32, &1_u32, &None);
        client.deposit(&trade_id);
        let reason = String::from_str(&env, "QmExtreme9999");
        client.initiate_dispute(&trade_id, &buyer, &reason);
        let mediator = Address::generate(&env);
        client.set_mediator(&mediator);
        client.resolve_dispute(&trade_id, &mediator, &5_000_u32);
        let tok = token::Client::new(&env, &usdc_id);
        let total = tok.balance(&seller) + tok.balance(&buyer) + client.get_accrued_fees();
        assert_eq!(total, amount, "fund conservation with 9999/1 ratio");
        assert_eq!(
            tok.balance(&client.address),
            client.get_accrued_fees(),
            "escrow holds accrued fees"
        );
    }

    /// Full seller payout (seller_gets_bps = 10000): fee deducted from full amount.
    #[test]
    fn test_fee_full_seller_payout_dispute() {
        let env = Env::default();
        env.mock_all_auths();
        let (contract_id, buyer, seller, treasury, usdc_id, trade_id) =
            setup_fee_trade(&env, 10_000, 100);
        let client = EscrowContractClient::new(&env, &contract_id);
        let reason = String::from_str(&env, "QmFullSellerFee");
        client.initiate_dispute(&trade_id, &buyer, &reason);
        let mediator = Address::generate(&env);
        client.set_mediator(&mediator);
        // seller_gets_bps = 10_000 → no loss
        // seller_raw = 10_000, fee = 100, seller_net = 9_900, buyer_refund = 0
        client.resolve_dispute(&trade_id, &mediator, &10_000_u32);
        let tok = token::Client::new(&env, &usdc_id);
        assert_eq!(tok.balance(&seller), 9_900);
        assert_eq!(tok.balance(&buyer), 0);
        assert_eq!(client.get_accrued_fees(), 100);
        assert_eq!(tok.balance(&client.address), 100, "escrow holds accrued fees");
    }

    /// Full buyer refund scenario (seller_gets_bps = 0): with 50/50 loss ratio,
    /// seller bears 50% of the 100% loss, so buyer gets 50% back.
    /// seller_loss = 10_000 * 10_000 * 5_000 / 100_000_000 = 5_000
    /// seller_raw  = 10_000 - 5_000 = 5_000
    /// fee         = 5_000 * 100 / 10_000 = 50
    /// seller_net  = 5_000 - 50 = 4_950
    /// buyer_refund = 5_000
    #[test]
    fn test_fee_full_buyer_refund_dispute() {
        let env = Env::default();
        env.mock_all_auths();
        let (contract_id, buyer, seller, treasury, usdc_id, trade_id) =
            setup_fee_trade(&env, 10_000, 100);
        let client = EscrowContractClient::new(&env, &contract_id);
        let reason = String::from_str(&env, "QmFullBuyerFee");
        client.initiate_dispute(&trade_id, &buyer, &reason);
        let mediator = Address::generate(&env);
        client.set_mediator(&mediator);
        // seller_gets_bps = 0 → loss_bps = 10_000 (100% loss)
        // With 50/50 split: seller_loss = 10_000 * 10_000 * 5_000 / 100_000_000 = 5_000
        // seller_raw = 5_000, fee = 50, seller_net = 4_950, buyer_refund = 5_000
        client.resolve_dispute(&trade_id, &mediator, &0_u32);
        let tok = token::Client::new(&env, &usdc_id);
        assert_eq!(tok.balance(&buyer), 5_000);
        assert_eq!(tok.balance(&seller), 4_950);
        assert_eq!(client.get_accrued_fees(), 50);
        assert_eq!(tok.balance(&client.address), 50, "escrow holds accrued fees");
        // Fund conservation
        assert_eq!(5_000 + 4_950 + 50, 10_000);
    }

    // =======================================================================
    // Issue #224: Evidence ordering, hash immutability, video proof constraints
    // =======================================================================

    /// Helper: create a funded + disputed trade for evidence tests.
    fn setup_disputed(
        env: &Env,
        amount: i128,
        fee_bps: u32,
    ) -> (Address, Address, Address, Address, Address, Address, u64) {
        let contract_id = env.register(EscrowContract, ());
        let client = EscrowContractClient::new(env, &contract_id);
        let admin = crate::test_fixture::admin_address(env);
        let buyer = Address::generate(env);
        let seller = Address::generate(env);
        let treasury = Address::generate(env);
        let mediator = Address::generate(env);
        let usdc_id = env
            .register_stellar_asset_contract_v2(admin.clone())
            .address();
        client.initialize(&admin, &usdc_id, &treasury, &fee_bps, &usdc_id);
        client.add_mediator(&mediator);
        let tok = token::StellarAssetClient::new(env, &usdc_id);
        tok.mint(&buyer, &amount);
        let trade_id = client.create_trade(&buyer, &seller, &amount, &5000_u32, &5000_u32, &None);
        client.deposit(&trade_id);
        env.ledger().with_mut(|l| l.timestamp = 1_000);
        let reason = String::from_str(env, "QmDisputeReason");
        client.initiate_dispute(&trade_id, &buyer, &reason);
        (
            contract_id,
            buyer,
            seller,
            treasury,
            mediator,
            usdc_id,
            trade_id,
        )
    }

    /// Submit 5 pieces of evidence and verify FIFO order is preserved.
    #[test]
    fn test_evidence_fifo_order_5_submissions() {
        let env = Env::default();
        env.mock_all_auths();
        let (contract_id, buyer, _seller, _treasury, _mediator, usdc_id, trade_id) =
            setup_disputed(&env, 10_000, 100);
        let client = EscrowContractClient::new(&env, &contract_id);
        let _ = usdc_id;

        let hashes = [
            "QmEvidence1",
            "QmEvidence2",
            "QmEvidence3",
            "QmEvidence4",
            "QmEvidence5",
        ];
        for (i, h) in hashes.iter().enumerate() {
            env.ledger()
                .with_mut(|l| l.timestamp = 2_000 + i as u64 * 100);
            let ipfs = String::from_str(&env, h);
            let desc = String::from_str(&env, "desc");
            client.submit_evidence(&trade_id, &buyer, &ipfs, &desc);
        }

        let list = client.get_evidence_list(&trade_id);
        assert_eq!(list.len(), 5, "must have exactly 5 evidence records");

        for (i, h) in hashes.iter().enumerate() {
            let expected = String::from_str(&env, h);
            assert_eq!(
                list.get(i as u32).unwrap().ipfs_hash,
                expected,
                "evidence at index {i} must be {h} (FIFO order)"
            );
        }
    }

    /// Evidence list is never shuffled — order matches submission order.
    #[test]
    fn test_evidence_order_matches_submission_order_mixed_parties() {
        let env = Env::default();
        env.mock_all_auths();
        let (contract_id, buyer, seller, _treasury, mediator, _usdc_id, trade_id) =
            setup_disputed(&env, 10_000, 100);
        let client = EscrowContractClient::new(&env, &contract_id);

        let submissions: [(&Address, &str); 4] = [
            (&buyer, "QmBuyer-A"),
            (&seller, "QmSeller-B"),
            (&buyer, "QmBuyer-C"),
            (&mediator, "QmMediator-D"),
        ];

        for (i, (party, hash)) in submissions.iter().enumerate() {
            env.ledger()
                .with_mut(|l| l.timestamp = 2_000 + i as u64 * 100);
            let ipfs = String::from_str(&env, hash);
            let desc = String::from_str(&env, "desc");
            client.submit_evidence(&trade_id, party, &ipfs, &desc);
        }

        let list = client.get_evidence_list(&trade_id);
        assert_eq!(list.len(), 4);

        for (i, (party, hash)) in submissions.iter().enumerate() {
            let record = list.get(i as u32).unwrap();
            let expected_hash = String::from_str(&env, hash);
            assert_eq!(record.ipfs_hash, expected_hash, "wrong hash at index {i}");
            assert_eq!(&record.submitter, *party, "wrong submitter at index {i}");
        }
    }

    /// Evidence hash immutability: stored ipfs_hash cannot be changed after submission.
    #[test]
    fn test_evidence_hash_immutable_after_submission() {
        let env = Env::default();
        env.mock_all_auths();
        let (contract_id, buyer, _seller, _treasury, _mediator, _usdc_id, trade_id) =
            setup_disputed(&env, 10_000, 100);
        let client = EscrowContractClient::new(&env, &contract_id);

        let original_hash = String::from_str(&env, "QmOriginalHash");
        let desc = String::from_str(&env, "desc");
        client.submit_evidence(&trade_id, &buyer, &original_hash, &desc);

        let new_hash = String::from_str(&env, "QmAttemptedOverwrite");
        client.submit_evidence(&trade_id, &buyer, &new_hash, &desc);

        let list = client.get_evidence_list(&trade_id);
        assert_eq!(list.len(), 2, "should have 2 records, not 1 overwritten");
        assert_eq!(
            list.get(0).unwrap().ipfs_hash,
            original_hash,
            "first hash must be immutable"
        );
        assert_eq!(
            list.get(1).unwrap().ipfs_hash,
            new_hash,
            "second record has new hash"
        );
    }

    /// Video proof: first submission accepted, second attempt panics.
    #[test]
    #[should_panic(expected = "Video proof already submitted for this trade")]
    fn test_video_proof_second_submission_rejected() {
        let env = Env::default();
        env.mock_all_auths();
        let (contract_id, buyer, seller, _treasury, _mediator, _usdc_id, trade_id) =
            setup_disputed(&env, 10_000, 100);
        let client = EscrowContractClient::new(&env, &contract_id);

        let cid1 = String::from_str(&env, "QmFirstVideoCID");
        client.submit_video_proof(&trade_id, &buyer, &cid1);

        let cid2 = String::from_str(&env, "QmSecondVideoCID");
        client.submit_video_proof(&trade_id, &seller, &cid2);
    }

    /// Video proof immutability: once submitted, get_video_proof always returns original.
    #[test]
    fn test_video_proof_immutable_after_submission() {
        let env = Env::default();
        env.mock_all_auths();
        let (contract_id, buyer, _seller, _treasury, _mediator, _usdc_id, trade_id) =
            setup_disputed(&env, 10_000, 100);
        let client = EscrowContractClient::new(&env, &contract_id);

        let cid = String::from_str(&env, "QmImmutableVideoCID");
        client.submit_video_proof(&trade_id, &buyer, &cid);

        let proof = client.get_video_proof(&trade_id).expect("proof must exist");
        assert_eq!(proof.ipfs_cid, cid, "CID must be immutable");
        assert_eq!(proof.submitter, buyer, "submitter must be immutable");
    }

    /// Video proof: seller can also submit (not just buyer).
    #[test]
    fn test_video_proof_seller_can_submit() {
        let env = Env::default();
        env.mock_all_auths();
        let (contract_id, _buyer, seller, _treasury, _mediator, _usdc_id, trade_id) =
            setup_disputed(&env, 10_000, 100);
        let client = EscrowContractClient::new(&env, &contract_id);

        let cid = String::from_str(&env, "QmSellerVideoCID");
        client.submit_video_proof(&trade_id, &seller, &cid);

        let proof = client.get_video_proof(&trade_id).expect("proof must exist");
        assert_eq!(proof.submitter, seller);
        assert_eq!(proof.ipfs_cid, cid);
    }

    /// Video proof: stranger cannot submit.
    #[test]
    #[should_panic(expected = "Only the buyer or seller can submit video proof")]
    fn test_video_proof_stranger_rejected() {
        let env = Env::default();
        env.mock_all_auths();
        let (contract_id, _buyer, _seller, _treasury, _mediator, _usdc_id, trade_id) =
            setup_disputed(&env, 10_000, 100);
        let client = EscrowContractClient::new(&env, &contract_id);

        let stranger = Address::generate(&env);
        let cid = String::from_str(&env, "QmStrangerCID");
        client.submit_video_proof(&trade_id, &stranger, &cid);
    }

    /// Video proof: empty CID is rejected.
    #[test]
    #[should_panic(expected = "ipfs_cid must not be empty")]
    fn test_video_proof_empty_cid_rejected() {
        let env = Env::default();
        env.mock_all_auths();
        let (contract_id, buyer, _seller, _treasury, _mediator, _usdc_id, trade_id) =
            setup_disputed(&env, 10_000, 100);
        let client = EscrowContractClient::new(&env, &contract_id);

        let empty_cid = String::from_str(&env, "");
        client.submit_video_proof(&trade_id, &buyer, &empty_cid);
    }

    /// Evidence access control: stranger cannot submit evidence.
    #[test]
    #[should_panic(expected = "Only buyer, seller, or mediator can submit evidence")]
    fn test_evidence_stranger_cannot_submit() {
        let env = Env::default();
        env.mock_all_auths();
        let (contract_id, _buyer, _seller, _treasury, _mediator, _usdc_id, trade_id) =
            setup_disputed(&env, 10_000, 100);
        let client = EscrowContractClient::new(&env, &contract_id);

        let stranger = Address::generate(&env);
        let ipfs = String::from_str(&env, "QmStrangerEvidence");
        let desc = String::from_str(&env, "desc");
        client.submit_evidence(&trade_id, &stranger, &ipfs, &desc);
    }

    /// Evidence: mediator (via add_mediator) can submit evidence.
    #[test]
    fn test_evidence_registered_mediator_can_submit() {
        let env = Env::default();
        env.mock_all_auths();
        let (contract_id, _buyer, _seller, _treasury, mediator, _usdc_id, trade_id) =
            setup_disputed(&env, 10_000, 100);
        let client = EscrowContractClient::new(&env, &contract_id);

        let ipfs = String::from_str(&env, "QmMediatorEvidence");
        let desc = String::from_str(&env, "mediator analysis");
        client.submit_evidence(&trade_id, &mediator, &ipfs, &desc);

        let list = client.get_evidence_list(&trade_id);
        assert_eq!(list.len(), 1);
        assert_eq!(list.get(0).unwrap().submitter, mediator);
    }

    /// Evidence: timestamps are recorded in ascending order.
    #[test]
    fn test_evidence_timestamps_ascending() {
        let env = Env::default();
        env.mock_all_auths();
        let (contract_id, buyer, _seller, _treasury, _mediator, _usdc_id, trade_id) =
            setup_disputed(&env, 10_000, 100);
        let client = EscrowContractClient::new(&env, &contract_id);

        let timestamps = [2_000u64, 3_000, 4_000];
        let hashes = ["QmTs0", "QmTs1", "QmTs2"];
        for (i, &ts) in timestamps.iter().enumerate() {
            env.ledger().with_mut(|l| l.timestamp = ts);
            let ipfs = String::from_str(&env, hashes[i]);
            let desc = String::from_str(&env, "desc");
            client.submit_evidence(&trade_id, &buyer, &ipfs, &desc);
        }

        let list = client.get_evidence_list(&trade_id);
        for i in 0..list.len() - 1 {
            let a = list.get(i).unwrap().submitted_at;
            let b = list.get(i + 1).unwrap().submitted_at;
            assert!(a <= b, "timestamps must be non-decreasing");
        }
    }

    /// Evidence list remains accessible and unchanged after dispute resolution.
    #[test]
    fn test_evidence_preserved_after_resolution() {
        let env = Env::default();
        env.mock_all_auths();
        let (contract_id, buyer, _seller, _treasury, mediator, _usdc_id, trade_id) =
            setup_disputed(&env, 10_000, 100);
        let client = EscrowContractClient::new(&env, &contract_id);

        let ipfs = String::from_str(&env, "QmPreservedEvidence");
        let desc = String::from_str(&env, "desc");
        client.submit_evidence(&trade_id, &buyer, &ipfs, &desc);

        client.resolve_dispute(&trade_id, &mediator, &10_000_u32);

        let list = client.get_evidence_list(&trade_id);
        assert_eq!(list.len(), 1, "evidence must be preserved after resolution");
        assert_eq!(list.get(0).unwrap().ipfs_hash, ipfs);
    }

    /// Dispute resolution with zero fee: seller_net > 0, fee == 0, buyer_refund > 0.
    /// Verifies the zero-fee transfer branch is skipped without panicking.
    #[test]
    fn test_dispute_resolution_zero_fee_skip() {
        let env = Env::default();
        env.mock_all_auths();
        let (contract_id, buyer, seller, treasury, usdc_id, trade_id) =
            setup_fee_trade(&env, 10_000, 0);
        let client = EscrowContractClient::new(&env, &contract_id);
        let reason = String::from_str(&env, "QmZeroFee");
        client.initiate_dispute(&trade_id, &buyer, &reason);
        let mediator = Address::generate(&env);
        client.set_mediator(&mediator);
        // seller_gets_bps = 10_000 → no loss
        // seller_raw = 10_000, fee = 0 (fee_bps=0), seller_net = 10_000, buyer_refund = 0
        client.resolve_dispute(&trade_id, &mediator, &10_000_u32);
        let tok = token::Client::new(&env, &usdc_id);
        assert_eq!(tok.balance(&seller), 10_000);
        assert_eq!(tok.balance(&treasury), 0, "fee must be zero");
        assert_eq!(tok.balance(&buyer), 0);
        assert_eq!(tok.balance(&client.address), 0);
        #[allow(clippy::identity_op)]
        {
            assert_eq!(10_000 + 0 + 0, 10_000, "conservation invariant");
        }
    }

    /// Dispute resolution where seller gets zero (seller_net == 0):
    /// buyer_loss_bps = 0, seller_loss_bps = 10000, seller_gets_bps = 0, fee_bps = 0.
    /// seller_loss = 10_000, seller_raw = 0, fee = 0, seller_net = 0, buyer_refund = 10_000.
    #[test]
    fn test_dispute_resolution_zero_seller_net_skip() {
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
        // fee_bps = 0 so fee is also zero
        client.initialize(&admin, &usdc_id, &treasury, &0, &usdc_id);
        let amount = 10_000_i128;
        let token_client = token::StellarAssetClient::new(&env, &usdc_id);
        token_client.mint(&buyer, &amount);
        // seller bears 100% loss (buyer_loss_bps=0, seller_loss_bps=10000)
        let trade_id = client.create_trade(&buyer, &seller, &amount, &0_u32, &10000_u32, &None);
        client.deposit(&trade_id);
        let reason = String::from_str(&env, "QmZeroSellerNet");
        client.initiate_dispute(&trade_id, &seller, &reason);
        let mediator = Address::generate(&env);
        client.set_mediator(&mediator);
        // seller_gets_bps = 0 → loss_bps = 10_000 (100% loss)
        // seller_loss = 10_000 * 10_000 * 10_000 / 100_000_000 = 10_000
        // seller_raw = 10_000 - 10_000 = 0
        // fee = 0 * 0 / 10_000 = 0
        // seller_net = 0, buyer_refund = 10_000
        client.resolve_dispute(&trade_id, &mediator, &0_u32);
        let tok = token::Client::new(&env, &usdc_id);
        assert_eq!(tok.balance(&seller), 0, "seller net must be zero");
        assert_eq!(tok.balance(&treasury), 0, "fee must be zero");
        assert_eq!(tok.balance(&buyer), 10_000, "buyer gets full refund");
        assert_eq!(tok.balance(&client.address), 0);
        #[allow(clippy::identity_op)]
        {
            assert_eq!(0 + 0 + 10_000, 10_000, "conservation invariant");
        }
    }
