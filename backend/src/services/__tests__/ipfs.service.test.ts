import { Readable } from "stream";

const mockFetch = jest.fn();
const mockLogger = {
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
};

jest.mock("node-fetch", () => ({
  __esModule: true,
  default: (...args: unknown[]) => mockFetch(...args),
}));

jest.mock("../../utils/logger", () => ({
  __esModule: true,
  default: mockLogger,
  logger: mockLogger,
}));

import * as ipfsService from "../ipfs.service";

describe("ipfs.service", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = { ...originalEnv };
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  describe("uploadToIPFS", () => {
    it("uploads a buffer and returns the CID", async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ IpfsHash: "QmTestHash123" }),
      });

      const result = await ipfsService.uploadToIPFS(
        Buffer.from("hello world"),
        "test.txt",
      );

      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(result).toBe("QmTestHash123");
    });

    it("throws when the IPFS gateway responds with a non-ok status", async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 500,
        statusText: "Internal Server Error",
        text: async () => "boom",
      });

      await expect(
        ipfsService.uploadToIPFS(Buffer.from("data"), "test.txt"),
      ).rejects.toThrow();
    });

    it("throws when the response is missing a CID", async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({}),
      });

      await expect(
        ipfsService.uploadToIPFS(Buffer.from("data"), "test.txt"),
      ).rejects.toThrow();
    });

    it("propagates network errors from fetch", async () => {
      mockFetch.mockRejectedValue(new Error("network down"));

      await expect(
        ipfsService.uploadToIPFS(Buffer.from("data"), "test.txt"),
      ).rejects.toThrow("network down");
    });
  });

  describe("getFromIPFS", () => {
    it("returns the content for a valid CID", async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        status: 200,
        text: async () => "file contents",
      });

      const result = await ipfsService.getFromIPFS("QmTestHash123");

      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(result).toBe("file contents");
    });

    it("throws when the CID is not found", async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 404,
        statusText: "Not Found",
        text: async () => "not found",
      });

      await expect(ipfsService.getFromIPFS("QmMissing")).rejects.toThrow();
    });

    it("propagates network errors from fetch", async () => {
      mockFetch.mockRejectedValue(new Error("timeout"));

      await expect(ipfsService.getFromIPFS("QmTestHash123")).rejects.toThrow(
        "timeout",
      );
    });
  });

  describe("getIPFSUrl", () => {
    it("builds a gateway URL for a CID", () => {
      const url = ipfsService.getIPFSUrl("QmTestHash123");

      expect(typeof url).toBe("string");
      expect(url).toContain("QmTestHash123");
    });
  });

  describe("isValidCID", () => {
    it("returns true for a well-formed CID", () => {
      expect(
        ipfsService.isValidCID(
          "QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG",
        ),
      ).toBe(true);
    });

    it("returns false for an invalid CID", () => {
      expect(ipfsService.isValidCID("not-a-cid")).toBe(false);
      expect(ipfsService.isValidCID("")).toBe(false);
    });
  });

  describe("uploadStreamToIPFS", () => {
    it("uploads a readable stream and returns the CID", async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ IpfsHash: "QmStreamHash" }),
      });

      const stream = Readable.from([Buffer.from("streamed data")]);
      const result = await ipfsService.uploadStreamToIPFS(stream, "stream.txt");

      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(result).toBe("QmStreamHash");
    });

    it("throws when the gateway rejects the stream upload", async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 400,
        statusText: "Bad Request",
        text: async () => "bad request",
      });

      const stream = Readable.from([Buffer.from("streamed data")]);

      await expect(
        ipfsService.uploadStreamToIPFS(stream, "stream.txt"),
      ).rejects.toThrow();
    });
  });
});
