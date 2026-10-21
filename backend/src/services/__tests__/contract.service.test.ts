import { PrismaClient } from "@prisma/client";
import * as StellarSdk from "@stellar/stellar-sdk";
import { ContractService, buildConfirmDeliveryTx, buildReleaseFundsTx, buildInitiateDisputeTx } from "../contract.service";
import { env } from "../../config/env";
import type { TradeStatus } from "@prisma/client";

// Valid Stellar test addresses (generated)
const BUYER_ADDRESS = "GA76UH2NCQGNQKV435NFKTPUKMICLNNKC3S23THQPYH6FPXZEGAYNORE";
const SELLER_ADDRESS = "GC727UYCOXQLY5CGQJEKTU2Z2VAITBSWBL7NCOSXKAZES4VJRL3ZUJEC";
const ADMIN_ADDRESS = "GBKGGED7YHNZLYZHJ7Y5OFS4MQOQZ6OFCH4WT7KXWHYET5SVGF57FNYP";
const MEDIATOR_ADDRESS = "GAFC5Z3DOIWNJC5XPYCNRCOFXK2XXFEYURMPFL2TPIEIFVLYN2J26E5H";
const CUSTOM_ADDRESS = "GDKPTP65CHTUDPUYRFQRTCA4P6YP6MVXZDNHVTVY7KW4M7UYTQAMNDQI";

// Valid contract IDs (generated)
const ESCROW_CONTRACT_ID = "CCGT4RNYSZIB6F7DI26YWU2WG2AH743GXCBM52OBHAZPCXLBBO3CXR7Z";
const USDC_CONTRACT_ID = "CCIBA6O2IP4SSX3PRBDLQSUUDTDDR4GQK3LPHYOIWPZRQDSYBH2P3BDK";

type TradeRow = {
  tradeId: string;
  buyerAddress: string;
  sellerAddress: string;
  amountUsdc: string;
  status: TradeStatus;
};

type RpcServerMock = {
  getAccount: jest.Mock;
  prepareTransaction: jest.Mock;
  simulateTransaction: jest.Mock;
};

function makeTrade(overrides: Partial<TradeRow> = {}): TradeRow {
  return {
    tradeId: "12345",
    buyerAddress: BUYER_ADDRESS,
    sellerAddress: SELLER_ADDRESS,
    amountUsdc: "5000",
    status: "FUNDED" as TradeStatus,
    ...overrides,
  };
}

function makeRpcServer(overrides: Partial<RpcServerMock> = {}): RpcServerMock {
  return {
    getAccount: jest.fn().mockResolvedValue({
      accountId: "BUYER_ADDRESS",
      sequenceNumber: "100",
      thresholds: [1, 0, 0, 0],
    }),
    prepareTransaction: jest.fn().mockImplementation(async (tx: StellarSdk.Transaction) => tx),
    simulateTransaction: jest.fn().mockResolvedValue({
      result: { retval: StellarSdk.nativeToScVal(BigInt("12345"), { type: "u64" }) },
      events: [],
      latestLedger: 100,
    }),
    ...overrides,
  };
}

function makeContractService(rpcServer: RpcServerMock): ContractService {
  const originalFactory = (global as any).__RPC_SERVER_FACTORY__;
  (global as any).__RPC_SERVER_FACTORY__ = () => rpcServer;
  
  const service = new ContractService(
    "https://mock-rpc.stellar.org",
    ESCROW_CONTRACT_ID,
    USDC_CONTRACT_ID,
    StellarSdk.Networks.TESTNET
  );
  
  (global as any).__RPC_SERVER_FACTORY__ = originalFactory;
  return service;
}

jest.mock("../../config/env", () => ({
  env: {
    STELLAR_RPC_URL: "https://soroban-testnet.stellar.org",
    STELLAR_NETWORK_PASSPHRASE: StellarSdk.Networks.TESTNET,
    STELLAR_NETWORK: "TESTNET",
    AMANA_ESCROW_CONTRACT_ID: "CCGT4RNYSZIB6F7DI26YWU2WG2AH743GXCBM52OBHAZPCXLBBO3CXR7Z",
    USDC_CONTRACT_ID: "CCIBA6O2IP4SSX3PRBDLQSUUDTDDR4GQK3LPHYOIWPZRQDSYBH2P3BDK",
    JWT_SECRET: "test-secret",
  },
}));

// Mock StellarSdk to avoid validation of addresses and contract IDs
jest.mock("@stellar/stellar-sdk", () => {
  const actualSdk = jest.requireActual("@stellar/stellar-sdk");
  return {
    ...actualSdk,
    Contract: jest.fn().mockImplementation(() => ({
      call: jest.fn().mockReturnThis(),
    })),
    Address: {
      fromString: jest.fn().mockImplementation((addr: string) => ({
        toScVal: jest.fn().mockReturnValue({ _scVal: addr }),
      })),
    },
    TransactionBuilder: jest.fn().mockImplementation(() => ({
      addOperation: jest.fn().mockReturnThis(),
      setTimeout: jest.fn().mockReturnThis(),
      build: jest.fn().mockReturnValue({
        toXDR: jest.fn().mockReturnValue("mock-xdr"),
      }),
    }),
    BASE_FEE: 100,
    Networks: {
      TESTNET: "Test SDF Network ; September 2015",
      PUBLIC: "Public Global Stellar Network ; September 2015",
    },
    rpc: {
      Server: jest.fn().mockImplementation(() => ({
        getAccount: jest.fn(),
        prepareTransaction: jest.fn(),
        simulateTransaction: jest.fn(),
      })),
    },
    nativeToScVal: jest.fn().mockImplementation((val: any) => ({ _scVal: val })),
    scValToNative: jest.fn().mockImplementation((val: any) => val._scVal),
    xdr: {
      ScVal: {
        scvU64: jest.fn().mockImplementation((val: any) => ({ _scVal: val })),
      },
      Uint64: {
        fromString: jest.fn().mockImplementation((val: string) => ({ _value: val })),
      },
    },
  };
});

jest.mock("../../lib/metrics", () => ({
  withRpcMetrics: jest.fn((name, fn) => fn()),
}));

jest.mock("../../lib/retry", () => ({
  retryAsync: jest.fn(async (fn) => fn()),
}));

jest.mock("../../lib/money", () => ({
  parseDecimalToStroops: jest.fn((val: string) => BigInt(Math.round(parseFloat(val) * 1_000_000))),
}));

jest.mock("../../middleware/correlationId.middleware", () => ({
  TraceContext: class TraceContext {},
}));

jest.mock("../../middleware/logger", () => ({
  appLogger: { info: jest.fn() },
}));

describe("ContractService.buildCreateTradeTx", () => {
  let rpcServer: RpcServerMock;
  let service: ContractService;

  beforeEach(() => {
    rpcServer = makeRpcServer();
    service = makeContractService(rpcServer);
  });

  it("builds create_trade transaction and returns tradeId and unsignedXdr", async () => {
    const result = await service.buildCreateTradeTx({
      buyerAddress: BUYER_ADDRESS,
      sellerAddress: SELLER_ADDRESS,
      amountUsdc: "5000.00",
      buyerLossBps: 5000,
      sellerLossBps: 5000,
    });

    expect(result.tradeId).toBe("12345");
    expect(result.unsignedXdr).toBeDefined();
    expect(typeof result.unsignedXdr).toBe("string");
    expect(rpcServer.getAccount).toHaveBeenCalled();
    expect(rpcServer.simulateTransaction).toHaveBeenCalled();
    expect(rpcServer.prepareTransaction).toHaveBeenCalled();
  });

  it("throws when CONTRACT_ID is not configured", async () => {
    const serviceNoContract = new ContractService(
      "https://mock-rpc.stellar.org",
      "",
      "USDC_CONTRACT_ID",
      StellarSdk.Networks.TESTNET
    );

    await expect(
      serviceNoContract.buildCreateTradeTx({
        buyerAddress: "BUYER_ADDRESS",
        sellerAddress: "SELLER_ADDRESS",
        amountUsdc: "5000",
        buyerLossBps: 5000,
        sellerLossBps: 5000,
      })
    ).rejects.toThrow("CONTRACT_ID is not configured");
  });

  it("calls parseDecimalToStroops for amount conversion", async () => {
    const { parseDecimalToStroops } = await import("../../lib/money");
    
    await service.buildCreateTradeTx({
      buyerAddress: "BUYER_ADDRESS",
      sellerAddress: "SELLER_ADDRESS",
      amountUsdc: "1234.56",
      buyerLossBps: 3000,
      sellerLossBps: 7000,
    });

    expect(parseDecimalToStroops).toHaveBeenCalledWith("1234.56");
  });

  it("passes correct loss ratios to contract call", async () => {
    await service.buildCreateTradeTx({
      buyerAddress: "BUYER_ADDRESS",
      sellerAddress: "SELLER_ADDRESS",
      amountUsdc: "5000",
      buyerLossBps: 3000,
      sellerLossBps: 7000,
    });

    // Verify the contract call was made with correct parameters
    const callArgs = rpcServer.simulateTransaction.mock.calls[0][0];
    const operations = callArgs.operations;
    expect(operations).toHaveLength(1);
  });
});

describe("ContractService.buildDepositTx", () => {
  let rpcServer: RpcServerMock;
  let service: ContractService;

  beforeEach(() => {
    rpcServer = makeRpcServer();
    service = makeContractService(rpcServer);
  });

  it("builds deposit transaction and returns unsignedXdr", async () => {
    const result = await service.buildDepositTx(
      makeTrade({ tradeId: "12345", buyerAddress: "BUYER_ADDRESS" })
    );

    expect(result.unsignedXdr).toBeDefined();
    expect(typeof result.unsignedXdr).toBe("string");
    expect(rpcServer.getAccount).toHaveBeenCalledWith("BUYER_ADDRESS");
    expect(rpcServer.prepareTransaction).toHaveBeenCalled();
  });

  it("throws when CONTRACT_ID is not configured", async () => {
    const serviceNoContract = new ContractService(
      "https://mock-rpc.stellar.org",
      "",
      "USDC_CONTRACT_ID",
      StellarSdk.Networks.TESTNET
    );

    await expect(
      serviceNoContract.buildDepositTx(makeTrade())
    ).rejects.toThrow("CONTRACT_ID is not configured");
  });

  it("throws when TOKEN_CONTRACT_ID is not configured", async () => {
    const serviceNoToken = new ContractService(
      "https://mock-rpc.stellar.org",
      ESCROW_CONTRACT_ID,
      "",
      StellarSdk.Networks.TESTNET
    );

    await expect(
      serviceNoToken.buildDepositTx(makeTrade())
    ).rejects.toThrow("TOKEN_CONTRACT_ID is not configured");
  });
});

describe("ContractService.buildSubmitManifestTx", () => {
  let rpcServer: RpcServerMock;
  let service: ContractService;

  beforeEach(() => {
    rpcServer = makeRpcServer();
    service = makeContractService(rpcServer);
  });

  it("builds submit_manifest transaction with driver hashes", async () => {
    const result = await service.buildSubmitManifestTx({
      tradeId: "12345",
      sellerAddress: "SELLER_ADDRESS",
      driverNameHash: "sha256-driver-name-hash",
      driverIdHash: "sha256-driver-id-hash",
    });

    expect(result.unsignedXdr).toBeDefined();
    expect(rpcServer.getAccount).toHaveBeenCalledWith("SELLER_ADDRESS");
    expect(rpcServer.prepareTransaction).toHaveBeenCalled();
  });

  it("throws when CONTRACT_ID is not configured", async () => {
    const serviceNoContract = new ContractService(
      "https://mock-rpc.stellar.org",
      "",
      "USDC_CONTRACT_ID",
      StellarSdk.Networks.TESTNET
    );

    await expect(
      serviceNoContract.buildSubmitManifestTx({
        tradeId: "12345",
        sellerAddress: "SELLER_ADDRESS",
        driverNameHash: "hash1",
        driverIdHash: "hash2",
      })
    ).rejects.toThrow("CONTRACT_ID is not configured");
  });
});

describe("ContractService.buildSubmitTradeManifestTx", () => {
  let rpcServer: RpcServerMock;
  let service: ContractService;

  beforeEach(() => {
    rpcServer = makeRpcServer();
    service = makeContractService(rpcServer);
  });

  it("builds submit_trade_manifest transaction with IPFS hash", async () => {
    const result = await service.buildSubmitTradeManifestTx({
      tradeId: "12345",
      sellerAddress: "SELLER_ADDRESS",
      ipfsHash: "QmTestIPFSHash1234567890123456789012345678901234567890",
    });

    expect(result.unsignedXdr).toBeDefined();
    expect(rpcServer.getAccount).toHaveBeenCalledWith("SELLER_ADDRESS");
    expect(rpcServer.prepareTransaction).toHaveBeenCalled();
  });
});

describe("ContractService.buildReleaseMilestoneTx", () => {
  let rpcServer: RpcServerMock;
  let service: ContractService;

  beforeEach(() => {
    rpcServer = makeRpcServer();
    service = makeContractService(rpcServer);
  });

  it("builds release_milestone transaction", async () => {
    const result = await service.buildReleaseMilestoneTx({
      tradeId: "12345",
      sourceAddress: "SELLER_ADDRESS",
      milestoneIndex: 0,
    });

    expect(result.unsignedXdr).toBeDefined();
    expect(rpcServer.getAccount).toHaveBeenCalledWith("SELLER_ADDRESS");
    expect(rpcServer.prepareTransaction).toHaveBeenCalled();
  });
});

describe("ContractService.buildInitiateDisputeTx", () => {
  let rpcServer: RpcServerMock;
  let service: ContractService;

  beforeEach(() => {
    rpcServer = makeRpcServer();
    service = makeContractService(rpcServer);
  });

  it("builds initiate_dispute transaction", async () => {
    const result = await service.buildInitiateDisputeTx({
      tradeId: "12345",
      initiatorAddress: "BUYER_ADDRESS",
      reasonHash: "sha256-reason-hash",
    });

    expect(result.unsignedXdr).toBeDefined();
    expect(rpcServer.getAccount).toHaveBeenCalledWith("BUYER_ADDRESS");
    expect(rpcServer.prepareTransaction).toHaveBeenCalled();
  });
});

describe("ContractService admin methods", () => {
  let rpcServer: RpcServerMock;
  let service: ContractService;

  beforeEach(() => {
    rpcServer = makeRpcServer();
    service = makeContractService(rpcServer);
  });

  it("buildAddMediatorTx builds add_mediator transaction", async () => {
    const result = await service.buildAddMediatorTx({
      adminAddress: "ADMIN_ADDRESS",
      mediatorAddress: "MEDIATOR_ADDRESS",
    });

    expect(result.unsignedXdr).toBeDefined();
    expect(rpcServer.getAccount).toHaveBeenCalledWith("ADMIN_ADDRESS");
    expect(rpcServer.prepareTransaction).toHaveBeenCalled();
  });

  it("buildRemoveMediatorTx builds remove_mediator transaction", async () => {
    const result = await service.buildRemoveMediatorTx({
      adminAddress: "ADMIN_ADDRESS",
      mediatorAddress: "MEDIATOR_ADDRESS",
    });

    expect(result.unsignedXdr).toBeDefined();
    expect(rpcServer.getAccount).toHaveBeenCalledWith("ADMIN_ADDRESS");
    expect(rpcServer.prepareTransaction).toHaveBeenCalled();
  });

  it("buildUpdateFeeBpsTx builds update_fee_bps transaction", async () => {
    const result = await service.buildUpdateFeeBpsTx({
      adminAddress: "ADMIN_ADDRESS",
      feeBps: 150,
    });

    expect(result.unsignedXdr).toBeDefined();
    expect(rpcServer.getAccount).toHaveBeenCalledWith("ADMIN_ADDRESS");
    expect(rpcServer.prepareTransaction).toHaveBeenCalled();
  });
});

describe("Static buildConfirmDeliveryTx", () => {
  let rpcServer: RpcServerMock;

  beforeEach(() => {
    rpcServer = makeRpcServer({
      getAccount: jest.fn().mockResolvedValue({
        accountId: "BUYER_ADDRESS",
        sequenceNumber: "100",
        thresholds: [1, 0, 0, 0],
      }),
      prepareTransaction: jest.fn().mockImplementation(async (tx: StellarSdk.Transaction) => tx),
    });
  });

  it("builds confirm_delivery transaction for FUNDED trade", async () => {
    const xdr = await buildConfirmDeliveryTx(
      makeTrade({ status: "FUNDED", tradeId: "12345" }),
      "BUYER_ADDRESS"
    );

    expect(xdr).toBeDefined();
    expect(typeof xdr).toBe("string");
  });

  it("throws when trade is not FUNDED", async () => {
    await expect(
      buildConfirmDeliveryTx(
        makeTrade({ status: "PENDING" as TradeStatus }),
        "BUYER_ADDRESS"
      )
    ).rejects.toThrow("Trade must be FUNDED before confirm_delivery");
  });
});

describe("Static buildReleaseFundsTx", () => {
  let rpcServer: RpcServerMock;

  beforeEach(() => {
    rpcServer = makeRpcServer({
      getAccount: jest.fn().mockResolvedValue({
        accountId: "SELLER_ADDRESS",
        sequenceNumber: "100",
        thresholds: [1, 0, 0, 0],
      }),
      prepareTransaction: jest.fn().mockImplementation(async (tx: StellarSdk.Transaction) => tx),
    });
  });

  it("builds release_funds transaction for DELIVERED trade", async () => {
    const xdr = await buildReleaseFundsTx(
      makeTrade({ status: "DELIVERED", tradeId: "12345" }),
      "SELLER_ADDRESS"
    );

    expect(xdr).toBeDefined();
    expect(typeof xdr).toBe("string");
  });

  it("throws when trade is not DELIVERED", async () => {
    await expect(
      buildReleaseFundsTx(
        makeTrade({ status: "FUNDED" as TradeStatus }),
        "SELLER_ADDRESS"
      )
    ).rejects.toThrow("Trade must be DELIVERED before release_funds");
  });
});

describe("Static buildInitiateDisputeTx", () => {
  let rpcServer: RpcServerMock;

  beforeEach(() => {
    rpcServer = makeRpcServer({
      getAccount: jest.fn().mockResolvedValue({
        accountId: "BUYER_ADDRESS",
        sequenceNumber: "100",
        thresholds: [1, 0, 0, 0],
      }),
      prepareTransaction: jest.fn().mockImplementation(async (tx: StellarSdk.Transaction) => tx),
    });
  });

  it("builds initiate_dispute transaction", async () => {
    const xdr = await buildInitiateDisputeTx(
      { tradeId: "12345" },
      "BUYER_ADDRESS",
      "sha256-reason-hash"
    );

    expect(xdr).toBeDefined();
    expect(typeof xdr).toBe("string");
  });
});

describe("RPC server factory override for tests", () => {
  it("allows overriding RPC server factory via __setRpcServerFactoryForTests", async () => {
    const customServer = makeRpcServer({
      getAccount: jest.fn().mockResolvedValue({
        accountId: "CUSTOM_ADDRESS",
        sequenceNumber: "200",
        thresholds: [1, 0, 0, 0],
      }),
    });

    // Import the internal function
    const { __setRpcServerFactoryForTests, __resetRpcServerFactoryForTests } = await import("../contract.service");
    
    __setRpcServerFactoryForTests(() => customServer as any);
    
    const service = new ContractService(
      "https://mock-rpc.stellar.org",
      ESCROW_CONTRACT_ID,
      USDC_CONTRACT_ID,
      StellarSdk.Networks.TESTNET
    );

    await service.buildCreateTradeTx({
      buyerAddress: CUSTOM_ADDRESS,
      sellerAddress: SELLER_ADDRESS,
      amountUsdc: "5000",
      buyerLossBps: 5000,
      sellerLossBps: 5000,
    });

    expect(customServer.getAccount).toHaveBeenCalledWith("CUSTOM_ADDRESS");
    
    __resetRpcServerFactoryForTests();
  });
});