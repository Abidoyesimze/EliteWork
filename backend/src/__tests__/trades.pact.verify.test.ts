import { existsSync } from 'node:fs';
import path from 'path';
import express from 'express';
import { Trade, TradeStatus } from '@prisma/client';

import { createTradeRouter } from '../routes/trade.routes';
import { errorHandler } from '../middleware/errorHandler';
import { AuthService } from '../services/auth.service';
import * as contractServiceModule from '../services/contract.service';
import { ContractService } from '../services/contract.service';
import { TradeService } from '../services/trade.service';

jest.mock('../services/auth.service', () => ({
  AuthService: {
    validateToken: jest.fn(async (token: string) => {
      const jwt = jest.requireActual<typeof import("jsonwebtoken")>("jsonwebtoken");
      return jwt.decode(token);
    }),
    isTokenRevoked: jest.fn().mockResolvedValue(false),
  },
}));

const JWT_SECRET = 'pact-provider-verify-secret-key-at-least-32-chars';
const pactFiles = [
  path.resolve(
    __dirname,
    '../../../frontend/tests/pact/pacts/AmanaFrontend-AmanaBackend.json',
  ),
  path.resolve(
    __dirname,
    '../../../mobile/tests/pact/pacts/AmanaMobile-AmanaBackend.json',
  ),
].filter((file) => existsSync(file));
const pactTest = pactFiles.length > 0 ? it : it.skip;
const pactDescribe = pactFiles.length > 0 ? describe : describe.skip;

function createMockTradeService() {
  return {
    createPendingTrade: jest.spyOn(TradeService.prototype, 'createPendingTrade'),
    getTradeById: jest.spyOn(TradeService.prototype, 'getTradeById'),
    listUserTrades: jest.spyOn(TradeService.prototype, 'listUserTrades'),
    getUserStats: jest.spyOn(TradeService.prototype, 'getUserStats'),
    initiateDispute: jest.spyOn(TradeService.prototype, 'initiateDispute'),
  };
}

function createMockContractService() {
  return {
    buildCreateTradeTx: jest.spyOn(
      ContractService.prototype,
      'buildCreateTradeTx',
    ),
    buildDepositTx: jest.spyOn(ContractService.prototype, 'buildDepositTx'),
  };
}

function makeTrade(overrides: Partial<Trade> = {}): Trade {
  return {
    id: 1,
    tradeId: '4294967297',
    buyerAddress: '',
    sellerAddress: '',
    amountUsdc: '100.00',
    buyerLossBps: 5000,
    sellerLossBps: 5000,
    version: 0,
    status: TradeStatus.CREATED,
    fundedAt: null,
    deliveredAt: null,
    completedAt: null,
    expiresAt: null,
    expiredAt: null,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  };
}

const mockTradeService = createMockTradeService();
const mockContractService = createMockContractService();
let mockedTradeStatus: TradeStatus = TradeStatus.CREATED;

jest
  .spyOn(contractServiceModule, 'buildConfirmDeliveryTx')
  .mockResolvedValue('AAAAAXNvbWUtY29uZmlybS14ZHI=');
jest
  .spyOn(contractServiceModule, 'buildReleaseFundsTx')
  .mockResolvedValue('AAAAAXNvbWUtcmVsZWFzZS14ZHI=');

function createTestApp(): express.Application {
  const app = express();
  app.use(express.json());

  process.env.JWT_SECRET = JWT_SECRET;
  process.env.JWT_ISSUER = 'amana';
  process.env.JWT_AUDIENCE = 'amana-api';

  const tradeRouter = createTradeRouter();
  app.use('/trades', tradeRouter);
  app.use('/api/v1/trades', tradeRouter);
  app.use(errorHandler);

  return app;
}

pactDescribe('Pact Provider Verification - Trades API', () => {
  let app: express.Application;
  let server: ReturnType<express.Application['listen']>;

  beforeAll(async () => {
    app = createTestApp();

    const buyerAddress = 'GDNM7WSJ7VIUVK2TSZ2OQES5XR2663TZEIBFXRDT56B5IRLHERVWSXMU';
    const sellerAddress = 'GBQ5NYMF2UBXZPH7PCPCUNTONIIIVRRQ24ZDUVAOD4GXLMI5SAQUJDFK';

    mockContractService.buildCreateTradeTx.mockResolvedValue({
      tradeId: '4294967297',
      unsignedXdr: 'AAAAAXNvbWUtY3JlYXRlLXRyYWRlLXhkcg==',
    });

    mockTradeService.createPendingTrade.mockResolvedValue(
      makeTrade({ tradeId: '4294967297' }),
    );

    mockTradeService.getTradeById.mockImplementation(async (tradeId, caller) => {
      if (caller === buyerAddress || caller === sellerAddress) {
        return makeTrade({
          tradeId,
          buyerAddress,
          sellerAddress,
          amountUsdc: '100.00',
          status: mockedTradeStatus,
        });
      }
      return null;
    });

    mockContractService.buildDepositTx.mockResolvedValue({
      unsignedXdr: 'AAAAAXNvbWUtZGVwb3NpdC10eC14ZHI=',
    });

    mockTradeService.listUserTrades.mockResolvedValue({
      items: [
        makeTrade({
          tradeId: '4294967297',
          buyerAddress,
          sellerAddress,
          amountUsdc: '100.00',
          status: TradeStatus.CREATED,
        }),
      ],
      pagination: { page: 1, limit: 10, total: 1, totalPages: 1 },
    });

    mockTradeService.getUserStats.mockResolvedValue({
      totalTrades: 10,
      totalVolume: "250000.0000000",
      openTrades: 3,
    });

    mockTradeService.initiateDispute.mockResolvedValue({
      unsignedXdr: 'AAAAAXNvbWUtZGlzcHV0ZS14ZHI=',
    });

    jest.spyOn(AuthService, 'isTokenRevoked').mockResolvedValue(false);

    return new Promise<void>((resolve) => {
      server = app.listen(0, () => {
        const addr = server.address();
        if (addr && typeof addr === 'object') {
          process.env.PACT_PROVIDER_PORT = String(addr.port);
        }
        resolve();
      });
    });
  });

  afterAll(() => {
    if (server) {
      server.close();
    }
    jest.restoreAllMocks();
  });

  pactTest('verifies the provider against the consumer pacts', async () => {
    const port = process.env.PACT_PROVIDER_PORT || '3001';

    const { Verifier } = await import('@pact-foundation/pact');
    const output = await new Verifier({
      provider: 'AmanaBackend',
      providerBaseUrl: `http://localhost:${port}`,
      pactUrls: pactFiles,
      stateHandlers: {
        'a buyer is authenticated': async () => Promise.resolve(),
        'a trade exists in CREATED status': async () => {
          mockedTradeStatus = TradeStatus.CREATED;
        },
        'a trade exists in FUNDED status': async () => {
          mockedTradeStatus = TradeStatus.FUNDED;
        },
        'a trade exists in DELIVERED status': async () => {
          mockedTradeStatus = TradeStatus.DELIVERED;
        },
        'a trade exists with id 4294967297': async () => {
          mockedTradeStatus = TradeStatus.CREATED;
        },
        'the user has trades': async () => Promise.resolve(),
        'the user has trade statistics': async () => Promise.resolve(),
      },
    }).verifyProvider();

    console.log('Pact Verification Complete:', output);
    expect(output).toBeDefined();
  });
});
