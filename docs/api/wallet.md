# Wallet Endpoints

Endpoints scoped to the caller's own wallet. Both require
`Authorization: Bearer <token>` (see
[overview.md](./overview.md#authentication)) and act on the wallet address
in the token, not on anything in the request. They're available on the
legacy `/wallet` path and under the versioned `/api/v1/wallet` prefix.

For balances of an arbitrary address, or account creation, see the Stellar
proxy endpoints in [stellar.md](./stellar.md#account-balance).

## Token balance

`GET /wallet/balance`

The caller's balance of the platform settlement token, read from the
network.

**Response `200`**

```json
{ "balance": "250.0000000", "asset": "cNGN" }
```

| Field | Type | Notes |
|---|---|---|
| `balance` | string | Decimal string with 7 decimal places. Don't parse it with `parseFloat` for anything money-related |
| `asset` | string | The platform token symbol (`TOKEN_CONFIG.symbol`, currently `cNGN`) |

| Status | Meaning |
|---|---|
| `400` | `{ "error": "Wallet address not found in token" }`. The token is valid but has no `walletAddress` claim |
| `401` | Missing/invalid token |
| `500` | `{ "error": "Failed to fetch balance" }`. The network lookup failed; safe to retry |

## Path payment quote

`GET /wallet/path-payment-quote`

Finds Stellar path-payment routes (Horizon strict-send paths) that convert
an amount of a source asset into USDC, e.g. to show a buyer paying in NGN
how much USDC their payment would settle as.

```bash
curl 'http://localhost:4000/wallet/path-payment-quote?sourceAmount=1000&sourceAsset=NGN&sourceAssetIssuer=GASI...ANKE' \
  -H 'Authorization: Bearer <token>'
```

**Query parameters**

| Param | Required | Notes |
|---|---|---|
| `sourceAmount` | yes | Decimal string |
| `sourceAsset` | yes | Asset code, or `native`/`XLM` for lumens |
| `sourceAssetIssuer` | no | Issuer's Stellar public key. Ignored for `native`/`XLM`. **If omitted for a non-native asset, the server falls back to a default issuer** (`GASIVS63...ANKE`), so always pass it unless that is the issuer you want |

The destination is always USDC from the issuer for the configured network
(testnet or mainnet).

**Response `200`**

The result is wrapped in `routes`:

```json
{
  "routes": {
    "quotes": [
      {
        "source_amount": "1000.0000000",
        "source_asset_type": "credit_alphanum4",
        "source_asset_code": "NGN",
        "destination_amount": "0.6512345",
        "destination_asset_type": "credit_alphanum4",
        "destination_asset_code": "USDC",
        "path": []
      }
    ],
    "cached": false,
    "freshnessMs": 0,
    "quotedAt": "2026-07-05T12:00:00.000Z"
  }
}
```

| Field | Notes |
|---|---|
| `routes.quotes` | Candidate routes, in Horizon's order. `path` lists any intermediate assets. An empty array means no route was found |
| `routes.cached` | `true` if served from the short-lived Redis quote cache |
| `routes.freshnessMs` | Age of the quote in ms (`0` when fetched live) |
| `routes.quotedAt` | When the quote was originally fetched from Horizon |

Quotes move with the market. Use `freshnessMs`/`quotedAt` to decide whether
a quote is still fresh enough to show or act on, and set your own slippage
bounds when building the actual payment.

| Status | Meaning |
|---|---|
| `400` | `{ "error": "Missing sourceAmount or sourceAsset" }` |
| `401` | Missing/invalid token |
| `500` | `{ "error": "Failed to fetch quotes" }`. Horizon failed, or the Horizon circuit breaker is open after sustained failures. Retry with backoff |

Horizon calls are retried internally (backoff `1s, 2s, 4s, 8s`) before the
request fails, so a `500` here can take several seconds to arrive.
