    use super::*;
    use soroban_sdk::testutils::{Address as _, Ledger as _};
    use soroban_sdk::{Address, Env, token};

    // -----------------------------------------------------------------------
    // Shared setup
    // -----------------------------------------------------------------------

    /// Full environment setup: registers contract, sets up USDC asset, mints
    /// `amount` tokens to buyer, initialises escrow with `fee_bps`, registers
    /// a mediator, and returns all relevant handles.
    struct Setup {
        env: Env,
        contract_id: Address,
        usdc_id: Address,
        buyer: Address,
        seller: Address,
        treasury: Address,
        mediator: Address,
    }

    impl Setup {
        fn new(amount: i128, fee_bps: u32) -> Self {
            let env = Env::default();
            env.mock_all_auths();

            let admin = crate::test_fixture::admin_address(&env);
            let buyer = Address::generate(&env);
            let seller = Address::generate(&env);
            let treasury = Address::generate(&env);
            let mediator = Address::generate(&env);

            let contract_id = env.register(EscrowContract, ());
            let client = EscrowContractClient::new(&env, &contract_id);

            let usdc_id = env
                .register_stellar_asset_contract_v2(admin.clone())
                .address();
            let mint_client = token::StellarAssetClient::new(&env, &usdc_id);
            mint_client.mint(&buyer, &amount);

            client.initialize(&admin, &usdc_id, &treasury, &fee_bps, &usdc_id);
            client.set_mediator(&mediator);

            Setup {
                env,
                contract_id,
                usdc_id,
                buyer,
                seller,
                treasury,
                mediator,
            }
        }

        fn client(&self) -> EscrowContractClient<'_> {
            EscrowContractClient::new(&self.env, &self.contract_id)
        }

        fn token(&self) -> token::Client<'_> {
            token::Client::new(&self.env, &self.usdc_id)
        }
    }

    /// Create a trade and immediately deposit funds. Returns the trade_id.
    fn create_and_fund(s: &Setup, amount: i128) -> u64 {
        let client = s.client();
        let trade_id =
            client.create_trade(&s.buyer, &s.seller, &amount, &5000_u32, &5000_u32, &None);
        client.deposit(&trade_id);
        trade_id
    }

    // -----------------------------------------------------------------------
    // Integration test 1: Full lifecycle — 50/50 split
    //
    // Scenario:
    //   Both parties contest; mediator rules 50/50.
    //
    //   total = 10_000, seller_payout_bps = 5_000 (50%), fee_bps = 100 (1%)
    //   seller_raw   = 5_000
    //   fee          =    50   ← 1% only on seller's 50%
    //   seller_net   = 4_950  → seller
    //   buyer_refund = 5_000  → buyer
    //   treasury     =    50  → treasury
    // -----------------------------------------------------------------------
    #[test]
    fn test_integration_full_lifecycle_50_50_split() {
        let amount = 10_000_i128;
        let s = Setup::new(amount, 100);
        let client = s.client();
        let token = s.token();

        // ── Step 1: Create trade ────────────────────────────────────────────
        s.env.ledger().with_mut(|l| l.timestamp = 1_000);
        let trade_id =
            client.create_trade(&s.buyer, &s.seller, &amount, &5000_u32, &5000_u32, &None);

        let trade = client.get_trade(&trade_id);
        assert!(
            matches!(trade.status, TradeStatus::Created),
            "Step 1: must be Created"
        );
        assert_eq!(trade.created_at, 1_000);

        // ── Step 2: Fund (deposit) ──────────────────────────────────────────
        s.env.ledger().with_mut(|l| l.timestamp = 2_000);
        client.deposit(&trade_id);

        let trade = client.get_trade(&trade_id);
        assert!(
            matches!(trade.status, TradeStatus::Funded),
            "Step 2: must be Funded"
        );
        assert_eq!(trade.funded_at, Some(2_000));
        assert_eq!(
            token.balance(&s.contract_id),
            amount,
            "Step 2: escrow must hold funds"
        );
        assert_eq!(
            token.balance(&s.buyer),
            0,
            "Step 2: buyer balance must be 0"
        );

        // ── Step 3: Raise dispute ───────────────────────────────────────────
        s.env.ledger().with_mut(|l| l.timestamp = 3_000);
        let dispute_reason = soroban_sdk::String::from_str(&s.env, "QmBuyerDisputeReason");
        client.initiate_dispute(&trade_id, &s.buyer, &dispute_reason);

        let trade = client.get_trade(&trade_id);
        assert!(
            matches!(trade.status, TradeStatus::Disputed),
            "Step 3: must be Disputed"
        );
        // Funds still locked in escrow
        assert_eq!(
            token.balance(&s.contract_id),
            amount,
            "Step 3: funds must still be in escrow"
        );

        // ── Step 4: Submit evidence (both parties) ──────────────────────────
        s.env.ledger().with_mut(|l| l.timestamp = 4_000);
        let buyer_ipfs = soroban_sdk::String::from_str(&s.env, "QmBuyerEvidenceHash");
        let buyer_desc = soroban_sdk::String::from_str(&s.env, "Buyer proof of payment");
        let seller_ipfs = soroban_sdk::String::from_str(&s.env, "QmSellerEvidenceHash");
        let seller_desc = soroban_sdk::String::from_str(&s.env, "Seller proof of shipment");

        client.submit_evidence(&trade_id, &s.buyer, &buyer_ipfs, &buyer_desc);
        client.submit_evidence(&trade_id, &s.seller, &seller_ipfs, &seller_desc);

        // Evidence retrievable on-chain via new list API
        let evidence_list = client.get_evidence_list(&trade_id);
        assert_eq!(
            evidence_list.len(),
            2,
            "Step 4: should have 2 evidence records"
        );
        assert_eq!(evidence_list.get(0).unwrap().submitter, s.buyer);
        assert_eq!(evidence_list.get(0).unwrap().ipfs_hash, buyer_ipfs);
        assert_eq!(evidence_list.get(1).unwrap().submitter, s.seller);
        assert_eq!(evidence_list.get(1).unwrap().ipfs_hash, seller_ipfs);

        // Trade still Disputed while mediator reviews
        assert!(matches!(
            client.get_trade(&trade_id).status,
            TradeStatus::Disputed
        ));

        // ── Step 5: Mediator resolves — 50/50 ──────────────────────────────
        s.env.ledger().with_mut(|l| l.timestamp = 5_000);
        client.resolve_dispute(&trade_id, &s.mediator, &5_000_u32);

        // ── Step 6: Verify final state ──────────────────────────────────────
        let trade = client.get_trade(&trade_id);
        assert!(
            matches!(trade.status, TradeStatus::Completed),
            "Step 6: must be Completed"
        );
        assert_eq!(trade.updated_at, 5_000);

        // With 50/50 loss-sharing and 50/50 mediator ruling:
        // loss = 50%, seller bears 50% of loss = 2,500
        // seller_raw = 10,000 - 2,500 = 7,500
        // fee = 75, seller_net = 7,425
        // buyer_refund = 2,500
        assert_eq!(token.balance(&s.seller), 7_425, "seller_net mismatch");
        assert_eq!(client.get_accrued_fees(), 75, "fee mismatch");
        assert_eq!(token.balance(&s.buyer), 2_500, "buyer_refund mismatch");
        assert_eq!(token.balance(&s.contract_id), client.get_accrued_fees(), "escrow holds accrued fees");
    }

    // -----------------------------------------------------------------------
    // Integration test 2: Full lifecycle — full seller blame
    //
    //   total = 10_000, seller_payout_bps = 10_000 (100%), fee_bps = 100
    //   seller_net   =  9_900 → seller
    //   fee          =    100 → treasury
    //   buyer_refund =      0 → buyer (nothing)
    // -----------------------------------------------------------------------
    #[test]
    fn test_integration_full_lifecycle_full_seller_payout() {
        let amount = 10_000_i128;
        let s = Setup::new(amount, 100);
        let client = s.client();
        let token = s.token();

        // Create → Fund
        s.env.ledger().with_mut(|l| l.timestamp = 1_000);
        let trade_id = create_and_fund(&s, amount);
        assert!(matches!(
            client.get_trade(&trade_id).status,
            TradeStatus::Funded
        ));

        // Seller initiates dispute this time
        s.env.ledger().with_mut(|l| l.timestamp = 2_000);
        let dispute_reason = soroban_sdk::String::from_str(&s.env, "QmSellerDisputeReason");
        client.initiate_dispute(&trade_id, &s.seller, &dispute_reason);
        assert!(matches!(
            client.get_trade(&trade_id).status,
            TradeStatus::Disputed
        ));

        // Seller submits evidence; buyer submits none
        let ipfs_hash = soroban_sdk::String::from_str(&s.env, "QmSellerProofOfDelivery");
        let desc_hash = soroban_sdk::String::from_str(&s.env, "Delivery confirmation");
        client.submit_evidence(&trade_id, &s.seller, &ipfs_hash, &desc_hash);

        let evidence_list = client.get_evidence_list(&trade_id);
        assert_eq!(evidence_list.len(), 1);
        assert_eq!(evidence_list.get(0).unwrap().submitter, s.seller);

        // Mediator rules fully for seller
        s.env.ledger().with_mut(|l| l.timestamp = 3_000);
        client.resolve_dispute(&trade_id, &s.mediator, &10_000_u32);

        assert!(matches!(
            client.get_trade(&trade_id).status,
            TradeStatus::Completed
        ));
        assert_eq!(token.balance(&s.seller), 9_900);
        assert_eq!(client.get_accrued_fees(), 100);
        assert_eq!(token.balance(&s.buyer), 0);
        assert_eq!(token.balance(&s.contract_id), client.get_accrued_fees());
    }

    // -----------------------------------------------------------------------
    // Integration test 3: Full lifecycle — full buyer refund (duplicate)
    //
    // With 50/50 loss-sharing and seller_gets_bps = 0:
    //   total = 10_000, seller_gets_bps = 0 (0%), fee_bps = 100
    //   loss = 100%, seller bears 50% = 5,000
    //   seller_raw = 10,000 - 5,000 = 5,000
    //   fee = 50, seller_net = 4,950
    //   buyer_refund = 5,000
    // -----------------------------------------------------------------------
    #[test]
    fn test_integration_full_lifecycle_full_buyer_refund() {
        let amount = 10_000_i128;
        let s = Setup::new(amount, 100);
        let client = s.client();
        let token = s.token();

        let trade_id = create_and_fund(&s, amount);
        let dispute_reason = soroban_sdk::String::from_str(&s.env, "QmBuyerRefundReason");
        client.initiate_dispute(&trade_id, &s.buyer, &dispute_reason);

        let ipfs_hash = soroban_sdk::String::from_str(&s.env, "QmBuyerProofNonDelivery");
        let desc_hash = soroban_sdk::String::from_str(&s.env, "Proof seller never delivered");
        client.submit_evidence(&trade_id, &s.buyer, &ipfs_hash, &desc_hash);

        client.resolve_dispute(&trade_id, &s.mediator, &0_u32);

        assert_eq!(token.balance(&s.buyer), 5_000);
        assert_eq!(token.balance(&s.seller), 4_950);
        assert_eq!(client.get_accrued_fees(), 50);
        assert_eq!(token.balance(&s.contract_id), client.get_accrued_fees());
    }

    // -----------------------------------------------------------------------
    // Out-of-order guard tests
    // -----------------------------------------------------------------------

    /// Cannot initiate a dispute before the trade has been funded.
    #[test]
    #[should_panic(expected = "Trade must be in Funded status to initiate a dispute")]
    fn test_cannot_raise_dispute_before_funding() {
        let s = Setup::new(10_000, 100);
        let client = s.client();
        let trade_id = client.create_trade(
            &s.buyer,
            &s.seller,
            &10_000_i128,
            &5000_u32,
            &5000_u32,
            &None,
        );
        // deposit deliberately skipped — trade is still Created
        let dispute_reason = soroban_sdk::String::from_str(&s.env, "QmPrematureDispute");
        client.initiate_dispute(&trade_id, &s.buyer, &dispute_reason);
    }

    /// Cannot initiate a dispute after delivery has already been confirmed.
    #[test]
    #[should_panic(expected = "Trade must be in Funded status to initiate a dispute")]
    fn test_cannot_raise_dispute_after_delivery_confirmed() {
        let s = Setup::new(10_000, 100);
        let client = s.client();
        let trade_id = create_and_fund(&s, 10_000);
        client.confirm_delivery(&trade_id); // Funded → Delivered
        // Now in Delivered status — initiate_dispute must panic
        let dispute_reason = soroban_sdk::String::from_str(&s.env, "QmLateDispute");
        client.initiate_dispute(&trade_id, &s.buyer, &dispute_reason);
    }

    /// Cannot submit evidence unless the trade is in Disputed status.
    #[test]
    #[should_panic(expected = "Evidence can only be submitted for a Disputed trade")]
    fn test_cannot_submit_evidence_before_dispute_raised() {
        let s = Setup::new(10_000, 100);
        let client = s.client();
        let trade_id = create_and_fund(&s, 10_000);
        // Trade is Funded, not Disputed
        let ipfs_hash = soroban_sdk::String::from_str(&s.env, "QmPrematureEvidence");
        let desc_hash = soroban_sdk::String::from_str(&s.env, "Premature attempt");
        client.submit_evidence(&trade_id, &s.buyer, &ipfs_hash, &desc_hash);
    }

    /// Cannot resolve a dispute that was never raised (trade is Funded, not Disputed).
    #[test]
    #[should_panic(expected = "Trade must be in Disputed status")]
    fn test_cannot_resolve_without_raising_dispute_first() {
        let s = Setup::new(10_000, 100);
        let client = s.client();
        let trade_id = create_and_fund(&s, 10_000);
        // initiate_dispute deliberately skipped
        client.resolve_dispute(&trade_id, &s.mediator, &5_000_u32);
    }

    /// Cannot resolve the same trade twice once it is already Completed.
    #[test]
    #[should_panic(expected = "Trade must be in Disputed status")]
    fn test_cannot_resolve_dispute_twice() {
        let s = Setup::new(10_000, 100);
        let client = s.client();
        let trade_id = create_and_fund(&s, 10_000);
        let dispute_reason = soroban_sdk::String::from_str(&s.env, "QmDuplicateResolution");
        client.initiate_dispute(&trade_id, &s.buyer, &dispute_reason);
        client.resolve_dispute(&trade_id, &s.mediator, &5_000_u32); // first resolution OK
        client.resolve_dispute(&trade_id, &s.mediator, &5_000_u32); // second must panic
    }

    /// A stranger (neither buyer nor seller) cannot raise a dispute.
    #[test]
    #[should_panic(expected = "Only the buyer or seller can initiate a dispute")]
    fn test_stranger_cannot_raise_dispute() {
        let s = Setup::new(10_000, 100);
        let client = s.client();
        let trade_id = create_and_fund(&s, 10_000);
        let stranger = Address::generate(&s.env);
        let dispute_reason = soroban_sdk::String::from_str(&s.env, "QmMaliciousDispute");
        client.initiate_dispute(&trade_id, &stranger, &dispute_reason);
    }

    /// A stranger cannot submit evidence for an active dispute.
    #[test]
    #[should_panic(expected = "Only buyer, seller, or mediator can submit evidence")]
    fn test_stranger_cannot_submit_evidence() {
        let s = Setup::new(10_000, 100);
        let client = s.client();
        let trade_id = create_and_fund(&s, 10_000);
        let dispute_reason = soroban_sdk::String::from_str(&s.env, "QmEvidenceDispute");
        client.initiate_dispute(&trade_id, &s.buyer, &dispute_reason);
        let stranger = Address::generate(&s.env);
        let ipfs_hash = soroban_sdk::String::from_str(&s.env, "QmMaliciousAttempt");
        let desc_hash = soroban_sdk::String::from_str(&s.env, "Malicious evidence");
        client.submit_evidence(&trade_id, &stranger, &ipfs_hash, &desc_hash);
    }

    // -----------------------------------------------------------------------
    // Evidence submission tests
    // -----------------------------------------------------------------------

    /// Buyer can submit evidence during an active dispute.
    #[test]
    fn test_buyer_can_submit_evidence_during_dispute() {
        let s = Setup::new(10_000, 100);
        let client = s.client();
        let trade_id = create_and_fund(&s, 10_000);

        // Raise dispute
        s.env.ledger().with_mut(|l| l.timestamp = 1_000);
        let dispute_reason = soroban_sdk::String::from_str(&s.env, "QmBuyerEvidenceDispute");
        client.initiate_dispute(&trade_id, &s.buyer, &dispute_reason);

        // Buyer submits evidence
        s.env.ledger().with_mut(|l| l.timestamp = 2_000);
        let ipfs_hash = soroban_sdk::String::from_str(&s.env, "QmBuyerEvidence123");
        let desc_hash = soroban_sdk::String::from_str(&s.env, "Payment proof");
        client.submit_evidence(&trade_id, &s.buyer, &ipfs_hash, &desc_hash);

        // Verify evidence was stored
        let evidence_list = client.get_evidence_list(&trade_id);
        assert_eq!(evidence_list.len(), 1);

        let record = evidence_list.get(0).unwrap();
        assert_eq!(record.submitter, s.buyer);
        assert_eq!(record.ipfs_hash, ipfs_hash);
        assert_eq!(record.description_hash, desc_hash);
        assert_eq!(record.submitted_at, 2_000);
    }

    /// Multiple evidence entries accumulate in chronological order.
    #[test]
    fn test_multiple_evidence_entries_accumulate() {
        let s = Setup::new(10_000, 100);
        let client = s.client();
        let trade_id = create_and_fund(&s, 10_000);

        // Raise dispute
        s.env.ledger().with_mut(|l| l.timestamp = 1_000);
        let dispute_reason = soroban_sdk::String::from_str(&s.env, "QmMultiEvidenceDispute");
        client.initiate_dispute(&trade_id, &s.buyer, &dispute_reason);

        // Buyer submits first evidence
        s.env.ledger().with_mut(|l| l.timestamp = 2_000);
        let buyer_ipfs_1 = soroban_sdk::String::from_str(&s.env, "QmBuyerEvidence1");
        let buyer_desc_1 = soroban_sdk::String::from_str(&s.env, "Payment receipt");
        client.submit_evidence(&trade_id, &s.buyer, &buyer_ipfs_1, &buyer_desc_1);

        // Seller submits evidence
        s.env.ledger().with_mut(|l| l.timestamp = 3_000);
        let seller_ipfs = soroban_sdk::String::from_str(&s.env, "QmSellerEvidence1");
        let seller_desc = soroban_sdk::String::from_str(&s.env, "Shipping label");
        client.submit_evidence(&trade_id, &s.seller, &seller_ipfs, &seller_desc);

        // Buyer submits second evidence
        s.env.ledger().with_mut(|l| l.timestamp = 4_000);
        let buyer_ipfs_2 = soroban_sdk::String::from_str(&s.env, "QmBuyerEvidence2");
        let buyer_desc_2 = soroban_sdk::String::from_str(&s.env, "Communication logs");
        client.submit_evidence(&trade_id, &s.buyer, &buyer_ipfs_2, &buyer_desc_2);

        // Mediator submits evidence
        s.env.ledger().with_mut(|l| l.timestamp = 5_000);
        let mediator_ipfs = soroban_sdk::String::from_str(&s.env, "QmMediatorAnalysis");
        let mediator_desc = soroban_sdk::String::from_str(&s.env, "Case analysis");
        client.submit_evidence(&trade_id, &s.mediator, &mediator_ipfs, &mediator_desc);

        // Verify all evidence is stored in chronological order
        let evidence_list = client.get_evidence_list(&trade_id);
        assert_eq!(evidence_list.len(), 4, "Should have 4 evidence records");

        // Check first entry (buyer)
        let record_0 = evidence_list.get(0).unwrap();
        assert_eq!(record_0.submitter, s.buyer);
        assert_eq!(record_0.ipfs_hash, buyer_ipfs_1);
        assert_eq!(record_0.submitted_at, 2_000);

        // Check second entry (seller)
        let record_1 = evidence_list.get(1).unwrap();
        assert_eq!(record_1.submitter, s.seller);
        assert_eq!(record_1.ipfs_hash, seller_ipfs);
        assert_eq!(record_1.submitted_at, 3_000);

        // Check third entry (buyer again)
        let record_2 = evidence_list.get(2).unwrap();
        assert_eq!(record_2.submitter, s.buyer);
        assert_eq!(record_2.ipfs_hash, buyer_ipfs_2);
        assert_eq!(record_2.submitted_at, 4_000);

        // Check fourth entry (mediator)
        let record_3 = evidence_list.get(3).unwrap();
        assert_eq!(record_3.submitter, s.mediator);
        assert_eq!(record_3.ipfs_hash, mediator_ipfs);
        assert_eq!(record_3.submitted_at, 5_000);
    }

    /// Evidence submission fails if trade is not in Disputed status.
    #[test]
    #[should_panic(expected = "Evidence can only be submitted for a Disputed trade")]
    fn test_evidence_submission_fails_if_not_in_dispute() {
        let s = Setup::new(10_000, 100);
        let client = s.client();
        let trade_id = create_and_fund(&s, 10_000);

        // Trade is Funded, not Disputed
        let ipfs_hash = soroban_sdk::String::from_str(&s.env, "QmEarlyEvidence");
        let desc_hash = soroban_sdk::String::from_str(&s.env, "Too early");
        client.submit_evidence(&trade_id, &s.buyer, &ipfs_hash, &desc_hash);
    }

    // -----------------------------------------------------------------------
    // Video proof tests
    // -----------------------------------------------------------------------

    /// Buyer can submit video proof for a funded trade; record is stored correctly.
    #[test]
    fn test_video_proof_stored_correctly() {
        let s = Setup::new(10_000, 100);
        let client = s.client();
        let trade_id = create_and_fund(&s, 10_000);

        s.env.ledger().with_mut(|l| l.timestamp = 5_000);
        let cid = soroban_sdk::String::from_str(&s.env, "QmVideoProofCID123");
        client.submit_video_proof(&trade_id, &s.buyer, &cid);

        let proof = client.get_video_proof(&trade_id).expect("proof must exist");
        assert_eq!(proof.submitter, s.buyer);
        assert_eq!(proof.ipfs_cid, cid);
        assert_eq!(proof.submitted_at, 5_000);
    }

    /// Video proof submission fails when the trade is not Funded or Disputed.
    #[test]
    #[should_panic(expected = "Video proof can only be submitted for a Funded or Disputed trade")]
    fn test_video_proof_fails_on_wrong_status() {
        let s = Setup::new(10_000, 100);
        let client = s.client();

        // Trade is Created (not yet funded)
        let trade_id = client.create_trade(
            &s.buyer,
            &s.seller,
            &10_000_i128,
            &5000_u32,
            &5000_u32,
            &None,
        );

        let cid = soroban_sdk::String::from_str(&s.env, "QmTooEarlyCID");
        client.submit_video_proof(&trade_id, &s.buyer, &cid);
    }

    /// A second call to submit_video_proof for the same trade must panic.
    #[test]
    #[should_panic(expected = "Video proof already submitted for this trade")]
    fn test_video_proof_cannot_be_overwritten() {
        let s = Setup::new(10_000, 100);
        let client = s.client();
        let trade_id = create_and_fund(&s, 10_000);

        let cid1 = soroban_sdk::String::from_str(&s.env, "QmFirstProof");
        client.submit_video_proof(&trade_id, &s.buyer, &cid1);

        // Second submission must panic
        let cid2 = soroban_sdk::String::from_str(&s.env, "QmSecondProof");
        client.submit_video_proof(&trade_id, &s.seller, &cid2);
    }

    /// Evidence submission fails after dispute is resolved.
    #[test]
    #[should_panic(expected = "Evidence can only be submitted for a Disputed trade")]
    fn test_evidence_submission_fails_after_dispute_resolved() {
        let s = Setup::new(10_000, 100);
        let client = s.client();
        let trade_id = create_and_fund(&s, 10_000);

        // Raise dispute
        s.env.ledger().with_mut(|l| l.timestamp = 1_000);
        let dispute_reason = soroban_sdk::String::from_str(&s.env, "QmDisputeReason");
        client.initiate_dispute(&trade_id, &s.buyer, &dispute_reason);

        // Resolve dispute
        s.env.ledger().with_mut(|l| l.timestamp = 2_000);
        client.resolve_dispute(&trade_id, &s.mediator, &10_000_u32);

        // Try to submit evidence after resolution - should fail
        s.env.ledger().with_mut(|l| l.timestamp = 3_000);
        let ipfs_hash = soroban_sdk::String::from_str(&s.env, "QmLateEvidence");
        let desc_hash = soroban_sdk::String::from_str(&s.env, "Too late");
        client.submit_evidence(&trade_id, &s.buyer, &ipfs_hash, &desc_hash);
    }

    /// Evidence list is empty for trades without disputes.
    #[test]
    fn test_evidence_list_empty_for_non_disputed_trade() {
        let s = Setup::new(10_000, 100);
        let client = s.client();
        let trade_id = create_and_fund(&s, 10_000);

        // Trade is Funded, no dispute raised
        let evidence_list = client.get_evidence_list(&trade_id);
        assert_eq!(
            evidence_list.len(),
            0,
            "Evidence list should be empty for non-disputed trade"
        );

        // Confirm delivery (no dispute path)
        client.confirm_delivery(&trade_id);

        // Evidence list should still be empty
        let evidence_list_after = client.get_evidence_list(&trade_id);
        assert_eq!(
            evidence_list_after.len(),
            0,
            "Evidence list should remain empty after delivery confirmation"
        );
    }

    // -----------------------------------------------------------------------
    // Additional comprehensive tests
    // -----------------------------------------------------------------------

    /// Test asymmetric loss-sharing with mediator ruling favoring buyer
    /// Tests 30/70 loss-sharing (buyer bears 30%, seller bears 70%) with 40% seller ruling
    /// This validates the contract handles asymmetric ratios correctly when buyer wins
    #[test]
    fn test_asymmetric_loss_sharing_buyer_favored() {
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

        // Create trade with 30/70 loss-sharing (seller bears 70% of loss)
        let trade_id = client.create_trade(&buyer, &seller, &amount, &3000_u32, &7000_u32, &None);
        client.deposit(&trade_id);
        let reason = soroban_sdk::String::from_str(&env, "QmAsymmetricDispute");
        client.initiate_dispute(&trade_id, &buyer, &reason);

        let mediator = Address::generate(&env);
        client.set_mediator(&mediator);

        // Mediator rules 40% for seller (60% loss - buyer wins)
        // loss = 60% = 6,000
        // seller bears: 6,000 * 70% = 4,200
        // buyer bears: 6,000 * 30% = 1,800
        // seller_raw = 10,000 - 4,200 = 5,800
        // fee = 5,800 * 1% = 58
        // seller_net = 5,742
        // buyer_refund = 4,200
        client.resolve_dispute(&trade_id, &mediator, &4_000_u32);

        let token = token::Client::new(&env, &usdc_id);
        assert_eq!(token.balance(&seller), 5_742, "seller with 70% loss burden");
        assert_eq!(client.get_accrued_fees(), 58, "fee on seller portion");
        assert_eq!(
            token.balance(&buyer),
            4_200,
            "buyer refund with 30% loss burden"
        );
        assert_eq!(token.balance(&client.address), 58, "escrow holds accrued fees");

        // Verify total adds up
        assert_eq!(
            5_742 + 58 + 4_200,
            10_000,
            "total must equal original amount"
        );
    }

    /// Test complete dispute lifecycle with evidence submission and resolution
    /// This integration test validates the entire flow from trade creation to resolution
    /// including multiple evidence submissions from all parties
    #[test]
    fn test_complete_dispute_lifecycle_with_evidence() {
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

        let amount = 50_000_i128;
        let token_client = token::StellarAssetClient::new(&env, &usdc_id);
        token_client.mint(&buyer, &amount);

        // Step 1: Create trade with 50/50 loss-sharing
        env.ledger().with_mut(|l| l.timestamp = 1_000);
        let trade_id = client.create_trade(&buyer, &seller, &amount, &5000_u32, &5000_u32, &None);
        let trade = client.get_trade(&trade_id);
        assert!(matches!(trade.status, TradeStatus::Created));
        assert_eq!(trade.amount, amount);

        // Step 2: Buyer deposits funds
        env.ledger().with_mut(|l| l.timestamp = 2_000);
        client.deposit(&trade_id);
        let trade = client.get_trade(&trade_id);
        assert!(matches!(trade.status, TradeStatus::Funded));
        assert_eq!(token_client.balance(&contract_id), amount);

        // Step 3: Buyer initiates dispute with reason
        env.ledger().with_mut(|l| l.timestamp = 3_000);
        let dispute_reason =
            soroban_sdk::String::from_str(&env, "QmDisputeReason_GoodsNotAsDescribed");
        client.initiate_dispute(&trade_id, &buyer, &dispute_reason);
        let trade = client.get_trade(&trade_id);
        assert!(matches!(trade.status, TradeStatus::Disputed));

        let dispute_record = client
            .get_dispute_record(&trade_id)
            .expect("dispute record must exist");
        assert_eq!(dispute_record.initiator, buyer);
        assert_eq!(dispute_record.reason_hash, dispute_reason);

        // Step 4: Buyer submits evidence
        env.ledger().with_mut(|l| l.timestamp = 4_000);
        let buyer_evidence =
            soroban_sdk::String::from_str(&env, "QmBuyerEvidence_PhotosOfDamagedGoods");
        let buyer_desc =
            soroban_sdk::String::from_str(&env, "Photos showing damaged agricultural products");
        client.submit_evidence(&trade_id, &buyer, &buyer_evidence, &buyer_desc);

        // Step 5: Seller submits counter-evidence
        env.ledger().with_mut(|l| l.timestamp = 5_000);
        let seller_evidence =
            soroban_sdk::String::from_str(&env, "QmSellerEvidence_PackagingAndShipping");
        let seller_desc = soroban_sdk::String::from_str(
            &env,
            "Proof of proper packaging and shipping documentation",
        );
        client.submit_evidence(&trade_id, &seller, &seller_evidence, &seller_desc);

        // Step 6: Register mediator and submit independent evidence
        let mediator = Address::generate(&env);
        client.add_mediator(&mediator);

        env.ledger().with_mut(|l| l.timestamp = 6_000);
        let mediator_evidence =
            soroban_sdk::String::from_str(&env, "QmMediatorEvidence_InspectionReport");
        let mediator_desc = soroban_sdk::String::from_str(&env, "Independent inspection findings");
        client.submit_evidence(&trade_id, &mediator, &mediator_evidence, &mediator_desc);

        // Verify all evidence is recorded
        let evidence_list = client.get_evidence_list(&trade_id);
        assert_eq!(evidence_list.len(), 3, "should have 3 evidence records");

        // Step 7: Mediator resolves dispute (65% for seller, 35% loss)
        env.ledger().with_mut(|l| l.timestamp = 7_000);
        client.set_mediator(&mediator);
        client.resolve_dispute(&trade_id, &mediator, &6_500_u32);

        // Step 8: Verify final state
        let trade = client.get_trade(&trade_id);
        assert!(matches!(trade.status, TradeStatus::Completed));

        // Calculate expected amounts:
        // loss = 35% = 17,500
        // seller bears: 17,500 * 50% = 8,750
        // seller_raw = 50,000 - 8,750 = 41,250
        // fee = 41,250 * 1% = 412.5 = 412 (integer division)
        // seller_net = 41,250 - 412 = 40,838
        // buyer_refund = 8,750

        let token = token::Client::new(&env, &usdc_id);
        assert_eq!(token.balance(&seller), 40_838, "seller final payout");
        assert_eq!(token.balance(&buyer), 8_750, "buyer refund");
        assert_eq!(client.get_accrued_fees(), 412, "platform fee");
        assert_eq!(
            token.balance(&contract_id),
            client.get_accrued_fees(),
            "escrow holds accrued fees"
        );

        // Verify evidence remains accessible after resolution
        let evidence_list_final = client.get_evidence_list(&trade_id);
        assert_eq!(
            evidence_list_final.len(),
            3,
            "evidence preserved after resolution"
        );
    }

    /// Test edge case: very small amounts with loss-sharing and fee calculation
    /// Validates that integer division doesn't cause rounding errors that break invariants
    #[test]
    fn test_small_amount_loss_sharing_rounding() {
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

        // Use a small amount to test rounding behavior
        let amount = 100_i128;
        let token_client = token::StellarAssetClient::new(&env, &usdc_id);
        token_client.mint(&buyer, &amount);

        // Create trade with 60/40 loss-sharing
        let trade_id = client.create_trade(&buyer, &seller, &amount, &6000_u32, &4000_u32, &None);
        client.deposit(&trade_id);
        let reason = soroban_sdk::String::from_str(&env, "QmSmallAmountDispute");
        client.initiate_dispute(&trade_id, &buyer, &reason);

        let mediator = Address::generate(&env);
        client.set_mediator(&mediator);

        // Mediator rules 55% for seller (45% loss)
        // loss = 45% of 100 = 45
        // seller bears: 45 * 40% = 18
        // buyer bears: 45 * 60% = 27
        // seller_raw = 100 - 18 = 82
        // fee = 82 * 1% = 0.82 = 0 (integer division)
        // seller_net = 82 - 0 = 82
        // buyer_refund = 18
        client.resolve_dispute(&trade_id, &mediator, &5_500_u32);

        let token = token::Client::new(&env, &usdc_id);
        let seller_balance = token.balance(&seller);
        let buyer_balance = token.balance(&buyer);
        let treasury_balance = client.get_accrued_fees();
        let escrow_balance = token.balance(&client.address);

        // Verify no funds are lost or created
        let total = seller_balance + buyer_balance + treasury_balance + escrow_balance;
        assert_eq!(
            total, amount,
            "total must equal original amount - no rounding loss"
        );

        // Verify escrow is empty
        assert_eq!(escrow_balance, 0, "escrow must be fully distributed");

        // Verify seller got the majority (since 55% ruling)
        assert!(
            seller_balance > buyer_balance,
            "seller should receive more than buyer"
        );

        // Log actual distribution for verification
        assert_eq!(seller_balance, 82, "seller receives 82");
        assert_eq!(buyer_balance, 18, "buyer receives 18");
        assert_eq!(treasury_balance, 0, "treasury receives 0 (fee too small)");
    }

    // -----------------------------------------------------------------------
    // Mediator revocation tests
    // -----------------------------------------------------------------------

    fn setup_base(env: &Env) -> (Address, Address, Address, Address) {
        let contract_id = env.register(EscrowContract, ());
        let admin = crate::test_fixture::admin_address(env);
        let treasury = Address::generate(env);
        let usdc_id = env
            .register_stellar_asset_contract_v2(admin.clone())
            .address();
        let client = EscrowContractClient::new(env, &contract_id);
        client.initialize(&admin, &usdc_id, &treasury, &0_u32, &usdc_id);
        (contract_id, admin, usdc_id, treasury)
    }

    /// A mediator registered via set_mediator() then removed must not be able to resolve disputes.
    #[test]
    #[should_panic(expected = "Unauthorized mediator")]
    fn test_legacy_mediator_cannot_resolve_after_remove() {
        let env = Env::default();
        env.mock_all_auths();

        let (contract_id, _admin, usdc_id, _treasury) = setup_base(&env);
        let client = EscrowContractClient::new(&env, &contract_id);

        let mediator = Address::generate(&env);
        let buyer = Address::generate(&env);
        let seller = Address::generate(&env);

        // Register via legacy set_mediator
        client.set_mediator(&mediator);

        // Confirm mediator is currently authorized
        assert!(
            client.is_mediator(&mediator),
            "mediator should be registered"
        );

        // Fund a trade and initiate a dispute
        let amount = 1000_i128;
        let token_client = token::StellarAssetClient::new(&env, &usdc_id);
        token_client.mint(&buyer, &amount);
        let trade_id = client.create_trade(&buyer, &seller, &amount, &5000_u32, &5000_u32, &None);
        client.deposit(&trade_id);
        client.initiate_dispute(&trade_id, &buyer, &String::from_str(&env, "reason"));

        // Remove the mediator — must clear both registry and legacy slot
        client.remove_mediator(&mediator);
        assert!(
            !client.is_mediator(&mediator),
            "mediator should be deregistered"
        );

        // Attempt to resolve — must panic with "Unauthorized mediator"
        client.resolve_dispute(&trade_id, &mediator, &10_000_u32);
    }

    /// A mediator registered via add_mediator() then removed must not be able to resolve disputes.
    #[test]
    #[should_panic(expected = "Unauthorized mediator")]
    fn test_registry_mediator_cannot_resolve_after_remove() {
        let env = Env::default();
        env.mock_all_auths();

        let (contract_id, _admin, usdc_id, _treasury) = setup_base(&env);
        let client = EscrowContractClient::new(&env, &contract_id);

        let mediator = Address::generate(&env);
        let buyer = Address::generate(&env);
        let seller = Address::generate(&env);

        // Register via registry add_mediator
        client.add_mediator(&mediator);
        assert!(
            client.is_mediator(&mediator),
            "mediator should be registered"
        );

        // Fund a trade and initiate a dispute
        let amount = 1000_i128;
        let token_client = token::StellarAssetClient::new(&env, &usdc_id);
        token_client.mint(&buyer, &amount);
        let trade_id = client.create_trade(&buyer, &seller, &amount, &5000_u32, &5000_u32, &None);
        client.deposit(&trade_id);
        client.initiate_dispute(&trade_id, &buyer, &String::from_str(&env, "reason"));

        // Remove the mediator
        client.remove_mediator(&mediator);
        assert!(
            !client.is_mediator(&mediator),
            "mediator should be deregistered"
        );

        // Attempt to resolve — must panic with "Unauthorized mediator"
        client.resolve_dispute(&trade_id, &mediator, &10_000_u32);
    }

    /// A mediator set via set_mediator() but NOT removed should still be able to resolve.
    #[test]
    fn test_legacy_mediator_can_resolve_when_not_removed() {
        let env = Env::default();
        env.mock_all_auths();

        let (contract_id, _admin, usdc_id, _treasury) = setup_base(&env);
        let client = EscrowContractClient::new(&env, &contract_id);

        let mediator = Address::generate(&env);
        let buyer = Address::generate(&env);
        let seller = Address::generate(&env);

        client.set_mediator(&mediator);

        let amount = 1000_i128;
        let token_client = token::StellarAssetClient::new(&env, &usdc_id);
        token_client.mint(&buyer, &amount);
        let trade_id = client.create_trade(&buyer, &seller, &amount, &5000_u32, &5000_u32, &None);
        client.deposit(&trade_id);
        client.initiate_dispute(&trade_id, &buyer, &String::from_str(&env, "reason"));

        // resolve_dispute must succeed (no panic)
        client.resolve_dispute(&trade_id, &mediator, &10_000_u32);

        let trade = client.get_trade(&trade_id);
        assert!(matches!(trade.status, TradeStatus::Completed));
    }

    /// Removing a different mediator must NOT clear the legacy slot of another mediator.
    #[test]
    fn test_remove_mediator_does_not_affect_other_legacy_mediator() {
        let env = Env::default();
        env.mock_all_auths();

        let (contract_id, _admin, usdc_id, _treasury) = setup_base(&env);
        let client = EscrowContractClient::new(&env, &contract_id);

        let mediator_a = Address::generate(&env);
        let mediator_b = Address::generate(&env);
        let buyer = Address::generate(&env);
        let seller = Address::generate(&env);

        // mediator_a is in the legacy slot; mediator_b is only in the registry
        client.set_mediator(&mediator_a);
        client.add_mediator(&mediator_b);

        // Remove mediator_b — must NOT touch mediator_a's legacy slot
        client.remove_mediator(&mediator_b);

        assert!(
            client.is_mediator(&mediator_a),
            "mediator_a must still be authorized"
        );
        assert!(
            !client.is_mediator(&mediator_b),
            "mediator_b must be revoked"
        );

        // mediator_a should still be able to resolve
        let amount = 1000_i128;
        let token_client = token::StellarAssetClient::new(&env, &usdc_id);
        token_client.mint(&buyer, &amount);
        let trade_id = client.create_trade(&buyer, &seller, &amount, &5000_u32, &5000_u32, &None);
        client.deposit(&trade_id);
        client.initiate_dispute(&trade_id, &buyer, &String::from_str(&env, "reason"));
        client.resolve_dispute(&trade_id, &mediator_a, &10_000_u32);

        let trade = client.get_trade(&trade_id);
        assert!(matches!(trade.status, TradeStatus::Completed));
    }

    // -----------------------------------------------------------------------
    // Comprehensive mediator registry tests (acceptance criteria)
    // -----------------------------------------------------------------------

    /// Test: Add 3 mediators, all can call resolve_dispute()
    /// Validates multiple mediators can be registered independently and all have resolution privileges.
    #[test]
    fn test_multiple_mediators_can_resolve_dispute() {
        let env = Env::default();
        env.mock_all_auths();

        let (contract_id, _admin, usdc_id, _treasury) = setup_base(&env);
        let client = EscrowContractClient::new(&env, &contract_id);

        // Register 3 mediators
        let mediator_1 = Address::generate(&env);
        let mediator_2 = Address::generate(&env);
        let mediator_3 = Address::generate(&env);

        client.add_mediator(&mediator_1);
        client.add_mediator(&mediator_2);
        client.add_mediator(&mediator_3);

        // Verify all are registered
        assert!(
            client.is_mediator(&mediator_1),
            "mediator_1 should be registered"
        );
        assert!(
            client.is_mediator(&mediator_2),
            "mediator_2 should be registered"
        );
        assert!(
            client.is_mediator(&mediator_3),
            "mediator_3 should be registered"
        );

        // Setup buyer with enough balance for 3 trades
        let buyer = Address::generate(&env);
        let seller = Address::generate(&env);
        let amount = 1000_i128;
        let token_client = token::StellarAssetClient::new(&env, &usdc_id);
        token_client.mint(&buyer, &(amount * 3)); // Mint enough for 3 trades

        // Each mediator should be able to resolve the dispute
        // Test mediator_1
        let trade_id = client.create_trade(&buyer, &seller, &amount, &5000_u32, &5000_u32, &None);
        client.deposit(&trade_id);
        client.initiate_dispute(&trade_id, &buyer, &String::from_str(&env, "reason"));
        client.resolve_dispute(&trade_id, &mediator_1, &6_000_u32);
        let trade = client.get_trade(&trade_id);
        assert!(matches!(trade.status, TradeStatus::Completed));

        // Test mediator_2
        let trade_id_2 = client.create_trade(&buyer, &seller, &amount, &5000_u32, &5000_u32, &None);
        client.deposit(&trade_id_2);
        client.initiate_dispute(&trade_id_2, &buyer, &String::from_str(&env, "reason2"));
        client.resolve_dispute(&trade_id_2, &mediator_2, &6_000_u32);
        let trade2 = client.get_trade(&trade_id_2);
        assert!(matches!(trade2.status, TradeStatus::Completed));

        // Test mediator_3
        let trade_id_3 = client.create_trade(&buyer, &seller, &amount, &5000_u32, &5000_u32, &None);
        client.deposit(&trade_id_3);
        client.initiate_dispute(&trade_id_3, &buyer, &String::from_str(&env, "reason3"));
        client.resolve_dispute(&trade_id_3, &mediator_3, &6_000_u32);
        let trade3 = client.get_trade(&trade_id_3);
        assert!(matches!(trade3.status, TradeStatus::Completed));
    }

    /// Test: Remove 1 mediator, that mediator cannot resolve (error), others can
    /// Validates selective revocation works correctly without affecting other mediators.
    #[test]
    fn test_remove_one_mediator_blocks_only_that_mediator() {
        let env = Env::default();
        env.mock_all_auths();

        let (contract_id, _admin, usdc_id, _treasury) = setup_base(&env);
        let client = EscrowContractClient::new(&env, &contract_id);

        // Register 3 mediators
        let mediator_1 = Address::generate(&env);
        let mediator_2 = Address::generate(&env);
        let mediator_3 = Address::generate(&env);

        client.add_mediator(&mediator_1);
        client.add_mediator(&mediator_2);
        client.add_mediator(&mediator_3);

        // Remove mediator_2
        client.remove_mediator(&mediator_2);

        // Verify mediator_2 is revoked, others remain
        assert!(
            client.is_mediator(&mediator_1),
            "mediator_1 should still be registered"
        );
        assert!(
            !client.is_mediator(&mediator_2),
            "mediator_2 should be revoked"
        );
        assert!(
            client.is_mediator(&mediator_3),
            "mediator_3 should still be registered"
        );

        // Setup buyer with enough balance for 2 trades
        let buyer = Address::generate(&env);
        let seller = Address::generate(&env);
        let amount = 1000_i128;
        let token_client = token::StellarAssetClient::new(&env, &usdc_id);
        token_client.mint(&buyer, &(amount * 2)); // Mint enough for 2 trades

        // mediator_1 should still be able to resolve
        let trade_id = client.create_trade(&buyer, &seller, &amount, &5000_u32, &5000_u32, &None);
        client.deposit(&trade_id);
        client.initiate_dispute(&trade_id, &buyer, &String::from_str(&env, "reason"));
        client.resolve_dispute(&trade_id, &mediator_1, &6_000_u32);
        let trade = client.get_trade(&trade_id);
        assert!(matches!(trade.status, TradeStatus::Completed));

        // mediator_3 should also be able to resolve
        let trade_id_2 = client.create_trade(&buyer, &seller, &amount, &5000_u32, &5000_u32, &None);
        client.deposit(&trade_id_2);
        client.initiate_dispute(&trade_id_2, &buyer, &String::from_str(&env, "reason2"));
        client.resolve_dispute(&trade_id_2, &mediator_3, &6_000_u32);
        let trade2 = client.get_trade(&trade_id_2);
        assert!(matches!(trade2.status, TradeStatus::Completed));
    }

    /// Test: Remove 1 mediator, that mediator cannot resolve - isolated test for panic
    #[test]
    #[should_panic(expected = "Unauthorized mediator")]
    fn test_removed_mediator_cannot_resolve() {
        let env = Env::default();
        env.mock_all_auths();

        let (contract_id, _admin, usdc_id, _treasury) = setup_base(&env);
        let client = EscrowContractClient::new(&env, &contract_id);

        // Register 3 mediators
        let mediator_1 = Address::generate(&env);
        let mediator_2 = Address::generate(&env);
        let mediator_3 = Address::generate(&env);

        client.add_mediator(&mediator_1);
        client.add_mediator(&mediator_2);
        client.add_mediator(&mediator_3);

        // Remove mediator_2
        client.remove_mediator(&mediator_2);

        // Setup disputed trade
        let buyer = Address::generate(&env);
        let seller = Address::generate(&env);
        let amount = 1000_i128;
        let token_client = token::StellarAssetClient::new(&env, &usdc_id);
        token_client.mint(&buyer, &amount);
        let trade_id = client.create_trade(&buyer, &seller, &amount, &5000_u32, &5000_u32, &None);
        client.deposit(&trade_id);
        client.initiate_dispute(&trade_id, &buyer, &String::from_str(&env, "reason"));

        // mediator_2 should NOT be able to resolve - must panic
        client.resolve_dispute(&trade_id, &mediator_2, &6_000_u32);
    }

    /// Test: After removing one mediator, other mediators can still resolve
    /// Complementary test to verify remaining mediators retain privileges.
    #[test]
    fn test_remaining_mediators_can_resolve_after_one_removed() {
        let env = Env::default();
        env.mock_all_auths();

        let (contract_id, _admin, usdc_id, _treasury) = setup_base(&env);
        let client = EscrowContractClient::new(&env, &contract_id);

        // Register 3 mediators
        let mediator_1 = Address::generate(&env);
        let mediator_2 = Address::generate(&env);
        let mediator_3 = Address::generate(&env);

        client.add_mediator(&mediator_1);
        client.add_mediator(&mediator_2);
        client.add_mediator(&mediator_3);

        // Remove mediator_2
        client.remove_mediator(&mediator_2);

        // Setup disputed trade for mediator_3
        let buyer = Address::generate(&env);
        let seller = Address::generate(&env);
        let amount = 1000_i128;
        let token_client = token::StellarAssetClient::new(&env, &usdc_id);
        token_client.mint(&buyer, &amount);
        let trade_id = client.create_trade(&buyer, &seller, &amount, &5000_u32, &5000_u32, &None);
        client.deposit(&trade_id);
        client.initiate_dispute(&trade_id, &buyer, &String::from_str(&env, "reason"));

        // mediator_3 should still be able to resolve
        client.resolve_dispute(&trade_id, &mediator_3, &6_000_u32);
        let trade = client.get_trade(&trade_id);
        assert!(matches!(trade.status, TradeStatus::Completed));
    }

    /// Test: Legacy slot doesn't prevent new registry from revoking mediator
    /// Validates that a mediator registered via add_mediator() can be fully revoked
    /// even if legacy slot is set to a different address.
    #[test]
    fn test_legacy_slot_does_not_prevent_registry_revocation() {
        let env = Env::default();
        env.mock_all_auths();

        let (contract_id, _admin, usdc_id, _treasury) = setup_base(&env);
        let client = EscrowContractClient::new(&env, &contract_id);

        // Set up legacy mediator (different from registry mediator)
        let legacy_mediator = Address::generate(&env);
        let registry_mediator = Address::generate(&env);

        // Legacy mediator in instance storage
        client.set_mediator(&legacy_mediator);
        // Registry mediator in persistent storage
        client.add_mediator(&registry_mediator);

        // Verify both are registered
        assert!(
            client.is_mediator(&legacy_mediator),
            "legacy_mediator should be registered"
        );
        assert!(
            client.is_mediator(&registry_mediator),
            "registry_mediator should be registered"
        );

        // Remove registry_mediator
        client.remove_mediator(&registry_mediator);

        // Verify registry_mediator is fully revoked
        assert!(
            !client.is_mediator(&registry_mediator),
            "registry_mediator should be revoked"
        );

        // Verify legacy_mediator is NOT affected (still in legacy slot)
        assert!(
            client.is_mediator(&legacy_mediator),
            "legacy_mediator should still be registered"
        );

        // Verify registry_mediator cannot resolve (should panic)
        let buyer = Address::generate(&env);
        let seller = Address::generate(&env);
        let amount = 1000_i128;
        let token_client = token::StellarAssetClient::new(&env, &usdc_id);
        token_client.mint(&buyer, &amount);
        let trade_id = client.create_trade(&buyer, &seller, &amount, &5000_u32, &5000_u32, &None);
        client.deposit(&trade_id);
        client.initiate_dispute(&trade_id, &buyer, &String::from_str(&env, "reason"));

        // This should panic - registry_mediator is revoked
        // We need a separate test for the panic assertion
    }

    /// Test: Registry mediator cannot resolve after removal even with legacy slot present
    /// Isolated panic test for the above scenario.
    #[test]
    #[should_panic(expected = "Unauthorized mediator")]
    fn test_registry_mediator_revoked_despite_legacy_slot_present() {
        let env = Env::default();
        env.mock_all_auths();

        let (contract_id, _admin, usdc_id, _treasury) = setup_base(&env);
        let client = EscrowContractClient::new(&env, &contract_id);

        // Set up legacy mediator (different from registry mediator)
        let legacy_mediator = Address::generate(&env);
        let registry_mediator = Address::generate(&env);

        // Legacy mediator in instance storage
        client.set_mediator(&legacy_mediator);
        // Registry mediator in persistent storage
        client.add_mediator(&registry_mediator);

        // Remove registry_mediator
        client.remove_mediator(&registry_mediator);

        // Setup disputed trade
        let buyer = Address::generate(&env);
        let seller = Address::generate(&env);
        let amount = 1000_i128;
        let token_client = token::StellarAssetClient::new(&env, &usdc_id);
        token_client.mint(&buyer, &amount);
        let trade_id = client.create_trade(&buyer, &seller, &amount, &5000_u32, &5000_u32, &None);
        client.deposit(&trade_id);
        client.initiate_dispute(&trade_id, &buyer, &String::from_str(&env, "reason"));

        // registry_mediator should NOT be able to resolve - must panic
        client.resolve_dispute(&trade_id, &registry_mediator, &6_000_u32);
    }

    /// Test: Concurrent add/remove operations don't corrupt registry
    /// Validates that rapid add/remove cycles maintain registry integrity.
    #[test]
    fn test_concurrent_add_remove_operations() {
        let env = Env::default();
        env.mock_all_auths();

        let (contract_id, _admin, _usdc_id, _treasury) = setup_base(&env);
        let client = EscrowContractClient::new(&env, &contract_id);

        let mediator_a = Address::generate(&env);
        let mediator_b = Address::generate(&env);
        let mediator_c = Address::generate(&env);

        // Rapid add/remove cycle for mediator_a
        client.add_mediator(&mediator_a);
        client.add_mediator(&mediator_b);
        client.remove_mediator(&mediator_a);
        client.add_mediator(&mediator_c);
        client.add_mediator(&mediator_a);
        client.remove_mediator(&mediator_b);

        // Verify final state
        assert!(
            client.is_mediator(&mediator_a),
            "mediator_a should be registered (re-added)"
        );
        assert!(
            !client.is_mediator(&mediator_b),
            "mediator_b should be revoked"
        );
        assert!(
            client.is_mediator(&mediator_c),
            "mediator_c should be registered"
        );

        // Verify mediator_a can still resolve (proves registry is not corrupted)
        let buyer = Address::generate(&env);
        let seller = Address::generate(&env);
        let amount = 1000_i128;
        let token_client = token::StellarAssetClient::new(&env, &_usdc_id);
        token_client.mint(&buyer, &amount);
        let trade_id = client.create_trade(&buyer, &seller, &amount, &5000_u32, &5000_u32, &None);
        client.deposit(&trade_id);
        client.initiate_dispute(&trade_id, &buyer, &String::from_str(&env, "reason"));
        client.resolve_dispute(&trade_id, &mediator_a, &6_000_u32);

        let trade = client.get_trade(&trade_id);
        assert!(matches!(trade.status, TradeStatus::Completed));
    }

    /// Test: Concurrent add/remove with legacy slot interactions
    /// Validates complex interleaving of legacy and registry operations.
    #[test]
    fn test_concurrent_legacy_registry_operations() {
        let env = Env::default();
        env.mock_all_auths();

        let (contract_id, _admin, usdc_id, _treasury) = setup_base(&env);
        let client = EscrowContractClient::new(&env, &contract_id);

        let mediator_a = Address::generate(&env);
        let mediator_b = Address::generate(&env);
        let mediator_c = Address::generate(&env);

        // Complex sequence mixing legacy and registry operations
        client.set_mediator(&mediator_a); // Legacy + Registry
        client.add_mediator(&mediator_b); // Registry only
        client.add_mediator(&mediator_c); // Registry only
        client.remove_mediator(&mediator_a); // Removes from both legacy and registry
        client.add_mediator(&mediator_a); // Re-add to registry only

        // Verify final state
        assert!(
            client.is_mediator(&mediator_a),
            "mediator_a should be registered"
        );
        assert!(
            client.is_mediator(&mediator_b),
            "mediator_b should be registered"
        );
        assert!(
            client.is_mediator(&mediator_c),
            "mediator_c should be registered"
        );

        // Verify legacy slot is empty (mediator_a was removed, clearing it)
        // All three should be able to resolve
        let buyer = Address::generate(&env);
        let seller = Address::generate(&env);
        let amount = 1000_i128;
        let token_client = token::StellarAssetClient::new(&env, &usdc_id);
        token_client.mint(&buyer, &(amount * 3)); // Mint enough for 3 trades

        // Test mediator_a can resolve
        let trade_id_a = client.create_trade(&buyer, &seller, &amount, &5000_u32, &5000_u32, &None);
        client.deposit(&trade_id_a);
        client.initiate_dispute(&trade_id_a, &buyer, &String::from_str(&env, "reason_a"));
        client.resolve_dispute(&trade_id_a, &mediator_a, &6_000_u32);
        assert!(matches!(
            client.get_trade(&trade_id_a).status,
            TradeStatus::Completed
        ));

        // Test mediator_b can resolve
        let trade_id_b = client.create_trade(&buyer, &seller, &amount, &5000_u32, &5000_u32, &None);
        client.deposit(&trade_id_b);
        client.initiate_dispute(&trade_id_b, &buyer, &String::from_str(&env, "reason_b"));
        client.resolve_dispute(&trade_id_b, &mediator_b, &6_000_u32);
        assert!(matches!(
            client.get_trade(&trade_id_b).status,
            TradeStatus::Completed
        ));

        // Test mediator_c can resolve
        let trade_id_c = client.create_trade(&buyer, &seller, &amount, &5000_u32, &5000_u32, &None);
        client.deposit(&trade_id_c);
        client.initiate_dispute(&trade_id_c, &buyer, &String::from_str(&env, "reason_c"));
        client.resolve_dispute(&trade_id_c, &mediator_c, &6_000_u32);
        assert!(matches!(
            client.get_trade(&trade_id_c).status,
            TradeStatus::Completed
        ));
    }

    /// Test: Remove mediator registered via set_mediator, verify both slots cleared
    /// Ensures remove_mediator properly cleans up both legacy and registry storage.
    #[test]
    fn test_remove_mediator_clears_both_slots() {
        let env = Env::default();
        env.mock_all_auths();

        let (contract_id, _admin, usdc_id, _treasury) = setup_base(&env);
        let client = EscrowContractClient::new(&env, &contract_id);

        let mediator = Address::generate(&env);

        // Register via set_mediator (writes to both legacy and registry)
        client.set_mediator(&mediator);
        assert!(
            client.is_mediator(&mediator),
            "mediator should be registered"
        );

        // Remove mediator
        client.remove_mediator(&mediator);
        assert!(!client.is_mediator(&mediator), "mediator should be revoked");

        // Verify mediator cannot resolve
        let buyer = Address::generate(&env);
        let seller = Address::generate(&env);
        let amount = 1000_i128;
        let token_client = token::StellarAssetClient::new(&env, &usdc_id);
        token_client.mint(&buyer, &amount);
        let trade_id = client.create_trade(&buyer, &seller, &amount, &5000_u32, &5000_u32, &None);
        client.deposit(&trade_id);
        client.initiate_dispute(&trade_id, &buyer, &String::from_str(&env, "reason"));

        // This should panic - mediator is fully revoked
        // Separate panic test below
    }

    /// Test: Mediator registered via set_mediator cannot resolve after remove
    /// Isolated panic test for complete revocation verification.
    #[test]
    #[should_panic(expected = "Unauthorized mediator")]
    fn test_set_mediator_then_remove_blocks_resolution() {
        let env = Env::default();
        env.mock_all_auths();

        let (contract_id, _admin, usdc_id, _treasury) = setup_base(&env);
        let client = EscrowContractClient::new(&env, &contract_id);

        let mediator = Address::generate(&env);

        // Register via set_mediator (writes to both legacy and registry)
        client.set_mediator(&mediator);

        // Remove mediator
        client.remove_mediator(&mediator);

        // Setup disputed trade
        let buyer = Address::generate(&env);
        let seller = Address::generate(&env);
        let amount = 1000_i128;
        let token_client = token::StellarAssetClient::new(&env, &usdc_id);
        token_client.mint(&buyer, &amount);
        let trade_id = client.create_trade(&buyer, &seller, &amount, &5000_u32, &5000_u32, &None);
        client.deposit(&trade_id);
        client.initiate_dispute(&trade_id, &buyer, &String::from_str(&env, "reason"));

        // This should panic - mediator is fully revoked from both slots
        client.resolve_dispute(&trade_id, &mediator, &6_000_u32);
    }
