import { Worker, Job } from 'bullmq';
import { appLogger } from '../../middleware/logger';
import { createQueueConnection, WebhookJobData } from '../queue';
import { webhookService } from '../../services/webhook.service';
import { attachDeadLetterQueue } from '../deadLetter';
import { withHeartbeat } from '../heartbeat-wrapper';
import { JobType } from '../../services/jobHeartbeat.service';

export function createWebhookWorker(): Worker<WebhookJobData> {
  const processor = withHeartbeat(
    JobType.WEBHOOK,
    async (job: Job<WebhookJobData>) => {
      const { tradeId, status, payload } = job.data;
      appLogger.info({ jobId: job.id, tradeId, status }, 'Processing webhook job');
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await webhookService.dispatch(tradeId, status as any, payload);
      appLogger.info({ jobId: job.id, tradeId }, 'Webhook job completed');
    },
  );

  const worker = new Worker<WebhookJobData>(
    'webhooks',
    processor,
    { connection: createQueueConnection() },
  );
  attachDeadLetterQueue(worker, 'webhooks');
  return worker;
}
