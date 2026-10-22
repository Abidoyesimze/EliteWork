/**
 * BullMQ worker for daily account reconciliation.
 *
 * Processes the "reconciliation" queue, running a full sweep comparing
 * off-chain ledger state against on-chain balances. Failures raise alerts
 * via the alert service (monitor the monitor pattern).
 */

import { Worker, Job } from "bullmq";
import { appLogger } from "../../middleware/logger";
import { createQueueConnection } from "../queue";
import { dailyReconciliationService } from "../../services/dailyReconciliation.service";
import { attachDeadLetterQueue } from "../deadLetter";
import { withHeartbeat } from "../heartbeat-wrapper";
import { JobType } from "../../services/jobHeartbeat.service";

export interface ReconciliationSweepJobData {
  sweepId?: string;
}

export function createReconciliationWorker(): Worker<ReconciliationSweepJobData> {
  const processor = withHeartbeat(
    JobType.RECONCILIATION,
    async (job: Job<ReconciliationSweepJobData>) => {
      const { sweepId = job.id } = job.data;
      appLogger.info({ jobId: job.id, sweepId }, "Reconciliation sweep started");

      try {
        const result = await dailyReconciliationService.sweep();
        appLogger.info(
          { jobId: job.id, ...result },
          "Reconciliation sweep completed",
        );
        return result;
      } catch (error) {
        appLogger.error(
          { jobId: job.id, error },
          "Reconciliation sweep failed — alert should have been dispatched",
        );
        throw error;
      }
    },
  );

  const worker = new Worker<ReconciliationSweepJobData>(
    "reconciliation",
    processor,
    { connection: createQueueConnection() },
  );
  attachDeadLetterQueue(worker, "reconciliation");
  return worker;
}
