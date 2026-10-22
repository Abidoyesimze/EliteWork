/**
 * Minimal CommonJS-compatible stand-in for `https-proxy-agent`.
 *
 * `@pact-foundation/pact@16` requires the ESM-only v9 package at module load,
 * which Jest cannot load in its CJS runtime. The agent is only constructed
 * when HTTPS_PROXY/HTTP_PROXY is set, which is not the case in CI or local
 * provider verification.
 */
export class HttpsProxyAgent {
  constructor(_proxy?: string | URL) {}
}
