# API Overview

This is the consumer-facing entry point for the Amana backend API. It covers
authentication, base URLs, rate limits, and pagination conventions that apply
across every endpoint. For endpoint-by-endpoint detail see:

- [trades.md](./trades.md) - trade lifecycle endpoints
- [dispute.md](./dispute.md) - dispute and dispute category endpoints
- [evidence.md](./evidence.md) - evidence upload and retrieval endpoints
- [stellar.md](./stellar.md) - Stellar network proxy endpoints
- [manifest.md](./manifest.md) - trade delivery manifest endpoints
- [wallet.md](./wallet.md) - caller's wallet balance and path payment quotes
- [webhooks.md](./webhooks.md) - webhook subscriptions and inbound provider callbacks
- [treasury.md](./treasury.md) - treasury balance, config, and admin withdrawals
- [admin.md](./admin.md) - admin-only endpoints
- [errors.md](./errors.md) - error code reference

The machine-readable spec lives at
[`backend/src/docs/openapi.json`](../../backend/src/docs/openapi.json) /
`openapi.yaml`; this page is the narrative companion to it.

## Base URL

The backend listens on `PORT` (default `4000`), with all routes mounted at
the root:

```
http://localhost:4000
```

There is no versioned URL prefix (e.g. no `/v1`) today - all paths in this
guide are relative to the base URL above.

## Authentication

Amana authenticates wallets with a challenge/response flow instead of
passwords, since the only identity a client has is a Stellar keypair:

1. `POST /auth/challenge` with your wallet's public key. The server returns a
   short-lived, single-use challenge string.
2. Sign the challenge with your Stellar secret key (client-side - the secret
   key never leaves the wallet).
3. `POST /auth/verify` with the public key and the signature. The server
   verifies it against the challenge and returns a JWT bearer token.
4. Send `Authorization: Bearer <token>` on every subsequent protected
   request.
5. `POST /auth/logout` revokes the current token immediately by adding its
   `jti` to a denylist, instead of waiting for natural expiry.

```bash
curl -X POST http://localhost:4000/auth/challenge \
  -H 'Content-Type: application/json' \
  -d '{"walletAddress":"GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF"}'
# => {"challenge":"amana:login:1742794421:7ced1c65a9a44a7d"}

curl -X POST http://localhost:4000/auth/verify \
  -H 'Content-Type: application/json' \
  -d '{"walletAddress":"GAAA...WHF","signedChallenge":"<base64url signature>"}'
# => {"token":"eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...."}

curl http://localhost:4000/users/me -H 'Authorization: Bearer <token>'
```

### JWT semantics enforced by the server

The auth middleware rejects a token if any of these fail:

| Claim | Requirement |
|---|---|
| `iss` | Must match `JWT_ISSUER` (default `amana`) |
| `aud` | Must match `JWT_AUDIENCE` (default `amana-api`) |
| `jti` | Required, and must not be on the revocation denylist (see logout above) |
| `nbf` | Required, and must not be in the future |
| `exp` | Token lifetime is `JWT_EXPIRES_IN` seconds from issuance (default `86400`, i.e. 24h) |

A request with a missing, expired, revoked, or otherwise invalid token gets
`401 Unauthorized` (see [errors.md](./errors.md#auth_error)).

### Public vs. protected endpoints

Most endpoints require a bearer token. A few are intentionally public, e.g.
`GET /users/:address` (public profile lookup) and the `/health*` endpoints.
Each endpoint's own doc page notes whether auth is required.

### Admin endpoints

A subset of endpoints (treasury management, admin trade transitions, feature
flags) additionally require the caller's wallet address to appear in the
`ADMIN_STELLAR_PUBKEYS` allowlist (a comma-separated list of Stellar public
keys). See [admin.md](./admin.md) for the full list and behavior.

## Rate limits

Selected endpoints are rate limited per client. The limiter keys on wallet
address when the request is authenticated, and falls back to client IP
otherwise. Defaults (all configurable via environment variables):

| Bucket | Applies to | Window | Max requests |
|---|---|---|---|
| `auth` | `POST /auth/challenge`, `POST /auth/verify` | 15 minutes | 10 |
| `authRefresh` | Token refresh flows | 15 minutes | 30 |
| `user` | User profile endpoints | 1 minute | 30 |
| `dispute` | `POST /trades/:id/dispute` | 1 hour | 5 |

A request over the limit gets `429 Too Many Requests`:

```json
{
  "code": "RATE_LIMIT_EXCEEDED",
  "message": "Too many challenges/verify attempts, try again later.",
  "details": { "retryAfterSeconds": 900, "limit": 10, "windowMs": 900000 },
  "timestamp": "2026-07-05T12:00:00.000Z",
  "path": "/auth/challenge"
}
```

Respect `retryAfterSeconds` (and the standard `RateLimit-*` response
headers) before retrying.

## Pagination

List endpoints that support pagination (e.g. `GET /trades`) use `page` +
`limit` query parameters rather than cursors:

| Parameter | Default | Notes |
|---|---|---|
| `page` | `1` | 1-indexed |
| `limit` | `20` | Max `100` |
| `sort` | server default | Format `field:direction`, e.g. `createdAt:desc` |

```bash
curl 'http://localhost:4000/trades?status=FUNDED&page=2&limit=50&sort=createdAt:desc' \
  -H 'Authorization: Bearer <token>'
```

Responses return the page of items under `items`; there is no total count or
next-page cursor in the payload today, so clients should keep requesting
increasing `page` values until a page comes back shorter than `limit`.

## Idempotency

Endpoints that create or mutate on-chain state (trade creation, deposit,
release, dispute, etc.) accept an optional `Idempotency-Key` request header.
Replaying the same request with the same key within 24 hours returns the
original cached response instead of re-executing the operation - use this
for safe client-side retries over flaky networks. A concurrent duplicate
request with the same key while the first is still in flight waits (up to
30s) for that first response rather than racing it.

## Content type and payload limits

- Send `Content-Type: application/json` on all request bodies.
- JSON bodies are capped at 100kb; url-encoded bodies at 5mb (for evidence
  upload metadata).
- Responses are JSON unless otherwise noted (the audit history export at
  `GET /trades/:id/history?format=csv` is the one `text/csv` exception - see
  [trades.md](./trades.md#audit-history)).
