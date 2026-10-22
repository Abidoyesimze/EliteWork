import { PactV3, MatchersV3 } from '@pact-foundation/pact';

import apiClient, { setAuthToken } from '../../src/api/client';
import { tradeApi } from '../../src/api/trade';

const { like, eachLike, regex, datetime } = MatchersV3;

const TRADE_ID = '4294967297';
const BUYER_ADDRESS =
  'GDNM7WSJ7VIUVK2TSZ2OQES5XR2663TZEIBFXRDT56B5IRLHERVWSXMU';
const SELLER_ADDRESS =
  'GBQ5NYMF2UBXZPH7PCPCUNTONIIIVRRQ24ZDUVAOD4GXLMI5SAQUJDFK';

type TradeListPayload = {
  items: Array<{ tradeId: string; status: string }>;
  pagination: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
  };
};

describe('Mobile Trades API Pact Consumer Tests', () => {
  const provider = new PactV3({
    consumer: 'AmanaMobile',
    provider: 'AmanaBackend',
    dir: './tests/pact/pacts',
  });

  const mockToken =
    'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ3YWxsZXRBZGRyZXNzIjoiR0ROTTdXU0o3VklVVksyVFNaMk9RRVM1WFIyNjYzVFpFSUJGWFJEVDU2QjVJUkxIRVJWV1NYTVUiLCJzdWIiOiJHRE5NN1dTSjdWSVVWSzJUU1oyT1FFUzVYUjI2NjNUWkVJQkZYUkRUNTZCNUlSTEhFUlZXU1hNVSJ9.signature';
  let originalBaseUrl: string | undefined;

  beforeAll(() => {
    originalBaseUrl = apiClient.defaults.baseURL;
    setAuthToken(mockToken);
  });

  afterAll(() => {
    setAuthToken(null);
    apiClient.defaults.baseURL = originalBaseUrl;
  });

  describe('POST /trades — create a trade', () => {
    it('returns tradeId and unsignedXdr', async () => {
      provider
        .given('a buyer is authenticated')
        .uponReceiving('a mobile request to create a trade')
        .withRequest({
          method: 'POST',
          path: '/api/v1/trades',
          headers: {
            Authorization: `Bearer ${mockToken}`,
            'Content-Type': 'application/json',
          },
          body: {
            sellerAddress: SELLER_ADDRESS,
            amountUsdc: '100.00',
            buyerLossBps: 5000,
            sellerLossBps: 5000,
          },
        })
        .willRespondWith({
          status: 201,
          headers: { 'Content-Type': 'application/json' },
          body: {
            tradeId: regex('\\d+', TRADE_ID),
            unsignedXdr: regex('[A-Za-z0-9+/=]+', 'AAAAAXNvbWUtY3JlYXRlLXRyYWRlLXhkcg=='),
          },
        });

      await provider.executeTest(async (mockServer) => {
        apiClient.defaults.baseURL = mockServer.url;

        const result = await tradeApi.createTrade({
          sellerAddress: SELLER_ADDRESS,
          amountUsdc: '100.00',
          buyerLossBps: 5000,
          sellerLossBps: 5000,
        });

        expect(result.tradeId).toBe(TRADE_ID);
        expect(result.unsignedXdr).toBeTruthy();
      });
    });
  });

  describe('POST /trades/:id/deposit — build deposit transaction', () => {
    it('returns an unsigned deposit XDR', async () => {
      provider
        .given('a trade exists in CREATED status')
        .uponReceiving('a mobile request to build a deposit transaction')
        .withRequest({
          method: 'POST',
          path: `/api/v1/trades/${TRADE_ID}/deposit`,
          headers: { Authorization: `Bearer ${mockToken}` },
        })
        .willRespondWith({
          status: 200,
          headers: { 'Content-Type': 'application/json' },
          body: {
            unsignedXdr: regex('[A-Za-z0-9+/=]+', 'AAAAAXNvbWUtZGVwb3NpdC10eC14ZHI='),
          },
        });

      await provider.executeTest(async (mockServer) => {
        apiClient.defaults.baseURL = mockServer.url;

        const result = await tradeApi.deposit(TRADE_ID);
        expect(result.unsignedXdr).toBeTruthy();
      });
    });
  });

  describe('POST /trades/:id/confirm — confirm delivery', () => {
    it('returns an unsigned confirm-delivery XDR', async () => {
      provider
        .given('a trade exists in FUNDED status')
        .uponReceiving('a mobile request to confirm delivery')
        .withRequest({
          method: 'POST',
          path: `/api/v1/trades/${TRADE_ID}/confirm`,
          headers: { Authorization: `Bearer ${mockToken}` },
        })
        .willRespondWith({
          status: 200,
          headers: { 'Content-Type': 'application/json' },
          body: {
            unsignedXdr: regex('[A-Za-z0-9+/=]+', 'AAAAAXNvbWUtY29uZmlybS14ZHI='),
          },
        });

      await provider.executeTest(async (mockServer) => {
        apiClient.defaults.baseURL = mockServer.url;

        const result = (await tradeApi.confirmDelivery(TRADE_ID)) as unknown as {
          unsignedXdr: string;
        };
        expect(result.unsignedXdr).toBeTruthy();
      });
    });
  });

  describe('POST /trades/:id/release — release funds', () => {
    it('returns an unsigned release XDR', async () => {
      provider
        .given('a trade exists in DELIVERED status')
        .uponReceiving('a mobile request to release funds')
        .withRequest({
          method: 'POST',
          path: `/api/v1/trades/${TRADE_ID}/release`,
          headers: { Authorization: `Bearer ${mockToken}` },
        })
        .willRespondWith({
          status: 200,
          headers: { 'Content-Type': 'application/json' },
          body: {
            unsignedXdr: regex('[A-Za-z0-9+/=]+', 'AAAAAXNvbWUtcmVsZWFzZS14ZHI='),
          },
        });

      await provider.executeTest(async (mockServer) => {
        apiClient.defaults.baseURL = mockServer.url;

        const result = await tradeApi.releaseFunds(TRADE_ID);
        expect(result.unsignedXdr).toBeTruthy();
      });
    });
  });

  describe('POST /trades/:id/dispute — initiate dispute', () => {
    it('returns an unsigned dispute XDR', async () => {
      provider
        .given('a trade exists in FUNDED status')
        .uponReceiving('a mobile request to initiate a dispute')
        .withRequest({
          method: 'POST',
          path: `/api/v1/trades/${TRADE_ID}/dispute`,
          headers: {
            Authorization: `Bearer ${mockToken}`,
            'Content-Type': 'application/json',
          },
          body: {
            reason: 'Goods not delivered as agreed',
            category: 'OTHER',
          },
        })
        .willRespondWith({
          status: 200,
          headers: { 'Content-Type': 'application/json' },
          body: {
            unsignedXdr: regex('[A-Za-z0-9+/=]+', 'AAAAAXNvbWUtZGlzcHV0ZS14ZHI='),
          },
        });

      await provider.executeTest(async (mockServer) => {
        apiClient.defaults.baseURL = mockServer.url;

        const result = (await tradeApi.initiateDispute(
          TRADE_ID,
          'Goods not delivered as agreed',
        )) as unknown as { unsignedXdr: string };
        expect(result.unsignedXdr).toBeTruthy();
      });
    });
  });

  describe('GET /trades/:id — get a trade', () => {
    it('returns trade details', async () => {
      provider
        .given(`a trade exists with id ${TRADE_ID}`)
        .uponReceiving('a mobile request to get a trade by id')
        .withRequest({
          method: 'GET',
          path: `/api/v1/trades/${TRADE_ID}`,
          headers: { Authorization: `Bearer ${mockToken}` },
        })
        .willRespondWith({
          status: 200,
          headers: { 'Content-Type': 'application/json' },
          body: {
            tradeId: TRADE_ID,
            buyerAddress: like(BUYER_ADDRESS),
            sellerAddress: like(SELLER_ADDRESS),
            amountUsdc: like('100.00'),
            buyerLossBps: like(5000),
            sellerLossBps: like(5000),
            status: like('CREATED'),
            createdAt: datetime(
              "yyyy-MM-dd'T'HH:mm:ss.SSS'Z'",
              '2026-01-01T00:00:00.000Z',
            ),
            updatedAt: datetime(
              "yyyy-MM-dd'T'HH:mm:ss.SSS'Z'",
              '2026-01-01T00:00:00.000Z',
            ),
          },
        });

      await provider.executeTest(async (mockServer) => {
        apiClient.defaults.baseURL = mockServer.url;

        const result = await tradeApi.getTrade(TRADE_ID);
        expect(result.tradeId).toBe(TRADE_ID);
        expect(result.buyerAddress).toBe(BUYER_ADDRESS);
        expect(result.status).toBeTruthy();
      });
    });
  });

  describe('GET /trades — list trades', () => {
    it('returns the backend paginated envelope', async () => {
      provider
        .given('the user has trades')
        .uponReceiving('a mobile request to list trades')
        .withRequest({
          method: 'GET',
          path: '/api/v1/trades',
          query: { page: '1', limit: '10' },
          headers: { Authorization: `Bearer ${mockToken}` },
        })
        .willRespondWith({
          status: 200,
          headers: { 'Content-Type': 'application/json' },
          body: {
            items: eachLike({
              tradeId: TRADE_ID,
              buyerAddress: like(BUYER_ADDRESS),
              sellerAddress: like(SELLER_ADDRESS),
              amountUsdc: like('100.00'),
              buyerLossBps: like(5000),
              sellerLossBps: like(5000),
              status: like('CREATED'),
              createdAt: datetime(
                "yyyy-MM-dd'T'HH:mm:ss.SSS'Z'",
                '2026-01-01T00:00:00.000Z',
              ),
              updatedAt: datetime(
                "yyyy-MM-dd'T'HH:mm:ss.SSS'Z'",
                '2026-01-01T00:00:00.000Z',
              ),
            }),
            pagination: {
              page: 1,
              limit: 10,
              total: 1,
              totalPages: 1,
            },
          },
        });

      await provider.executeTest(async (mockServer) => {
        apiClient.defaults.baseURL = mockServer.url;

        const result = (await tradeApi.listTrades({
          page: 1,
          limit: 10,
        })) as unknown as TradeListPayload;

        expect(result.items).toHaveLength(1);
        expect(result.items[0].tradeId).toBe(TRADE_ID);
        expect(result.pagination.total).toBe(1);
      });
    });
  });
});
