    use super::*;
    use soroban_sdk::testutils::{Address as _, Deployer as _, Ledger as _};
    use soroban_sdk::{Address, Env, token};

    // -----------------------------------------------------------------------
    // Helpers
    // -----------------------------------------------------------------------

    fn mock_reason(env: &Env, reason: &str) -> String {
        String::from_str(env, reason)
    }

    fn setup_funded_trade(
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

        (contract_id, usdc_id, buyer, seller, treasury, trade_id)
    }

    fn setup_disputed_trade(
        env: &Env,
        amount: i128,
        fee_bps: u32,
    ) -> (Address, Address, Address, Address, Address, u64) {
        let (contract_id, usdc_id, buyer, seller, treasury, trade_id) =
            setup_funded_trade(env, amount, fee_bps);
        let client = EscrowContractClient::new(env, &contract_id);
        let reason = mock_reason(env, "QmSetupDisputeReason");
        client.initiate_dispute(&trade_id, &buyer, &reason);
        (contract_id, usdc_id, buyer, seller, treasury, trade_id)
    }

    // -----------------------------------------------------------------------
    // Existing tests
    // -----------------------------------------------------------------------

    #[test]
    fn test_deposit_succeeds_and_transitions_to_funded() {
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

        let amount = 1000_i128;
        let token_client = token::StellarAssetClient::new(&env, &usdc_id);
        token_client.mint(&buyer, &amount);

        let trade_id = client.create_trade(&buyer, &seller, &amount, &5000_u32, &5000_u32, &None);

        env.ledger().with_mut(|li| li.timestamp = 1000);
        client.deposit(&trade_id);

        let trade = client.get_trade(&trade_id);
        assert!(matches!(trade.status, TradeStatus::Funded));
        assert_eq!(trade.funded_at, Some(1000));

        let token_readonly = token::Client::new(&env, &usdc_id);
        assert_eq!(token_readonly.balance(&client.address), amount);
        assert_eq!(token_readonly.balance(&buyer), 0);
    }

    #[test]
    #[should_panic]
    fn test_deposit_fails_if_caller_is_not_buyer() {
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

        let trade_id =
            client.create_trade(&buyer, &seller, &1000_i128, &5000_u32, &5000_u32, &None);
        client.mock_auths(&[]).deposit(&trade_id);
    }

    // -----------------------------------------------------------------------
    // confirm_delivery tests
    // -----------------------------------------------------------------------

    #[test]
    #[should_panic(expected = "Trade must be in Created status")]
    fn test_deposit_fails_if_trade_already_funded() {
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

        let amount = 1000_i128;
        let token_client = token::StellarAssetClient::new(&env, &usdc_id);
        token_client.mint(&buyer, &(amount * 2));

        let trade_id = client.create_trade(&buyer, &seller, &amount, &5000_u32, &5000_u32, &None);
        client.deposit(&trade_id);
        client.deposit(&trade_id);
    }

    #[test]
    fn test_cancel_before_funding_succeeds_for_either_party() {
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

        let trade_id_1 =
            client.create_trade(&buyer, &seller, &1000_i128, &5000_u32, &5000_u32, &None);
        client.cancel_trade(&trade_id_1, &buyer);
        assert!(matches!(
            client.get_trade(&trade_id_1).status,
            TradeStatus::Cancelled
        ));

        let trade_id_2 =
            client.create_trade(&buyer, &seller, &1000_i128, &5000_u32, &5000_u32, &None);
        client.cancel_trade(&trade_id_2, &seller);
        assert!(matches!(
            client.get_trade(&trade_id_2).status,
            TradeStatus::Cancelled
        ));
    }

    #[test]
    fn test_cancel_after_funding_requires_both_parties() {
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

        let amount = 1000_i128;
        let token_client = token::StellarAssetClient::new(&env, &usdc_id);
        token_client.mint(&buyer, &amount);

        let trade_id = client.create_trade(&buyer, &seller, &amount, &5000_u32, &5000_u32, &None);
        client.deposit(&trade_id);

        client.cancel_trade(&trade_id, &buyer);
        assert!(matches!(
            client.get_trade(&trade_id).status,
            TradeStatus::Funded
        ));

        client.cancel_trade(&trade_id, &seller);
        assert!(matches!(
            client.get_trade(&trade_id).status,
            TradeStatus::Cancelled
        ));
    }

    #[test]
    fn test_cancel_refunds_buyer_correctly() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register(EscrowContract, ());
        let client = EscrowContractClient::new(&env, &contract_id);
        let admin = crate::test_fixture::admin_address(&env);
        let buyer = Address::generate(&env);
        let seller = Address::generate(&env);
        let treasury = Address::generate(&env);
        let amount = 5000_i128;
        let usdc_id = env
            .register_stellar_asset_contract_v2(admin.clone())
            .address();
        client.initialize(&admin, &usdc_id, &treasury, &100, &usdc_id);

        let token_client = token::StellarAssetClient::new(&env, &usdc_id);
        token_client.mint(&buyer, &amount);

        let trade_id = client.create_trade(&buyer, &seller, &amount, &5000_u32, &5000_u32, &None);
        client.deposit(&trade_id);

        let token_readonly = token::Client::new(&env, &usdc_id);
        assert_eq!(token_readonly.balance(&client.address), amount);

        client.cancel_trade(&trade_id, &buyer);
        client.cancel_trade(&trade_id, &seller);

        assert_eq!(token_readonly.balance(&buyer), amount);
        assert_eq!(token_readonly.balance(&client.address), 0);
    }

    #[test]
    #[should_panic(expected = "Cannot cancel trade in current status")]
    fn test_cancel_fails_after_delivery_confirmed() {
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

        let amount = 1000_i128;
        let token_client = token::StellarAssetClient::new(&env, &usdc_id);
        token_client.mint(&buyer, &amount);

        let trade_id = client.create_trade(&buyer, &seller, &amount, &5000_u32, &5000_u32, &None);
        client.deposit(&trade_id);
        client.confirm_delivery(&trade_id);

        client.cancel_trade(&trade_id, &buyer);
    }

    #[test]
    fn test_seller_can_unilaterally_refund() {
        let env = Env::default();
        env.mock_all_auths();
        let amount = 5000_i128;
        let (contract_id, usdc_id, buyer, _seller, _treasury, trade_id) =
            setup_funded_trade(&env, amount, 100);
        let client = EscrowContractClient::new(&env, &contract_id);
        let token = token::Client::new(&env, &usdc_id);

        // Refund while Funded
        client.refund(&trade_id);

        assert_eq!(token.balance(&buyer), amount);
        assert_eq!(token.balance(&client.address), 0);
        assert!(matches!(
            client.get_trade(&trade_id).status,
            TradeStatus::Cancelled
        ));

        // Refund while Delivered
        let buyer_2 = Address::generate(&env);
        let seller_2 = Address::generate(&env);
        let token_client = token::StellarAssetClient::new(&env, &usdc_id);
        token_client.mint(&buyer_2, &amount);

        let trade_id_2 =
            client.create_trade(&buyer_2, &seller_2, &amount, &5000_u32, &5000_u32, &None);
        client.deposit(&trade_id_2);
        client.confirm_delivery(&trade_id_2);
        client.refund(&trade_id_2);

        assert_eq!(token.balance(&buyer_2), amount);
        assert!(matches!(
            client.get_trade(&trade_id_2).status,
            TradeStatus::Cancelled
        ));
    }

    #[test]
    fn test_release_funds_sends_correct_amounts() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register(EscrowContract, ());
        let client = EscrowContractClient::new(&env, &contract_id);
        let admin = crate::test_fixture::admin_address(&env);
        let buyer = Address::generate(&env);
        let seller = Address::generate(&env);
        let treasury = Address::generate(&env);
        let amount = 10_000_i128;
        let fee_bps = 100_u32; // 1%
        let usdc_id = env
            .register_stellar_asset_contract_v2(admin.clone())
            .address();
        client.initialize(&admin, &usdc_id, &treasury, &fee_bps, &usdc_id);

        let token_client = token::StellarAssetClient::new(&env, &usdc_id);
        token_client.mint(&buyer, &amount);

        let trade_id = client.create_trade(&buyer, &seller, &amount, &5000_u32, &5000_u32, &None);
        client.deposit(&trade_id);
        client.confirm_delivery(&trade_id);
        client.release_funds(&trade_id, &buyer);

        let token_readonly = token::Client::new(&env, &usdc_id);
        assert_eq!(token_readonly.balance(&seller), 9_900);
        assert_eq!(client.get_accrued_fees(), 100);
        assert_eq!(token_readonly.balance(&client.address), 100, "escrow holds accrued fees");
        assert!(matches!(
            client.get_trade(&trade_id).status,
            TradeStatus::Completed
        ));
    }

    #[test]
    fn test_release_sequence_tracks_manifest_delivery_and_release() {
        let env = Env::default();
        env.mock_all_auths();
        let (contract_id, _usdc_id, buyer, seller, _treasury, trade_id) =
            setup_funded_trade(&env, 10_000_i128, 100_u32);
        let client = EscrowContractClient::new(&env, &contract_id);

        let funded_sequence = client.get_release_sequence(&trade_id);
        assert_eq!(funded_sequence.trade_id, trade_id);
        assert!(funded_sequence.funded_at.is_some());
        assert!(funded_sequence.manifest_submitted_at.is_none());
        assert!(funded_sequence.delivered_at.is_none());
        assert!(funded_sequence.released_at.is_none());

        client.submit_manifest(
            &trade_id,
            &seller,
            &String::from_str(&env, "driver-name-hash"),
            &String::from_str(&env, "driver-id-hash"),
        );
        client.confirm_delivery(&trade_id);
        client.release_funds(&trade_id, &buyer);

        let released_sequence = client.get_release_sequence(&trade_id);
        assert!(released_sequence.manifest_submitted_at.is_some());
        assert!(released_sequence.delivered_at.is_some());
        assert!(released_sequence.released_at.is_some());
        assert!(released_sequence.resolved_at.is_none());
        assert!(released_sequence.cancelled_at.is_none());
    }

    // -----------------------------------------------------------------------
    // Loss-sharing ratio tests
    // -----------------------------------------------------------------------

    #[test]
    fn test_create_trade_with_valid_loss_ratios() {
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

        // Test 50/50 split
        let trade_id_1 =
            client.create_trade(&buyer, &seller, &1000_i128, &5000_u32, &5000_u32, &None);
        let trade_1 = client.get_trade(&trade_id_1);
        assert_eq!(trade_1.buyer_loss_bps, 5000);
        assert_eq!(trade_1.seller_loss_bps, 5000);

        // Test 70/30 split (buyer bears 70% of loss)
        let trade_id_2 =
            client.create_trade(&buyer, &seller, &2000_i128, &7000_u32, &3000_u32, &None);
        let trade_2 = client.get_trade(&trade_id_2);
        assert_eq!(trade_2.buyer_loss_bps, 7000);
        assert_eq!(trade_2.seller_loss_bps, 3000);

        // Test 100/0 split (buyer bears all loss)
        let trade_id_3 =
            client.create_trade(&buyer, &seller, &3000_i128, &10000_u32, &0_u32, &None);
        let trade_3 = client.get_trade(&trade_id_3);
        assert_eq!(trade_3.buyer_loss_bps, 10000);
        assert_eq!(trade_3.seller_loss_bps, 0);

        // Test 0/100 split (seller bears all loss)
        let trade_id_4 =
            client.create_trade(&buyer, &seller, &4000_i128, &0_u32, &10000_u32, &None);
        let trade_4 = client.get_trade(&trade_id_4);
        assert_eq!(trade_4.buyer_loss_bps, 0);
        assert_eq!(trade_4.seller_loss_bps, 10000);

        // Test 30/70 split
        let trade_id_5 =
            client.create_trade(&buyer, &seller, &5000_i128, &3000_u32, &7000_u32, &None);
        let trade_5 = client.get_trade(&trade_id_5);
        assert_eq!(trade_5.buyer_loss_bps, 3000);
        assert_eq!(trade_5.seller_loss_bps, 7000);

        // Test 10/90 split
        let trade_id_6 =
            client.create_trade(&buyer, &seller, &6000_i128, &1000_u32, &9000_u32, &None);
        let trade_6 = client.get_trade(&trade_id_6);
        assert_eq!(trade_6.buyer_loss_bps, 1000);
        assert_eq!(trade_6.seller_loss_bps, 9000);

        // Test 25/75 split (middle cases)
        let trade_id_7 =
            client.create_trade(&buyer, &seller, &7000_i128, &2500_u32, &7500_u32, &None);
        let trade_7 = client.get_trade(&trade_id_7);
        assert_eq!(trade_7.buyer_loss_bps, 2500);
        assert_eq!(trade_7.seller_loss_bps, 7500);
    }

    #[test]
    fn test_trade_id_counter_survives_long_ledger_gap() {
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

        assert_eq!(
            env.deployer().get_contract_instance_ttl(&contract_id),
            INSTANCE_TTL_EXTEND_TO
        );

        let trade_id_1 =
            client.create_trade(&buyer, &seller, &1000_i128, &5000_u32, &5000_u32, &None);
        assert_eq!(trade_id_1 & 0xFFFF_FFFF_u64, 1);

        let current_ledger = env.ledger().sequence();
        env.ledger()
            .set_sequence_number(current_ledger + INSTANCE_TTL_EXTEND_TO - 1);
        assert_eq!(env.deployer().get_contract_instance_ttl(&contract_id), 1);

        let trade_id_2 =
            client.create_trade(&buyer, &seller, &1000_i128, &5000_u32, &5000_u32, &None);
        assert_eq!(trade_id_2 & 0xFFFF_FFFF_u64, 2);
        assert_eq!(
            env.deployer().get_contract_instance_ttl(&contract_id),
            INSTANCE_TTL_EXTEND_TO
        );
    }

    #[test]
    #[should_panic(expected = "loss ratios must sum to 10000 (100%)")]
    fn test_create_trade_fails_if_ratios_dont_sum_to_100() {
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

        // This should panic: 5000 + 4000 = 9000 ≠ 10000
        client.create_trade(&buyer, &seller, &1000_i128, &5000_u32, &4000_u32, &None);
    }

    #[test]
    #[should_panic(expected = "loss ratios must sum to 10000 (100%)")]
    fn test_create_trade_fails_if_ratios_sum_exceeds_10000() {
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

        // This should panic: 5001 + 5001 = 10002 > 10000
        client.create_trade(&buyer, &seller, &1000_i128, &5001_u32, &5001_u32, &None);
    }

    // -----------------------------------------------------------------------
    // Dispute resolution tests
    // -----------------------------------------------------------------------

    /// 50/50 split with 50/50 loss-sharing: seller gets 5_000 bps (50%), fee = 1% on seller portion.
    ///
    /// With loss-sharing ratios (buyer_loss_bps=5000, seller_loss_bps=5000):
    /// total = 10_000, seller_gets_bps = 5_000, fee_bps = 100
    ///   loss_bps         = 10_000 - 5_000 = 5_000 (50% loss)
    ///   seller_loss      = 10_000 * 5_000 * 5_000 / 100_000_000 = 2_500
    ///   seller_raw       = 10_000 - 2_500 = 7_500
    ///   fee              = 7_500 * 100 / 10_000 = 75
    ///   seller_net       = 7_500 - 75 = 7_425
    ///   buyer_refund     = 10_000 - 7_500 = 2_500
    #[test]
    fn test_resolve_50_50_split_calculates_correctly() {
        let env = Env::default();
        env.mock_all_auths();
        let amount = 10_000_i128;
        let fee_bps = 100_u32;
        let (contract_id, usdc_id, buyer, seller, _treasury, trade_id) =
            setup_disputed_trade(&env, amount, fee_bps);

        let mediator = Address::generate(&env);
        let client = EscrowContractClient::new(&env, &contract_id);
        client.set_mediator(&mediator);

        client.resolve_dispute(&trade_id, &mediator, &5_000_u32);

        let token = token::Client::new(&env, &usdc_id);
        assert_eq!(token.balance(&seller), 7_425, "seller_net mismatch");
        assert_eq!(client.get_accrued_fees(), 75, "fee mismatch");
        assert_eq!(token.balance(&buyer), 2_500, "buyer_refund mismatch");
        assert_eq!(token.balance(&client.address), client.get_accrued_fees(), "escrow should hold only accrued fees");
        assert!(matches!(
            client.get_trade(&trade_id).status,
            TradeStatus::Completed
        ));
    }

    /// Full seller payout: seller gets 10_000 bps (100%), buyer gets nothing.
    ///
    /// total = 10_000, seller_payout_bps = 10_000, fee_bps = 100
    ///   seller_raw   = 10_000
    ///   fee          =    100
    ///   seller_net   =  9_900
    ///   buyer_refund =      0
    #[test]
    fn test_resolve_full_seller_payout() {
        let env = Env::default();
        env.mock_all_auths();
        let amount = 10_000_i128;
        let fee_bps = 100_u32;
        let (contract_id, usdc_id, buyer, seller, _treasury, trade_id) =
            setup_disputed_trade(&env, amount, fee_bps);

        let mediator = Address::generate(&env);
        let client = EscrowContractClient::new(&env, &contract_id);
        client.set_mediator(&mediator);

        client.resolve_dispute(&trade_id, &mediator, &10_000_u32);

        let token = token::Client::new(&env, &usdc_id);
        assert_eq!(token.balance(&seller), 9_900, "seller_net mismatch");
        assert_eq!(client.get_accrued_fees(), 100, "fee mismatch");
        assert_eq!(token.balance(&buyer), 0, "buyer should receive nothing");
        assert_eq!(token.balance(&client.address), 100, "escrow should hold accrued fees");
    }

    /// Full buyer refund with 50/50 loss-sharing: seller gets 0 bps (0%), buyer gets everything back.
    ///
    /// With loss-sharing ratios (buyer_loss_bps=5000, seller_loss_bps=5000):
    /// total = 10_000, seller_gets_bps = 0, fee_bps = 100
    ///   loss_bps         = 10_000 - 0 = 10_000 (100% loss)
    ///   seller_loss      = 10_000 * 10_000 * 5_000 / 100_000_000 = 5_000
    ///   seller_raw       = 10_000 - 5_000 = 5_000
    ///   fee              = 5_000 * 100 / 10_000 = 50
    ///   seller_net       = 5_000 - 50 = 4_950
    ///   buyer_refund     = 10_000 - 5_000 = 5_000
    #[test]
    fn test_resolve_full_buyer_refund() {
        let env = Env::default();
        env.mock_all_auths();
        let amount = 10_000_i128;
        let fee_bps = 100_u32;
        let (contract_id, usdc_id, buyer, seller, _treasury, trade_id) =
            setup_disputed_trade(&env, amount, fee_bps);

        let mediator = Address::generate(&env);
        let client = EscrowContractClient::new(&env, &contract_id);
        client.set_mediator(&mediator);

        client.resolve_dispute(&trade_id, &mediator, &0_u32);

        let token = token::Client::new(&env, &usdc_id);
        assert_eq!(token.balance(&buyer), 5_000, "buyer_refund mismatch");
        assert_eq!(
            token.balance(&seller),
            4_950,
            "seller should receive their share minus fee"
        );
        assert_eq!(client.get_accrued_fees(), 50, "fee on seller's portion");
        assert_eq!(token.balance(&client.address), 50, "escrow should hold accrued fees");
    }

    /// Non-mediator address cannot call resolve_dispute.
    #[test]
    #[should_panic(expected = "Unauthorized mediator")]
    fn test_non_mediator_cannot_resolve() {
        let env = Env::default();
        env.mock_all_auths();
        let amount = 10_000_i128;
        let fee_bps = 100_u32;
        let (contract_id, _usdc_id, _buyer, _seller, _treasury, trade_id) =
            setup_disputed_trade(&env, amount, fee_bps);

        let mediator = Address::generate(&env);
        let imposter = Address::generate(&env);
        let client = EscrowContractClient::new(&env, &contract_id);
        client.set_mediator(&mediator);

        // Imposter tries to resolve without being in the registry or legacy slot.
        client.resolve_dispute(&trade_id, &imposter, &5_000_u32);
    }

    #[test]
    fn test_mediator_added_via_add_mediator_can_resolve_dispute() {
        let env = Env::default();
        env.mock_all_auths();
        let amount = 10_000_i128;
        let fee_bps = 100_u32;
        let (contract_id, _usdc_id, _buyer, _seller, _treasury, trade_id) =
            setup_disputed_trade(&env, amount, fee_bps);

        let mediator = Address::generate(&env);
        let client = EscrowContractClient::new(&env, &contract_id);
        client.add_mediator(&mediator);

        client.resolve_dispute(&trade_id, &mediator, &5_000_u32);
        assert!(matches!(
            client.get_trade(&trade_id).status,
            TradeStatus::Completed
        ));
    }

    #[test]
    fn test_mediator_added_via_set_mediator_can_still_resolve_dispute() {
        let env = Env::default();
        env.mock_all_auths();
        let amount = 10_000_i128;
        let fee_bps = 100_u32;
        let (contract_id, _usdc_id, _buyer, _seller, _treasury, trade_id) =
            setup_disputed_trade(&env, amount, fee_bps);

        let mediator = Address::generate(&env);
        let client = EscrowContractClient::new(&env, &contract_id);
        client.set_mediator(&mediator);

        client.resolve_dispute(&trade_id, &mediator, &5_000_u32);
        assert!(matches!(
            client.get_trade(&trade_id).status,
            TradeStatus::Completed
        ));
    }

    // -----------------------------------------------------------------------
    // Additional loss-sharing dispute resolution tests
    // -----------------------------------------------------------------------

    /// Test 70/30 loss-sharing with 60% seller ruling
    /// buyer_loss_bps=7000 (buyer bears 70% of loss), seller_loss_bps=3000
    /// seller_gets_bps=6000 (mediator rules 60% for seller, 40% loss)
    ///
    /// Calculation:
    ///   total = 10_000, loss = 40% = 4_000
    ///   seller_loss = 4_000 * 30% = 1_200
    ///   buyer_loss = 4_000 * 70% = 2_800
    ///   seller_raw = 10_000 - 1_200 = 8_800
    ///   fee = 8_800 * 1% = 88
    ///   seller_net = 8_712
    ///   buyer_refund = 1_200
    #[test]
    fn test_resolve_with_70_30_loss_sharing() {
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

        // Create trade with 70/30 loss-sharing (buyer bears 70% of loss)
        let trade_id = client.create_trade(&buyer, &seller, &amount, &7000_u32, &3000_u32, &None);
        client.deposit(&trade_id);
        let reason = mock_reason(&env, "Qm70_30LossSharing");
        client.initiate_dispute(&trade_id, &buyer, &reason);

        let mediator = Address::generate(&env);
        client.set_mediator(&mediator);

        // Mediator rules 60% for seller (40% loss)
        client.resolve_dispute(&trade_id, &mediator, &6_000_u32);

        let token = token::Client::new(&env, &usdc_id);
        assert_eq!(
            token.balance(&seller),
            8_712,
            "seller_net with 70/30 loss-sharing"
        );
        assert_eq!(client.get_accrued_fees(), 88, "fee on seller portion");
        assert_eq!(
            token.balance(&buyer),
            1_200,
            "buyer_refund with 70/30 loss-sharing"
        );
        assert_eq!(token.balance(&client.address), 88, "escrow should hold accrued fees");
    }

    /// Test 100/0 loss-sharing (buyer bears all loss) with 80% seller ruling
    /// buyer_loss_bps=10000, seller_loss_bps=0
    /// seller_gets_bps=8000 (mediator rules 80% for seller, 20% loss)
    ///
    /// Calculation:
    ///   total = 10_000, loss = 20% = 2_000
    ///   seller_loss = 2_000 * 0% = 0
    ///   buyer_loss = 2_000 * 100% = 2_000
    ///   seller_raw = 10_000 - 0 = 10_000
    ///   fee = 10_000 * 1% = 100
    ///   seller_net = 9_900
    ///   buyer_refund = 0
    #[test]
    fn test_resolve_buyer_bears_all_loss() {
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

        // Buyer bears all loss (100/0)
        let trade_id = client.create_trade(&buyer, &seller, &amount, &10000_u32, &0_u32, &None);
        client.deposit(&trade_id);
        let reason = mock_reason(&env, "QmBuyerBearsAllLoss");
        client.initiate_dispute(&trade_id, &seller, &reason);

        let mediator = Address::generate(&env);
        client.set_mediator(&mediator);

        // Mediator rules 80% for seller
        client.resolve_dispute(&trade_id, &mediator, &8_000_u32);

        let token = token::Client::new(&env, &usdc_id);
        assert_eq!(
            token.balance(&seller),
            9_900,
            "seller gets full amount minus fee"
        );
        assert_eq!(client.get_accrued_fees(), 100, "fee on full seller amount");
        assert_eq!(
            token.balance(&buyer),
            0,
            "buyer gets nothing when bearing all loss"
        );
        assert_eq!(token.balance(&client.address), 100, "escrow should hold accrued fees");
    }

    /// Test 0/100 loss-sharing (seller bears all loss) with 30% seller ruling
    /// buyer_loss_bps=0, seller_loss_bps=10000
    /// seller_gets_bps=3000 (mediator rules 30% for seller, 70% loss)
    ///
    /// Calculation:
    ///   total = 10_000, loss = 70% = 7_000
    ///   seller_loss = 7_000 * 100% = 7_000
    ///   buyer_loss = 7_000 * 0% = 0
    ///   seller_raw = 10_000 - 7_000 = 3_000
    ///   fee = 3_000 * 1% = 30
    ///   seller_net = 2_970
    ///   buyer_refund = 7_000
    #[test]
    fn test_resolve_seller_bears_all_loss() {
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

        // Seller bears all loss (0/100)
        let trade_id = client.create_trade(&buyer, &seller, &amount, &0_u32, &10000_u32, &None);
        client.deposit(&trade_id);
        let reason = mock_reason(&env, "QmSellerBearsAllLoss");
        client.initiate_dispute(&trade_id, &buyer, &reason);

        let mediator = Address::generate(&env);
        client.set_mediator(&mediator);

        // Mediator rules 30% for seller (70% loss)
        client.resolve_dispute(&trade_id, &mediator, &3_000_u32);

        let token = token::Client::new(&env, &usdc_id);
        assert_eq!(token.balance(&seller), 2_970, "seller bears all loss");
        assert_eq!(client.get_accrued_fees(), 30, "fee on seller portion");
        assert_eq!(
            token.balance(&buyer),
            7_000,
            "buyer gets most back when seller bears all loss"
        );
        assert_eq!(token.balance(&client.address), 30, "escrow should hold accrued fees");
    }

    /// Test 20/80 loss-sharing with 90% seller ruling (small loss)
    /// buyer_loss_bps=2000, seller_loss_bps=8000
    /// seller_gets_bps=9000 (mediator rules 90% for seller, 10% loss)
    ///
    /// Calculation:
    ///   total = 10_000, loss = 10% = 1_000
    ///   seller_loss = 1_000 * 80% = 800
    ///   buyer_loss = 1_000 * 20% = 200
    ///   seller_raw = 10_000 - 800 = 9_200
    ///   fee = 9_200 * 1% = 92
    ///   seller_net = 9_108
    ///   buyer_refund = 800
    #[test]
    fn test_resolve_with_small_loss_20_80_sharing() {
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

        // 20/80 loss-sharing (seller bears 80% of loss)
        let trade_id = client.create_trade(&buyer, &seller, &amount, &2000_u32, &8000_u32, &None);
        client.deposit(&trade_id);
        let reason = mock_reason(&env, "QmSmallLoss80Seller");
        client.initiate_dispute(&trade_id, &seller, &reason);

        let mediator = Address::generate(&env);
        client.set_mediator(&mediator);

        // Mediator rules 90% for seller (small 10% loss)
        client.resolve_dispute(&trade_id, &mediator, &9_000_u32);

        let token = token::Client::new(&env, &usdc_id);
        assert_eq!(token.balance(&seller), 9_108, "seller with small loss");
        assert_eq!(client.get_accrued_fees(), 92, "fee on seller portion");
        assert_eq!(token.balance(&buyer), 800, "buyer refund with small loss");
        assert_eq!(token.balance(&client.address), 92, "escrow should hold accrued fees");
    }

    /// Test 25/75 loss-sharing with 60% seller ruling (40% loss middle case)
    /// buyer_loss_bps=2500, seller_loss_bps=7500
    /// seller_gets_bps=6000 (mediator rules 60% for seller, 40% loss)
    ///
    /// Calculation:
    ///   total = 10_000, loss = 40% = 4_000
    ///   seller_loss = 4_000 * 75% = 3_000
    ///   buyer_refund = 3_000
    ///   seller_raw = 10_000 - 3_000 = 7_000
    ///   fee = 7_000 * 1% = 70
    ///   seller_net = 6_930
    #[test]
    fn test_resolve_with_middle_case_25_75_sharing() {
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

        // 25/75 loss-sharing (seller bears 75% of loss)
        let trade_id = client.create_trade(&buyer, &seller, &amount, &2500_u32, &7500_u32, &None);
        client.deposit(&trade_id);
        let reason = mock_reason(&env, "QmMiddleCase25_75Loss");
        client.initiate_dispute(&trade_id, &buyer, &reason);

        let mediator = Address::generate(&env);
        client.set_mediator(&mediator);

        // Mediator rules 60% for seller (40% loss)
        client.resolve_dispute(&trade_id, &mediator, &6_000_u32);

        let token = token::Client::new(&env, &usdc_id);
        assert_eq!(token.balance(&seller), 6_930, "seller with 25/75 case");
        assert_eq!(client.get_accrued_fees(), 70, "fee on seller portion");
        assert_eq!(token.balance(&buyer), 3_000, "buyer refund 25/75 case");
        assert_eq!(token.balance(&client.address), 70, "escrow should hold accrued fees");
    }

    /// Test edge case: 50/50 loss-sharing with 100% seller ruling (no loss)
    /// buyer_loss_bps=5000, seller_loss_bps=5000
    /// seller_gets_bps=10000 (mediator rules 100% for seller, 0% loss)
    ///
    /// Calculation:
    ///   total = 10_000, loss = 0% = 0
    ///   seller_loss = 0 * 50% = 0
    ///   buyer_loss = 0 * 50% = 0
    ///   seller_raw = 10_000 - 0 = 10_000
    ///   fee = 10_000 * 1% = 100
    ///   seller_net = 9_900
    ///   buyer_refund = 0
    #[test]
    fn test_resolve_no_loss_full_seller_payout() {
        let env = Env::default();
        env.mock_all_auths();
        let amount = 10_000_i128;
        let fee_bps = 100_u32;
        let (contract_id, usdc_id, buyer, seller, _treasury, trade_id) =
            setup_disputed_trade(&env, amount, fee_bps);

        let mediator = Address::generate(&env);
        let client = EscrowContractClient::new(&env, &contract_id);
        client.set_mediator(&mediator);

        // Mediator rules 100% for seller (no loss)
        client.resolve_dispute(&trade_id, &mediator, &10_000_u32);

        let token = token::Client::new(&env, &usdc_id);
        assert_eq!(
            token.balance(&seller),
            9_900,
            "seller gets full amount minus fee"
        );
        assert_eq!(client.get_accrued_fees(), 100, "fee on full amount");
        assert_eq!(token.balance(&buyer), 0, "buyer gets nothing when no loss");
        assert_eq!(token.balance(&client.address), 100, "escrow should hold accrued fees");
    }

    // -----------------------------------------------------------------------
    // initiate_dispute() tests
    // -----------------------------------------------------------------------

    /// Buyer initiates a dispute: trade transitions to Disputed and DisputeRecord is stored.
    #[test]
    fn test_dispute_initiated_by_buyer() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register(EscrowContract, ());
        let client = EscrowContractClient::new(&env, &contract_id);
        let admin = crate::test_fixture::admin_address(&env);
        let buyer = Address::generate(&env);
        let seller = Address::generate(&env);
        let treasury = Address::generate(&env);
        let amount = 10_000_i128;
        let usdc_id = env
            .register_stellar_asset_contract_v2(admin.clone())
            .address();
        client.initialize(&admin, &usdc_id, &treasury, &100, &usdc_id);

        let token_client = token::StellarAssetClient::new(&env, &usdc_id);
        token_client.mint(&buyer, &amount);

        let trade_id = client.create_trade(&buyer, &seller, &amount, &5000_u32, &5000_u32, &None);
        client.deposit(&trade_id);

        env.ledger().with_mut(|l| l.timestamp = 5_000);
        let reason = soroban_sdk::String::from_str(&env, "QmBuyerReasonHash1234");
        client.initiate_dispute(&trade_id, &buyer, &reason);

        // Status must be Disputed
        let trade = client.get_trade(&trade_id);
        assert!(matches!(trade.status, TradeStatus::Disputed));
        assert_eq!(trade.updated_at, 5_000);

        // DisputeRecord must be stored with correct fields
        let record = client
            .get_dispute_record(&trade_id)
            .expect("DisputeRecord must be present");
        assert_eq!(record.initiator, buyer);
        assert_eq!(record.reason_hash, reason);
        assert_eq!(record.disputed_at, 5_000);
    }

    /// Seller initiates a dispute: same logic should hold symmetrically.
    #[test]
    fn test_dispute_initiated_by_seller() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register(EscrowContract, ());
        let client = EscrowContractClient::new(&env, &contract_id);
        let admin = crate::test_fixture::admin_address(&env);
        let buyer = Address::generate(&env);
        let seller = Address::generate(&env);
        let treasury = Address::generate(&env);
        let amount = 8_000_i128;
        let usdc_id = env
            .register_stellar_asset_contract_v2(admin.clone())
            .address();
        client.initialize(&admin, &usdc_id, &treasury, &100, &usdc_id);

        let token_client = token::StellarAssetClient::new(&env, &usdc_id);
        token_client.mint(&buyer, &amount);

        let trade_id = client.create_trade(&buyer, &seller, &amount, &5000_u32, &5000_u32, &None);
        client.deposit(&trade_id);

        env.ledger().with_mut(|l| l.timestamp = 9_000);
        let reason = soroban_sdk::String::from_str(&env, "QmSellerClaimsNonPayment");
        client.initiate_dispute(&trade_id, &seller, &reason);

        let trade = client.get_trade(&trade_id);
        assert!(matches!(trade.status, TradeStatus::Disputed));

        let record = client
            .get_dispute_record(&trade_id)
            .expect("DisputeRecord must be present");
        assert_eq!(record.initiator, seller);
        assert_eq!(record.reason_hash, reason);
        assert_eq!(record.disputed_at, 9_000);
    }

    /// initiate_dispute panics when the trade is not in Funded status (e.g. still Created).
    #[test]
    #[should_panic(expected = "Trade must be in Funded status to initiate a dispute")]
    fn test_dispute_fails_if_trade_not_funded() {
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

        // create_trade but NO deposit — trade is still Created
        let trade_id =
            client.create_trade(&buyer, &seller, &5_000_i128, &5000_u32, &5000_u32, &None);
        let reason = soroban_sdk::String::from_str(&env, "QmPrematureDispute");
        client.initiate_dispute(&trade_id, &buyer, &reason);
    }

    /// initiate_dispute panics when the trade is already Disputed (cannot dispute twice).
    #[test]
    #[should_panic(expected = "Trade must be in Funded status to initiate a dispute")]
    fn test_dispute_fails_if_already_disputed() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register(EscrowContract, ());
        let client = EscrowContractClient::new(&env, &contract_id);
        let admin = crate::test_fixture::admin_address(&env);
        let buyer = Address::generate(&env);
        let seller = Address::generate(&env);
        let treasury = Address::generate(&env);
        let amount = 10_000_i128;
        let usdc_id = env
            .register_stellar_asset_contract_v2(admin.clone())
            .address();
        client.initialize(&admin, &usdc_id, &treasury, &100, &usdc_id);

        let token_client = token::StellarAssetClient::new(&env, &usdc_id);
        token_client.mint(&buyer, &amount);

        let trade_id = client.create_trade(&buyer, &seller, &amount, &5000_u32, &5000_u32, &None);
        client.deposit(&trade_id);

        let reason = soroban_sdk::String::from_str(&env, "QmFirstDispute");
        client.initiate_dispute(&trade_id, &buyer, &reason); // first: OK

        let reason2 = soroban_sdk::String::from_str(&env, "QmDuplicateDispute");
        client.initiate_dispute(&trade_id, &seller, &reason2); // second: must panic
    }

    /// A stranger (neither buyer nor seller) cannot initiate a dispute.
    #[test]
    #[should_panic(expected = "Only the buyer or seller can initiate a dispute")]
    fn test_stranger_cannot_initiate_dispute() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register(EscrowContract, ());
        let client = EscrowContractClient::new(&env, &contract_id);
        let admin = crate::test_fixture::admin_address(&env);
        let buyer = Address::generate(&env);
        let seller = Address::generate(&env);
        let treasury = Address::generate(&env);
        let amount = 10_000_i128;
        let usdc_id = env
            .register_stellar_asset_contract_v2(admin.clone())
            .address();
        client.initialize(&admin, &usdc_id, &treasury, &100, &usdc_id);

        let token_client = token::StellarAssetClient::new(&env, &usdc_id);
        token_client.mint(&buyer, &amount);

        let trade_id = client.create_trade(&buyer, &seller, &amount, &5000_u32, &5000_u32, &None);
        client.deposit(&trade_id);

        // Stranger tries to initiate dispute
        let stranger = Address::generate(&env);
        let reason = soroban_sdk::String::from_str(&env, "QmMaliciousDispute");
        client.initiate_dispute(&trade_id, &stranger, &reason);
    }

    /// Dispute cannot be initiated after trade is completed.
    #[test]
    #[should_panic(expected = "Trade must be in Funded status to initiate a dispute")]
    fn test_dispute_fails_after_trade_completed() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register(EscrowContract, ());
        let client = EscrowContractClient::new(&env, &contract_id);
        let admin = crate::test_fixture::admin_address(&env);
        let buyer = Address::generate(&env);
        let seller = Address::generate(&env);
        let treasury = Address::generate(&env);
        let amount = 10_000_i128;
        let usdc_id = env
            .register_stellar_asset_contract_v2(admin.clone())
            .address();
        client.initialize(&admin, &usdc_id, &treasury, &100, &usdc_id);

        let token_client = token::StellarAssetClient::new(&env, &usdc_id);
        token_client.mint(&buyer, &amount);

        let trade_id = client.create_trade(&buyer, &seller, &amount, &5000_u32, &5000_u32, &None);
        client.deposit(&trade_id);

        // Complete the trade successfully
        client.confirm_delivery(&trade_id);
        client.release_funds(&trade_id, &buyer);

        // Try to initiate dispute after completion
        let reason = soroban_sdk::String::from_str(&env, "QmTooLateDispute");
        client.initiate_dispute(&trade_id, &buyer, &reason);
    }

    /// Dispute record stores correct IPFS hash and can be retrieved.
    #[test]
    fn test_dispute_record_stores_ipfs_hash_correctly() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register(EscrowContract, ());
        let client = EscrowContractClient::new(&env, &contract_id);
        let admin = crate::test_fixture::admin_address(&env);
        let buyer = Address::generate(&env);
        let seller = Address::generate(&env);
        let treasury = Address::generate(&env);
        let amount = 10_000_i128;
        let usdc_id = env
            .register_stellar_asset_contract_v2(admin.clone())
            .address();
        client.initialize(&admin, &usdc_id, &treasury, &100, &usdc_id);

        let token_client = token::StellarAssetClient::new(&env, &usdc_id);
        token_client.mint(&buyer, &amount);

        let trade_id = client.create_trade(&buyer, &seller, &amount, &5000_u32, &5000_u32, &None);
        client.deposit(&trade_id);

        // Set specific timestamp
        env.ledger().with_mut(|l| l.timestamp = 12_345);

        // Initiate dispute with detailed IPFS hash
        let ipfs_reason =
            soroban_sdk::String::from_str(&env, "QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG");
        client.initiate_dispute(&trade_id, &seller, &ipfs_reason);

        // Verify dispute record is stored correctly
        let record = client
            .get_dispute_record(&trade_id)
            .expect("DisputeRecord must exist");

        assert_eq!(record.initiator, seller, "Initiator should be seller");
        assert_eq!(
            record.reason_hash, ipfs_reason,
            "Reason hash should match IPFS CID"
        );
        assert_eq!(
            record.disputed_at, 12_345,
            "Timestamp should be recorded correctly"
        );

        // Verify trade status changed
        let trade = client.get_trade(&trade_id);
        assert!(
            matches!(trade.status, TradeStatus::Disputed),
            "Trade should be in Disputed status"
        );
        assert_eq!(
            trade.updated_at, 12_345,
            "Trade updated_at should match dispute timestamp"
        );
    }

    // -----------------------------------------------------------------------
    // Mediator registry tests
    // -----------------------------------------------------------------------

    fn setup_base(env: &Env) -> (Address, Address, Address) {
        let admin = crate::test_fixture::admin_address(env);
        let usdc_id = env
            .register_stellar_asset_contract_v2(admin.clone())
            .address();
        let contract_id = env.register(EscrowContract, ());
        let client = EscrowContractClient::new(env, &contract_id);
        let treasury = Address::generate(env);
        client.initialize(&admin, &usdc_id, &treasury, &100, &usdc_id);
        (contract_id, admin, usdc_id)
    }

    /// Admin can add a mediator; is_mediator returns true afterwards.
    #[test]
    fn test_admin_can_add_mediator() {
        let env = Env::default();
        env.mock_all_auths();
        let (contract_id, _admin, _usdc) = setup_base(&env);
        let client = EscrowContractClient::new(&env, &contract_id);
        let mediator = Address::generate(&env);

        assert!(
            !client.is_mediator(&mediator),
            "must be false before adding"
        );
        client.add_mediator(&mediator);
        assert!(client.is_mediator(&mediator), "must be true after adding");
    }

    /// Admin can remove a mediator; is_mediator returns false afterwards.
    #[test]
    fn test_admin_can_remove_mediator() {
        let env = Env::default();
        env.mock_all_auths();
        let (contract_id, _admin, _usdc) = setup_base(&env);
        let client = EscrowContractClient::new(&env, &contract_id);
        let mediator = Address::generate(&env);

        client.add_mediator(&mediator);
        assert!(client.is_mediator(&mediator));

        client.remove_mediator(&mediator);
        assert!(
            !client.is_mediator(&mediator),
            "must be false after removal"
        );
    }

    /// is_mediator returns false for an unknown address without panic.
    #[test]
    fn test_is_mediator_returns_false_for_unknown() {
        let env = Env::default();
        env.mock_all_auths();
        let (contract_id, _admin, _usdc) = setup_base(&env);
        let client = EscrowContractClient::new(&env, &contract_id);
        let random = Address::generate(&env);
        assert!(!client.is_mediator(&random));
    }

    /// Non-admin cannot add a mediator.
    #[test]
    #[should_panic]
    fn test_non_admin_cannot_add_mediator() {
        let env = Env::default();
        env.mock_all_auths();
        let (contract_id, _admin, _usdc) = setup_base(&env);
        let impostor = Address::generate(&env);
        let mediator = Address::generate(&env);

        // Only provide auth for the impostor, not the admin
        EscrowContractClient::new(&env, &contract_id)
            .mock_auths(&[soroban_sdk::testutils::MockAuth {
                address: &impostor,
                invoke: &soroban_sdk::testutils::MockAuthInvoke {
                    contract: &contract_id,
                    fn_name: "add_mediator",
                    args: soroban_sdk::vec![
                        &env,
                        soroban_sdk::IntoVal::<Env, soroban_sdk::Val>::into_val(&mediator, &env),
                    ],
                    sub_invokes: &[],
                },
            }])
            .add_mediator(&mediator);
    }

    /// Non-admin cannot remove a mediator.
    #[test]
    #[should_panic]
    fn test_non_admin_cannot_remove_mediator() {
        let env = Env::default();
        env.mock_all_auths();
        let (contract_id, _admin, _usdc) = setup_base(&env);
        let client = EscrowContractClient::new(&env, &contract_id);
        let mediator = Address::generate(&env);
        client.add_mediator(&mediator);

        let impostor = Address::generate(&env);
        client
            .mock_auths(&[soroban_sdk::testutils::MockAuth {
                address: &impostor,
                invoke: &soroban_sdk::testutils::MockAuthInvoke {
                    contract: &contract_id,
                    fn_name: "remove_mediator",
                    args: soroban_sdk::vec![
                        &env,
                        soroban_sdk::IntoVal::<Env, soroban_sdk::Val>::into_val(&mediator, &env),
                    ],
                    sub_invokes: &[],
                },
            }])
            .remove_mediator(&mediator);
    }

    // -----------------------------------------------------------------------
    // Input validation tests (#190)
    // -----------------------------------------------------------------------

    #[test]
    #[should_panic(expected = "fee_bps must not exceed 10000")]
    fn test_initialize_rejects_fee_bps_over_10000() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register(EscrowContract, ());
        let client = EscrowContractClient::new(&env, &contract_id);
        let admin = crate::test_fixture::admin_address(&env);
        let usdc_id = env
            .register_stellar_asset_contract_v2(admin.clone())
            .address();
        let treasury = Address::generate(&env);
        client.initialize(&admin, &usdc_id, &treasury, &10_001_u32, &usdc_id);
    }

    #[test]
    fn test_initialize_accepts_fee_bps_at_boundary_10000() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register(EscrowContract, ());
        let client = EscrowContractClient::new(&env, &contract_id);
        let admin = crate::test_fixture::admin_address(&env);
        let usdc_id = env
            .register_stellar_asset_contract_v2(admin.clone())
            .address();
        let treasury = Address::generate(&env);
        // 10_000 bps (100%) is the maximum allowed — must not panic
        client.initialize(&admin, &usdc_id, &treasury, &10_000_u32, &usdc_id);
    }

    #[test]
    #[should_panic(expected = "buyer and seller must be different addresses")]
    fn test_create_trade_rejects_self_trade() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register(EscrowContract, ());
        let client = EscrowContractClient::new(&env, &contract_id);
        let admin = crate::test_fixture::admin_address(&env);
        let actor = Address::generate(&env);
        let usdc_id = env
            .register_stellar_asset_contract_v2(admin.clone())
            .address();
        let treasury = Address::generate(&env);
        client.initialize(&admin, &usdc_id, &treasury, &100_u32, &usdc_id);
        client.create_trade(&actor, &actor, &1_000_i128, &5000_u32, &5000_u32, &None);
    }

    #[test]
    #[should_panic(expected = "reason_hash must not be empty")]
    fn test_initiate_dispute_rejects_empty_reason_hash() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register(EscrowContract, ());
        let client = EscrowContractClient::new(&env, &contract_id);
        let admin = crate::test_fixture::admin_address(&env);
        let buyer = Address::generate(&env);
        let seller = Address::generate(&env);
        let treasury = Address::generate(&env);
        let amount = 1_000_i128;
        let usdc_id = env
            .register_stellar_asset_contract_v2(admin.clone())
            .address();
        client.initialize(&admin, &usdc_id, &treasury, &100_u32, &usdc_id);
        let token_client = token::StellarAssetClient::new(&env, &usdc_id);
        token_client.mint(&buyer, &amount);
        let trade_id = client.create_trade(&buyer, &seller, &amount, &5000_u32, &5000_u32, &None);
        client.deposit(&trade_id);
        let empty = soroban_sdk::String::from_str(&env, "");
        client.initiate_dispute(&trade_id, &buyer, &empty);
    }

    #[test]
    #[should_panic]
    fn test_submit_video_proof_rejects_empty_cid() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register(EscrowContract, ());
        let client = EscrowContractClient::new(&env, &contract_id);
        let admin = crate::test_fixture::admin_address(&env);
        let buyer = Address::generate(&env);
        let seller = Address::generate(&env);
        let treasury = Address::generate(&env);
        let amount = 1_000_i128;
        let usdc_id = env
            .register_stellar_asset_contract_v2(admin.clone())
            .address();
        client.initialize(&admin, &usdc_id, &treasury, &100_u32, &usdc_id);
        let token_client = token::StellarAssetClient::new(&env, &usdc_id);
        token_client.mint(&buyer, &amount);
        let trade_id = client.create_trade(&buyer, &seller, &amount, &5000_u32, &5000_u32, &None);
        client.deposit(&trade_id);
        let empty_cid = soroban_sdk::String::from_str(&env, "");
        client.submit_video_proof(&trade_id, &buyer, &empty_cid);
    }

    // -----------------------------------------------------------------------
    // Payout invariant and boundary tests (#191)
    // -----------------------------------------------------------------------

    /// Helper: run a full dispute resolution and return (seller_net, buyer_refund, fee).
    fn resolve_and_balances(
        env: &Env,
        buyer_loss_bps: u32,
        seller_loss_bps: u32,
        seller_gets_bps: u32,
        fee_bps: u32,
        amount: i128,
    ) -> (i128, i128, i128) {
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
        let token_mint = token::StellarAssetClient::new(env, &usdc_id);
        token_mint.mint(&buyer, &amount);
        let trade_id = client.create_trade(
            &buyer,
            &seller,
            &amount,
            &buyer_loss_bps,
            &seller_loss_bps,
            &None,
        );
        client.deposit(&trade_id);
        let reason = soroban_sdk::String::from_str(env, "QmInvariantTest");
        client.initiate_dispute(&trade_id, &buyer, &reason);
        let mediator = Address::generate(env);
        client.set_mediator(&mediator);
        client.resolve_dispute(&trade_id, &mediator, &seller_gets_bps);
        let tok = token::Client::new(env, &usdc_id);
        (
            tok.balance(&seller),
            tok.balance(&buyer),
            client.get_accrued_fees(),
        )
    }

    /// Conservation invariant: seller_net + buyer_refund + fee == total for all inputs.
    #[test]
    fn test_payout_conservation_invariant() {
        // Table of (buyer_loss_bps, seller_loss_bps, seller_gets_bps, fee_bps, amount)
        let cases: &[(u32, u32, u32, u32, i128)] = &[
            (5000, 5000, 5000, 100, 10_000),
            (5000, 5000, 10000, 100, 10_000),
            (5000, 5000, 0, 100, 10_000),
            (10000, 0, 8000, 100, 10_000),
            (0, 10000, 3000, 100, 10_000),
            (7000, 3000, 6000, 100, 10_000),
            (2000, 8000, 9000, 100, 10_000),
            (5000, 5000, 5000, 0, 10_000),
            (5000, 5000, 5000, 10000, 10_000),
            (5000, 5000, 5000, 100, 1),
            (5000, 5000, 5000, 100, 1_000_000),
        ];
        for &(blb, slb, sgb, fb, amt) in cases {
            let env = Env::default();
            env.mock_all_auths();
            let (seller_net, buyer_refund, fee) =
                resolve_and_balances(&env, blb, slb, sgb, fb, amt);
            assert_eq!(
                seller_net + buyer_refund + fee,
                amt,
                "conservation failed: blb={blb} slb={slb} sgb={sgb} fb={fb} amt={amt}"
            );
        }
    }

    /// Non-negativity: no payout component is negative.
    #[test]
    fn test_payout_non_negativity() {
        let cases: &[(u32, u32, u32, u32, i128)] = &[
            (5000, 5000, 0, 100, 10_000),
            (5000, 5000, 10000, 10000, 10_000),
            (0, 10000, 0, 100, 10_000),
            (10000, 0, 10000, 100, 10_000),
        ];
        for &(blb, slb, sgb, fb, amt) in cases {
            let env = Env::default();
            env.mock_all_auths();
            let (seller_net, buyer_refund, fee) =
                resolve_and_balances(&env, blb, slb, sgb, fb, amt);
            assert!(seller_net >= 0, "seller_net negative");
            assert!(buyer_refund >= 0, "buyer_refund negative");
            assert!(fee >= 0, "fee negative");
        }
    }

    /// Monotonicity: increasing seller_gets_bps must not decrease seller payout
    /// (with fixed 50/50 loss-sharing ratios).
    #[test]
    fn test_payout_seller_monotonicity() {
        let bps_steps = [0_u32, 2000, 4000, 5000, 6000, 8000, 10000];
        let mut prev_seller = -1_i128;
        for &sgb in &bps_steps {
            let env = Env::default();
            env.mock_all_auths();
            let (seller_net, _, _) = resolve_and_balances(&env, 5000, 5000, sgb, 100, 10_000);
            assert!(
                seller_net >= prev_seller,
                "seller payout decreased: sgb={sgb} seller_net={seller_net} prev={prev_seller}"
            );
            prev_seller = seller_net;
        }
    }

    /// Bounds: seller_gets_bps > 10_000 must panic.
    #[test]
    #[should_panic(expected = "seller_gets_bps must be <= 10_000")]
    fn test_resolve_panics_on_seller_gets_bps_over_10000() {
        let env = Env::default();
        env.mock_all_auths();
        let (contract_id, _usdc_id, _buyer, _seller, _treasury, trade_id) =
            setup_disputed_trade(&env, 10_000, 100);
        let mediator = Address::generate(&env);
        let client = EscrowContractClient::new(&env, &contract_id);
        client.set_mediator(&mediator);
        client.resolve_dispute(&trade_id, &mediator, &10_001_u32);
    }

    // -----------------------------------------------------------------------
    // Auth / state guard matrix tests (#189)
    // confirm_delivery x release_funds x cancel_trade
    // -----------------------------------------------------------------------

    // --- confirm_delivery guards ---

    #[test]
    #[should_panic]
    fn test_confirm_delivery_rejects_non_buyer_caller() {
        let env = Env::default();
        env.mock_all_auths();
        let (contract_id, _usdc, _buyer, seller, _treasury, trade_id) =
            setup_funded_trade(&env, 10_000, 100);
        let client = EscrowContractClient::new(&env, &contract_id);
        // seller is not the buyer — must be rejected
        client
            .mock_auths(&[soroban_sdk::testutils::MockAuth {
                address: &seller,
                invoke: &soroban_sdk::testutils::MockAuthInvoke {
                    contract: &contract_id,
                    fn_name: "confirm_delivery",
                    args: soroban_sdk::vec![
                        &env,
                        soroban_sdk::IntoVal::<Env, soroban_sdk::Val>::into_val(&trade_id, &env)
                    ],
                    sub_invokes: &[],
                },
            }])
            .confirm_delivery(&trade_id);
    }

    #[test]
    #[should_panic(expected = "Trade must be funded")]
    fn test_confirm_delivery_rejects_wrong_status() {
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
        // Trade is Created (not Funded)
        let trade_id =
            client.create_trade(&buyer, &seller, &1_000_i128, &5000_u32, &5000_u32, &None);
        client.confirm_delivery(&trade_id);
    }

    // --- release_funds guards ---

    #[test]
    #[should_panic]
    fn test_release_funds_rejects_non_buyer_caller() {
        let env = Env::default();
        env.mock_all_auths();
        let (contract_id, _usdc, _buyer, seller, _treasury, trade_id) =
            setup_funded_trade(&env, 10_000, 100);
        let client = EscrowContractClient::new(&env, &contract_id);
        client.confirm_delivery(&trade_id);
        // seller tries to release — must be rejected
        client
            .mock_auths(&[soroban_sdk::testutils::MockAuth {
                address: &seller,
                invoke: &soroban_sdk::testutils::MockAuthInvoke {
                    contract: &contract_id,
                    fn_name: "release_funds",
                    args: soroban_sdk::vec![
                        &env,
                        soroban_sdk::IntoVal::<Env, soroban_sdk::Val>::into_val(&trade_id, &env),
                        soroban_sdk::IntoVal::<Env, soroban_sdk::Val>::into_val(&seller, &env)
                    ],
                    sub_invokes: &[],
                },
            }])
            .release_funds(&trade_id, &seller);
    }

    #[test]
    #[should_panic(expected = "Trade must be delivered")]
    fn test_release_funds_rejects_wrong_status() {
        let env = Env::default();
        env.mock_all_auths();
        let (contract_id, _usdc, buyer, _seller, _treasury, trade_id) =
            setup_funded_trade(&env, 10_000, 100);
        let client = EscrowContractClient::new(&env, &contract_id);
        // Trade is Funded, not Delivered
        client.release_funds(&trade_id, &buyer);
    }

    // Cancellation policy:
    // - Created: buyer, seller, or admin may cancel immediately.
    // - Funded: buyer/seller request cancellation; admin may cancel immediately.
    // - Delivered / Disputed / Completed / Cancelled: cancellation is rejected.
    // These tests lock that policy down explicitly.
    // --- cancel_trade guards ---

    #[test]
    #[should_panic(expected = "Unauthorized caller")]
    fn test_cancel_trade_rejects_third_party_in_created_status() {
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
        let trade_id =
            client.create_trade(&buyer, &seller, &1_000_i128, &5000_u32, &5000_u32, &None);
        let stranger = Address::generate(&env);
        client.cancel_trade(&trade_id, &stranger);
    }

    #[test]
    fn test_cancel_trade_allows_admin_in_created_status() {
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

        let trade_id =
            client.create_trade(&buyer, &seller, &1_000_i128, &5000_u32, &5000_u32, &None);
        client.cancel_trade(&trade_id, &admin);

        assert!(matches!(
            client.get_trade(&trade_id).status,
            TradeStatus::Cancelled
        ));
    }

    #[test]
    #[should_panic(expected = "Unauthorized caller")]
    fn test_cancel_trade_rejects_third_party_in_funded_status() {
        let env = Env::default();
        env.mock_all_auths();
        let (contract_id, _usdc, _buyer, _seller, _treasury, trade_id) =
            setup_funded_trade(&env, 10_000, 100);
        let client = EscrowContractClient::new(&env, &contract_id);
        let stranger = Address::generate(&env);
        client.cancel_trade(&trade_id, &stranger);
    }

    #[test]
    fn test_admin_immediate_cancel_in_funded_status() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register(EscrowContract, ());
        let client = EscrowContractClient::new(&env, &contract_id);
        let admin = crate::test_fixture::admin_address(&env);
        let buyer = Address::generate(&env);
        let seller = Address::generate(&env);
        let treasury = Address::generate(&env);
        let amount = 5_000_i128;
        let usdc_id = env
            .register_stellar_asset_contract_v2(admin.clone())
            .address();
        client.initialize(&admin, &usdc_id, &treasury, &100, &usdc_id);
        let token_mint = token::StellarAssetClient::new(&env, &usdc_id);
        token_mint.mint(&buyer, &amount);
        let trade_id = client.create_trade(&buyer, &seller, &amount, &5000_u32, &5000_u32, &None);
        client.deposit(&trade_id);
        // Admin cancels immediately without needing both parties
        client.cancel_trade(&trade_id, &admin);
        assert!(matches!(
            client.get_trade(&trade_id).status,
            TradeStatus::Cancelled
        ));
        let tok = token::Client::new(&env, &usdc_id);
        assert_eq!(tok.balance(&buyer), amount, "buyer must be fully refunded");
        assert_eq!(tok.balance(&client.address), 0, "escrow must be empty");
    }

    #[test]
    #[should_panic(expected = "Cannot cancel trade in current status")]
    fn test_cancel_trade_rejects_after_dispute() {
        let env = Env::default();
        env.mock_all_auths();
        let (contract_id, _usdc, buyer, _seller, _treasury, trade_id) =
            setup_disputed_trade(&env, 10_000, 100);
        let client = EscrowContractClient::new(&env, &contract_id);
        client.cancel_trade(&trade_id, &buyer);
    }

    // -----------------------------------------------------------------------
    // Path Payment (Volatility Protection) tests
    // -----------------------------------------------------------------------

    fn setup_path_payment_env(
        env: &Env,
        init_fee_bps: u32,
    ) -> (
        Address,
        Address,
        Address,
        Address,
        Address,
        Address,
        Address,
    ) {
        let contract_id = env.register(EscrowContract, ());
        let client = EscrowContractClient::new(env, &contract_id);
        let admin = crate::test_fixture::admin_address(env);
        let buyer = Address::generate(env);
        let seller = Address::generate(env);
        let treasury = Address::generate(env);
        let cngn_id = env
            .register_stellar_asset_contract_v2(admin.clone())
            .address();
        let ngn_id = env
            .register_stellar_asset_contract_v2(admin.clone())
            .address();
        client.initialize(&admin, &cngn_id, &treasury, &init_fee_bps, &ngn_id);
        (contract_id, admin, buyer, seller, treasury, cngn_id, ngn_id)
    }

    /// Successful path payment deposit: buyer provides NGN, contract converts to cNGN, funds the trade.
    #[test]
    fn test_deposit_with_path_succeeds() {
        let env = Env::default();
        env.mock_all_auths();
        let (contract_id, _admin, buyer, seller, _treasury, cngn_id, ngn_id) =
            setup_path_payment_env(&env, 100);
        let client = EscrowContractClient::new(&env, &contract_id);

        let source_amount = 10_000_i128;
        let dest_min = 9_900_i128;

        let ngn_mint = token::StellarAssetClient::new(&env, &ngn_id);
        ngn_mint.mint(&buyer, &source_amount);

        let trade_id =
            client.create_trade(&buyer, &seller, &source_amount, &5000_u32, &5000_u32, &None);

        env.ledger().with_mut(|l| l.timestamp = 1_000);
        let path = Vec::new(&env);
        client.deposit_with_path(&trade_id, &buyer, &source_amount, &dest_min, &path);

        let cngn_mint = token::StellarAssetClient::new(&env, &cngn_id);
        cngn_mint.mint(&contract_id, &dest_min);

        client.finalize_path_payment(&trade_id, &buyer);

        let trade = client.get_trade(&trade_id);
        assert!(matches!(trade.status, TradeStatus::Funded));
        assert_eq!(trade.funded_at, Some(1_000));

        let ngn_balance = token::Client::new(&env, &ngn_id);
        assert_eq!(
            ngn_balance.balance(&buyer),
            0,
            "all NGN should be transferred"
        );

        assert!(
            trade.amount >= dest_min,
            "received cNGN must be >= dest_min"
        );

        let stored_source = client.get_source_token();
        assert_eq!(
            stored_source, ngn_id,
            "source token should be stored correctly"
        );
    }

    /// deposit_with_path panics if source_amount is zero.
    #[test]
    #[should_panic(expected = "source_amount must be greater than zero")]
    fn test_deposit_with_path_rejects_zero_source_amount() {
        let env = Env::default();
        env.mock_all_auths();
        let (contract_id, _admin, buyer, seller, _treasury, _cngn_id, _ngn_id) =
            setup_path_payment_env(&env, 100);
        let client = EscrowContractClient::new(&env, &contract_id);
        let trade_id =
            client.create_trade(&buyer, &seller, &10_000_i128, &5000_u32, &5000_u32, &None);
        let path = Vec::new(&env);
        client.deposit_with_path(&trade_id, &buyer, &0_i128, &1_i128, &path);
    }

    /// deposit_with_path panics if dest_min is zero.
    #[test]
    #[should_panic(expected = "dest_min must be greater than zero")]
    fn test_deposit_with_path_rejects_zero_dest_min() {
        let env = Env::default();
        env.mock_all_auths();
        let (contract_id, _admin, buyer, seller, _treasury, cngn_id, ngn_id) =
            setup_path_payment_env(&env, 100);
        let client = EscrowContractClient::new(&env, &contract_id);
        let ngn_mint = token::StellarAssetClient::new(&env, &ngn_id);
        ngn_mint.mint(&buyer, &10_000_i128);
        let cngn_mint = token::StellarAssetClient::new(&env, &cngn_id);
        cngn_mint.mint(&contract_id, &20_000_i128);
        let trade_id =
            client.create_trade(&buyer, &seller, &10_000_i128, &5000_u32, &5000_u32, &None);
        let path = Vec::new(&env);
        client.deposit_with_path(&trade_id, &buyer, &5_000_i128, &0_i128, &path);
    }

    /// deposit_with_path panics if trade is not in Created status.
    #[test]
    #[should_panic(expected = "Trade must be in Created status")]
    fn test_deposit_with_path_rejects_wrong_status() {
        let env = Env::default();
        env.mock_all_auths();
        let (contract_id, _admin, buyer, seller, _treasury, cngn_id, ngn_id) =
            setup_path_payment_env(&env, 100);
        let client = EscrowContractClient::new(&env, &contract_id);

        let ngn_mint = token::StellarAssetClient::new(&env, &ngn_id);
        ngn_mint.mint(&buyer, &20_000_i128);
        let cngn_mint = token::StellarAssetClient::new(&env, &cngn_id);
        cngn_mint.mint(&buyer, &20_000_i128);
        cngn_mint.mint(&contract_id, &20_000_i128);

        let trade_id =
            client.create_trade(&buyer, &seller, &10_000_i128, &5000_u32, &5000_u32, &None);
        client.deposit(&trade_id);
        let path = Vec::new(&env);
        client.deposit_with_path(&trade_id, &buyer, &5_000_i128, &4_900_i128, &path);
    }

    /// deposit_with_path panics if caller is not the buyer.
    #[test]
    #[should_panic]
    fn test_deposit_with_path_rejects_non_buyer() {
        let env = Env::default();
        env.mock_all_auths();
        let (contract_id, _admin, buyer, seller, _treasury, cngn_id, ngn_id) =
            setup_path_payment_env(&env, 100);
        let client = EscrowContractClient::new(&env, &contract_id);
        let ngn_mint = token::StellarAssetClient::new(&env, &ngn_id);
        ngn_mint.mint(&seller, &20_000_i128);
        let cngn_mint = token::StellarAssetClient::new(&env, &cngn_id);
        cngn_mint.mint(&buyer, &20_000_i128);
        cngn_mint.mint(&contract_id, &20_000_i128);
        let trade_id =
            client.create_trade(&buyer, &seller, &10_000_i128, &5000_u32, &5000_u32, &None);
        let path = Vec::new(&env);
        client.deposit_with_path(&trade_id, &seller, &5_000_i128, &4_900_i128, &path);
    }

    /// Full lifecycle: create_trade -> deposit_with_path -> confirm_delivery -> release_funds.
    #[test]
    fn test_path_payment_full_lifecycle() {
        let env = Env::default();
        env.mock_all_auths();
        let (contract_id, _admin, buyer, seller, _treasury, cngn_id, ngn_id) =
            setup_path_payment_env(&env, 100);
        let client = EscrowContractClient::new(&env, &contract_id);

        let source_amount = 10_000_i128;
        let dest_min = 9_900_i128;

        let ngn_mint = token::StellarAssetClient::new(&env, &ngn_id);
        ngn_mint.mint(&buyer, &source_amount);

        let trade_id =
            client.create_trade(&buyer, &seller, &source_amount, &5000_u32, &5000_u32, &None);

        let path = Vec::new(&env);
        client.deposit_with_path(&trade_id, &buyer, &source_amount, &dest_min, &path);

        let cngn_mint = token::StellarAssetClient::new(&env, &cngn_id);
        cngn_mint.mint(&contract_id, &dest_min);

        client.finalize_path_payment(&trade_id, &buyer);

        let trade = client.get_trade(&trade_id);
        assert!(matches!(trade.status, TradeStatus::Funded));

        client.confirm_delivery(&trade_id);
        let trade = client.get_trade(&trade_id);
        assert!(matches!(trade.status, TradeStatus::Delivered));

        client.release_funds(&trade_id, &buyer);
        let trade = client.get_trade(&trade_id);
        assert!(matches!(trade.status, TradeStatus::Completed));

        let cngn_token = token::Client::new(&env, &cngn_id);
        let dest_amount = trade.amount;
        let fee_bps = 100_u32;
        let fee = dest_amount * (fee_bps as i128) / 10_000;
        let seller_amount = dest_amount - fee;

        assert_eq!(cngn_token.balance(&seller), seller_amount);
        assert_eq!(client.get_accrued_fees(), fee);
        assert_eq!(cngn_token.balance(&contract_id), fee, "escrow holds accrued fees");
    }

    /// Path payment event verification: events contain correct fields.
    #[test]
    fn test_deposit_with_path_emits_correct_events() {
        let env = Env::default();
        env.mock_all_auths();
        let (contract_id, _admin, buyer, seller, _treasury, cngn_id, ngn_id) =
            setup_path_payment_env(&env, 100);
        let client = EscrowContractClient::new(&env, &contract_id);

        let source_amount = 5_000_i128;
        let dest_min = 4_900_i128;

        let ngn_mint = token::StellarAssetClient::new(&env, &ngn_id);
        ngn_mint.mint(&buyer, &source_amount);

        let trade_id =
            client.create_trade(&buyer, &seller, &source_amount, &5000_u32, &5000_u32, &None);
        let mut path = Vec::new(&env);
        path.push_back(ngn_id.clone());
        client.deposit_with_path(&trade_id, &buyer, &source_amount, &dest_min, &path);

        let cngn_mint = token::StellarAssetClient::new(&env, &cngn_id);
        cngn_mint.mint(&contract_id, &dest_min);

        client.finalize_path_payment(&trade_id, &buyer);

        let trade = client.get_trade(&trade_id);
        assert_eq!(trade.amount, dest_min);
    }

    /// Path payment: dest_min not met panics.
    #[test]
    #[should_panic(expected = "Path payment: dest_amount below dest_min")]
    fn test_deposit_with_path_panics_if_dest_min_not_met() {
        let env = Env::default();
        env.mock_all_auths();
        let (contract_id, _admin, buyer, seller, _treasury, cngn_id, ngn_id) =
            setup_path_payment_env(&env, 100);
        let client = EscrowContractClient::new(&env, &contract_id);

        let source_amount = 100_i128;
        let dest_min = 1_000_000_i128;

        let ngn_mint = token::StellarAssetClient::new(&env, &ngn_id);
        ngn_mint.mint(&buyer, &source_amount);
        let trade_id =
            client.create_trade(&buyer, &seller, &source_amount, &5000_u32, &5000_u32, &None);
        let path = Vec::new(&env);
        client.deposit_with_path(&trade_id, &buyer, &source_amount, &dest_min, &path);

        // Simulate only a small amount of cNGN arriving (less than dest_min)
        let cngn_mint = token::StellarAssetClient::new(&env, &cngn_id);
        cngn_mint.mint(&contract_id, &100_i128);

        client.finalize_path_payment(&trade_id, &buyer);
    }

    /// Path payment: works with different fee configurations.
    #[test]
    fn test_deposit_with_path_varying_fees() {
        let fee_cases = [0_u32, 50, 100, 500, 1000];
        for &fee_bps in &fee_cases {
            let env = Env::default();
            env.mock_all_auths();
            let (contract_id, _admin, buyer, seller, treasury, cngn_id, ngn_id) =
                setup_path_payment_env(&env, fee_bps);
            let client = EscrowContractClient::new(&env, &contract_id);

            let source_amount = 1_000_i128;
            let dest_min = 1_i128;

            let ngn_mint = token::StellarAssetClient::new(&env, &ngn_id);
            ngn_mint.mint(&buyer, &source_amount);
            let trade_id =
                client.create_trade(&buyer, &seller, &source_amount, &5000_u32, &5000_u32, &None);
            let path = Vec::new(&env);
            client.deposit_with_path(&trade_id, &buyer, &source_amount, &dest_min, &path);

            let cngn_mint = token::StellarAssetClient::new(&env, &cngn_id);
            let swap_result = source_amount.max(dest_min);
            cngn_mint.mint(&contract_id, &swap_result);

            client.finalize_path_payment(&trade_id, &buyer);

            client.confirm_delivery(&trade_id);
            client.release_funds(&trade_id, &buyer);

            let trade = client.get_trade(&trade_id);
            assert!(matches!(trade.status, TradeStatus::Completed));

            let cngn_token = token::Client::new(&env, &cngn_id);
            let dest_amount = trade.amount;
            let fee = dest_amount * (fee_bps as i128) / 10_000;
            let seller_amount = dest_amount - fee;

            assert_eq!(cngn_token.balance(&seller), seller_amount);
            assert_eq!(client.get_accrued_fees(), fee);
            assert_eq!(
                cngn_token.balance(&buyer),
                0,
                "buyer should have 0 cNGN after funding + release"
            );
            assert_eq!(
                cngn_token.balance(&contract_id),
                fee,
                "escrow holds accrued fees"
            );
        }
    }
    #[test]
    #[should_panic(expected = "Cannot cancel trade in current status")]
    fn test_cancel_trade_rejects_after_completed() {
        let env = Env::default();
        env.mock_all_auths();
        let (contract_id, _usdc_id, buyer, _seller, _treasury, trade_id) =
            setup_disputed_trade(&env, 10_000, 100);
        let client = EscrowContractClient::new(&env, &contract_id);
        let mediator = Address::generate(&env);
        client.set_mediator(&mediator);
        client.resolve_dispute(&trade_id, &mediator, &10_000_u32);
        let trade = client.get_trade(&trade_id);
        assert!(matches!(trade.status, TradeStatus::Completed));
        client.cancel_trade(&trade_id, &buyer);
    }

    #[test]
    #[should_panic(expected = "Cannot cancel trade in current status")]
    fn test_cancel_trade_rejects_after_cancelled() {
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
        // Admin cancels the funded trade immediately
        client.cancel_trade(&trade_id, &admin);
        assert!(matches!(
            client.get_trade(&trade_id).status,
            TradeStatus::Cancelled
        ));
        // Buyer can no longer cancel - already Cancelled
        client.cancel_trade(&trade_id, &buyer);
    }
