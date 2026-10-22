# Treasury Endpoints

The treasury is the escrow contract's balance. It holds funds swept from
resolved/expired escrows, and admins can build transactions that withdraw
from it.

All treasury endpoints require `Authorization: Bearer <token>` (see
[overview.md](./overview.md#authentication)). Withdrawal also requires an
admin wallet. All three are available on the legacy `/treasury` path and
under the versioned `/api/v1/treasury` prefix.

| Endpoint | Auth |
|---|---|
| `GET /treasury/balance` | Any authenticated wallet |
| `GET /treasury/config` | Any authenticated wallet |
| `POST /treasury/withdraw` | Admin wallet (`ADMIN_STELLAR_PUBKEYS`) |

## Balance

`GET /treasury/balance`

The escrow contract's current balance of the platform settlement token,
read from the network via Horizon.

**Response `200`**

```json
{ "balance": "50000.0000000", "asset": "cNGN", "contractId": "CA..." }
```

| Field | Type | Notes |
|---|---|---|
| `balance` | string | Decimal string with 7 decimal places. Don't parse it with `parseFloat` |
| `asset` | string | The platform token symbol (`TOKEN_CONFIG.symbol`, currently `cNGN`) |
| `contractId` | string | `AMANA_ESCROW_CONTRACT_ID` |

| Status | Meaning |
|---|---|
| `401` | Missing/invalid token |
| `500` | `{ "error": "Failed to get treasury balance" }`. Horizon lookup failed; safe to retry |

## Config

`GET /treasury/config`

Static treasury configuration. It makes no network calls.

**Response `200`**

```json
{ "contractId": "CA...", "network": "testnet", "asset": "cNGN" }
```

`network` is `STELLAR_NETWORK` (`testnet` or `pubnet`/mainnet).

| Status | Meaning |
|---|---|
| `401` | Missing/invalid token |
| `500` | `{ "error": "Failed to get treasury config" }` |

## Withdraw

`POST /treasury/withdraw`

**Admin only.** Builds an unsigned withdrawal transaction that moves funds
out of the treasury (e.g. a clawback of funds swept from an expired escrow).
The caller signs and submits the returned XDR themselves; the backend never
holds a signing key for the treasury.

**Request body**

```json
{
  "destination": "GBBB...C4",
  "amount": "1000.0000000",
  "note": "Reclaiming funds from expired escrow per ticket OPS-42"
}
```

| Field | Required | Notes |
|---|---|---|
| `destination` | yes | A valid Stellar ed25519 public key (`G...`) |
| `amount` | yes | Positive **decimal string** with at most 7 decimal places. A JSON number is rejected, because it can't represent large amounts exactly. The value is normalised to 7 decimal places |
| `note` | no | Free-text reason, max 2000 characters. Strongly recommended for compliance (see below) |

**Response `200`**

```json
{ "unsignedXdr": "..." }
```

> **Note:** `TreasuryService.withdraw` doesn't build the contract call yet
> and returns an empty `unsignedXdr` (`""`). The validation, quota, and
> audit steps below already run, so treat an empty XDR as "recorded but not
> yet executable" until the contract wiring lands.

| Status | Meaning |
|---|---|
| `400` | `VALIDATION_ERROR`: invalid `destination`, non-string or non-positive `amount`, too many decimals, or `note` over 2000 chars. See [errors.md](./errors.md) |
| `401` | Missing/invalid token |
| `403` | `AUTH_ERROR`, `"Forbidden: admin access required"`. The wallet isn't on the `ADMIN_STELLAR_PUBKEYS` allowlist (see [admin.md](./admin.md)) |
| `429` | `ADMIN_QUOTA_EXCEEDED`. See [Quota](#quota) |
| `500` | `{ "error": "Treasury withdrawal failed" }` |

### Audit trail

Every accepted withdrawal is recorded in two places:

- **`AdminActionAudit` table**: `action: "TREASURY_WITHDRAW"`, the caller's
  wallet as `actorAddress`, `destination` as `targetReference`, and the
  trimmed `note` (or `null`). Admins can list these via `GET /admin/audit`
  (see [admin.md](./admin.md#admin-action-audit-history)).
- **Structured logs**: an entry with `audit: true`,
  `eventType: "TREASURY_WITHDRAWAL"`, and
  `actionName: "admin.treasury.withdraw"`, linked to the request's trace (see
  [admin.md](./admin.md#admin-audit-trail)).

Omitting `note` still succeeds, but the audit record's `note` is then empty,
so ops/legal can't later tell why the withdrawal happened. Like all
validated string fields, `note` is HTML-escaped (`<`, `>`, `&`, quotes)
before it's stored.

### Quota

Withdrawals are quota-limited per admin identity. The identity is the
`x-api-key` header when one is sent, otherwise the caller's wallet address.
This guards against accidentally submitting many clawbacks. Requests over
the limit get `429` with a `Retry-After` header:

```json
{
  "code": "ADMIN_QUOTA_EXCEEDED",
  "message": "Treasury withdrawal (clawback) quota exceeded for this admin, try again later.",
  "details": { "operation": "treasury.withdraw", "limit": 10, "windowMs": 3600000, "retryAfterSeconds": 1800 }
}
```

| Env var | Default | Meaning |
|---|---|---|
| `ADMIN_QUOTA_CLAWBACK_WINDOW_MS` | `3600000` (1 hour) | Quota window, starting at the admin's first request in it |
| `ADMIN_QUOTA_CLAWBACK_MAX` | `10` | Withdrawals allowed per window |

Validation runs before the quota check, so rejected (`400`) requests don't
use up quota. Counters are kept in memory per backend process, so they
reset on restart and aren't shared between instances.
