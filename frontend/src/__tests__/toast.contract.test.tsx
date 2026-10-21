import React from "react";
import { render, act } from "@testing-library/react";
import { ToastProvider, useToast, TOAST_CONTRACT } from "@/hooks/useToast";

function Harness({ onReady }: { onReady: (api: ReturnType<typeof useToast>) => void }) {
  const api = useToast();
  React.useEffect(() => { onReady(api); }, [api, onReady]);
  return null;
}

describe("Unified toast contract: success/error/pending w/ correlation IDs", () => {
  it("pending -> success updates same toast (no duplicate stack)", async () => {
    let api: ReturnType<typeof useToast> | null = null;
    render(<ToastProvider><Harness onReady={(a) => (api = a)} /></ToastProvider>);
    // Wait for effect
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    expect(api).toBeTruthy();

    const correlationId = "corr-1";
    await act(async () => {
      api!.addToastWithCorrelation({ type: "info", message: "Locking funds…", title: "In progress", correlationId, duration: 0 });
    });
    expect(api!.toasts).toHaveLength(1);
    expect(api!.toasts[0].message).toMatch(/Locking/);

    await act(async () => {
      api!.updateToast(correlationId, { type: "success", message: "Trade created", title: "Success" });
    });
    expect(api!.toasts).toHaveLength(1);
    expect(api!.toasts[0].type).toBe("success");
    expect(api!.toasts[0].message).toMatch(/created/);
  });

  it("dedup: same correlationId does not create second toast", async () => {
    let api: ReturnType<typeof useToast> | null = null;
    render(<ToastProvider><Harness onReady={(a) => (api = a)} /></ToastProvider>);
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });

    const corr = "corr-dedup";
    await act(async () => {
      api!.addToastWithCorrelation({ type: "info", message: "Pending", correlationId: corr, duration: 0 });
      api!.addToastWithCorrelation({ type: "info", message: "Pending again", correlationId: corr, duration: 0 });
    });
    expect(api!.toasts).toHaveLength(1);
  });

  it("toast inventory contains success/error/pending with correlation", () => {
    // Inventory reviewed for consistency — ensure contract has all three
    expect(TOAST_CONTRACT.pending).toBeDefined();
    expect(TOAST_CONTRACT.success).toBeDefined();
    expect(TOAST_CONTRACT.error).toBeDefined();
    const p = TOAST_CONTRACT.pending("msg", "c1");
    const s = TOAST_CONTRACT.success("msg", "c1");
    const e = TOAST_CONTRACT.error("msg", "c1");
    expect(p.correlationId).toBe("c1");
    expect(s.type).toBe("success");
    expect(e.type).toBe("error");
  });
});
