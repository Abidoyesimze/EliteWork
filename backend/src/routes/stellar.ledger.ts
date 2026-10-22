/**
 * Stellar latest-ledger route — migrated from routes-d/ (see docs/backend.md §13).
 *
 * GET /stellar/ledger/latest
 *   Returns the most recently closed ledger's sequence, hash, and statistics.
 */
import { Router, Request, Response } from "express";
import { horizonServer } from "../config/stellar";
import { appLogger } from "../middleware/logger";

export function createLedgerRouter(): Router {
  const router = Router();

  router.get("/latest", async (_req: Request, res: Response) => {
    try {
      const ledgerResponse = await horizonServer
        .ledgers()
        .order("desc")
        .limit(1)
        .call();

      if (!ledgerResponse.records || ledgerResponse.records.length === 0) {
        res.status(503).json({ error: "No ledger data available" });
        return;
      }

      const latest = ledgerResponse.records[0];

      res.json({
        sequence: latest.sequence,
        hash: latest.hash,
        closedAt: latest.closed_at,
        totalOps: latest.total_operations,
        protocolVersion: latest.protocol_version,
        txCount: latest.successful_transaction_count,
      });
    } catch (error: unknown) {
      appLogger.error({ error }, "Failed to fetch latest ledger from Stellar");
      const msg = error instanceof Error ? error.message : String(error);
      res.status(502).json({
        error: "Failed to fetch latest ledger from Stellar network",
        details: msg,
      });
    }
  });

  return router;
}

export const stellarLedgerRoutes = createLedgerRouter();
