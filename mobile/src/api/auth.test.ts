import apiClient from './client';
import { authApi } from './auth';

jest.mock('./client', () => ({
  __esModule: true,
  default: {
    get: jest.fn(),
    post: jest.fn(),
  },
}));

const mockPost = apiClient.post as jest.MockedFunction<typeof apiClient.post>;

const WALLET = 'GDNM7WSJ7VIUVK2TSZ2OQES5XR2663TZEIBFXRDT56B5IRLHERVWSXMU';

describe('authApi', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('generateChallenge', () => {
    it('POSTs the wallet address to /auth/challenge and returns the body', async () => {
      mockPost.mockResolvedValueOnce({ data: { challenge: 'nonce-123' } });

      const result = await authApi.generateChallenge(WALLET);

      expect(mockPost).toHaveBeenCalledTimes(1);
      expect(mockPost).toHaveBeenCalledWith('/auth/challenge', {
        walletAddress: WALLET,
      });
      expect(result).toEqual({ challenge: 'nonce-123' });
    });

    it('propagates request failures to the caller', async () => {
      const failure = new Error('Network Error');
      mockPost.mockRejectedValueOnce(failure);

      await expect(authApi.generateChallenge(WALLET)).rejects.toBe(failure);
    });
  });

  describe('verifyChallenge', () => {
    it('POSTs the address and signed challenge to /auth/verify and returns the token', async () => {
      mockPost.mockResolvedValueOnce({ data: { token: 'jwt-abc' } });

      const result = await authApi.verifyChallenge(WALLET, 'signed-payload');

      expect(mockPost).toHaveBeenCalledTimes(1);
      expect(mockPost).toHaveBeenCalledWith('/auth/verify', {
        walletAddress: WALLET,
        signedChallenge: 'signed-payload',
      });
      expect(result).toEqual({ token: 'jwt-abc' });
    });

    it('propagates request failures to the caller', async () => {
      const failure = new Error('Request failed with status code 401');
      mockPost.mockRejectedValueOnce(failure);

      await expect(
        authApi.verifyChallenge(WALLET, 'bad-signature'),
      ).rejects.toBe(failure);
    });
  });

  describe('refreshToken', () => {
    it('POSTs to /auth/refresh without a body and returns the new token', async () => {
      mockPost.mockResolvedValueOnce({ data: { token: 'jwt-refreshed' } });

      const result = await authApi.refreshToken();

      expect(mockPost).toHaveBeenCalledTimes(1);
      expect(mockPost).toHaveBeenCalledWith('/auth/refresh');
      expect(result).toEqual({ token: 'jwt-refreshed' });
    });

    it('propagates request failures to the caller', async () => {
      const failure = new Error('Request failed with status code 401');
      mockPost.mockRejectedValueOnce(failure);

      await expect(authApi.refreshToken()).rejects.toBe(failure);
    });
  });
});
