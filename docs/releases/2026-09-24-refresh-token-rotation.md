# Release Note — Refresh Token Rotation

> Date: 2026-09-24
> Type: Feature (backend / security)
> Status: Shipped

## Overview

Adds refresh-token rotation for wallet-authenticated sessions: a short-lived
access JWT can be exchanged for a new one via `POST /auth/refresh` shortly after
it expires, while the previous token's `jti` is pinned to a short-lived
revocation denylist so it cannot be replayed. Rotation bounds the lifetime of a
stolen or leaked refresh token, and every rotation is mediated by the same
issuer/audience/JTI claims used across admin auth. This release note covers the
refresh route, the revocation denylist, logout revocation, and the operator
secrets so stakeholders and operators have a single consistent account of what
shipped.

## Feature

### Admin features

None — refresh rotation is a general auth feature; admin routes additionally
enforce the same JWT claims (see the admin auth replay protection work).

- `POST /auth/challenge` — issues a Stellar signature challenge for a wallet
  address
- `POST /auth/verify` — verifies a signed challenge and issues an access JWT
  (`iat`, `exp`, `jti`, `walletAddress`, issuer/audience claims)
- `POST /auth/logout` — revokes the current token's `jti` (denylist) so it can
  no longer be used or refreshed
- `POST /auth/refresh` — exchanges a recently-expired access token for a new
  one; rejects tokens outside the refresh window, missing `jti`/`walletAddress`,
  or already-revoked `jti`, then revokes the old `jti` and issues a new token
- `GET /auth/validate` — validates a bearer token without rotation

### Contract changes

None — this is a backend/auth feature with no on-chain contract changes.

### Docs

- `docs/releases/2026-09-24-refresh-token-rotation.md` — this release note
- `docs/threat-model.md` — recommends short JWT TTL with refresh token rotation
- `docs/secrets-policy.md` — `JWT_SECRET` zero-downtime rotation procedure
- `docs/api/admin.md` — admin auth middleware shares the same JWT claim
  enforcement (issuer, audience, `jti`, HS256)

### Infra & operations

- Deployment: backend service (auth routes + `AuthService`)
- Secrets: `JWT_SECRET`, `JWT_ISSUER`, `JWT_AUDIENCE`; rotate `JWT_SECRET`
  zero-downtime per `docs/secrets-policy.md` (accept outgoing + incoming secret
  for a bounded window during rollout)
- Network: auth endpoints are rate-limited (`authLimiter`, `refreshLimiter`)
- State: `revoked_jti:<jti>` Redis keys with TTL matching remaining token
  lifetime; the denylist is checked on every verify and refresh
- CI/Policy: admin auth replay tests enforced; auth service unit tests cover
  refresh rotation, revocation, and grace windows

## Verification

- [x] Refresh route documented with accepted claims and rejection conditions
- [x] JWT revocation denylist (jti) and TTL behaviour documented for operators
- [x] Logout revocation and refresh rotation documented
- [x] Docs section links resolve
- [x] Release note stored under `docs/releases/`

## Related Issues

- Closes #312
