/**
 * Tests for outbox-scan.worker.ts — verifies that the scan report is persisted
 * to the audit trail (issue #241) and that alerting/logging still behave
 * correctly around it.
 */

import { processOutboxScanJob } from "../jobs/workers/outbox-scan.worker";
import * as outboxScanner from "../lib/outbox/outboxScanner";
import { alertService } from "../services/alert.service";
import { auditTrailService } from "../services/auditTrail.service";
import type { Job } from "bullmq";

// ── Mocks ────────────────────────────────────────────────────────────────────

jest.mock("../lib/outbox/outboxScanner");
jest.mock("../services/alert.service", () => ({
  alertService: { dispatch: jest.fn().mockResolvedValue(undefined) },
}));
jest.mock("../services/auditTrail.service", () => ({
  auditTrailService: { logScanReport: jest.fn().mockResolvedValue(undefined) },
}));

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeJob(data: Record<string, unknown> = {}, id = "job-001"): Job {
  return { id, data } as unknown as Job;
}

function makeCleanReport() {
  return {
    totalTradesScanned: 10,
    gapsDetected: [],
    summary: { criticalGaps: 0, warningGaps: 0, totalGaps: 0 },
  };
}

function makeReportWithCritical() {
  return {
    totalTradesScanned: 10,
    gapsDetected: [
      { tradeId: "trade-1", severity: "critical", description: "missing event" },
    ],
    summary: { criticalGaps: 1, warningGaps: 0, totalGaps: 1 },
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("processOutboxScanJob", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("persists the scan report to the audit trail on a clean run", async () => {
    const report = makeCleanReport();
    (outboxScanner.scanOutboxCompleteness as jest.Mock).mockResolvedValue(report);

    const result = await processOutboxScanJob(makeJob({ timeWindowMinutes: 60, alertOnGaps: true }));

    expect(result).toEqual(report);
    expect(auditTrailService.logScanReport).toHaveBeenCalledTimes(1);
    expect(auditTrailService.logScanReport).toHaveBeenCalledWith(report, "job-001");
  });

  it("does not dispatch an alert when there are no critical gaps", async () => {
    const report = makeCleanReport();
    (outboxScanner.scanOutboxCompleteness as jest.Mock).mockResolvedValue(report);

    await processOutboxScanJob(makeJob({ alertOnGaps: true }));

    expect(alertService.dispatch).not.toHaveBeenCalledWith(
      "outbox_critical_gaps",
      expect.any(String),
      expect.any(Object),
    );
  });

  it("dispatches an outbox_critical_gaps alert when critical gaps are present", async () => {
    const report = makeReportWithCritical();
    (outboxScanner.scanOutboxCompleteness as jest.Mock).mockResolvedValue(report);

    await processOutboxScanJob(makeJob({ alertOnGaps: true }));

    expect(alertService.dispatch).toHaveBeenCalledWith(
      "outbox_critical_gaps",
      expect.stringContaining("1 gaps"),
      expect.objectContaining({ gapCount: 1 }),
    );
    // Audit trail is still persisted even when gaps are found
    expect(auditTrailService.logScanReport).toHaveBeenCalledTimes(1);
  });

  it("continues and returns the report even when audit trail persistence fails", async () => {
    const report = makeCleanReport();
    (outboxScanner.scanOutboxCompleteness as jest.Mock).mockResolvedValue(report);
    (auditTrailService.logScanReport as jest.Mock).mockRejectedValueOnce(
      new Error("DB write failed"),
    );

    // Should not throw — audit failure is non-fatal
    const result = await processOutboxScanJob(makeJob());
    expect(result).toEqual(report);
  });

  it("dispatches an outbox_scan_failed alert and rethrows when the scan itself fails", async () => {
    const scanError = new Error("Scanner exploded");
    (outboxScanner.scanOutboxCompleteness as jest.Mock).mockRejectedValue(scanError);

    await expect(processOutboxScanJob(makeJob())).rejects.toThrow("Scanner exploded");

    expect(alertService.dispatch).toHaveBeenCalledWith(
      "outbox_scan_failed",
      expect.stringContaining("Scanner exploded"),
      expect.any(Object),
    );
    // Audit trail should NOT be called when the scan itself throws
    expect(auditTrailService.logScanReport).not.toHaveBeenCalled();
  });
});
