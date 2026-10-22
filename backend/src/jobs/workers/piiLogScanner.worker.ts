/**
 * BullMQ worker for the weekly PII log-leak scan (#233).
 *
 * Samples recently emitted (post-redaction) log lines and checks whether
 * any PII survived the redaction pipeline in middleware/logger.ts. A clean
 * run is the expected steady state; any finding means the denylist/pattern
 * rules in lib/logRedaction.ts have a gap and pages the on-call/files a
 * ticket via AlertService, without ever including the leaked value itself.
 */

import { Worker, Job } from "bullmq";
import { appLogger } from "../../middleware/logger";
import { createQueueConnection } from "../queue";
import { attachDeadLetterQueue } from "../deadLetter";
import { getRecentLogSample } from "../../lib/logSampleBuffer";
import { scanForPiiLeaks, PiiLeakFinding } from "../../lib/piiLeakScanner";
import { alertService } from "../../services/alert.service";
import { withHeartbeat } from "../heartbeat-wrapper";
import { JobType } from "../../services/jobHeartbeat.service";

export interface PiiScanJobData {
  scanId?: string;
}

export interface PiiScanResult {
  linesScanned: number;
  findingCount: number;
  findingsByKind: Record<string, number>;
}

function summarizeFindings(findings: PiiLeakFinding[]): Record<string, number> {
  const summary: Record<string, number> = {};
  for (const finding of findings) {
    summary[finding.kind] = (summary[finding.kind] ?? 0) + 1;
  }
  return summary;
}

export async function runPiiScan(): Promise<PiiScanResult> {
  const sample = getRecentLogSample();
  const findings = scanForPiiLeaks(sample);
  const findingsByKind = summarizeFindings(findings);

  if (findings.length > 0) {
    // Paths only, never the leaked value — the alert must not itself leak PII.
    const affectedPaths = [...new Set(findings.map((f) => f.path))].slice(0, 20);
    await alertService.dispatch(
      "pii_log_leak_detected",
      `PII log scanner found ${findings.length} suspected leak(s) across ${sample.length} sampled log lines`,
      { findingsByKind, affectedPaths },
    );
    appLogger.warn(
      { findingCount: findings.length, findingsByKind, linesScanned: sample.length },
      "PII log scan found suspected leaks",
    );
  } else {
    appLogger.info({ linesScanned: sample.length }, "PII log scan completed with a clean baseline");
  }

  return { linesScanned: sample.length, findingCount: findings.length, findingsByKind };
}

export function createPiiLogScannerWorker(): Worker<PiiScanJobData> {
  const processor = withHeartbeat(
    JobType.STREAM_CLAWBACK_MONITOR, // reuses nearest available JobType; see jobHeartbeat.service.ts
    async (job: Job<PiiScanJobData>) => {
      appLogger.info({ jobId: job.id }, "PII log scan started");
      try {
        const result = await runPiiScan();
        appLogger.info({ jobId: job.id, ...result }, "PII log scan finished");
        return result;
      } catch (error) {
        appLogger.error({ jobId: job.id, error }, "PII log scan failed");
        throw error;
      }
    },
  );

  const worker = new Worker<PiiScanJobData>(
    "pii-log-scan",
    processor,
    { connection: createQueueConnection() },
  );
  attachDeadLetterQueue(worker, "pii-log-scan");
  return worker;
}
