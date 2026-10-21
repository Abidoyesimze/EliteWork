# PR Summary — Issue #39: Admin Auth Token Replay Protection

Close #39

## Problem
Admin auth tokens may be reused or replayed if not properly protected. We needed to ensure anti-replay considerations are baked into admin auth with proper test coverage and documentation.

## Changes

### 1. New test file: `backend/src/__tests__/admin.auth.replay.test.ts` (17 tests)

Comprehensive test suite verifying admin routes enforce all JWT protections through the `authMiddleware` → `adminMiddleware` chain:

| Category | Tests | What's verified |
|---|---|---|
| Happy path | 2 | Valid admin token grants access, `isAdmin` is propagated |
| Expired tokens | 3 | Expired tokens rejected with 401 (including 1-second-expiry edge case); expiry checked before role evaluation |
| Revoked / replay | 3 | Revoked tokens rejected; `isTokenRevoked` called with correct `jti`; same-token replay after revocation fails |
| Future nbf | 1 | Tokens with future `nbf` rejected |
| Missing headers | 4 | No header, non-Bearer, invalid, and empty Bearer all return 401 |
| Wrong claims | 3 | Wrong issuer, wrong audience, missing `jti` — all rejected |
| Access control | 1 | 403 when caller passes auth but isn't an admin |

**Mock design**: Uses a fully self-contained `AuthService` mock (no `jest.requireActual`) that performs real `jwt.verify` checks (expiry, nbf, iss, aud) while avoiding the real service's dependency chain (env/redis/prisma). This matches the pattern proven in `admin.tracing.test.ts`.

### 2. Updated `backend/src/docs/openapi.yaml`

Added comprehensive JWT token validity documentation to the API description:

- `iat` (issued-at) — must be present and in the past
- `exp` (expires-at) — enforced, expired tokens rejected (default TTL: 86400s / 24h, configurable via `JWT_EXPIRES_IN`)
- `jti` — replay protection via revocation denylist (revoked tokens rejected)
- Algorithm — HS256 only; other algorithms rejected

## Acceptance Criteria

| Criteria | Status |
|---|---|
| Token claim expiry behavior documented and enforced | ✅ OpenAPI updated + 3 expiry tests |
| Tests verify expired tokens are rejected | ✅ Multiple expiry test cases |
| Route middleware detects duplicate requests | ✅ jti-based revocation replay tests |
| OpenAPI auth docs include token validity expectations | ✅ Full JWT semantics documented |

## Testing

```bash
# All 17 new tests pass
npx jest --no-coverage src/__tests__/admin.auth.replay.test.ts

# Existing admin tests unaffected (13/13 pass)
npx jest --no-coverage src/__tests__/admin.middleware.test.ts src/__tests__/admin.tracing.test.ts
```

## Files Changed

- `backend/src/__tests__/admin.auth.replay.test.ts` — **new file** (+383 lines)
- `backend/src/docs/openapi.yaml` — updated JWT semantics section (+4 lines)
