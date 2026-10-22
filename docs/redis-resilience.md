# Redis Resilience — Expected Behavior per Consumer

> Status: Active | Owner: Platform | Last verified: 2026-08-31

## Overview

Redis backs queues, locks, cache, and rate limiting. This document defines the **expected behavior per consumer during Redis unavailability** (failover, network partition, or total loss). It is the source of truth for `backend/src/lib/redisPolicy.ts`.

## Policy Table

| Consumer | Redis usage | On Redis down | Behavior | Alert |
|---|---|---|---|---|
| **Stream lock** | **None — DB-backed** `stream.lockedAt/lockedBy` | **Fail-closed (DB)** | `requireStreamNotLocked` always checks DB; Redis loss does NOT unlock streams. Suspend/terminate/clawback remain gated by DB row. | — |
| **Clawback distributed lock** | `SET clawback:lock:{streamId} NX EX 30` + in-memory Set | **Fail-closed (503)** | New clawback requests denied with `503 REDIS_UNAVAILABLE`. Prevents split-brain double payout where two pods each hold in-memory lock. Lock expires via TTL if holder crashes. | `redis_connection_failure` (page) |
| **Idempotency** | `idempotency:{method}:{path}:{key}` + `idempotency:lock:… NX EX 30` | **Fail-open graceful** | Middleware calls `next()` without caching; request proceeds. Warn + `cache_unavailable` ticket. Payout routes additionally have DB uniqueness constraints so duplicate execution is blocked at DB level. | `cache_unavailable` (ticket) |
| **Cache** (`cacheGet/Set`, `streamCache`, `quoteCache`, `dailyReconciliation`, `feature-flags`) | `GET/SET EX` | **Fail-open graceful** | `cacheGet` → `null` (miss), `cacheSet` → no-op, callers fall back to DB/Horizon. Warn + `cache_unavailable`. | `cache_unavailable` |
| **Rate limiting** | `express-rate-limit` MemoryStore (wallet/IP keying) | **Fail-open graceful (documented choice)** | **Allow request** with per-pod counters (lenient). Do NOT deny traffic. Rationale: routine Redis upgrade must not cause global deadlock. Alternatives considered: fail-closed (deny all when Redis down) rejected — unacceptable for trade flows on mobile networks. | `redis_connection_failure` (page, informational) |
| **Queues** (BullMQ: `webhooks`, `notifications`, `exports`, `trade-expiry`, `reconciliation` + DLQs) | BullMQ + `createQueueConnection()` per queue/worker | **Degrade-queue, resume on reconnect** | Producers throw transiently, workers pause. Connections use `retryStrategy` exponential backoff (200ms*attempt capped 5s, 20 retries). Jobs are durable in Redis (AOF + RDB) and remain until processed. DLQs capture failed jobs after 3 attempts. On reconnect, workers re-attach and drain. | `redis_connection_failure` + Grafana `redis_key_length_total{key=~"bull:.*:wait"}` |
| **Auth challenge / revocation / token version** | `challenge:{addr}`, `revoked_jti:{jti}`, `token_version:{addr}`, `auth:challenge-failures:{id}` | **Fail-closed (503)** | Challenge generation/verification, `isTokenRevoked`, and `getTokenVersion` deny auth when Redis unavailable. Because every authenticated request re-checks revocation/version, **all authenticated trade and settlement routes can return 503 during a Redis outage**. Prevents use of revoked tokens during split-brain. | `redis_connection_failure` (page) |
| **Admin session registry** | `admin_session:{jti}`, `admin_sessions:{wallet}` | **Fail-closed (401/503)** | Device-bound admin session lookup/registration fails closed; admin actions (including clawback/terminate) are unavailable until Redis recovers. | `redis_connection_failure` (page) |
| **Feature flags** | `feature:<name>` | **Fail-open graceful** | Fall back to DB/default rollout. | `cache_unavailable` |

## Fail-closed verification (payout-safety-critical)

- `StreamClawbackService.acquire()` checks `redis.status === "ready"` synchronously. If not ready, throws `AppError 503 REDIS_UNAVAILABLE_FAIL_CLOSED` before taking in-memory lock.
- Async path `acquireAsync()` does `SET NX EX` atomically; on Redis error it throws 503 (not 409).
- `StreamLockService` never consults Redis — DB row is authoritative.
- Tests: `backend/src/__tests__/redis.resilience.test.ts` kills Redis mid-suite and asserts:
  - No double-payout window (second acquire → 409 or 503, never 200).
  - `isLockedAsync` returns `true` when Redis down (fail-closed assumption).
  - Queue `retryStrategy` exists and `withQueueResilience` retries.

## Graceful degradation for cache/rate-limit consumers

- `backend/src/lib/cache.ts`: `cacheGet` catches and returns `null`; `cacheSet` catches and no-ops. Both dispatch `cache_unavailable`.
- `backend/src/lib/rateLimit.ts`: In-memory store remains. `RATE_LIMIT_RESILIENCE_POLICY` documents fail-open choice.

## Queue consumers resume cleanly after reconnect

- `backend/src/jobs/queue.ts`: `createQueueConnection()` sets `retryStrategy` + `error/close/reconnecting/ready` handlers.
- `backend/src/lib/redisPolicy.ts`: `withQueueResilience` retries queue ops with exponential backoff.
- Health: `health.service.ts:checkRedis` ping 3s timeout; `performHealthCheck` marks `degraded` (not `unhealthy`) if Redis down; `performReadinessCheck` blocks traffic (not_ready) until Redis recovers; `performStartupCheck` exits 1 if not ready at boot.

## Automated test: killing Redis mid-suite asserting invariants

Run: `pnpm --filter backend test -- redis.resilience`

Coverage:
- Policy completeness (8 consumers)
- Fail-closed for `clawback-distributed-lock`, `stream-lock`, `auth-challenge`
- Cache graceful degrade
- Rate limit fail-open documented
- Queue reconnect
- Kill-test: acquire → kill Redis → second acquire fails closed

See `backend/src/__tests__/redis.resilience.test.ts`.

## Runbooks

- `docs/runbooks/redis-maintenance.md` — planned maintenance/failover with no payout risk.
- `docs/runbooks/redis-outage-active-settlement.md` — unplanned outage during an active trade settlement window, including impact matrix, recovery ordering, and payout-intent reconciliation.

## References

- `backend/src/lib/redis.ts`, `redisPolicy.ts`, `cache.ts`, `rateLimit.ts`
- `backend/src/services/streamLock.service.ts`, `streamClawback.service.ts`
- `backend/src/middleware/idempotency.ts`
- `backend/src/jobs/queue.ts`, `deadLetter.ts`, workers
- `infra/terraform/modules/redis` (ElastiCache replication_group multi-AZ, auto-failover)
- `docs/runbooks/redis-maintenance.md`
- `docs/runbooks/redis-outage-active-settlement.md`
