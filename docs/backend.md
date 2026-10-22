# Amana Backend Reliability Layer

This document describes the reliability features implemented in the Amana API.

## 1. Schema Validation Coverage

All incoming requests (body, query, params) are validated using **Zod** schemas.

- **Schemas location**: `backend/src/schemas/`
- **Middleware**: `validateRequest(schema)`

### Usage Example
```typescript
router.post(
  "/", 
  authMiddleware, 
  validateRequest({ body: createTradeSchema }),
  tradeController.createTrade
);
```

### Why `src/validators/` only contains `user.validators.ts`

`backend/src/validators/` holds a single file (`user.validators.ts`) that defines
the Zod schema for the user-profile update body. This is intentional and not an
oversight:

| Location | Purpose |
|---|---|
| `src/schemas/` | Domain-level Zod schemas for business entities (trades, money, evidence, etc.), shared across routes and services. |
| `src/validators/` | Route-level request-body schemas for the _user_ resource only. `user.validators.ts` was extracted here because it is consumed by a dedicated `validateRequest` middleware call in `user.routes.ts` and tests reference it directly by path. |

All other request validation lives in `src/schemas/` and is applied via the
`validateRequest(schema)` middleware helper.  `src/validators/` will grow if
additional route-local validator modules are introduced; for now it deliberately
contains only the user profile validator.  Do not move `user.validators.ts` into
`src/schemas/` — doing so would break the import path used in
`src/__tests__/validateRequest.user.validators.test.ts`.

## 2. Error Taxonomy

The API uses a structured error response format to ensure consistency and easier debugging.

### Error Response Format
```json
{
  "code": "VALIDATION_ERROR",
  "message": "Validation failed",
  "details": [
    { "path": "amountUsdc", "message": "Invalid amount format" }
  ]
}
```

### Standard Error Codes
- `VALIDATION_ERROR`: Input validation failed.
- `AUTH_ERROR`: Authentication or authorization issues.
- `DOMAIN_ERROR`: Business logic constraints violated.
- `INFRA_ERROR`: Database or external service issues.
- `INTERNAL_ERROR`: Unexpected server errors.

## 3. Configurable Token (cNGN)

The backend is configured to use a specific token metadata (defaulting to cNGN).

- **Config location**: `backend/src/config/token.ts`
- **Settings**:
  - `symbol`: "cNGN"
  - `decimals`: 7

All logic previously hardcoded for USDC now references this configuration.

## 4. Idempotency Support

Mutation endpoints support idempotency via the `Idempotency-Key` header.

- **Header**: `Idempotency-Key: <unique-uuid>`
- **Storage**: Redis (fallback to logging on failure)
- **TTL**: 24 hours
- **Supported Endpoints**:
  - `POST /trades` (Create)
  - `POST /trades/:id/deposit`
  - `POST /trades/:id/release`
  - `POST /trades/:id/dispute`
  - `POST /evidence/video` (Upload)

## 5. Observability

- **Request ID**: Every request is assigned a unique `X-Request-ID` header for correlation.
- **Logging**: Structured logging using **Pino**, including error codes and request IDs.
- **Health checks**: `GET /health` reports database, Redis cache, and indexer status. Returns `503` when unhealthy.
- **Ops alerting**: Configure a dedicated ops webhook separate from trade lifecycle webhooks:
  - `ALERT_WEBHOOK_URL` — destination for infrastructure alerts (optional)
  - `ALERT_WEBHOOK_SECRET` — optional HMAC secret; sent as `X-Alert-Signature`
  - `ALERT_COOLDOWN_MS` — per-alert-type cooldown (default 300000 ms) to prevent alert storms
- **Alert types**:
  - `db_connection_failure` — database health check failed
  - `redis_connection_failure` — Redis health check or client connection error
  - `cache_unavailable` — idempotency cache unavailable during a mutation request

## 6. Wallet Route Security and Bootstrap Parity

- Wallet routes are mounted in the shared app factory (`createApp`) used by runtime bootstrap.
- `GET /wallet/balance` and `GET /wallet/path-payment-quote` both require JWT authentication.
- This prevents route-protection drift between test app instances and production startup wiring.

## 7. Optimistic Concurrency for Trade Status

- Trade records now include a monotonic `version` field.
- Event-driven status transitions are guarded by compare-and-set updates:
  - expected `tradeId`
  - expected current `status`
  - expected current `version`
- Invalid or out-of-order transitions are ignored with structured warning logs.
- Replays for already-applied statuses are idempotent no-ops.

## 8. Signed Audit Export Integrity

- Audit history exports support signed integrity metadata using Ed25519.
- Signed responses include:
  - `algorithm` (`ed25519`)
  - `keyId`
  - `payloadHash` (SHA-256)
  - detached `signature` (base64)
- Verification endpoint:
  - `GET /trades/:id/history/verify?signature=<base64>`
- Required environment variables for signing/verification:
  - `AUDIT_SIGNING_KEY_ID`
  - `AUDIT_SIGNING_PRIVATE_KEY_PEM`
  - `AUDIT_SIGNING_PUBLIC_KEY_PEM`

## 9. Resilient Chain Event Outbox

- Chain sync now persists per-event processing state in `ChainEventOutbox`.
- Each row is uniquely keyed by `(ledgerSequence, contractId, eventId)` and stores:
  - event metadata (`eventType`, `tradeId`, `payload`)
  - processing state (`PENDING`, `RETRYING`, `PROCESSED`, `DEAD_LETTER`)
  - retry controls (`attempts`, `nextAttemptAt`, `lastError`)
  - terminal timestamps (`processedAt`, `deadLetteredAt`)
- Retry behavior:
  - failed events are re-scheduled with exponential backoff
  - retries stop after `EVENT_OUTBOX_MAX_ATTEMPTS`
  - final failures are moved to `DEAD_LETTER` and logged
- Exactly-once semantics are preserved by keeping `ProcessedEvent` write in the same transaction as event handling.

### Event Sync Environment Variables

- `EVENT_OUTBOX_MAX_ATTEMPTS`: max attempts before dead-lettering (default `5`)
- `BACKOFF_INITIAL_MS`: retry backoff initial delay (default `1000`)
- `BACKOFF_MAX_MS`: retry backoff max delay (default `30000`)

## 10. Evidence Upload Hardening

- Upload validation now enforces both:
  - declared content-type allowlist (`video/mp4`, `video/webm`)
  - byte-level MIME sniffing from file signatures
- Size limits are enforced with a shared configurable cap for multer and service validation.
- Malware scanning is pluggable via `EvidenceScanner` hook:
  - clean files proceed
  - flagged files are blocked with validation error
  - scanner outages are fail-open by default, fail-closed when required

### Evidence Security Environment Variables

- `EVIDENCE_MAX_BYTES`: max upload size in bytes (default `52428800`)
- `EVIDENCE_SCAN_REQUIRED`: set `true` to fail-closed when scanner is unavailable

## 11. IPFS Egress Hardening

- Streaming requests now enforce:
  - outbound request timeout
  - optional gateway hostname allowlist
  - per-gateway in-process circuit breaker
  - automatic fallback across configured gateway list
- Upload requests now enforce:
  - strict upload timeout for Pinata calls
  - in-process circuit breaker to protect backend stability during upstream incidents

### IPFS Egress Environment Variables

- `IPFS_GATEWAY_URLS`: comma-separated gateway base URLs to try for stream fallback
- `IPFS_GATEWAY_ALLOWLIST`: comma-separated allowed gateway hostnames
- `IPFS_STREAM_TIMEOUT_MS`: per-stream request timeout (default `5000`)
- `IPFS_GATEWAY_CIRCUIT_FAILURE_THRESHOLD`: failures before opening stream gateway circuit (default `3`)
- `IPFS_GATEWAY_CIRCUIT_COOLDOWN_MS`: stream circuit open duration (default `30000`)
- `IPFS_UPLOAD_TIMEOUT_MS`: upload timeout for Pinata calls (default `10000`)
- `IPFS_PINATA_CIRCUIT_FAILURE_THRESHOLD`: failures before opening upload circuit (default `3`)
- `IPFS_PINATA_CIRCUIT_COOLDOWN_MS`: upload circuit open duration (default `30000`)

## 12. PII Minimization and Retention

- Manifest and evidence metadata now enforce retention windows on read:
  - stale evidence metadata is redacted (`cid`, `filename`, selective actor details)
  - stale manifest seller PII is redacted to `REDACTED` while preserving hashes
- Audit history metadata is minimized for non-admin callers:
  - vehicle registrations are masked
  - expired evidence metadata is redacted and tagged with `retentionExpired`
- Admin-safe access controls:
  - callers in `ADMIN_STELLAR_PUBKEYS` can access protected trade metadata views
  - access remains explicit and authenticated; uploads still require buyer/seller roles

### PII Retention Environment Variables

- `MANIFEST_PII_RETENTION_DAYS`: seller raw manifest PII retention window (default `30`)
- `EVIDENCE_METADATA_RETENTION_DAYS`: evidence metadata retention window (default `90`)

## 13. Stellar Route Consolidation (routes-d → backend)

Previously a top-level `routes-d/` package existed alongside the monorepo root.
It contained five Stellar route modules with their own isolated test suite:

| Former file | Migrated to |
|---|---|
| `routes-d/routes/stellar.payments.ts` | `backend/src/routes/stellar.payments.ts` |
| `routes-d/routes/stellar.ledger.ts` | `backend/src/routes/stellar.ledger.ts` |
| `routes-d/routes/stellar.payment.strictSend.ts` | `backend/src/routes/stellar.payment.strictSend.ts` |
| `routes-d/routes/stellar.payment.strictReceive.ts` | `backend/src/routes/stellar.payment.strictReceive.ts` |
| `routes-d/routes/stellar.trustline.ts` | `backend/src/routes/stellar.trustline.ts` |

All five are now wired into `publicApi.router.ts` and share the project-wide
`horizonServer` singleton from `config/stellar.ts`.

### Exposed endpoints

| Method | Path | Description |
|---|---|---|
| GET | `/stellar/account/:address/payments` | Paginated payment history |
| GET | `/stellar/ledger/latest` | Latest closed ledger info |
| POST | `/stellar/payments/strict-send` | Build strict-send XDR |
| POST | `/stellar/payments/strict-receive` | Build strict-receive XDR |
| POST | `/stellar/trustline` | Add a trustline |
| DELETE | `/stellar/trustline` | Remove a trustline |

The `routes-d/` directory has been removed. Do not recreate it — any new
Stellar routes belong in `backend/src/routes/` following the same pattern.
