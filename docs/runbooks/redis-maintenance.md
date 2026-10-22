# Runbook — Redis Maintenance Without Payout Risk

> Severity: Standard maintenance | Audience: On-call, SRE, Backend | ElastiCache + K8s `redis-service`

## Goal

Perform Redis upgrade/failover without risk of split-brain double payout or global deadlock.

## Preconditions

- Payout-safety locks are **DB-backed** (`stream.lockedAt`) and **Redis-distributed** (`clawback:lock:*`). Both enforce fail-closed when Redis unavailable.
- Health endpoints reflect Redis state: `/health` → `degraded` if Redis down, `/health/ready` → `not_ready` (removes pod from LB), `/health/startup` blocks boot until ready.
- No maintenance during active clawback window — check Grafana `redis_key_length_total` and `clawback:lock:*` keys.

## Procedure

### 1. Announce & Drain (5 min)

1. Post in `#incidents`: `Redis maintenance window starting — expect degraded cache/queues, no payout impact`.
2. Verify no active clawbacks:
   ```bash
   redis-cli --tls -h <primary_endpoint> --scan --pattern 'clawback:lock:*'
   # expect 0 keys; if non-zero, wait for TTL 30s or cancel window
   ```
3. Check DB locks: `SELECT streamId, lockedAt FROM stream WHERE lockedAt IS NOT NULL;` — note locked streams (maintenance locks remain valid without Redis).

### 2. Enable Maintenance Mode (if upgrading primary)

- For ElastiCache: trigger `failover` via AWS console (`ElastiCache → Replication group → Failover`) or Terraform apply with new `engine_version`.
- For K8s `redis-service`: `kubectl rollout pause deployment/backend` is **not required** — pods handle reconnect, but you may cordon one replica at a time.

### 3. What Happens Automatically During Redis Unavailability

| Consumer | Behavior | Action needed |
|---|---|---|
| Stream lock / Clawback | Fail-closed 503 | **Do not retry clawbacks** until Redis `ready`. Frontend shows "temporarily unavailable". |
| Cache | Miss → DB fallback | None — expect higher DB latency, watch `databaseLatency` in `/health`. |
| Rate limit | Fail-open, per-pod lenient | None — monitor for abuse spike; tighten WAF if needed. |
| Queues | Workers pause, producers retry | None — jobs durable, will drain after reconnect. Verify DLQ depth after. |
| Auth | 503 on login/revoke | Advise users to wait; existing JWTs remain valid until expiry (stateless). |
| Health | `/health` degraded, `/health/ready` not_ready | LB will shed pods; ensure at least 1 pod stays `ready` via DB check — if all pods report not_ready, LB 503 is expected briefly. |

### 4. Observe Reconnect

Watch logs:
```bash
kubectl logs -f deployment/backend | grep -E "Queue Redis|Redis connection|Redis recovered"
# Expect: "Queue Redis reconnecting" → "Queue Redis ready — consumers will resume"
```

Verify:
```bash
curl -sf http://localhost:4000/health/ready | jq .status  # expect "ready"
curl -sf http://localhost:4000/health | jq .checks.redis.status  # expect "up"
redis-cli -h <primary> ping  # PONG
```

### 5. Validate Post-Maintenance

1. DLQ depth: `GET /api/admin/dlq/:queue/depth` for each queue — alert if >=50.
2. Replay DLQ if needed: `POST /api/admin/dlq/:queue/:jobId/replay`.
3. Run kill-test locally to confirm invariants:
   ```bash
   pnpm --filter backend test -- redis.resilience
   ```
4. Check drill findings: `docs/redis-resilience.md` invariants green.

### 6. Rollback

- ElastiCache: `snapshot_retention_limit=5` — restore from latest snapshot if data loss suspected.
- K8s: `kubectl rollout undo deployment/redis` or re-apply previous `infra/k8s/redis-deployment.yaml`.

## Failure Modes & Mitigations

| Failure | Mitigation |
|---|---|
| Split-brain double payout attempted | Blocked by DB `lockedAt` + Redis `clawback:lock:*` fail-closed 503. Even if Redis partitions, DB single source prevents double payout. |
| Global deadlock (all requests 503) | Auth revocation/token-version checks fail closed, so authenticated trade and settlement routes can return 503 while Redis is down. Cache/rate-limit/queues fail open or degrade; unauthenticated/cache-only paths stay available. See `docs/runbooks/redis-outage-active-settlement.md`. |
| Queue job loss | BullMQ `attempts:3` + DLQ + `retryStrategy` ensures no loss; verify `reconciliation` daily sweep still scheduled (`0 2 * * *`). |
| Auth outage | Logins 503, but existing sessions continue (JWT stateless). No mass logout. |

## Sign-off

- [ ] Drill performed (kill Redis in staging, assertions green)
- [ ] Findings fixed or accepted with sign-off (see `docs/redis-resilience.md` appendix)
- [ ] Runbook merged and linked from `alertRegistry.ts` `redis_connection_failure.runbookUrl`

## Links

- `docs/redis-resilience.md`
- `docs/runbooks/redis-outage-active-settlement.md` (unplanned outage during settlement)
- `backend/src/lib/redisPolicy.ts`
- `backend/src/__tests__/redis.resilience.test.ts`
- `infra/terraform/modules/redis/main.tf` (multi-AZ, auto_failover)
- `infra/k8s/redis-deployment.yaml`, `redis-service.yaml`
