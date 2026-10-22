# Webhook Endpoints

Webhooks go in two directions:

- **Outbound**: you register a URL, and the backend `POST`s to it when one
  of your subscribed trade events happens. Managed with the
  [subscription endpoints](#register-a-webhook) below.
- **Inbound**: external providers (anchors, payment providers) send signed
  callbacks to the backend at
  [`POST /webhooks/inbound/:provider`](#inbound-provider-callbacks).

The subscription endpoints require `Authorization: Bearer <token>` (see
[overview.md](./overview.md#authentication)) and are available on the legacy
`/webhooks` path and under `/api/v1/webhooks`. The inbound endpoint uses an
HMAC signature instead of a bearer token and is **only** mounted at
`/webhooks/inbound`, not under `/api/v1`.

## Register a webhook

`POST /webhooks`

**Request body**

```json
{
  "url": "https://example.com/amana/webhooks",
  "events": ["trade.funded", "trade.completed"],
  "secret": "optional-shared-secret"
}
```

| Field | Required | Notes |
|---|---|---|
| `url` | yes | Must be a valid URL |
| `events` | yes | At least one event name. See [Events](#events) |
| `secret` | no | Shared secret used to [sign deliveries](#verifying-deliveries). If you omit it, the server generates a random 64-character hex secret |

**Response `201`**

```json
{
  "id": 12,
  "url": "https://example.com/amana/webhooks",
  "events": ["trade.funded", "trade.completed"],
  "secret": "3f1c...e9",
  "isActive": true,
  "createdAt": "2026-07-05T12:00:00.000Z"
}
```

**`secret` is returned only in this response.** The server stores only its
SHA-256 hash, so you can't retrieve it later. Save it now. If you lose it,
delete the webhook and register a new one.

| Status | Meaning |
|---|---|
| `400` | `VALIDATION_ERROR`: invalid `url`, or `events` is empty. See [errors.md](./errors.md) |
| `401` | Missing/invalid token |
| `404` | `{ "error": "User not found" }`. The wallet has no user record yet |
| `500` | `{ "error": "Failed to create webhook" }` |

## List your webhooks

`GET /webhooks`

Lists the caller's webhooks, newest first. Secrets are never included.

**Response `200`**

```json
{
  "webhooks": [
    {
      "id": 12,
      "url": "https://example.com/amana/webhooks",
      "events": ["trade.funded", "trade.completed"],
      "isActive": true,
      "createdAt": "2026-07-05T12:00:00.000Z",
      "updatedAt": "2026-07-05T12:00:00.000Z"
    }
  ]
}
```

The list isn't paginated. `401`, `404` (user not found), and `500` behave as
for registration.

## Delete a webhook

`DELETE /webhooks/:id`

Deletes one of the caller's webhooks. `:id` must be numeric.

**Response `200`**

```json
{ "message": "Webhook deleted successfully" }
```

| Status | Meaning |
|---|---|
| `400` | `VALIDATION_ERROR`: `id` isn't numeric |
| `401` | Missing/invalid token |
| `403` | `{ "error": "Forbidden" }`. The webhook belongs to another user |
| `404` | `{ "error": "Webhook not found" }` or `{ "error": "User not found" }` |
| `500` | `{ "error": "Failed to delete webhook" }` |

There's no update endpoint. To change a webhook's URL or events, delete it
and register a new one.

## Events

Event names are `trade.<status>`, using the lowercase trade status:

| Event | Fired when |
|---|---|
| `trade.created` | A trade is created on-chain |
| `trade.funded` | The buyer's deposit lands |
| `trade.delivered` | Delivery is confirmed |
| `trade.completed` | Funds are released, or a dispute is resolved |
| `trade.disputed` | A dispute is opened |

These are emitted by the chain event handlers in
`backend/src/services/eventHandlers.ts`. `trade.cancelled` and
`trade.expired` follow the same naming scheme but aren't emitted today.

`events` isn't checked against this list at registration, so a misspelled
event name is accepted but never fires. Check your spelling.

A subscription receives events for **every** trade that reaches a
subscribed status, not just the caller's own trades.

## Delivery format

Each delivery is a `POST` to your URL with `Content-Type: application/json`:

```json
{
  "event": "trade.funded",
  "tradeId": "4294967297",
  "status": "FUNDED",
  "timestamp": "2026-07-05T12:00:00.000Z",
  "data": {}
}
```

`data` carries event-specific metadata and may be empty. Treat unknown
fields as forward-compatible additions.

### Verifying deliveries

Every delivery to a subscription carries an `X-Webhook-Signature` header: a
hex-encoded HMAC-SHA256 of the raw request body.

Because the server stores only the hash of your secret, the HMAC key is
**`sha256_hex(secret)`, not the secret itself**:

```js
import crypto from "crypto";

function verify(rawBody, signatureHeader, secret) {
  const key = crypto.createHash("sha256").update(secret).digest("hex");
  const expected = crypto.createHmac("sha256", key).update(rawBody).digest("hex");
  return (
    expected.length === signatureHeader.length &&
    crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signatureHeader))
  );
}
```

Compute the HMAC over the raw bytes you received. Re-serialising the parsed
JSON can change key order or whitespace and break the comparison.

Outbound deliveries carry no timestamp header. Use `timestamp` in the body
together with `tradeId` + `event` to discard stale or duplicate deliveries.

### Retries

A delivery is retried when your endpoint returns `5xx` or `429`, or the
request fails at the network level. Any other `4xx` stops retries
immediately. Retries use exponential backoff:

| Env var | Default | Meaning |
|---|---|---|
| `WEBHOOK_MAX_ATTEMPTS` | `3` | Total attempts, including the first |
| `WEBHOOK_RETRY_BASE_MS` | `1000` | Delay before the first retry; doubles each attempt |
| `WEBHOOK_RETRY_MAX_MS` | `30000` | Upper bound on the delay |

Respond `2xx` quickly and do heavy processing asynchronously. Since a
delivery can arrive more than once, make your handler idempotent.

Operators can also set a single global receiver with `WEBHOOK_URL` /
`WEBHOOK_SECRET`. It receives every event, and its signature uses
`WEBHOOK_SECRET` directly as the HMAC key.

## Inbound provider callbacks

`POST /webhooks/inbound/:provider`

The endpoint external providers call. It's not meant for app clients. Every
request is HMAC-verified before any handler runs, and verification fails
closed: a provider with no configured secret is rejected.

**Required headers**

| Header | Value |
|---|---|
| `X-Webhook-Timestamp` | Unix time in **seconds**, as an integer |
| `X-Webhook-Signature` | `hex(HMAC_SHA256(secret, "<timestamp>." + rawBody))` |

The timestamp must be within `INBOUND_WEBHOOK_TOLERANCE_SECONDS` (default
`300`) of server time, in either direction. Secrets are configured per
provider in `INBOUND_WEBHOOK_SECRETS`. See
[webhook-secret-rotation.md](../../backend/docs/webhook-secret-rotation.md)
for the configuration format, a reference signing implementation, and how
to rotate secrets without dropping deliveries.

**Responses**

| Status | Body | Meaning |
|---|---|---|
| `200` | `{ "status": "ok", "provider": "<name>", "handled": true }` | Verified and processed |
| `202` | `{ "status": "accepted", "provider": "<name>", "handled": false }` | Verified, but no handler is registered for this provider yet. Acknowledged so the provider doesn't retry forever |
| `400` | `{ "error": "Malformed x-webhook-timestamp header" }` / `"Raw request body unavailable for signature verification"` | Bad request shape |
| `401` | `{ "error": "Missing x-webhook-signature header" }` / `"Missing x-webhook-timestamp header"` / `"Webhook timestamp outside the accepted tolerance window"` / `"Webhook signature verification failed"` | Signature or timestamp check failed |
| `404` | `{ "error": "Unknown webhook provider" }` | No provider in the path |
| `503` | `{ "error": "Webhook provider is not configured for signature verification" }` | No secret configured for this provider. A configuration issue on our side; retrying later can succeed |
| `500` | `{ "error": "Failed to process inbound webhook" }` | The provider's handler threw. The provider should retry |

Provider names are matched case-insensitively.

## Delivery logs

`backend/src/routes/webhooks.logs.routes.ts` defines
`GET /webhooks/:id/logs` (a cursor-paginated delivery-attempt history), but
`createWebhookLogsRouter` isn't mounted in `app.ts` or the public API
router yet, so the endpoint isn't reachable today.
