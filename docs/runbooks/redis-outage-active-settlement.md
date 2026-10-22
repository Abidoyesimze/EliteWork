# Runbook — Redis Outage During Active Trade Settlement

> Severity: P1 (fund-safety review required) | Audience: On-call, SRE, Backend, Admin operators
> Trigger alerts: `redis_connection_failure`, `cache_unavailable`, `job_missed_heartbeat`
> Related: `docs/redis-resilience.md`, `docs/runbooks/redis-maintenance.md`,
> `docs/runbooks/incident-response.md`, `docs/runbooks/emergency-clawback.md`

## Goal

Restore Redis safely while an escrow/trade settlement window is active, without
double-paying a trade, losing a durable queue job, or replaying a clawback. The
DB (`stream.lockedAt`, `PayoutIntent.idempotencyKey`, trade status) is the
source of truth for payout safety — Redis loss must never be treated as
permission to retry a fund movement.

## 1. Confirm and scope the outage

1. Acknowledge `redis_connection_failure` and open an incident channel
   (`#incident-YYYY-MM-DD-redis`) plus a tracking issue.
2. Confirm Redis is actually down (not just a single pod's view):
   ```bash
   redis-cli -h <primary_endpoint> ping            # expect PONG
   redis-cli -h <replica_endpoint> info replication
   ```
3. Check the backend view:
   ```bash
   curl -sf https://<backend>/health | jq '.checks.redis'
   curl -sf https://<backend>/health/ready | jq .
   ```
   Expected during an outage: `/health` is `degraded` (Redis down), and
   `/health/ready` is `not_ready` until Redis responds. `/health/startup`
   prevents a pod from booting without Redis.
4. Check infra signals: ElastiCache events/failover status, `CPUUtilization`,
   `DatabaseMemoryUsagePercentage`, `Evictions`, `ReplicationLag`,
   `CurrConnections`, and K8s `redis-service` pod restarts/OOMKills.
5. Establish blast radius:
   - Is this a single node, a primary failover, or total loss?
   - Which regions/pods still reach Redis?
   - Is a settlement/clawback/reconciliation job running right now?

## 2. Expected impact while Redis is unavailable

| Consumer | Behavior on Redis loss | Settlement implication |
|---|---|---|
| Auth challenge / token revocation / token version | Fail-closed: `503` `REDIS_UNAVAILABLE` / revocation check failure | **All authenticated trade and settlement endpoints can return 503/timeout**, including create/deposit/confirm/release/dispute, because token validation checks Redis on every request. Existing JWTs do not bypass this. |
| Admin sessions (`admin_session:*`) | Fail-closed: admin session registry check fails (`401`/`503`); step-up registration fails | Admin actions and clawbacks are unavailable during the outage |
| Clawback distributed lock (`clawback:lock:*`) | Fail-closed `503 REDIS_UNAVAILABLE_FAIL_CLOSED` | **Never retry a clawback until Redis is `ready`.** Prevents split-brain double payout |
| Stream lock | DB-backed (`stream.lockedAt`); Redis does not unlock streams | Locked streams stay locked; do not clear DB locks as an outage workaround |
| Idempotency (`idempotency:*`, `idempotency:lock:*`) | Fail-open: request proceeds without caching, emits `cache_unavailable` | Payout routes still rely on `PayoutIntent.idempotencyKey` DB uniqueness. Non-payout routes lose replay protection for the outage duration |
| Rate limiting | In-memory `MemoryStore`, per-pod; fail-open | Traffic may be more lenient; no settlement block |
| Cache / feature flags | Fail-open; DB/default fallback | Higher DB/Horizon load; flags fall back to defaults |
| Queues (webhooks, notifications, exports, trade-expiry, reconciliation, PII scan) | Producers throw transiently, workers pause, connections retry with exponential backoff; jobs stay durable in Redis | Settlement-driven notifications/webhooks pause; **trade-expiry and reconciliation sweeps do not run** until Redis recovers |
| Event listener / ledger indexing | Not Redis-backed (DB + Soroban RPC) | On-chain events may continue to be indexed, but queue side-effects pause |

If `/health/ready` is `not_ready` on every pod, the load balancer may return
503 before requests reach the app. Treat that as expected during a total
outage, not as a separate application bug.

## 3. Containment (first 15 minutes)

1. **Do not** flush Redis, delete `clawback:lock:*` keys, unlock streams in the
   DB, or manually replay payout/clawback requests to "clear" the outage.
2. Pause admin-initiated fund operations (clawback, terminate, release) in the
   incident channel until recovery checks in §5 pass.
3. If ElastiCache is healthy enough to fail over, follow
   `docs/runbooks/redis-maintenance.md`; otherwise restore the node/snapshot.
4. Ask support/comms to tell users that settlement actions may be temporarily
   unavailable. Do not promise a retry time until Redis is `ready`.
5. If a settlement transaction was already signed/submitted before the outage,
   record its hash and **do not resubmit it**. Track it in §5.

### Decision points

| Situation | Action |
|---|---|
| Single replica/nodes down, primary healthy | Fail over/restart the affected node; keep observing |
| Primary down, automatic failover in progress | Wait for ElastiCache failover; check `ReplicationLag` and endpoint DNS |
| Failover not complete within 10 minutes | Escalate to cloud/infra owner; prepare snapshot restore |
| Data loss suspected (AOF/RDB corruption) | Freeze payouts, restore latest snapshot, run §5 before re-enabling admin actions |
| Active clawback lock held when outage started | Wait for lock TTL (30s) after Redis returns; the DB stream lock remains authoritative |
| `PayoutIntent` in `SUBMITTED` with a `txHash` | Query the chain for that hash before changing status; never infer failure from Redis being down |

## 4. Recovery order

1. **Restore Redis first.** Prefer failover/reconnect over data deletion. Confirm:
   ```bash
   redis-cli -h <primary> ping
   redis-cli -h <primary> info persistence   # aof_enabled/rdb_last_bgsave_status
   redis-cli -h <primary> info replication
   ```
2. Confirm the backend has reconnected and is ready:
   ```bash
   curl -sf https://<backend>/health | jq '.status, .checks.redis'
   curl -sf https://<backend>/health/ready | jq .status   # expect "ready"
   ```
   Logs should show `Queue Redis ready — consumers will resume` and Redis
   recovery messages.
3. Inspect for stale locks. Idempotency locks expire after 30s; clawback locks
   expire after 30s. Let TTLs expire rather than mass-deleting keys:
   ```bash
   redis-cli --scan --pattern 'clawback:lock:*'
   redis-cli --scan --pattern 'idempotency:lock:*'
   ```
   Non-zero keys immediately after recovery are expected; re-check after 60s.
4. Verify queues are draining and check DLQ depth before replaying anything:
   ```bash
   curl -sf https://<backend>/api/admin/dlq/<queue>/depth -H "Authorization: Bearer <admin-token>"
   ```
   Queues: `webhooks`, `notifications`, `exports`, `trade-expiry`,
   `reconciliation`, `pii-log-scan`. Replay only after confirming the job is
   not already applied (idempotency/DB check).
5. Run the settlement integrity checks in §5 **before** re-enabling admin fund
   actions.
6. Once checks pass, resume normal operations and announce recovery.

## 5. Settlement and data-integrity checks

Run these read-only checks against the primary DB. Investigate every row before
mutating status.

```sql
-- Unresolved payout intents: the highest-risk retry surface
SELECT "idempotencyKey", kind, "tradeId", "milestoneIndex", "txHash",
       status, "duplicateAttempts", "submittedAt", "confirmedAt", "updatedAt"
FROM "PayoutIntent"
WHERE status IN ('PENDING', 'SUBMITTED')
ORDER BY "updatedAt" ASC;

-- Streams locked across the outage: do not clear these as part of recovery
SELECT "streamId", status, "lockedAt", "lockedBy", "lockReason"
FROM "Stream"
WHERE "lockedAt" IS NOT NULL;

-- Clawbacks recorded before/during the window
SELECT "streamId", admin, amount, timestamp, "txHash"
FROM "StreamClawbackEvent"
ORDER BY timestamp DESC
LIMIT 50;

-- Trades that may have advanced but not completed
SELECT "tradeId", status, "fundedAt", "deliveredAt", "completedAt", "updatedAt"
FROM "Trade"
WHERE status NOT IN ('COMPLETED', 'CANCELLED', 'EXPIRED')
ORDER BY "updatedAt" DESC
LIMIT 100;

-- Event listener lag / recent chain processing
SELECT "ledgerSequence", "contractId", "eventId", "processedAt"
FROM "ProcessedEvent"
ORDER BY "ledgerSequence" DESC
LIMIT 10;
```

For every `PayoutIntent` with `status = 'SUBMITTED'` and a `txHash`:

1. Look up the transaction on Soroban RPC/Horizon.
2. If confirmed, call the normal confirmation path (or the service method) so
   the intent becomes `CONFIRMED`; do not create a new intent.
3. If definitively failed/not found, follow the normal failure path and record
   the reason. Be conservative: an RPC timeout is not proof of failure.
4. Never resubmit a payout with the same idempotency key through a different
   code path. `PayoutIntent.idempotencyKey` is the DB-level replay guard.

Then run the reconciliation sweep manually (or wait for the next 02:00 UTC
sweep) and confirm no new `reconciliation_drift_warning` /
`reconciliation_drift_critical` alerts. Verify the latest indexed ledger is
advancing and indexer lag is back to normal.

## 6. Communication

Post an initial update within 10 minutes:

> P1: Redis outage affecting authenticated settlement actions. On-chain funds
> are safe. New deposit/release/clawback requests may return 503. We are
> failing over/restoring Redis and will verify payout intents before re-enabling
> admin actions.

Post recovery only after §5 passes:

> Recovery: Redis is ready, queues are draining, and payout intents /
> clawbacks have been reconciled against the chain. Settlement actions are
> re-enabled.

Escalate to the eng lead + treasury/admin key holder immediately if:

- any `PayoutIntent` is `SUBMITTED` with an unverifiable `txHash`,
- a clawback lock or stream lock cannot be accounted for,
- reconciliation reports new drift,
- Redis data loss forces a snapshot restore.

## 7. Rollback

- ElastiCache: automatic failover first; if the new primary is unhealthy,
  restore the latest snapshot (`snapshot_retention_limit=5`) and replay the
  integrity checks in §5.
- Kubernetes `redis-service`: `kubectl rollout undo deployment/redis` or
  re-apply the previous manifest. Do not delete the PVC unless data loss is
  confirmed and accepted.
- Backend: no code rollback is expected for a Redis outage. If a deploy caused
  the outage, roll back the deploy and still follow §5 before re-enabling
  payouts.

## 8. Closeout

- [ ] Redis `PING`/persistence/replication verified
- [ ] `/health` and `/health/ready` green; no restart loop
- [ ] Stale `clawback:lock:*` / `idempotency:lock:*` keys gone or explained
- [ ] Queue wait/active counts draining; DLQ depth checked and replay decisions recorded
- [ ] Every unresolved `PayoutIntent` accounted for against the chain
- [ ] No stream locks cleared without rationale
- [ ] Reconciliation sweep clean after recovery
- [ ] Incident timeline + postmortem filed within 2 business days
  (`docs/runbooks/postmortem-template.md`)
- [ ] `pnpm --filter backend test -- redis.resilience` passes locally/CI

## 9. Tabletop checklist

Run this scenario quarterly or whenever the Redis/auth/queue wiring changes:

1. Simulate Redis loss in staging while a trade is `FUNDED` and a clawback lock
   is held.
2. Confirm authenticated settlement calls fail closed (503) and that no retry
   produces a second payout.
3. Confirm the event listener catches up and queue jobs drain after reconnect.
4. Confirm `PayoutIntent` and `StreamClawbackEvent` records reconcile with the
   chain.
5. Record gaps in this runbook, not just in the retro.

## Links

- `docs/redis-resilience.md` — per-consumer policy table and invariants
- `docs/runbooks/redis-maintenance.md` — planned maintenance/failover procedure
- `docs/runbooks/incident-response.md` — severity, IC role, comms
- `docs/runbooks/emergency-clawback.md` — clawback-specific safety steps
- `docs/idempotency-redis-roundtrips.md` — idempotency lock/caching design
- `backend/src/lib/redisPolicy.ts`, `backend/src/services/streamClawback.service.ts`
- `backend/src/services/payoutIntent.service.ts`, `backend/src/jobs/queue.ts`
- `backend/src/__tests__/redis.resilience.test.ts`
