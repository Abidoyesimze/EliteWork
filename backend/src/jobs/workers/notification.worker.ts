import { Worker, Job } from 'bullmq';
import { appLogger } from '../../middleware/logger';
import { createQueueConnection, NotificationJobData } from '../queue';
import { prisma } from '../../lib/db';
import type { Prisma } from '@prisma/client';
import { attachDeadLetterQueue } from '../deadLetter';
import { sendSms } from '../../services/sms.service';
import { withHeartbeat } from '../heartbeat-wrapper';
import { JobType } from '../../services/jobHeartbeat.service';

async function dispatchSms(userAddress: string, title: string, message: string, jobId: string | undefined) {
  const pref = await (prisma as unknown as {
    notificationPreference?: { findUnique: (args: unknown) => Promise<{ phoneNumber: string | null } | null> };
  }).notificationPreference?.findUnique({ where: { userAddress } });

  if (!pref?.phoneNumber) {
    appLogger.info({ jobId, userAddress }, 'SMS notification skipped: no phone number on file');
    return;
  }

  const result = await sendSms(pref.phoneNumber, `${title}: ${message}`);
  if (!result.sent) {
    appLogger.warn({ jobId, userAddress, reason: result.reason }, 'SMS notification not sent');
  }
}

export function createNotificationWorker(): Worker<NotificationJobData> {
  const processor = withHeartbeat(
    JobType.NOTIFICATION,
    async (job: Job<NotificationJobData>) => {
      const { userAddress, type, title, message, metadata } = job.data;
      appLogger.info({ jobId: job.id, userAddress, type }, 'Processing notification job');

      if (type === 'in_app') {
        await prisma.inAppNotification.create({
          data: {
            userAddress,
            title,
            message,
            type,
            metadata: (metadata ?? {}) as Prisma.InputJsonValue,
          },
        });
      } else if (type === 'sms') {
        await dispatchSms(userAddress, title, message, job.id);
      } else {
        // email / push: log intent; extend with provider integration
        appLogger.info({ jobId: job.id, type, userAddress }, `${type} notification dispatched`);
      }

      appLogger.info({ jobId: job.id, userAddress }, 'Notification job completed');
    },
  );

  const worker = new Worker<NotificationJobData>(
    'notifications',
    processor,
    { connection: createQueueConnection() },
  );
  attachDeadLetterQueue(worker, 'notifications');
  return worker;
}
