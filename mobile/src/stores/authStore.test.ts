import { act, renderHook } from '@testing-library/react-native';
import * as SecureStore from 'expo-secure-store';

import { useAuthStore, AuthRole } from './authStore';
import { setAuthToken } from '../api/client';

jest.mock('expo-secure-store', () => ({
  setItemAsync: jest.fn(),
  getItemAsync: jest.fn(),
  deleteItemAsync: jest.fn(),
}));

jest.mock('../api/client', () => ({
  setAuthToken: jest.fn(),
}));

const mockSetItemAsync = SecureStore.setItemAsync as jest.MockedFunction<
  typeof SecureStore.setItemAsync
>;
const mockGetItemAsync = SecureStore.getItemAsync as jest.MockedFunction<
  typeof SecureStore.getItemAsync
>;
const mockDeleteItemAsync = SecureStore.deleteItemAsync as jest.MockedFunction<
  typeof SecureStore.deleteItemAsync
>;
const mockSetAuthToken = setAuthToken as jest.MockedFunction<typeof setAuthToken>;

function resetStore(): void {
  act(() => {
    useAuthStore.setState({
      token: null,
      walletAddress: null,
      isLoading: true,
      role: null,
    });
  });
}

describe('useAuthStore', () => {
  let consoleErrorSpy: jest.SpyInstance;

  beforeEach(() => {
    resetStore();
    jest.clearAllMocks();
    consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    mockSetItemAsync.mockResolvedValue();
    mockGetItemAsync.mockResolvedValue(null);
    mockDeleteItemAsync.mockResolvedValue();
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
  });

  describe('initial state and selectors', () => {
    it('initializes with default state values', () => {
      const state = useAuthStore.getState();
      expect(state.token).toBeNull();
      expect(state.walletAddress).toBeNull();
      expect(state.isLoading).toBe(true);
      expect(state.role).toBeNull();
    });

    it('supports selecting state slices via store selector hook', () => {
      act(() => {
        useAuthStore.setState({
          token: 'sample-jwt',
          walletAddress: 'G_WALLET_123',
          isLoading: false,
          role: 'admin',
        });
      });

      const { result: tokenResult } = renderHook(() =>
        useAuthStore((state) => state.token),
      );
      const { result: walletResult } = renderHook(() =>
        useAuthStore((state) => state.walletAddress),
      );
      const { result: loadingResult } = renderHook(() =>
        useAuthStore((state) => state.isLoading),
      );
      const { result: roleResult } = renderHook(() =>
        useAuthStore((state) => state.role),
      );

      expect(tokenResult.current).toBe('sample-jwt');
      expect(walletResult.current).toBe('G_WALLET_123');
      expect(loadingResult.current).toBe(false);
      expect(roleResult.current).toBe('admin');
    });
  });

  describe('setRole', () => {
    it.each<AuthRole>(['admin', 'user', null])(
      'updates role to %s',
      (role) => {
        act(() => {
          useAuthStore.getState().setRole(role);
        });

        expect(useAuthStore.getState().role).toBe(role);
      },
    );
  });

  describe('setToken', () => {
    it('persists token to SecureStore, syncs apiClient, and updates state', async () => {
      const sampleToken = 'eyJhbGciOiJIUzI1NiJ9.sample';

      await act(async () => {
        await useAuthStore.getState().setToken(sampleToken);
      });

      expect(mockSetItemAsync).toHaveBeenCalledWith('amana_token', sampleToken);
      expect(mockSetAuthToken).toHaveBeenCalledWith(sampleToken);
      expect(useAuthStore.getState().token).toBe(sampleToken);
    });

    it('propagates error if SecureStore fails on setToken', async () => {
      const storageError = new Error('Disk full');
      mockSetItemAsync.mockRejectedValueOnce(storageError);

      await expect(
        act(async () => {
          await useAuthStore.getState().setToken('failing-token');
        }),
      ).rejects.toThrow('Disk full');

      expect(useAuthStore.getState().token).toBeNull();
    });
  });

  describe('setWalletAddress', () => {
    it('updates walletAddress in state and writes to remembered key', async () => {
      const wallet = 'GDNM7WSJ7VIUVK2TSZ2OQES5XR2663TZEIBFXRDT56B5IRLHERVWSXMU';

      act(() => {
        useAuthStore.getState().setWalletAddress(wallet);
      });

      expect(useAuthStore.getState().walletAddress).toBe(wallet);
      expect(mockSetItemAsync).toHaveBeenCalledWith(
        'amana_remembered_wallet',
        wallet,
      );
    });

    it('does not throw or block when SecureStore write fails (fire-and-forget)', async () => {
      const writeError = new Error('Secure storage unavailable');
      mockSetItemAsync.mockRejectedValueOnce(writeError);

      expect(() => {
        act(() => {
          useAuthStore.getState().setWalletAddress('G_FAILING_WALLET');
        });
      }).not.toThrow();

      expect(useAuthStore.getState().walletAddress).toBe('G_FAILING_WALLET');

      // Flush microtasks for the .catch handler
      await act(async () => {
        await Promise.resolve();
      });

      expect(consoleErrorSpy).toHaveBeenCalledWith(
        'Failed to persist remembered wallet address:',
        writeError,
      );
    });
  });

  describe('getToken', () => {
    it('retrieves token from SecureStore, updates apiClient and state, and returns it', async () => {
      const storedToken = 'stored-jwt-token';
      mockGetItemAsync.mockResolvedValueOnce(storedToken);

      let returnedToken: string | null = null;
      await act(async () => {
        returnedToken = await useAuthStore.getState().getToken();
      });

      expect(mockGetItemAsync).toHaveBeenCalledWith('amana_token');
      expect(mockSetAuthToken).toHaveBeenCalledWith(storedToken);
      expect(useAuthStore.getState().token).toBe(storedToken);
      expect(returnedToken).toBe(storedToken);
    });

    it('returns null and updates state when no token is in storage', async () => {
      mockGetItemAsync.mockResolvedValueOnce(null);

      let returnedToken: string | null = 'not-null';
      await act(async () => {
        returnedToken = await useAuthStore.getState().getToken();
      });

      expect(mockGetItemAsync).toHaveBeenCalledWith('amana_token');
      expect(mockSetAuthToken).toHaveBeenCalledWith(null);
      expect(useAuthStore.getState().token).toBeNull();
      expect(returnedToken).toBeNull();
    });

    it('catches SecureStore failure, logs error, and returns null', async () => {
      const readError = new Error('Keychain read failure');
      mockGetItemAsync.mockRejectedValueOnce(readError);

      let returnedToken: string | null = 'not-null';
      await act(async () => {
        returnedToken = await useAuthStore.getState().getToken();
      });

      expect(consoleErrorSpy).toHaveBeenCalledWith(
        'Failed to retrieve token:',
        readError,
      );
      expect(returnedToken).toBeNull();
    });
  });

  describe('getRememberedWalletAddress', () => {
    it('returns remembered wallet address from SecureStore', async () => {
      const rememberedWallet = 'G_REMEMBERED_123';
      mockGetItemAsync.mockResolvedValueOnce(rememberedWallet);

      let result: string | null = null;
      await act(async () => {
        result = await useAuthStore.getState().getRememberedWalletAddress();
      });

      expect(mockGetItemAsync).toHaveBeenCalledWith('amana_remembered_wallet');
      expect(result).toBe(rememberedWallet);
    });

    it('returns null if no remembered address exists', async () => {
      mockGetItemAsync.mockResolvedValueOnce(null);

      let result: string | null = 'placeholder';
      await act(async () => {
        result = await useAuthStore.getState().getRememberedWalletAddress();
      });

      expect(mockGetItemAsync).toHaveBeenCalledWith('amana_remembered_wallet');
      expect(result).toBeNull();
    });

    it('catches storage failure, logs error, and returns null gracefully', async () => {
      const readError = new Error('Biometric lock active');
      mockGetItemAsync.mockRejectedValueOnce(readError);

      let result: string | null = 'placeholder';
      await act(async () => {
        result = await useAuthStore.getState().getRememberedWalletAddress();
      });

      expect(consoleErrorSpy).toHaveBeenCalledWith(
        'Failed to retrieve remembered wallet address:',
        readError,
      );
      expect(result).toBeNull();
    });
  });

  describe('clearAuth', () => {
    it('deletes token from storage, clears apiClient token, resets auth state, and leaves remembered wallet untouched', async () => {
      // Seed signed-in state
      act(() => {
        useAuthStore.setState({
          token: 'existing-token',
          walletAddress: 'G_SIGNED_IN_WALLET',
          role: 'admin',
          isLoading: false,
        });
      });

      await act(async () => {
        await useAuthStore.getState().clearAuth();
      });

      expect(mockDeleteItemAsync).toHaveBeenCalledWith('amana_token');
      // Must NOT delete the remembered wallet key (Issue #57 biometric shortcut invariant)
      expect(mockDeleteItemAsync).not.toHaveBeenCalledWith(
        'amana_remembered_wallet',
      );
      expect(mockSetAuthToken).toHaveBeenCalledWith(null);

      const state = useAuthStore.getState();
      expect(state.token).toBeNull();
      expect(state.walletAddress).toBeNull();
      expect(state.role).toBeNull();
    });
  });
});
