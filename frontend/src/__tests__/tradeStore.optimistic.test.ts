import { act } from "@testing-library/react";
import { useTradeStore } from "@/stores/tradeStore";
import type { TradeResponse } from "@/lib/api/types";
import { _clearAllForTests } from "@/lib/actionDedup";

jest.mock("@/lib/api/trades", () => ({ tradesApi: { list: jest.fn() } }));

const makeTrade = (tradeId: string, status = "PENDING"): TradeResponse => ({
  tradeId,
  buyerAddress: "GBUYER",
  sellerAddress: "GSELLER",
  amountCngn: "100",
  buyerLossBps: 0,
  sellerLossBps: 0,
  status,
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
});

beforeEach(() => {
  useTradeStore.setState({ trades: [], total: 0, page: 1, filters: {}, isLoading: false, error: null, pendingActions: {} });
  _clearAllForTests();
});

describe("Optimistic store updates with snapshot-based rollback", () => {
  it("forced-failure restores exact prior UI state", async () => {
    useTradeStore.setState({ trades: [makeTrade("t1", "PENDING")], total: 1 });
    const before = JSON.stringify(useTradeStore.getState().trades);

    await act(async () => {
      await expect(
        useTradeStore.getState().updateTrade("t1", { status: "SETTLED" }, async () => {
          throw new Error("Network failure mid-flight");
        }),
      ).rejects.toThrow();
    });

    const after = JSON.stringify(useTradeStore.getState().trades);
    expect(after).toBe(before);
    expect(useTradeStore.getState().trades[0].status).toBe("PENDING");
  });

  it("success keeps optimistic patch", async () => {
    useTradeStore.setState({ trades: [makeTrade("t1", "PENDING")], total: 1 });
    await act(async () => {
      await useTradeStore.getState().updateTrade("t1", { status: "SETTLED" }, async () => {});
    });
    expect(useTradeStore.getState().trades[0].status).toBe("SETTLED");
  });

  it("removeTrade failure-mid-flight restores list", async () => {
    useTradeStore.setState({ trades: [makeTrade("t1"), makeTrade("t2")], total: 2 });
    const before = useTradeStore.getState().trades.map((t) => t.tradeId);
    await act(async () => {
      await expect(useTradeStore.getState().removeTrade("t1", async () => { throw new Error("fail"); })).rejects.toThrow();
    });
    expect(useTradeStore.getState().trades.map((t) => t.tradeId)).toEqual(before);
    expect(useTradeStore.getState().total).toBe(2);
  });
});

describe("Action de-duplication window preventing double-submit", () => {
  it("rapid triple-click yields single intent (server confirms once)", async () => {
    useTradeStore.setState({ trades: [makeTrade("t1", "PENDING")], total: 1 });
    const serverFn = jest.fn().mockImplementation(() => new Promise((res) => setTimeout(res, 50)));
    const { updateTrade } = useTradeStore.getState();

    // Fire three concurrent updates with same patch — dedup window should suppress 2nd/3rd
    const p1 = updateTrade("t1", { status: "SETTLED" }, serverFn);
    const p2 = updateTrade("t1", { status: "SETTLED" }, serverFn);
    const p3 = updateTrade("t1", { status: "SETTLED" }, serverFn);

    await act(async () => {
      await Promise.allSettled([p1, p2, p3]);
    });

    // Only first call should have invoked serverFn
    expect(serverFn).toHaveBeenCalledTimes(1);
  });

  it("withDedup wrapper prevents duplicate intents across callers", async () => {
    const { withDedup } = useTradeStore.getState();
    const fn = jest.fn().mockResolvedValue("ok");
    const k = "test:action";

    const r1 = withDedup(k, fn);
    const r2 = withDedup(k, fn);
    const [v1, v2] = await Promise.all([r1, r2]);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(v2).toBeNull(); // deduped
    expect(v1).toBe("ok");
  });
});
