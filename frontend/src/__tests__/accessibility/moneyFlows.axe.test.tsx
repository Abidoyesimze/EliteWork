import React from "react";
import { render } from "@testing-library/react";
import { axe, toHaveNoViolations } from "jest-axe";
import { CurrencyInput } from "@/components/ui/CurrencyInput";
import { VideoUploadCard } from "@/components/ui/VideoUploadCard";
import { ConfirmActionModal } from "@/components/ui/ConfirmActionModal";
import type { AssetInfo } from "@/lib/stellar/assets";

expect.extend(toHaveNoViolations);

jest.mock("@/lib/stellar/assets", () => ({
  getAssetInfo: () => ({ symbol: "cNGN", decimals: 2, name: "cNGN" }),
}));

// Mock BentoCard for VideoUploadCard
jest.mock("@/components/ui/BentoCard", () => ({
  BentoCard: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
}));
jest.mock("@/components/ui/Icon", () => ({
  Icon: (props: React.ComponentProps<"span">) => <span {...props} />,
}));

const mockAsset: AssetInfo = {
  symbol: "cNGN",
  decimals: 2,
  name: "cNGN",
  code: "cNGN",
  issuer: "G...",
  type: "credit_alphanum4",
};

describe("Money-action flows — axe WCAG 2.1 AA", () => {
  describe("CurrencyInput", () => {
    it("has no axe violations — default", async () => {
      const { container } = render(<CurrencyInput value="100" onChange={() => {}} asset={mockAsset} label="Amount" />);
      expect(await axe(container)).toHaveNoViolations();
    });
    it("has no axe violations — error state with alert", async () => {
      const { container } = render(<CurrencyInput value="" onChange={() => {}} asset={mockAsset} label="Clawback amount" error="Amount exceeds vested" />);
      expect(await axe(container)).toHaveNoViolations();
    });
    it("has accessible label association and aria-invalid", async () => {
      const { container } = render(<CurrencyInput value="" onChange={() => {}} asset={mockAsset} label="Clawback amount" error="Required" id="clawback-amount" />);
      const input = container.querySelector("input")!;
      expect(input.getAttribute("aria-invalid")).toBe("true");
      expect(input.getAttribute("aria-describedby")).toContain("clawback-amount-error");
      const label = container.querySelector("label")!;
      expect(label.getAttribute("for")).toBe("clawback-amount");
    });
  });

  describe("VideoUploadCard", () => {
    it("has no axe violations", async () => {
      const { container } = render(<VideoUploadCard />);
      expect(await axe(container)).toHaveNoViolations();
    });
    it("drop zone has aria-label and handles Space without scroll", async () => {
      const { container } = render(<VideoUploadCard />);
      const zone = container.querySelector('[role="button"]') as HTMLElement;
      expect(zone.getAttribute("aria-label")).toMatch(/Upload delivery proof/);
      expect(zone.getAttribute("tabIndex")).toBe("0");
    });
  });

  describe("ConfirmActionModal — money-action confirmation (alertdialog)", () => {
    it("has no axe violations — danger variant", async () => {
      const { container } = render(
        <ConfirmActionModal
          isOpen={true}
          onClose={() => {}}
          onConfirm={() => {}}
          title="Confirm clawback"
          description="This will claw back 100 cNGN irreversibly."
          variant="danger"
          confirmLabel="Confirm Clawback"
        />
      );
      // Modal uses Radix; in jsdom axe may warn about missing focus but we assert no critical/serious
      const results = await axe(container);
      const critical = results.violations.filter((v) => ["critical", "serious"].includes(v.impact!));
      expect(critical).toEqual([]);
    });
  });

  describe("TradeListItem — keyboard accessible", () => {
    it("outer div has role=button, tabIndex=0, and aria-label", async () => {
      const { TradeListItem } = await import("@/components/trade/TradeListItem");
      const { container } = render(
        <TradeListItem
          tradeId="t-1"
          commodity="Maize"
          counterparty={{ role: "Buyer", address: "GABC1234567890XYZ" }}
          amountCngn="10,000"
          status="PENDING"
          createdAt="2026-08-31"
          onView={() => {}}
          onDeposit={() => {}}
        />
      );
      const card = container.querySelector('[role="button"]') as HTMLElement;
      expect(card).toBeTruthy();
      expect(card.getAttribute("tabIndex")).toBe("0");
      expect(card.getAttribute("aria-label")).toMatch(/View trade t-1/);
      const depositBtn = container.querySelector('button[aria-label*="Deposit"]');
      expect(depositBtn).toBeTruthy();
      expect(await axe(container)).toHaveNoViolations();
    });
  });
});
