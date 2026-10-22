import request from "supertest";
import express from "express";

const mockFeeStats = jest.fn();

jest.mock("../config/stellar", () => ({
  horizonServer: {
    feeStats: mockFeeStats,
  },
  sorobanRpcClient: {},
  networkPassphrase: "Test SDF Network ; September 2015",
}));

const { createStellarFeesRouter } = require("../routes/stellar.fees") as typeof import("../routes/stellar.fees");

const FEE_STATS = {
  last_ledger: "12345",
  last_ledger_base_fee: "100",
  ledger_capacity_usage: "0.25",
  fee_charged: {
    max: "1000", min: "100", mode: "100", p10: "100", p20: "100",
    p30: "100", p40: "100", p50: "100", p60: "100", p70: "100",
    p80: "100", p90: "100", p95: "100", p99: "100",
  },
  max_fee: {
    max: "10000", min: "100", mode: "100", p10: "100", p20: "100",
    p30: "100", p40: "100", p50: "100", p60: "100", p70: "100",
    p80: "100", p90: "100", p95: "100", p99: "100",
  },
};

describe("GET /stellar/fees", () => {
  let app: express.Application;

  beforeEach(() => {
    mockFeeStats.mockReset();
    app = express().use("/stellar/fees", createStellarFeesRouter());
  });

  it("returns fee stats and a recommendation without authentication", async () => {
    mockFeeStats.mockResolvedValue(FEE_STATS);

    const response = await request(app).get("/stellar/fees");

    expect(response.status).toBe(200);
    expect(response.body).toHaveProperty("feeCharged");
    expect(response.body).toHaveProperty("maxFee");
    expect(response.body).toHaveProperty("ledger");
    expect(response.body.ledger).toBe(12345);
    expect(response.body).toHaveProperty("lastLedgerBaseFee");
    expect(response.body.lastLedgerBaseFee).toBe(100);
    expect(response.body.feeCharged).toHaveProperty("max");
    expect(response.body.feeCharged).toHaveProperty("min");
    expect(response.body.maxFee).toHaveProperty("max");
    expect(response.body.maxFee).toHaveProperty("min");
    expect(response.body.recommended.operations).toBe(1);
    expect(response.body.recommended.transactionFee).toBe(
      response.body.recommended.perOperationFee,
    );
  });

  it.each(["invalid", "0", "-2"])(
    "falls back to one operation when operations=%s fails validation",
    async (operations) => {
      mockFeeStats.mockResolvedValue(FEE_STATS);

      const response = await request(app).get(`/stellar/fees?operations=${operations}`);

      expect(response.status).toBe(200);
      expect(response.body.recommended.operations).toBe(1);
      expect(response.body.recommended.transactionFee).toBe(
        response.body.recommended.perOperationFee,
      );
    },
  );

  it("caps the requested operation count at 100", async () => {
    mockFeeStats.mockResolvedValue(FEE_STATS);

    const response = await request(app).get("/stellar/fees?operations=101");

    expect(response.status).toBe(200);
    expect(response.body.recommended.operations).toBe(100);
    expect(response.body.recommended.transactionFee).toBe(
      response.body.recommended.perOperationFee * 100,
    );
  });

  it("returns 502 when Horizon fails", async () => {
    mockFeeStats.mockRejectedValue(new Error("Horizon unavailable"));

    const response = await request(app).get("/stellar/fees");

    expect(response.status).toBe(502);
    expect(response.body).toHaveProperty("error");
  });
});
