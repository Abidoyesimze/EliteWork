import { Router } from "express";
import { authRoutes } from "./auth.routes";
import { walletRoutes } from "./wallet.routes";
import { createTradeRouter } from "./trade.routes";
import { createCooperativeRouter } from "./cooperative.routes";
import { createTradeTemplateRouter } from "./trade.template.routes";
import { createTradeWatchlistRouter } from "./trade.watchlist.routes";
import { createTradeEvidenceRouter } from "./trade.evidence.routes";
import { createTradeExportRouter } from "./trade.export.routes";
import { createEscrowReleaseRouter } from "./escrow.release.routes";
import { createEscrowScheduleRouter } from "./escrow.schedule.routes";
import { createTradeManifestRouter } from "./trade.manifest.routes";
import { createManifestRouter } from "./manifest.routes";
import { createTradeNotesRouter } from "./trade.notes.routes";
import { createEvidenceRouter } from "./evidence.routes";
import { createAuditTrailRouter } from "./auditTrail.routes";
import { createGoalsRouter } from "./goals.routes";
import { createNotificationPreferencesRouter } from "./notifications.preferences.routes";
import { createNotificationsRouter } from "./notifications.inapp.routes";
import { disputeRoutes } from "./dispute.routes";
import { disputeCategoryRoutes } from "./disputeCategory.routes";
import userRoutes from "./user.routes";
import reputationRoutes from "./reputation.routes";
import { stellarFeesRoutes } from "./stellar.fees";
import { stellarTxStatusRoutes } from "./stellar.tx.status";
import { stellarAssetRoutes } from "./stellar.asset";
import { stellarAccountBalanceRoutes } from "./stellar.account.balance";
import { stellarAccountCreateRoutes } from "./stellar.account.create";
import { stellarPaymentsRoutes } from "./stellar.payments";
import { stellarLedgerRoutes } from "./stellar.ledger";
import { stellarStrictSendRoutes } from "./stellar.payment.strictSend";
import { stellarStrictReceiveRoutes } from "./stellar.payment.strictReceive";
import { stellarTrustlineRoutes } from "./stellar.trustline";
import { createContractStateRouter } from "./contract.state.routes";
import { createTreasuryRouter } from "./treasury.routes";
import { webhooksRoutes } from "./webhooks.routes";
import { createPrivacyRouter } from "./privacy.routes";

/**
 * Aggregates every consumer-facing API route into a single router mounted at
 * its legacy base paths. The SAME router is mounted twice in app.ts:
 *
 *   - at the legacy aliases (e.g. `/auth`, `/trades`) for backwards
 *     compatibility with shipped clients (deprecated), and
 *   - under `/api/v1` as the stable, versioned lane.
 *
 * Sharing one router guarantees byte-for-byte behavioural parity between the
 * two lanes — there is no separate legacy code path to drift.
 *
 * Admin and health routes are intentionally NOT here: health is infrastructure
 * and /admin (+ /api/admin) are internal ops tools, neither carries a consumer
 * stability promise.
 *
 * Mount ORDER is significant:
 *  - literal sub-resource routers (`/trades/:id/...`) must precede the generic
 *    `/trades/:id` handler router (createTradeRouter).
 *  - full-path routers (privacy, evidence, manifest, goals, notifications,
 *    admin-adjacent) are mounted at root inside this router so their absolute
 *    routes keep working under both the legacy "" and "/api/v1" prefixes.
 */
export function createPublicApiRouter(): Router {
  const router = Router();

  // Identity & preferences
  router.use("/auth", authRoutes);
  router.use("/wallet", walletRoutes);
  router.use("/users", userRoutes);
  router.use(createPrivacyRouter());
  router.use("/users", reputationRoutes);
  router.use(createNotificationPreferencesRouter());
  router.use(createNotificationsRouter());

  // Cooperatives (pilot): GET /cooperatives/:id/trades (read-only member view)
  router.use("/cooperatives", createCooperativeRouter());

  // Trade lifecycle — literal sub-routes must precede the generic /:id router.
  router.use("/trades", createTradeExportRouter());
  router.use("/trades", createTradeTemplateRouter());
  router.use("/trades", createTradeWatchlistRouter());
  router.use("/trades", createTradeEvidenceRouter());
  router.use("/trades", createEscrowReleaseRouter());
  router.use("/trades", createEscrowScheduleRouter());
  router.use("/trades", createTradeRouter());

  // Notes: POST /trades/:id/notes and GET /trades/:id/notes
  router.use("/trades", createTradeNotesRouter());

  // Manifest: POST /trades/:id/manifest
  router.use("/trades/:id/manifest", createTradeManifestRouter());
  router.use("/trades/:id/manifest", createManifestRouter());

  // Evidence: GET /trades/:id/evidence and GET /evidence/:cid/stream
  router.use(createEvidenceRouter());

  // Audit trail: GET /trades/:id/history
  router.use("/trades", createAuditTrailRouter());

  // Goals analytics: GET /goals
  router.use("/goals", createGoalsRouter());

  // Disputes: GET /disputes
  router.use("/disputes", disputeRoutes);

  // Dispute categories: CRUD /dispute-categories
  router.use("/dispute-categories", disputeCategoryRoutes);

  // Stellar network endpoints
  router.use("/stellar/fees", stellarFeesRoutes);
  router.use("/stellar/tx", stellarTxStatusRoutes);
  router.use("/stellar/assets", stellarAssetRoutes);
  // Keep the documented /create path while retaining the legacy /account alias.
  router.use("/stellar/account/create", stellarAccountCreateRoutes);
  router.use("/stellar/account", stellarAccountCreateRoutes);
  router.use("/stellar/account", stellarAccountBalanceRoutes);
  // Payment history: GET /stellar/account/:address/payments
  router.use("/stellar/account", stellarPaymentsRoutes);
  // Ledger info: GET /stellar/ledger/latest
  router.use("/stellar/ledger", stellarLedgerRoutes);
  // Path payments (build unsigned XDR):
  // POST /stellar/payments/strict-send
  // POST /stellar/payments/strict-receive
  router.use("/stellar/payments", stellarStrictSendRoutes);
  router.use("/stellar/payments", stellarStrictReceiveRoutes);
  // Trustline management: POST/DELETE /stellar/trustline
  router.use("/stellar", stellarTrustlineRoutes);
  router.use("/contract", createContractStateRouter());

  // Treasury management
  router.use("/treasury", createTreasuryRouter());

  // Webhooks: CRUD /webhooks
  router.use("/webhooks", webhooksRoutes);

  return router;
}
