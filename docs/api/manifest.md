# Delivery Manifest Endpoints

A delivery manifest records who is moving the goods for a trade (driver,
vehicle, route, delivery window). It is submitted by the seller once the
buyer has funded escrow, and anchored on-chain so it can't be quietly changed
later.

All manifest endpoints require `Authorization: Bearer <token>` (see
[overview.md](./overview.md#authentication)). Both are available on the
legacy path shown below and under the versioned `/api/v1` prefix.

Manifest data includes courier PII. The driver name, driver id/phone,
vehicle registration, and route are stored encrypted at rest (see
[pii-encryption.md](../pii-encryption.md)), and every read of a manifest is
recorded in the PII access log.

## Submit a manifest

`POST /trades/:id/manifest`

**Seller only**, and the trade must be `FUNDED`. The server:

1. Uploads the manifest JSON to IPFS as `trade-<id>-manifest.json`.
2. Stores an encrypted copy in the database, along with SHA-256 hashes of
   the driver name and phone.
3. Builds an **unsigned Soroban transaction (XDR)** that records the IPFS
   hash on the escrow contract. As with trade transitions in
   [trades.md](./trades.md#trade-lifecycle), you sign and submit it
   yourself; the backend never holds your signing key.

**Request body**

```json
{
  "driverName": "Musa Ibrahim",
  "phone": "+2348012345678",
  "licensePlate": "KAN-123-XY",
  "vehicleType": "Box truck",
  "estimatedDeliveryWindow": {
    "from": "2026-07-06T08:00:00Z",
    "to": "2026-07-06T17:00:00Z"
  }
}
```

| Field | Required | Notes |
|---|---|---|
| `driverName` | yes | Non-empty after trimming |
| `phone` | yes | At least 5 characters. Stored as the driver's id number |
| `licensePlate` | yes | Non-empty. Stored as the vehicle registration |
| `vehicleType` | yes | Non-empty |
| `estimatedDeliveryWindow.from` | yes | ISO 8601 datetime |
| `estimatedDeliveryWindow.to` | yes | ISO 8601 datetime, must be after `from`. Stored as `expectedDeliveryAt` |

`phone`, `vehicleType`, the delivery window, and the IPFS hash are packed
into the stored `routeDescription`, so that's where they show up when the
manifest is read back.

**Response `201`**

```json
{
  "manifestId": 17,
  "ipfsHash": "bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi",
  "unsignedXdr": "AAAAAgAAAAC..."
}
```

| Status | Meaning |
|---|---|
| `400` | Validation failed (body is `{ "error": { "<field>": ["<message>"] } }`), or the trade isn't `FUNDED`: `{ "error": "Trade must be in FUNDED status to submit a manifest (current: CREATED)" }` |
| `401` | Missing/invalid token |
| `403` | `{ "error": "Only the seller may submit a delivery manifest" }` |
| `404` | `{ "error": "Trade not found" }` |
| `409` | `{ "error": "A manifest has already been submitted for this trade" }`. Manifests are write-once; there is no update endpoint |
| `503` | IPFS is unavailable. Nothing has been stored, so retrying later is safe |

Validation and domain errors on this route use the legacy `{ "error": ... }`
envelope rather than the `{ code, message, details }` one (see
[errors.md](./errors.md)).

## Fetch a manifest

`GET /trades/:id/manifest`

Returns the trade's manifest. The buyer, the seller, and wallets on the
`ADMIN_STELLAR_PUBKEYS` allowlist (mediators/admins) can read it, and each
role gets a different view. `roleView` in the response tells you which one
you got.

| Caller | `roleView` | What you see |
|---|---|---|
| Seller | `seller` | Every field in plaintext, plus `driverNameHash`/`driverIdHash` |
| Buyer | `buyer` | `driverName` masked to its first initial (`"M****"`), `driverIdNumber` always `"ID-****"`, no hashes. Vehicle and route are in plaintext |
| Mediator/admin | `mediator` | No driver name or id, only `driverNameHash`/`driverIdHash`. `vehicleRegistration` and `routeDescription` are returned as stored (encrypted), not decrypted |

If a wallet is both a party to the trade and on the allowlist, the buyer
view takes precedence over the mediator view, and the mediator view takes
precedence over the seller view.

**Response `200`** (seller view)

```json
{
  "tradeId": "4294967297",
  "roleView": "seller",
  "driverName": "Musa Ibrahim",
  "driverIdNumber": "+2348012345678",
  "driverNameHash": "9f86d081884c7d65...",
  "driverIdHash": "2c26b46b68ffc68f...",
  "vehicleRegistration": "KAN-123-XY",
  "routeDescription": "phone=+2348012345678; vehicleType=Box truck; deliveryWindow=2026-07-06T08:00:00Z/2026-07-06T17:00:00Z; ipfsHash=bafy...",
  "expectedDeliveryAt": "2026-07-06T17:00:00.000Z",
  "createdAt": "2026-07-05T12:00:00.000Z",
  "retentionExpired": false
}
```

**Response `200`** (buyer view)

```json
{
  "tradeId": "4294967297",
  "roleView": "buyer",
  "driverName": "M****",
  "driverIdNumber": "ID-****",
  "vehicleRegistration": "KAN-123-XY",
  "routeDescription": "phone=+2348012345678; ...",
  "expectedDeliveryAt": "2026-07-06T17:00:00.000Z",
  "createdAt": "2026-07-05T12:00:00.000Z",
  "retentionExpired": false
}
```

| Status | Meaning |
|---|---|
| `401` | Missing/invalid token |
| `403` | `{ "error": "Access denied: you are not allowed to view this manifest" }`. The caller isn't the buyer, the seller, or on the allowlist |
| `404` | `{ "error": "Trade not found" }` or `{ "error": "Manifest not found" }` |

### PII retention

`retentionExpired` becomes `true` once the manifest is older than
`MANIFEST_PII_RETENTION_DAYS` (default `30`). From then on the seller view
returns `"REDACTED"` for `driverName` and `driverIdNumber`. The hashes stay
available, so a driver can still be matched against a known name or id
without the plaintext being exposed. The buyer and mediator views don't
change, since they never include the plaintext driver identity.

## Implementation notes

Two routers are mounted on `/trades/:id/manifest`:
`trade.manifest.routes.ts` (the IPFS-backed flow described above) and the
older `manifest.routes.ts`. The newer router is mounted first and answers
both `GET` and `POST`, so the older router's `POST` body (`driverIdNumber`,
`vehicleRegistration`, `routeDescription`, `expectedDeliveryAt`) is not
reachable over HTTP. The `GET` behaviour is identical in both because they
share `ManifestService.getManifestByTradeId`.
