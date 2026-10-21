import apiClient from './client';
import { adminApi, TRADE_STATUSES, BatchTradeUpdate } from './admin';

jest.mock('./client', () => ({
  __esModule: true,
  default: {
    get: jest.fn(),
    post: jest.fn(),
    patch: jest.fn(),
    delete: jest.fn(),
  },
}));

const mockGet = apiClient.get as jest.MockedFunction<typeof apiClient.get>;
const mockPost = apiClient.post as jest.MockedFunction<typeof apiClient.post>;
const mockPatch = apiClient.patch as jest.MockedFunction<typeof apiClient.patch>;
const mockDelete = apiClient.delete as jest.MockedFunction<typeof apiClient.delete>;

describe('adminApi', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('TRADE_STATUSES re-export', () => {
    it('re-exports TRADE_STATUSES matching domain constants', () => {
      expect(TRADE_STATUSES).toBeDefined();
      expect(Array.isArray(TRADE_STATUSES)).toBe(true);
      expect(TRADE_STATUSES).toContain('CREATED');
      expect(TRADE_STATUSES).toContain('FUNDED');
      expect(TRADE_STATUSES).toContain('DELIVERED');
      expect(TRADE_STATUSES).toContain('COMPLETED');
      expect(TRADE_STATUSES).toContain('DISPUTED');
    });
  });

  describe('streams', () => {
    it('listStreams calls GET /admin/streams with query params', async () => {
      const mockResult = {
        items: [
          {
            streamId: 'stream-1',
            recipient: 'G_RECIP',
            status: 'ACTIVE',
            vestingState: 'vesting' as const,
            totalVested: '1000',
            claimed: '200',
            unclaimed: '800',
            pendingClawback: '0',
            adminTags: ['verified'],
          },
        ],
        pagination: { page: 1, limit: 10, total: 1, totalPages: 1 },
      };
      mockGet.mockResolvedValueOnce({ data: mockResult });

      const params = {
        page: 1,
        limit: 10,
        status: 'ACTIVE',
        vestingState: 'vesting' as const,
        adminTag: 'verified',
      };
      const result = await adminApi.listStreams(params);

      expect(mockGet).toHaveBeenCalledWith('/admin/streams', { params });
      expect(result).toEqual(mockResult);
    });

    it('listStreams supports invocation without params', async () => {
      const mockResult = {
        items: [],
        pagination: { page: 1, limit: 20, total: 0, totalPages: 0 },
      };
      mockGet.mockResolvedValueOnce({ data: mockResult });

      const result = await adminApi.listStreams();

      expect(mockGet).toHaveBeenCalledWith('/admin/streams', {
        params: undefined,
      });
      expect(result).toEqual(mockResult);
    });

    it('getStream calls GET /admin/streams/:streamId', async () => {
      const streamSummary = {
        streamId: 'stream-42',
        recipient: 'G_RECIPIENT_ADDR',
        status: 'LOCKED',
        vestingState: 'not_started' as const,
        totalVested: '500',
        claimed: '0',
        unclaimed: '500',
        pendingClawback: '0',
        adminTags: [],
      };
      mockGet.mockResolvedValueOnce({ data: streamSummary });

      const result = await adminApi.getStream('stream-42');

      expect(mockGet).toHaveBeenCalledWith('/admin/streams/stream-42');
      expect(result).toEqual(streamSummary);
    });

    it('lockStream calls POST /admin/streams/:streamId/lock with reason', async () => {
      const responsePayload = {
        streamId: 'stream-1',
        locked: true as const,
        reason: 'Compliance audit',
      };
      mockPost.mockResolvedValueOnce({ data: responsePayload });

      const result = await adminApi.lockStream('stream-1', 'Compliance audit');

      expect(mockPost).toHaveBeenCalledWith('/admin/streams/stream-1/lock', {
        reason: 'Compliance audit',
      });
      expect(result).toEqual(responsePayload);
    });

    it('unlockStream calls POST /admin/streams/:streamId/unlock with reason', async () => {
      const responsePayload = {
        streamId: 'stream-1',
        locked: false as const,
        reason: 'Audit passed',
      };
      mockPost.mockResolvedValueOnce({ data: responsePayload });

      const result = await adminApi.unlockStream('stream-1', 'Audit passed');

      expect(mockPost).toHaveBeenCalledWith('/admin/streams/stream-1/unlock', {
        reason: 'Audit passed',
      });
      expect(result).toEqual(responsePayload);
    });

    it('suspendStream calls POST /admin/streams/:streamId/suspend with reason', async () => {
      const responsePayload = {
        streamId: 'stream-1',
        status: 'SUSPENDED',
        reason: 'Suspicious activity',
      };
      mockPost.mockResolvedValueOnce({ data: responsePayload });

      const result = await adminApi.suspendStream(
        'stream-1',
        'Suspicious activity',
      );

      expect(mockPost).toHaveBeenCalledWith('/admin/streams/stream-1/suspend', {
        reason: 'Suspicious activity',
      });
      expect(result).toEqual(responsePayload);
    });

    it('resumeStream calls POST /admin/streams/:streamId/resume with note', async () => {
      const responsePayload = {
        streamId: 'stream-1',
        status: 'ACTIVE',
        note: 'Issue cleared',
      };
      mockPost.mockResolvedValueOnce({ data: responsePayload });

      const result = await adminApi.resumeStream('stream-1', 'Issue cleared');

      expect(mockPost).toHaveBeenCalledWith('/admin/streams/stream-1/resume', {
        note: 'Issue cleared',
      });
      expect(result).toEqual(responsePayload);
    });

    it('terminateStream calls POST /admin/streams/:streamId/terminate with options', async () => {
      const responsePayload = { terminated: true };
      mockPost.mockResolvedValueOnce({ data: responsePayload });

      const opts = { reason: 'Breach of contract', unsignedTxXdr: 'xdr-123' };
      const result = await adminApi.terminateStream('stream-1', opts);

      expect(mockPost).toHaveBeenCalledWith(
        '/admin/streams/stream-1/terminate',
        opts,
      );
      expect(result).toEqual(responsePayload);
    });

    it('terminateStream defaults options to empty object when omitted', async () => {
      const responsePayload = { terminated: true };
      mockPost.mockResolvedValueOnce({ data: responsePayload });

      const result = await adminApi.terminateStream('stream-1');

      expect(mockPost).toHaveBeenCalledWith(
        '/admin/streams/stream-1/terminate',
        {},
      );
      expect(result).toEqual(responsePayload);
    });

    it('previewClawback calls POST /admin/streams/:streamId/clawback/preview with amount', async () => {
      const previewResult = {
        streamId: 'stream-1',
        remainingVested: '500',
        requestedClawback: '200',
        postClawbackBalance: '300',
        preview: true as const,
        timestamp: '2026-01-01T00:00:00.000Z',
      };
      mockPost.mockResolvedValueOnce({ data: previewResult });

      const result = await adminApi.previewClawback('stream-1', '200');

      expect(mockPost).toHaveBeenCalledWith(
        '/admin/streams/stream-1/clawback/preview',
        { amount: '200' },
      );
      expect(result).toEqual(previewResult);
    });
  });

  describe('batch trade status updates', () => {
    it('updateTradeStatusesBatch calls POST /admin/trades/batch/status with updates array', async () => {
      const updates: BatchTradeUpdate[] = [
        { tradeId: 'trade-1', status: 'FUNDED' },
        { tradeId: 'trade-2', status: 'DISPUTED' },
      ];
      const batchResult = {
        succeeded: ['trade-1', 'trade-2'],
        failed: [],
      };
      mockPost.mockResolvedValueOnce({ data: batchResult });

      const result = await adminApi.updateTradeStatusesBatch(updates);

      expect(mockPost).toHaveBeenCalledWith('/admin/trades/batch/status', {
        updates,
      });
      expect(result).toEqual(batchResult);
    });
  });

  describe('contract operations', () => {
    it('addMediator calls POST /admin/contract/mediators with mediatorAddress', async () => {
      const contractResult = { unsignedXdr: 'mock-add-mediator-xdr' };
      mockPost.mockResolvedValueOnce({ data: contractResult });

      const result = await adminApi.addMediator('G_MEDIATOR_ADDRESS');

      expect(mockPost).toHaveBeenCalledWith('/admin/contract/mediators', {
        mediatorAddress: 'G_MEDIATOR_ADDRESS',
      });
      expect(result).toEqual(contractResult);
    });

    it('removeMediator calls DELETE /admin/contract/mediators/:mediatorAddress', async () => {
      const contractResult = { unsignedXdr: 'mock-remove-mediator-xdr' };
      mockDelete.mockResolvedValueOnce({ data: contractResult });

      const result = await adminApi.removeMediator('G_MEDIATOR_ADDRESS');

      expect(mockDelete).toHaveBeenCalledWith(
        '/admin/contract/mediators/G_MEDIATOR_ADDRESS',
      );
      expect(result).toEqual(contractResult);
    });

    it('updateContractFeeBps calls PATCH /admin/contract/fee with feeBps', async () => {
      const contractResult = { unsignedXdr: 'mock-update-fee-xdr' };
      mockPatch.mockResolvedValueOnce({ data: contractResult });

      const result = await adminApi.updateContractFeeBps(150);

      expect(mockPatch).toHaveBeenCalledWith('/admin/contract/fee', {
        feeBps: 150,
      });
      expect(result).toEqual(contractResult);
    });
  });

  describe('feature flags', () => {
    it('listFeatureFlags calls GET /admin/features', async () => {
      const flagsResult = {
        flags: {
          flagA: { enabled: true, rolloutPercentage: 100 },
          flagB: { enabled: false },
        },
      };
      mockGet.mockResolvedValueOnce({ data: flagsResult });

      const result = await adminApi.listFeatureFlags();

      expect(mockGet).toHaveBeenCalledWith('/admin/features');
      expect(result).toEqual(flagsResult);
    });

    it('setFeatureFlag calls PATCH /admin/features/:name with opts', async () => {
      const setResult = {
        name: 'newStreamTypes',
        flag: { enabled: true, rolloutPercentage: 50 },
      };
      mockPatch.mockResolvedValueOnce({ data: setResult });

      const result = await adminApi.setFeatureFlag('newStreamTypes', {
        enabled: true,
        rolloutPercentage: 50,
      });

      expect(mockPatch).toHaveBeenCalledWith('/admin/features/newStreamTypes', {
        enabled: true,
        rolloutPercentage: 50,
      });
      expect(result).toEqual(setResult);
    });
  });

  describe('audit trail', () => {
    it('getAuditTrail calls GET /api/admin/audit with params', async () => {
      const auditResult = {
        items: [
          {
            id: 1,
            action: 'LOCK_STREAM',
            actorAddress: 'G_ADMIN',
            targetReference: 'stream-1',
            note: 'Locking for investigation',
            createdAt: '2026-01-01T00:00:00.000Z',
          },
        ],
        pagination: { page: 1, limit: 10, total: 1, totalPages: 1 },
      };
      mockGet.mockResolvedValueOnce({ data: auditResult });

      const result = await adminApi.getAuditTrail({ page: 1, limit: 10 });

      expect(mockGet).toHaveBeenCalledWith('/api/admin/audit', {
        params: { page: 1, limit: 10 },
      });
      expect(result).toEqual(auditResult);
    });

    it('getAuditTrail works with undefined params', async () => {
      const auditResult = {
        items: [],
        pagination: { page: 1, limit: 20, total: 0, totalPages: 0 },
      };
      mockGet.mockResolvedValueOnce({ data: auditResult });

      const result = await adminApi.getAuditTrail();

      expect(mockGet).toHaveBeenCalledWith('/api/admin/audit', {
        params: undefined,
      });
      expect(result).toEqual(auditResult);
    });
  });

  describe('error propagation', () => {
    it('propagates client rejections up to the caller', async () => {
      const networkError = new Error('Network failure');
      mockGet.mockRejectedValueOnce(networkError);

      await expect(adminApi.getStream('stream-fail')).rejects.toThrow(
        'Network failure',
      );
    });
  });
});
