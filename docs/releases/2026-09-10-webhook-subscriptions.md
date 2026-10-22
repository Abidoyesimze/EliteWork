# Release Note — Webhook Subscriptions

> Date: 2026-09-10
> Type: Feature (backend)
> Status: Shipped

## Overview

Adds user-managed outbound webhook subscriptions so external systems can be
notified when trade lifecycle events happen, plus signed inbound provider
callbacks. Subscribers pick the events they care about (`trade.created`,
`trade.funded`, `trade.delivered`, `trade.completed`, `trade.disputed`), the
backend POSTs a signed payload to each target URL on every matching transition,
and delivery attempts are recorded for audit and replay debugging. This release
note covers the subscription CRUD API, inbound webhook verification, the
background delivery pipeline, and the supporting operators so stakeholders and
operators have a single consistent account of what shipped.

## Feature

### Admin features

None — webhook subscriptions are user-scoped (caller wallet) rather than
admin-only.

- `POST /webhooks` — registers a new webhook subscription (url, events,
  optional shared secret). Returns the unhashed secret once, on creation only;
  the server stores a SHA-256 hash.
- `GET /webhooks` — lists the caller's subscriptions, newest first (secrets
  never included).
- `DELETE /webhooks/:id` — deletes one of the caller's subscriptions (ownership
  enforced).
- `POST /webhooks/inbound/:provider` — receives signed callbacks from external
  providers (anchors, payment providers); HMAC verified via
  `x-webhook-signature` / `x-webhook-timestamp` headers, no bearer token.

### Contract changes

None — this is a backend/API feature with no on-chain contract changes.

### Docs

- `docs/releases/2026-09-10-webhook-subscriptions.md` — this release note
- `docs/api/webhooks.md` — webhook subscription endpoints, inbound callbacks,
  signature verification, and delivery-attempt logs
- `docs/event-flow.md` — trade lifecycle events that trigger outbound deliveries
- `docs/backend.md` — ops alerting webhook (separate from trade lifecycle
  webhooks)

### Infra & operations

- Deployment: backend service (webhook routes + worker registered at deploy)
- Secrets: `WEBHOOK_URL` / `WEBHOOK_SECRET` for the default outbound target;
  per-subscription secrets are returned at registration and hashed at rest
- Network: outbound webhook targets are called from the backend; allowlist
  egress targets where the environment firewall requires it
- Queue: BullMQ `webhooks` queue with a dead-letter queue; `webhook.worker.ts`
  processes dispatch jobs with retry/backoff and DLQ after 3 attempts
- Observability: `webhook_signature_verifications_total{provider,outcome}`
  counter for inbound verification outcomes; alert on spikes in
  `invalid_signature` (probing) or `missing_secret` (misconfigured provider)
- CI/Policy: webhook route tests enforced; signature middleware covered by unit
  tests

## Verification

- [x] Subscription CRUD (register / list / delete) documented with caller scope
- [x] Inbound HMAC verification documented (headers, outcomes, retries)
- [x] Delivery pipeline (queue, worker, DLQ, attempt logs) captured for
  operators
- [x] Docs section links resolve
- [x] Release note stored under `docs/releases/`

## Related Issues

- Closes #312
