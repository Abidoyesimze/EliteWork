# Archived implementation & PR summaries

Historical implementation summaries and PR recaps that used to live at the
repository root. They have been moved under `docs/archive/` so the root stays
limited to standard project files (`README.md`, `CONTRIBUTING.md`,
`package.json`, etc.).

These records are retained for context only; the code they describe is the
authoritative source of behavior. Where a summary's content is now captured in
a current document, the "superseded by" column points at it.

## Index

| File | Original issue / PR | Summary | Superseded by |
|---|---|---|---|
| [`ISSUE_67_IMPLEMENTATION.md`](./ISSUE_67_IMPLEMENTATION.md) | Issue #67 | Admin UI feature-flag system (`NEXT_PUBLIC_ENABLE_ADMIN_UI`) gating admin pages | `docs/admin-ci-policy.md` (feature-flag policy), `frontend/src/lib/featureFlags.ts` |
| [`ISSUE_72_IMPLEMENTATION.md`](./ISSUE_72_IMPLEMENTATION.md) | Issue #72 | Admin breadcrumb navigation linking stream detail pages to stream management | `docs/api/admin.md` (admin routes) |
| [`ISSUE_75_IMPLEMENTATION.md`](./ISSUE_75_IMPLEMENTATION.md) | Issue #75 | Multi-currency (asset) support for admin stream management | `docs/api/wallet.md` (asset handling), `frontend/src/lib/stellar/assets.ts` |
| [`PR_SUMMARY_ISSUE_39.md`](./PR_SUMMARY_ISSUE_39.md) | PR close #39 | Admin auth token replay protection (JWT claims, jti revocation, OpenAPI docs) | `backend/src/docs/openapi.yaml` (JWT semantics), `docs/api/admin.md` |
| [`PR_SUMMARY_ISSUE_40.md`](./PR_SUMMARY_ISSUE_40.md) | PR close #40 | Admin action tracing (traceId/spanId/actionName in audit logs, OpenTelemetry span annotation) | `docs/api/admin.md` (audit field table + tracing section) |
| [`STELLAR_WAVE_IMPLEMENTATION.md`](./STELLAR_WAVE_IMPLEMENTATION.md) | Issues #189, #191, #192, #193 | Stellar Wave: timelock delay, upgrade authorization policy, contract fuzzing, gas benchmarks | `docs/TIMELOCK_POLICY.md` (upgrade/timelock policy), `contracts/amana_escrow/` |

## Convention

New implementation summaries and PR recaps belong next to the feature they
describe (under `docs/`, `backend/src/`, `contracts/`, or `frontend/src/` as
appropriate), not at the repository root. If a summary is truly historical and
no longer referenced, prefer moving it here over deleting it, so the
decision rationale stays discoverable through git history.
