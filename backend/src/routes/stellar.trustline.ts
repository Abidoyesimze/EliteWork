/**
 * Stellar trustline management routes — migrated from routes-d/ (see docs/backend.md §13).
 *
 * POST   /stellar/trustline  — add a trustline (changeTrust with optional limit)
 * DELETE /stellar/trustline  — remove a trustline (changeTrust with limit "0")
 */
import { Router, Request, Response } from "express";
import { z } from "zod";
import * as StellarSdk from "@stellar/stellar-sdk";
import { horizonServer } from "../config/stellar";
import { appLogger } from "../middleware/logger";

const networkPassphrase =
  process.env.STELLAR_NETWORK === "mainnet"
    ? StellarSdk.Networks.PUBLIC
    : StellarSdk.Networks.TESTNET;

const AssetSchema = z.object({
  code: z.string().min(1).max(12),
  issuer: z.string().regex(/^G[A-Z0-9]{55}$/, "Invalid Stellar public key"),
});

const AddTrustlineSchema = z.object({
  sourceAccount: z.string().regex(/^G[A-Z0-9]{55}$/, "Invalid Stellar public key"),
  asset: AssetSchema,
  limit: z.string().regex(/^\d+(\.\d+)?$/, "Must be a positive decimal").optional(),
});

const RemoveTrustlineSchema = z.object({
  sourceAccount: z.string().regex(/^G[A-Z0-9]{55}$/, "Invalid Stellar public key"),
  asset: AssetSchema,
});

/** Shared helper — builds a changeTrust XDR for the given limit. */
async function buildChangeTrustXdr(
  sourceAccount: string,
  asset: { code: string; issuer: string },
  limit: string | undefined,
): Promise<{ envelopeXDR: string; networkPassphrase: string }> {
  const account = await horizonServer.loadAccount(sourceAccount);
  const trustAsset = new StellarSdk.Asset(asset.code, asset.issuer);

  const operation = StellarSdk.Operation.changeTrust({
    asset: trustAsset,
    limit: limit ?? undefined,
  });

  const builder = new StellarSdk.TransactionBuilder(account, {
    fee: StellarSdk.BASE_FEE,
    networkPassphrase,
  });

  builder.addOperation(operation);
  builder.setTimeout(180);

  const transaction = builder.build();

  return {
    envelopeXDR: transaction.toEnvelope().toXDR().toString("base64"),
    networkPassphrase,
  };
}

function handleHorizonError(error: unknown, res: Response, action: string): void {
  if (
    typeof error === "object" && error !== null &&
    "response" in error &&
    (error as { response?: { status?: number } }).response?.status === 404
  ) {
    res.status(404).json({ error: "Source account not found" });
    return;
  }

  appLogger.error({ error }, `Failed to ${action} trustline`);
  const msg = error instanceof Error ? error.message : String(error);
  res.status(502).json({ error: `Failed to build trustline transaction`, details: msg });
}

export function createTrustlineRouter(): Router {
  const router = Router();

  router.post("/trustline", async (req: Request, res: Response) => {
    const parsed = AddTrustlineSchema.safeParse(req.body);

    if (!parsed.success) {
      res.status(400).json({ error: "Validation failed", details: parsed.error.issues });
      return;
    }

    const { sourceAccount, asset, limit } = parsed.data;

    try {
      const result = await buildChangeTrustXdr(sourceAccount, asset, limit);
      res.json(result);
    } catch (error: unknown) {
      handleHorizonError(error, res, "add");
    }
  });

  router.delete("/trustline", async (req: Request, res: Response) => {
    const parsed = RemoveTrustlineSchema.safeParse(req.body);

    if (!parsed.success) {
      res.status(400).json({ error: "Validation failed", details: parsed.error.issues });
      return;
    }

    const { sourceAccount, asset } = parsed.data;

    try {
      const result = await buildChangeTrustXdr(sourceAccount, asset, "0");
      res.json(result);
    } catch (error: unknown) {
      handleHorizonError(error, res, "remove");
    }
  });

  return router;
}

export const stellarTrustlineRoutes = createTrustlineRouter();
