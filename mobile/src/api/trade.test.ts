import apiClient from './client';
import { tradeApi } from './trade';

jest.mock('./client', () => ({
  __esModule: true,
  default: {
    get: jest.fn(),
    post: jest.fn(),
  },
}));

const mockGet = apiClient.get as jest.MockedFunction<typeof apiClient.get>;
const mockPost = apiClient.post as jest.MockedFunction<typeof apiClient.post>;

const TRADE_ID = '4294967297';
const SELLER =
  'GBQ5NYMF2UBXZPH7PCPCUNTONIIIVRRQ24ZDUVAOD4GXLMI5SAQUJDFK';

describe('tradeApi', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('listTrades', () => {
    it('GETs /trades with the supplied query params and returns the body', async () => {
      const body = { trades: [], total: 0, page: 2, limit: 5 };
      mockGet.mockResolvedValueOnce({ data: body });

      const result = await tradeApi.listTrades({
        status: 'FUNDED',
        page: 2,
        limit: 5,
      });

      expect(mockGet).toHaveBeenCalledWith('/trades', {
        params: { status: 'FUNDED', page: 2, limit: 5 },
      });
      expect(result).toBe(body);
    });

    it('passes undefined params through when called without arguments', async () => {
      mockGet.mockResolvedValueOnce({ data: { trades: [] } });

      await tradeApi.listTrades();

      expect(mockGet).toHaveBeenCalledWith('/trades', { params: undefined });
    });

    it('propagates request failures', async () => {
      const failure = new Error('boom');
      mockGet.mockRejectedValueOnce(failure);

      await expect(tradeApi.listTrades()).rejects.toBe(failure);
    });
  });

  describe('getTrade', () => {
    it('GETs /trades/:id and returns the trade', async () => {
      const trade = { tradeId: TRADE_ID, status: 'FUNDED' };
      mockGet.mockResolvedValueOnce({ data: trade });

      const result = await tradeApi.getTrade(TRADE_ID);

      expect(mockGet).toHaveBeenCalledWith(`/trades/${TRADE_ID}`);
      expect(result).toBe(trade);
    });

    it('propagates request failures', async () => {
      const failure = new Error('not found');
      mockGet.mockRejectedValueOnce(failure);

      await expect(tradeApi.getTrade(TRADE_ID)).rejects.toBe(failure);
    });
  });

  describe('createTrade', () => {
    it('POSTs the payload to /trades and returns tradeId + unsignedXdr', async () => {
      const payload = {
        sellerAddress: SELLER,
        amountUsdc: '100.00',
        buyerLossBps: 5000,
        sellerLossBps: 5000,
        commodity: 'Cocoa',
        quantity: '10',
        unit: 'kg',
      };
      const body = { tradeId: TRADE_ID, unsignedXdr: 'AAAA' };
      mockPost.mockResolvedValueOnce({ data: body });

      const result = await tradeApi.createTrade(payload);

      expect(mockPost).toHaveBeenCalledWith('/trades', payload);
      expect(result).toBe(body);
    });

    it('propagates request failures', async () => {
      const failure = new Error('validation');
      mockPost.mockRejectedValueOnce(failure);

      await expect(
        tradeApi.createTrade({ sellerAddress: SELLER, amountUsdc: '1' }),
      ).rejects.toBe(failure);
    });
  });

  describe.each([
    ['confirmDelivery', 'confirm', { tradeId: TRADE_ID, status: 'DELIVERED' }],
    ['releaseFunds', 'release', { unsignedXdr: 'REL' }],
    ['deposit', 'deposit', { unsignedXdr: 'DEP' }],
  ] as const)('%s', (method, segment, body) => {
    it(`POSTs /trades/:id/${segment} with no body and returns the response`, async () => {
      mockPost.mockResolvedValueOnce({ data: body });

      const result = await tradeApi[method](TRADE_ID);

      expect(mockPost).toHaveBeenCalledTimes(1);
      expect(mockPost).toHaveBeenCalledWith(`/trades/${TRADE_ID}/${segment}`);
      expect(result).toBe(body);
    });

    it('propagates request failures', async () => {
      const failure = new Error('conflict');
      mockPost.mockRejectedValueOnce(failure);

      await expect(tradeApi[method](TRADE_ID)).rejects.toBe(failure);
    });
  });

  describe('initiateDispute', () => {
    it('POSTs reason and the default OTHER category', async () => {
      const body = { tradeId: TRADE_ID, status: 'DISPUTED' };
      mockPost.mockResolvedValueOnce({ data: body });

      const result = await tradeApi.initiateDispute(TRADE_ID, 'Damaged goods');

      expect(mockPost).toHaveBeenCalledWith(`/trades/${TRADE_ID}/dispute`, {
        reason: 'Damaged goods',
        category: 'OTHER',
      });
      expect(result).toBe(body);
    });

    it('forwards an explicit category', async () => {
      mockPost.mockResolvedValueOnce({ data: {} });

      await tradeApi.initiateDispute(TRADE_ID, 'Short delivery', 'QUANTITY');

      expect(mockPost).toHaveBeenCalledWith(`/trades/${TRADE_ID}/dispute`, {
        reason: 'Short delivery',
        category: 'QUANTITY',
      });
    });

    it('propagates request failures', async () => {
      const failure = new Error('forbidden');
      mockPost.mockRejectedValueOnce(failure);

      await expect(
        tradeApi.initiateDispute(TRADE_ID, 'reason'),
      ).rejects.toBe(failure);
    });
  });
});
