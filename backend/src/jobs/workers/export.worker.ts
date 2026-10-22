import { Worker, Job } from 'bullmq';
import { appLogger } from '../../middleware/logger';
import { createQueueConnection, ExportJobData } from '../queue';
import { prisma } from '../../lib/db';
import { Parser as CsvParser } from 'json2csv';
import { attachDeadLetterQueue } from '../deadLetter';
import { withHeartbeat } from '../heartbeat-wrapper';
import { JobType } from '../../services/jobHeartbeat.service';

export interface ExportResult {
  // Mirrors `ExportJobData['format']` so a queued 'pdf' job is not narrowed
  // away from the worker's result contract.
  format: 'csv' | 'json' | 'pdf';
  data: string;
  rowCount: number;
  s3Key?: string;
}

async function uploadToS3(data: string, key: string): Promise<string | undefined> {
  const bucket = process.env.AWS_S3_BUCKET;
  if (!bucket) return undefined;
  // S3 upload requires @aws-sdk/client-s3 and AWS credentials in env.
  // Install the SDK and set AWS_S3_BUCKET, AWS_REGION, AWS_ACCESS_KEY_ID,
  // AWS_SECRET_ACCESS_KEY to enable actual uploads.
  appLogger.warn({ key, bucket }, 'S3 upload skipped — install @aws-sdk/client-s3 to enable');
  return undefined;
}

export function createExportWorker(): Worker<ExportJobData> {
  const processor = withHeartbeat(
    JobType.EXPORT,
    async (job: Job<ExportJobData>): Promise<ExportResult> => {
      const { requestedBy, format, tradeIds, filters } = job.data;
      appLogger.info({ jobId: job.id, requestedBy, format }, 'Processing export job');

      if (format === 'pdf') {
        throw new Error('PDF exports are not supported by the background export worker');
      }

      const where: Record<string, unknown> = { ...filters };
      if (tradeIds?.length) {
        where['tradeId'] = { in: tradeIds };
      }

      const trades = await prisma.trade.findMany({ where });

      let data: string;
      if (format === 'csv') {
        const parser = new CsvParser();
        data = parser.parse(trades);
      } else {
        data = JSON.stringify(trades, null, 2);
      }

      const s3Key = `exports/${requestedBy}/${job.id}.${format}`;
      const s3Uri = await uploadToS3(data, s3Key);

      appLogger.info(
        { jobId: job.id, rowCount: trades.length, s3Uri },
        'Export job completed',
      );

      return { format, data, rowCount: trades.length, s3Key: s3Uri };
    },
  );

  const worker = new Worker<ExportJobData>(
    'exports',
    processor,
    { connection: createQueueConnection() },
  );
  attachDeadLetterQueue(worker, 'exports');
  return worker;
}
