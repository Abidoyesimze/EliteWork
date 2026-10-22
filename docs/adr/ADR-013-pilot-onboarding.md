# ADR-013: Pilot Onboarding Flow and Lightweight KYC

## Status

Accepted (implemented in `backend/src/middleware/cooperative.middleware.ts` and `backend/src/config/env.ts`)

## Context

Amana is onboarding a few early cooperative pilots (issues #43/#44) who need to access specific, pilot-only features and endpoints (such as specific trade flows or member registration flows). Since we do not yet have a full, automated KYC provider integration (e.g., Sumsub or similar), we need a lightweight, secure mechanism to selectively allowlist their wallet addresses. This ensures only designated pilot members and administrators can interact with cooperative features during this beta phase.

Building a full database-backed KYC management system with admin UI would delay the pilot significantly. A static configuration approach provides the necessary access control with zero engineering overhead for the administrative interface, deferring the full KYC buildout until post-pilot.

## Decision

We will implement a simple, environment-variable-backed allowlist for the duration of the pilot.

### 1. Configuration (Environment Variables)

Two new environment variables will define the allowlist:
- `COOPERATIVE_ADMINS`
- `COOPERATIVE_MEMBERS`

These variables will accept a comma-separated list of `"coop-id:wallet"` pairs or simply wallet addresses depending on the lookup requirement. For the initial lightweight implementation, we parse these lists at startup or on demand in the middleware.

### 2. Middleware (`cooperativeMiddleware`)

We will introduce a new middleware, `requireCooperativeMember` (and `requireCooperativeAdmin`), which:
1. Extracts the authenticated user's `walletAddress` from the JWT payload.
2. Checks if the address exists in the configured allowlist.
3. Rejects unauthorized requests with a `403 Forbidden` response.

### 3. Application

The new middleware will be applied to the specific Express routes handling pilot-only cooperative logic. This isolates the beta features from the general public API without complex user roles in the database.

## Consequences

- **Positive:** Immediate unblocking of the cooperative pilot.
- **Positive:** Extremely simple to audit—access is defined purely by environment configuration.
- **Positive:** Zero new database tables or administrative UI required right now.
- **Negative:** Adding or removing a pilot member requires an environment variable update and a service restart (or redeployment). This is acceptable for a small, static group of early testers but will not scale.
- **Follow-up:** Once the pilot concludes and we open the platform to general users, this mechanism must be replaced with a robust, database-backed KYC and role-based access control (RBAC) system.
