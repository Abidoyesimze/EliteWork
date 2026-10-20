# User Screens — Mobile

This document describes the user-facing screens and key interaction patterns available in the mobile app, serving as the companion reference to `ADMIN_SCREENS.md`.

---

## Screen Reference

### HomeScreen

**Location:** `mobile/src/screens/HomeScreen.tsx`

The welcome entrypoint introducing the Amana application and initializing device notification response listeners.

#### Purpose

Provides onboarding context and setup instructions for new users before connecting their Stellar wallet, and handles incoming push notification lifecycle responses.

#### Key behaviour

- Registers an `addNotificationResponseReceivedListener` subscriber on mount to handle background/tap notification events.
- Displays brand mission, key features, and guidance on connecting a Stellar wallet.
- Simple, unauthenticated overview layout wrapped in a scrollable view.

---

### WalletConnectScreen

**Location:** `mobile/src/screens/WalletConnectScreen.tsx`

The initial authentication screen where users connect their Stellar wallet address or authenticate using biometrics.

#### Purpose

Authenticates users via Stellar public key challenge-response verification and stores the authenticated session JWT in `authStore`.

#### Key behaviour

- **Biometric Unlock (#57):** Checks device biometric hardware capability (`isBiometricUnlockAvailable`) and whether a previously remembered wallet address exists (`getRememberedWalletAddress`). If available, prompts Face ID / Touch ID unlock without requiring manual address re-entry.
- **Manual Wallet Entry:** Prompts for Stellar public key address, generates an auth challenge via `authApi.generateChallenge(address)`, verifies via `authApi.verifyChallenge`, and sets the active token.
- **Navigation:** On successful authentication, automatically transitions to `TradeListScreen` (`navigation.replace('TradeList')`).
- **Deep-link resume:** Replays parked deep links once authentication completes.

---

### TradeListScreen

**Location:** `mobile/src/screens/TradeListScreen.tsx`

The primary dashboard displaying all active and historical escrow trades for the authenticated user.

#### Purpose

Allows users to browse, filter, refresh, and inspect their escrow trades across all lifecycle states.

#### Key behaviour

- **Status Filtering:** Segmented filter chips for `ALL`, `PENDING`, `IN_TRANSIT`, `DISPUTED`, and `COMPLETED`.
- **Pull-to-Refresh:** Pull-to-refresh via `RefreshControl` that reloads trades from `tradeStore.fetchTrades()` with haptic feedback.
- **Empty State & CTA (#54):** Displays a dedicated empty state graphic and "Create Trade" CTA when no trades match the selected filter.
- **Error Banner:** Displays network or API failures via `AdminErrorBanner` with inline retry button and mailto support link (`buildSupportMailto`).
- **Trade Cards:** Displays trade ID, status badge, USDC amount, buyer/seller truncated addresses, and creation timestamps. Tap navigates to `TradeDetailScreen`.

---

### CreateTradeScreen

**Location:** `mobile/src/screens/CreateTradeScreen.tsx`

The multi-step or form-based trade initialization flow for setting up a new escrow agreement.

#### Purpose

Enables buyers or sellers to negotiate risk-sharing terms, enter counterparty addresses, specify escrow amounts, set delivery deadlines, and submit the trade.

#### Key behaviour

- **Counterparty & Asset Selection:** Input validation for Stellar public keys (`GB...`) and supported asset tokens (cNGN / USDC).
- **Loss Sharing Ratio Slider / Inputs:** Configures buyer and seller risk-sharing percentages (e.g. 50/50, 70/30) summing to 100% (10,000 basis points).
- **Deadline Selection:** Optional delivery deadline picker ensuring future timestamp validation.
- **Draft Persistence:** Automatically persists unsubmitted drafts locally so input is not lost on backgrounding or app restarts.
- **Submission & Navigation:** Calls escrow creation API/contract, invalidates trade cache, and redirects directly to the newly created trade detail.

---

### TradeDetailScreen

**Location:** `mobile/src/screens/TradeDetailScreen.tsx`

The comprehensive trade view showing full lifecycle status, actions, timeline, and dispute management.

#### Purpose

Serves as the operational hub for an active trade, allowing buyers to deposit funds, confirm delivery, or initiate disputes, and sellers to submit delivery evidence or voluntary refunds.

#### Key behaviour

- **Lifecycle Actions:** Dynamically surfaces valid state transitions based on caller role (buyer vs seller) and trade status:
  - `Created`: Buyer deposit button, cancel trade.
  - `Funded`: Confirm delivery (buyer), submit manifest/evidence (seller), initiate dispute.
  - `Delivered`: Release funds to seller (buyer), voluntary refund (seller).
  - `Disputed`: View dispute details, submit additional IPFS evidence.
- **Timeline & Proof:** Displays tracking steps (Created → Funded → In Transit → Delivered → Completed) with timestamps and transaction hashes.
- **Copy & Share:** Quick tap-to-copy for trade IDs, transaction hashes, and deep-link sharing.

---

### EvidenceCaptureScreen

**Location:** `mobile/src/screens/EvidenceCaptureScreen.tsx`

Media capture and upload interface for Proof-of-Delivery (PoD) and dispute documentation.

#### Purpose

Allows trade participants or logistics drivers to capture photo/video verification or select media from device storage for IPFS pinning.

#### Key behaviour

- **Camera & Library Permissions:** Requests camera and camera-roll permissions with clear explanation prompts.
- **Preview & Retake:** Displays media preview with options to retake, delete, or confirm upload.
- **Accessibility (#58):** Includes descriptive accessibility labels, hints, minimum 44px touch targets, and live-region announcements for upload progress and errors.
- **IPFS Upload:** Packages binary evidence with metadata and submits to IPFS via Pinata/backend endpoint, updating the trade record.

---

### DisputeDetailScreen

**Location:** `mobile/src/screens/DisputeDetailScreen.tsx`

Detailed dispute resolution screen for contested trades under mediation.

#### Purpose

Displays dispute claims, reason hashes, uploaded evidence items, and mediator status for disputed trades.

#### Key behaviour

- **Dispute Timeline:** Shows dispute initiation timestamp, initiating party, and stated reason.
- **Evidence Vault:** Lists all IPFS-pinned evidence records, photos, and video proof submitted by either party.
- **Mediator Status:** Displays whether single-mediator or multi-mediator quorum resolution applies and voting status.
- **Navigation:** Deep-link target for `amanavault://disputes/:id` with auth gating.

---

### VaultDashboard

**Location:** `mobile/src/screens/VaultDashboard.tsx`

Overview of user balances, escrow deposits, and earnings across active smart contracts.

#### Purpose

Provides aggregated financial metrics across all locked escrow holdings, pending releases, and fee accounting.

#### Key behaviour

- **Balance Breakdown:** Summarizes total value locked (TVL) in active trades, available wallet balances, and completed settlement totals.
- **Quick Actions:** Shortcuts to initiate a new trade, review flagged disputes, or manage trustlines.
- **Currency Toggle:** Views amounts denominated in USDC or cNGN with live path conversion estimates.

---

## Error, Empty, and Loading States

| Screen | Error state | Empty state | Loading / Other states |
| --- | --- | --- | --- |
| `HomeScreen` | None (static informational screen). | None. | Notification response listener initialized in background. |
| `WalletConnectScreen` | Alert modal on invalid public key or challenge verification failure; inline error text on biometric rejection. | None. | `ActivityIndicator` while verifying signature challenge or checking biometric hardware (`connecting`/`unlocking`). |
| `TradeListScreen` | `AdminErrorBanner` displayed at top on fetch failure with retry button and mailto support link; pull-to-refresh error handling. | Dedicated empty state illustration, "No trades found", and "Create Trade" button (#54). | Pull-to-refresh spinner (`RefreshControl`), initial loading skeleton, filter chips for status segregation. |
| `CreateTradeScreen` | Inline field error messages for invalid address, negative amounts, or mismatched loss-ratio basis points. | Form defaults to empty inputs or restored draft from local storage. | "Creating trade…" loading overlay while broadcasting contract call. |
| `TradeDetailScreen` | Banner error on failed status transition (e.g., insufficient balance on deposit, rejected delivery confirmation). | Not applicable; shows "Trade not found" if invalid trade ID requested. | Shimmer / skeleton loading on initial fetch; action button disabled with activity spinner during transaction execution. |
| `EvidenceCaptureScreen` | Accessible live-region error text on camera access denial or IPFS upload timeout. | Camera viewfinder preview before capture; placeholder when no image selected. | Upload progress bar / indicator while pinning binary evidence to IPFS. |
| `DisputeDetailScreen` | Error banner on failing to fetch dispute or evidence records. | "No evidence submitted yet" when dispute record has empty evidence array. | Loading spinner while resolving dispute evidence list from backend. |
| `VaultDashboard` | Warning banner if balance RPC or price oracle fails to respond. | "No active deposits" when user has 0 open escrows. | Pull-to-refresh balance update; currency conversion loader. |
