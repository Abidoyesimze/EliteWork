/**
 * VaultDashboard.test.tsx
 *
 * Covers the primary render states of VaultDashboard (loading skeleton,
 * empty, populated, load-error-only, error-above-list) and its key
 * interactions (mount fetch, pull-to-refresh, banner retry / sign-out /
 * go-back / contact-support).
 */
import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
import { FlatList, Linking, RefreshControl } from 'react-native';

import VaultDashboard from './VaultDashboard';
import { useTradeStore } from '../stores/tradeStore';
import { useAuthStore } from '../stores/authStore';
import type { AdminErrorView } from '../api/errors';
import type { Trade, TradeStatus } from '../types/trade';

jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

jest.mock('../stores/tradeStore', () => ({
  useTradeStore: jest.fn(),
}));

jest.mock('../stores/authStore', () => ({
  useAuthStore: jest.fn(),
}));

const WALLET = 'GDNM7WSJ7VIUVK2TSZ2OQES5XR2663TZEIBFXRDT56B5IRLHERVWSXMU';

function makeTrade(
  n: number,
  status: TradeStatus,
  amountUsdc = '100.00',
): Trade {
  return {
    id: n,
    tradeId: `${n}`.padStart(12, '0'),
    buyerAddress: WALLET,
    sellerAddress: 'GBQ5NYMF2UBXZPH7PCPCUNTONIIIVRRQ24ZDUVAOD4GXLMI5SAQUJDFK',
    amountUsdc,
    status,
  };
}

function makeView(overrides: Partial<AdminErrorView> = {}): AdminErrorView {
  return {
    title: 'Something went wrong',
    message: 'Could not load your trades.',
    action: 'retry',
    code: 'INTERNAL_ERROR',
    requestId: 'req-123',
    ...overrides,
  };
}

describe('VaultDashboard', () => {
  const fetchTrades = jest.fn();
  const clearErrorView = jest.fn();
  const clearAuth = jest.fn();
  let openURL: jest.SpyInstance;

  function mockStores(
    trade: Partial<ReturnType<typeof useTradeStore>> = {},
    auth: { walletAddress?: string | null } = {},
  ) {
    (useTradeStore as unknown as jest.Mock).mockReturnValue({
      trades: [],
      isLoading: false,
      errorView: null,
      lastActionErrorView: null,
      fetchTrades,
      clearErrorView,
      ...trade,
    });
    (useAuthStore as unknown as jest.Mock).mockReturnValue({
      walletAddress: WALLET,
      clearAuth,
      ...auth,
    });
  }

  beforeEach(() => {
    jest.clearAllMocks();
    fetchTrades.mockResolvedValue(undefined);
    clearAuth.mockResolvedValue(undefined);
    openURL = jest.spyOn(Linking, 'openURL').mockResolvedValue(true);
    mockStores();
  });

  afterEach(() => {
    openURL.mockRestore();
  });

  describe('loading', () => {
    it('shows only the header and skeleton while the first load is in flight', () => {
      mockStores({ isLoading: true });
      const { getByText, queryByText } = render(<VaultDashboard />);

      expect(getByText('Vault Dashboard')).toBeTruthy();
      expect(queryByText('Recent Trades')).toBeNull();
      expect(queryByText('Total Locked')).toBeNull();
      expect(queryByText('No trades yet')).toBeNull();
    });

    it('fetches trades once on mount', () => {
      render(<VaultDashboard />);

      expect(fetchTrades).toHaveBeenCalledTimes(1);
    });
  });

  describe('empty state', () => {
    it('renders zeroed stats and the empty message', () => {
      const { getByText } = render(<VaultDashboard />);

      expect(getByText('Total Locked')).toBeTruthy();
      expect(getByText('$0.00')).toBeTruthy();
      expect(getByText('Active Trades')).toBeTruthy();
      expect(getByText('0')).toBeTruthy();
      expect(getByText('Recent Trades')).toBeTruthy();
      expect(getByText('No trades yet')).toBeTruthy();
    });
  });

  describe('populated state', () => {
    it('only counts FUNDED and IN_TRANSIT trades towards the stats', () => {
      mockStores({
        trades: [
          makeTrade(1, 'FUNDED', '100.50'),
          makeTrade(2, 'IN_TRANSIT', '49.50'),
          makeTrade(3, 'COMPLETED', '900.00'),
          makeTrade(4, 'PENDING', '25.00'),
          makeTrade(5, 'DISPUTED', '10.00'),
        ],
      });
      const { getByText } = render(<VaultDashboard />);

      expect(getByText('$150.00')).toBeTruthy();
      expect(getByText('2')).toBeTruthy();
      expect(getByText('in progress')).toBeTruthy();
    });

    it('renders each trade row with a shortened id and its USDC amount', () => {
      mockStores({
        trades: [makeTrade(123456789012, 'FUNDED', '75.25')],
      });
      const { getByText, queryByText } = render(<VaultDashboard />);

      expect(getByText('#12345678')).toBeTruthy();
      expect(getByText('75.25 USDC')).toBeTruthy();
      expect(queryByText('No trades yet')).toBeNull();
    });

    it('treats a missing amount as zero when totalling locked funds', () => {
      mockStores({
        trades: [
          makeTrade(1, 'FUNDED', ''),
          makeTrade(2, 'FUNDED', '20.00'),
        ],
      });
      const { getByText } = render(<VaultDashboard />);

      expect(getByText('$20.00')).toBeTruthy();
    });

    it('lists at most the 10 most recent trades but totals every active trade', () => {
      const trades = Array.from({ length: 12 }, (_, i) =>
        makeTrade(i + 1, 'FUNDED', '10.00'),
      );
      mockStores({ trades });
      const { UNSAFE_getByType, getByText } = render(<VaultDashboard />);

      expect(UNSAFE_getByType(FlatList).props.data).toHaveLength(10);
      // Stats are computed over all 12 trades, not just the visible slice.
      expect(getByText('$120.00')).toBeTruthy();
      expect(getByText('12')).toBeTruthy();
    });
  });

  describe('wallet badge', () => {
    it('shows the shortened wallet address when connected', () => {
      const { getByText } = render(<VaultDashboard />);

      expect(getByText('GDNM7W…SXMU')).toBeTruthy();
    });

    it('shows "Not connected" without a wallet address', () => {
      mockStores({}, { walletAddress: null });
      const { getByText } = render(<VaultDashboard />);

      expect(getByText('Not connected')).toBeTruthy();
    });
  });

  describe('pull-to-refresh', () => {
    it('re-fetches trades and clears the refreshing flag when done', async () => {
      const { UNSAFE_getByType } = render(<VaultDashboard />);
      expect(UNSAFE_getByType(RefreshControl).props.refreshing).toBe(false);

      await act(async () => {
        await UNSAFE_getByType(RefreshControl).props.onRefresh();
      });

      expect(fetchTrades).toHaveBeenCalledTimes(2);
      await waitFor(() =>
        expect(UNSAFE_getByType(RefreshControl).props.refreshing).toBe(false),
      );
    });
  });

  describe('error handling', () => {
    it('shows only the banner when the load failed and there are no trades', () => {
      mockStores({ errorView: makeView() });
      const { getByTestId, getByText, queryByText } = render(
        <VaultDashboard />,
      );

      expect(getByTestId('admin-error-banner')).toBeTruthy();
      expect(getByText('Something went wrong')).toBeTruthy();
      expect(queryByText('Total Locked')).toBeNull();
      expect(queryByText('Not connected')).toBeNull();
      expect(queryByText('GDNM7W…SXMU')).toBeNull();
    });

    it('keeps the stats and list visible beneath the banner when trades already loaded', () => {
      mockStores({
        errorView: makeView(),
        trades: [makeTrade(1, 'FUNDED', '60.00')],
      });
      const { getByTestId, getByText } = render(<VaultDashboard />);

      expect(getByTestId('admin-error-banner')).toBeTruthy();
      expect(getByText('Total Locked')).toBeTruthy();
      expect(getByText('$60.00')).toBeTruthy();
    });

    it('prefers the last action error over a stale load error', () => {
      mockStores({
        errorView: makeView({ title: 'Load failed' }),
        lastActionErrorView: makeView({ title: 'Action failed' }),
      });
      const { getByText, queryByText } = render(<VaultDashboard />);

      expect(getByText('Action failed')).toBeTruthy();
      expect(queryByText('Load failed')).toBeNull();
    });

    it('retries the fetch from the banner "Try again" button', () => {
      mockStores({ errorView: makeView({ action: 'retry' }) });
      const { getByTestId } = render(<VaultDashboard />);
      expect(fetchTrades).toHaveBeenCalledTimes(1);

      fireEvent.press(getByTestId('admin-error-banner-primary-retry'));

      expect(fetchTrades).toHaveBeenCalledTimes(2);
    });

    it('clears auth from the banner "Sign out" button', async () => {
      mockStores({
        errorView: makeView({
          action: 'sign_out_required',
          code: 'AUTH_ERROR',
        }),
      });
      const { getByTestId } = render(<VaultDashboard />);

      await act(async () => {
        fireEvent.press(
          getByTestId('admin-error-banner-primary-sign_out_required'),
        );
      });

      expect(clearAuth).toHaveBeenCalledTimes(1);
    });

    it('dismisses the error from the banner "Go back" button', () => {
      mockStores({ errorView: makeView({ action: 'go_back' }) });
      const { getByTestId } = render(<VaultDashboard />);

      fireEvent.press(getByTestId('admin-error-banner-primary-go_back'));

      expect(clearErrorView).toHaveBeenCalledTimes(1);
    });

    it('opens a support mailto carrying the error code and request id', () => {
      mockStores({
        errorView: makeView({ code: 'INTERNAL_ERROR', requestId: 'req-987' }),
      });
      const { getByTestId } = render(<VaultDashboard />);

      fireEvent.press(getByTestId('admin-error-banner-secondary'));

      expect(openURL).toHaveBeenCalledTimes(1);
      const url = decodeURIComponent(openURL.mock.calls[0][0] as string);
      expect(url).toMatch(/^mailto:/);
      expect(url).toContain('vault dashboard');
      expect(url).toContain('Error code: INTERNAL_ERROR');
      expect(url).toContain('Request id: req-987');
    });
  });
});
