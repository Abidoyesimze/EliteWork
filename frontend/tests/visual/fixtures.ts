/**
 * Shared fixtures for visual regression tests.
 *
 * Provides:
 *  - Deterministic rendering helpers (freeze animations, mock fonts, freeze
 *    Date so timestamps don't drift between runs).
 *  - A seeded JWT/Freighter mock so authenticated pages render their real
 *    content without hitting the network.
 *  - Route mocks for every API call that dashboard/vault/admin pages make,
 *    returning stable fixture data so screenshot content never changes.
 *
 * Usage:
 *   import { test, expect } from '../visual/fixtures';
 *   test('vault header matches snapshot', async ({ authenticatedPage }) => { ... });
 */

import { test as base, type Page } from '@playwright/test';

// ---------------------------------------------------------------------------
// Fixture data — deterministic values that stay identical across every run.
// ---------------------------------------------------------------------------

export const FIXTURES = {
  walletAddress: 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA001',
  tradeId: 'TRD-FIXTURE-0001',
  tradeIdShort: 'TRD-FIXTU',

  stats: {
    totalTrades: 12,
    totalVolume: 48000,
    openTrades: 3,
  },

  trades: [
    {
      tradeId: 'TRD-FIXTURE-0001',
      buyerAddress: 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA001',
      sellerAddress: 'GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB002',
      amountCngn: '5000',
      amountUsdc: '5000',
      status: 'active',
      buyerLossBps: 5000,
      sellerLossBps: 5000,
      createdAt: '2026-01-15T10:00:00.000Z',
      updatedAt: '2026-01-15T10:00:00.000Z',
    },
    {
      tradeId: 'TRD-FIXTURE-0002',
      buyerAddress: 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA001',
      sellerAddress: 'GCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC003',
      amountCngn: '12000',
      amountUsdc: '12000',
      status: 'completed',
      buyerLossBps: 5000,
      sellerLossBps: 5000,
      createdAt: '2026-01-10T08:00:00.000Z',
      updatedAt: '2026-01-12T14:30:00.000Z',
    },
  ],

  walletBalance: { balance: '17000', asset: 'cNGN' },

  adminStreams: {
    items: [
      {
        id: 'stream-fixture-001',
        status: 'ACTIVE',
        createdAt: '2026-01-15T10:00:00.000Z',
        totalAmount: 5000,
        recipientAddress: 'GDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD004',
        tags: ['agriculture', 'test-fixture'],
      },
    ],
    pagination: { page: 1, limit: 20, total: 1, totalPages: 1 },
  },
} as const;

// ---------------------------------------------------------------------------
// JWT builder (unsigned / alg:none — same pattern used across e2e tests).
// ---------------------------------------------------------------------------

function buildJwt(address: string): string {
  const payload = {
    exp: Math.floor(Date.UTC(2099, 0, 1) / 1000), // far future — won't expire
    walletAddress: address,
    role: 'user',
  };
  return [
    Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url'),
    Buffer.from(JSON.stringify(payload)).toString('base64url'),
    'visual-fixture',
  ].join('.');
}

function buildAdminJwt(address: string): string {
  const payload = {
    exp: Math.floor(Date.UTC(2099, 0, 1) / 1000),
    walletAddress: address,
    role: 'admin',
    isAdmin: true,
  };
  return [
    Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url'),
    Buffer.from(JSON.stringify(payload)).toString('base64url'),
    'visual-admin-fixture',
  ].join('.');
}

// ---------------------------------------------------------------------------
// Deterministic rendering helpers.
// ---------------------------------------------------------------------------

/**
 * Inject into page context before navigation to:
 *  1. Freeze `Date` to a fixed point so timestamps are stable.
 *  2. Override `requestAnimationFrame` so CSS transitions settle immediately.
 *  3. Disable smooth scrolling.
 */
async function freezePageDynamics(page: Page): Promise<void> {
  await page.addInitScript(() => {
    // Freeze date to a deterministic ISO timestamp.
    const FROZEN_DATE = new Date('2026-03-01T12:00:00.000Z').getTime();
    const OrigDate = window.Date;
    class FrozenDate extends OrigDate {
      // `Date`'s constructor is overloaded, so `ConstructorParameters` collapses
      // to a single-argument tuple; a rest-args signature keeps the zero-arg and
      // one-arg calls both valid.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      constructor(...args: any[]) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        if (args.length === 0) super(FROZEN_DATE as any);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        else super(...(args as [any]));
      }
      static now() { return FROZEN_DATE; }
    }
    Object.defineProperty(window, 'Date', { value: FrozenDate, writable: true });

    // Force CSS animations/transitions to skip to end state instantly.
    const style = document.createElement('style');
    style.textContent = `
      *, *::before, *::after {
        animation-duration: 0s !important;
        animation-delay: 0s !important;
        transition-duration: 0s !important;
        transition-delay: 0s !important;
      }
    `;
    document.head.appendChild(style);

    // Disable smooth scroll behaviour.
    document.documentElement.style.scrollBehavior = 'auto';
  });
}

/**
 * Mock Freighter wallet API and seed a JWT into sessionStorage so the page
 * renders the authenticated state without a real wallet connection.
 */
async function seedAuthenticatedWallet(
  page: Page,
  address: string,
  token: string,
): Promise<void> {
  await page.addInitScript(
    ({ tok, addr }) => {
      window.sessionStorage.setItem('amana_jwt', tok);
      const freighter = {
        isConnected: async () => ({ isConnected: true }),
        isAllowed: async () => ({ isAllowed: true }),
        getAddress: async () => ({ address: addr }),
        requestAccess: async () => ({ address: addr }),
        signMessage: async () => ({ signedMessage: 'mock-signed' }),
        signTransaction: async (xdr: string) => ({ signedTxXdr: `signed-${xdr}` }),
      };
      Object.assign(window, { freighter, freighterApi: freighter });
    },
    { tok: token, addr: address },
  );
}

/**
 * Intercept all backend API calls and return stable fixture responses.
 * Call before page.goto() so no real requests escape.
 */
async function mockApiRoutes(page: Page): Promise<void> {
  const API = 'http://localhost:4000';

  // Trade stats
  await page.route(`${API}/trades/stats`, (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(FIXTURES.stats) }),
  );

  // Wallet balance
  await page.route(`${API}/wallet/balance`, (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(FIXTURES.walletBalance) }),
  );

  // Trade list (matches /trades?*)
  await page.route(`${API}/trades?**`, (r) =>
    r.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        items: FIXTURES.trades,
        pagination: { page: 1, limit: 5, total: 2, totalPages: 1 },
      }),
    }),
  );

  // Single trade
  await page.route(`${API}/trades/${FIXTURES.tradeId}`, (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(FIXTURES.trades[0]) }),
  );

  // Admin streams
  await page.route(`${API}/admin/streams?**`, (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(FIXTURES.adminStreams) }),
  );

  // Feature flags
  await page.route(`${API}/api/admin/features`, (r) =>
    r.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        flags: {
          adminUI: { enabled: true, updatedAt: '2026-01-15T10:00:00.000Z' },
          clawbackUI: { enabled: false, updatedAt: '2026-01-15T10:00:00.000Z' },
          advancedReporting: { enabled: true, rolloutPercentage: 50, updatedAt: '2026-01-15T10:00:00.000Z' },
        },
      }),
    }),
  );

  // Next.js API route for feature flags bootstrap
  await page.route('**/api/flags', (r) =>
    r.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        flags: {
          adminUI: true,
          clawbackUI: false,
          advancedReporting: true,
        },
        fetchedAt: '2026-03-01T12:00:00.000Z',
      }),
    }),
  );

  // Catch-all for any other API calls — return empty 200 to avoid navigation failures.
  await page.route(`${API}/**`, (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: '{}' }),
  );
}

// ---------------------------------------------------------------------------
// Custom fixture types.
// ---------------------------------------------------------------------------

interface VisualFixtures {
  /** Unauthenticated page with frozen dynamics and mocked API routes. */
  publicPage: Page;
  /** Authenticated page (user role) with frozen dynamics, mocked auth + API routes. */
  authenticatedPage: Page;
  /** Admin-role authenticated page for admin dashboard tests. */
  adminPage: Page;
}

// ---------------------------------------------------------------------------
// Extend base test with visual fixtures.
// ---------------------------------------------------------------------------

export const test = base.extend<VisualFixtures>({
  publicPage: async ({ page }, consume) => {
    await freezePageDynamics(page);
    await mockApiRoutes(page);
    await consume(page);
  },

  authenticatedPage: async ({ page }, consume) => {
    const token = buildJwt(FIXTURES.walletAddress);
    await freezePageDynamics(page);
    await seedAuthenticatedWallet(page, FIXTURES.walletAddress, token);
    await mockApiRoutes(page);
    await consume(page);
  },

  adminPage: async ({ page }, consume) => {
    const token = buildAdminJwt(FIXTURES.walletAddress);
    await freezePageDynamics(page);
    await seedAuthenticatedWallet(page, FIXTURES.walletAddress, token);
    await mockApiRoutes(page);
    // Mock isAdmin check — inject into localStorage/sessionStorage if needed.
    await page.addInitScript(() => {
      window.sessionStorage.setItem('amana_is_admin', 'true');
    });
    await consume(page);
  },
});

export { expect } from '@playwright/test';
