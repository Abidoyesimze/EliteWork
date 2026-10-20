import {
  parseDeepLink,
  requiresAuth,
  webUrlFor,
  PUBLIC_SCREENS,
  LINK_PREFIXES,
  type DeepLinkTarget,
} from '../../constants/links';

describe('Navigation Route Guards & Deep Link Resolution', () => {
  describe('Route Guard Logic (requiresAuth & PUBLIC_SCREENS)', () => {
    it('marks WalletConnect as a public screen not requiring authentication', () => {
      expect(PUBLIC_SCREENS.has('WalletConnect')).toBe(true);

      const target: DeepLinkTarget = { screen: 'WalletConnect' };
      expect(requiresAuth(target)).toBe(false);
    });

    it('marks core trade and dispute screens as auth-gated', () => {
      const authGatedScreens: DeepLinkTarget[] = [
        { screen: 'TradeList' },
        { screen: 'TradeDetail', params: { tradeId: 'trade-123' } },
        { screen: 'DisputeDetail', params: { id: 'dispute-456' } },
        { screen: 'CreateTrade' },
        { screen: 'EvidenceCapture', params: { tradeId: 'trade-123' } },
        { screen: 'VaultDashboard' },
      ];

      for (const target of authGatedScreens) {
        expect(requiresAuth(target)).toBe(true);
        expect(PUBLIC_SCREENS.has(target.screen)).toBe(false);
      }
    });

    it('marks admin screens as auth-gated', () => {
      const adminScreens: DeepLinkTarget[] = [
        { screen: 'AdminStreamsOverview' },
        { screen: 'AdminTradesBatch' },
        { screen: 'AdminContract' },
        { screen: 'AdminFeatures' },
        { screen: 'AdminActionSuccess' },
      ];

      for (const target of adminScreens) {
        expect(requiresAuth(target)).toBe(true);
        expect(PUBLIC_SCREENS.has(target.screen)).toBe(false);
      }
    });

    it('simulates auth-interception in getStateFromPath when user is unauthenticated', () => {
      const simulateGetStateFromPath = (path: string, isAuthenticated: boolean) => {
        const target = parseDeepLink(path);
        if (target && requiresAuth(target) && !isAuthenticated) {
          return { routes: [{ name: 'WalletConnect' }] };
        }
        return { routes: [{ name: target ? target.screen : 'Unknown', params: target?.params }] };
      };

      // Unauthenticated access to auth-gated routes gets redirected to WalletConnect
      expect(simulateGetStateFromPath('trades/123', false)).toEqual({
        routes: [{ name: 'WalletConnect' }],
      });
      expect(simulateGetStateFromPath('amanavault://disputes/456', false)).toEqual({
        routes: [{ name: 'WalletConnect' }],
      });
      expect(simulateGetStateFromPath('/create-trade', false)).toEqual({
        routes: [{ name: 'WalletConnect' }],
      });

      // Authenticated access resolves to the target screen
      expect(simulateGetStateFromPath('trades/123', true)).toEqual({
        routes: [{ name: 'TradeDetail', params: { tradeId: '123' } }],
      });
      expect(simulateGetStateFromPath('amanavault://disputes/456', true)).toEqual({
        routes: [{ name: 'DisputeDetail', params: { id: '456' } }],
      });
    });
  });

  describe('Deep Link URL & Scheme Parsing (parseDeepLink)', () => {
    it('parses custom scheme URLs (amanavault://)', () => {
      expect(parseDeepLink('amanavault://trades')).toEqual({
        screen: 'TradeList',
        params: undefined,
      });

      expect(parseDeepLink('amanavault://trades/trade-987')).toEqual({
        screen: 'TradeDetail',
        params: { tradeId: 'trade-987' },
      });

      expect(parseDeepLink('amanavault://disputes/disp-543')).toEqual({
        screen: 'DisputeDetail',
        params: { id: 'disp-543' },
      });

      expect(parseDeepLink('amanavault://create-trade')).toEqual({
        screen: 'CreateTrade',
        params: undefined,
      });
    });

    it('parses evidence deep links via both canonical and legacy alias formats', () => {
      expect(parseDeepLink('amanavault://trades/tr-42/evidence')).toEqual({
        screen: 'EvidenceCapture',
        params: { tradeId: 'tr-42' },
      });

      expect(parseDeepLink('amanavault://evidence/tr-42')).toEqual({
        screen: 'EvidenceCapture',
        params: { tradeId: 'tr-42' },
      });
    });

    it('parses universal web URLs (https://amanavault.app and www variant)', () => {
      expect(parseDeepLink('https://amanavault.app/trades/abc-123')).toEqual({
        screen: 'TradeDetail',
        params: { tradeId: 'abc-123' },
      });

      expect(parseDeepLink('https://www.amanavault.app/disputes/xyz-789')).toEqual({
        screen: 'DisputeDetail',
        params: { id: 'xyz-789' },
      });
    });

    it('parses bare paths with or without leading slashes', () => {
      expect(parseDeepLink('/trades/456')).toEqual({
        screen: 'TradeDetail',
        params: { tradeId: '456' },
      });

      expect(parseDeepLink('trades/456')).toEqual({
        screen: 'TradeDetail',
        params: { tradeId: '456' },
      });

      expect(parseDeepLink('///trades///456///')).toEqual({
        screen: 'TradeDetail',
        params: { tradeId: '456' },
      });
    });

    it('decodes URI encoded parameters properly', () => {
      expect(parseDeepLink('amanavault://trades/encoded%20trade%20id')).toEqual({
        screen: 'TradeDetail',
        params: { tradeId: 'encoded trade id' },
      });
    });

    it('rejects malformed, empty, or malicious parameter values', () => {
      expect(parseDeepLink(null)).toBeNull();
      expect(parseDeepLink(undefined)).toBeNull();
      expect(parseDeepLink('')).toBeNull();
      expect(parseDeepLink('not-a-valid-route')).toBeNull();
      expect(parseDeepLink('amanavault://trades/undefined')).toBeNull();
      expect(parseDeepLink('amanavault://trades/null')).toBeNull();
      expect(parseDeepLink('amanavault://disputes/undefined')).toBeNull();
    });

    it('contains all expected link prefixes', () => {
      expect(LINK_PREFIXES).toContain('amanavault://');
      expect(LINK_PREFIXES).toContain('https://amanavault.app');
      expect(LINK_PREFIXES).toContain('https://www.amanavault.app');
    });
  });

  describe('Web URL Generation (webUrlFor)', () => {
    it('generates canonical web URL for trade detail', () => {
      const url = webUrlFor({
        screen: 'TradeDetail',
        params: { tradeId: 'trade-123' },
      });
      expect(url).toBe('https://amanavault.app/trades/trade-123');
    });

    it('generates canonical web URL for dispute detail', () => {
      const url = webUrlFor({
        screen: 'DisputeDetail',
        params: { id: 'dispute-999' },
      });
      expect(url).toBe('https://amanavault.app/disputes/dispute-999');
    });

    it('generates canonical web URL for create trade', () => {
      const url = webUrlFor({ screen: 'CreateTrade' });
      expect(url).toBe('https://amanavault.app/trades/create');
    });

    it('generates canonical web URL for trade list', () => {
      const url = webUrlFor({ screen: 'TradeList' });
      expect(url).toBe('https://amanavault.app/trades');
    });

    it('falls back to web origin for unmapped screens', () => {
      const url = webUrlFor({ screen: 'WalletConnect' });
      expect(url).toBe('https://amanavault.app');
    });
  });
});
