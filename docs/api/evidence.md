# Evidence Endpoints

Evidence endpoints handle video file uploads to IPFS and retrieval of dispute
evidence. All endpoints require `Authorization: Bearer <token>` (see
[overview.md](./overview.md#authentication)) unless stated otherwise.

## Upload video evidence

`POST /evidence/video`

Uploads a video file (MP4 or WebM, max 50 MB) to IPFS and creates an
evidence record linked to a trade. The caller must be the buyer or seller
of the trade.

**Authentication:** Bearer token required.

**Request**

`Content-Type: multipart/form-data`

| Field | Type | Required | Notes |
|---|---|---|---|
| `file` | file | yes | Video file (MP4 or WebM, ≤ 50 MB) |
| `tradeId` | string (form field) | yes | UUID of the trade this evidence belongs to |

**Response `201`**

```json
{
  "evidenceId": 42,
  "cid": "bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi",
  "ipfsUrl": "https://gateway.pinata.cloud/ipfs/bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi"
}
```

| Status | Meaning |
|---|---|
| `400` | Validation failed (file type, size, or content mismatch) |
| `401` | Missing/invalid token |
| `403` | Caller is not the buyer or seller of the trade |
| `404` | Trade not found |
| `413` | File exceeds the 50 MB size limit |
| `415` | Unsupported media type — only MP4 and WebM are accepted |
| `502` | IPFS upload failed |
| `503` | Evidence scan service unavailable (when `EVIDENCE_SCAN_REQUIRED=true`) |

### Validation details

1. **MIME type** — Only `video/mp4` and `video/webm` are accepted (checked
   via `Content-Type` header and magic bytes).
2. **Magic bytes** — The file content is sniffed to prevent spoofed
   `Content-Type` headers:
   - MP4: bytes 4–7 must contain `ftyp` (ISO BMFF container)
   - WebM: bytes 0–3 must be EBML header `0x1A45DFA3`
3. **Size limit** — Configured via `EVIDENCE_MAX_BYTES` (default `52428800`
   = 50 MB).
4. **Malware scan** — If `EVIDENCE_SCAN_REQUIRED=true`, the file is scanned
   via the configured `EvidenceScanner` implementation. A failed or
   unavailable scan blocks the upload.

### Idempotency

Supports `Idempotency-Key` header (see [overview.md](./overview.md#idempotency)).
Replaying the same upload with the same key within 24 hours returns the
original response.

## List evidence for a trade (disputed trades only)

`GET /trades/:id/evidence`

Returns all evidence (video files and delivery manifest) for a trade that is
in `DISPUTED` status or has an associated dispute record. The caller must
be the buyer, seller, or an admin/mediator.

**Authentication:** Bearer token required.

**Path parameter**

| Name | Type | Description |
|---|---|---|
| `id` | string | Trade ID |

**Query parameters**

| Param | Type | Default | Notes |
|---|---|---|---|
| `type` | enum | — | `video` or `manifest` to filter; omit for all |
| `page` | integer | `1` | 1-indexed |
| `limit` | integer | `20` | Max `100` |

**Response `200`**

```json
{
  "items": [
    {
      "id": "video:7",
      "type": "video",
      "cid": "bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi",
      "filename": "delivery-proof.mp4",
      "mimeType": "video/mp4",
      "uploadedBy": "GCBUYER...",
      "downloadUrl": "https://gateway.pinata.cloud/ipfs/...?signature=...",
      "expiresAt": "2026-07-06T12:00:00.000Z",
      "createdAt": "2026-07-05T10:30:00.000Z"
    },
    {
      "id": "manifest:3",
      "type": "manifest",
      "tradeId": "trade-dispute-001",
      "filename": "delivery-manifest.json",
      "mimeType": "application/json",
      "downloadUrl": null,
      "expiresAt": null,
      "createdAt": "2026-07-05T09:00:00.000Z"
    }
  ],
  "pagination": {
    "page": 1,
    "limit": 20,
    "total": 2,
    "totalPages": 1
  }
}
```

| Status | Meaning |
|---|---|
| `401` | Missing/invalid token |
| `403` | Caller is not a party to the trade or an admin |
| `404` | Trade not found |
| `409` | Trade is not disputed and has no dispute record (`TradeNotDisputedError`) |

### Retention and redaction

Evidence metadata is subject to a retention window (default 90 days,
configured via `EVIDENCE_METADATA_RETENTION_DAYS`). After expiration:

- `cid` and `filename` are replaced with `"redacted"`
- `uploadedBy` is replaced with `"redacted"` (except for admins)
- `url` / `downloadUrl` is set to `null`
- `retentionExpired` flag is set to `true`

Admins (wallets in `ADMIN_STELLAR_PUBKEYS`) always see unredacted metadata.

## Stream evidence from IPFS

`GET /evidence/:cid/stream`

Proxies a video file from the IPFS gateway with HTTP Range support,
enabling video seeking in the browser. The caller must be a party to the
trade the evidence belongs to (validated internally via the CID-to-trade
mapping).

**Authentication:** Bearer token required.

**Path parameter**

| Name | Type | Description |
|---|---|---|
| `cid` | string | IPFS content identifier (CIDv0 or CIDv1) |

**Headers**

| Header | Notes |
|---|---|
| `Range` | Optional. Enables partial content responses (HTTP 206) for video seeking. |

**Response**

- `200` — Full file stream (no `Range` header)
- `206` — Partial content (when `Range` header provided)
- `502` — Upstream IPFS gateway unavailable

The response includes standard streaming headers:
- `Accept-Ranges: bytes`
- `Content-Type` (from upstream)
- `Content-Length` / `Content-Range` (from upstream)

### Gateway failover

The endpoint tries multiple IPFS gateways in order (configured via
`IPFS_GATEWAY_URLS` or defaults to Pinata/Cloudflare). Circuit breaker
logic skips gateways that have recently failed.

## List evidence via EvidenceService (internal)

`GET /trades/:id/evidence` (legacy, via `EvidenceService`)

The `EvidenceService.getEvidenceByTradeId` method is also exposed via the
trade evidence route at `GET /trades/:id/evidence` (see
[trade.evidence.routes.ts](../../backend/src/routes/trade.evidence.routes.ts)).
It returns a simpler format without pagination and includes retention status:

```json
[
  {
    "id": 7,
    "cid": "bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi",
    "filename": "delivery-proof.mp4",
    "mimeType": "video/mp4",
    "uploadedBy": "GCBUYER...",
    "url": "https://gateway.pinata.cloud/ipfs/...",
    "createdAt": "2026-07-05T10:30:00.000Z",
    "retentionExpired": false
  }
]
```

This endpoint is used by the dispute UI to show evidence during mediation.

## Rate limits

| Endpoint | Bucket | Window | Max requests |
|---|---|---|---|
| `POST /evidence/video` | `evidenceUpload` | 1 hour | 10 |

See [overview.md](./overview.md#rate-limits) for the envelope shape.

## Evidence-specific error codes

See [errors.md](./errors.md) for:

- `VALIDATION_ERROR` — file type, size, or content validation failed
- `AUTH_ERROR` — missing/invalid token
- `DOMAIN_ERROR` — access denied (not a party to the trade) or trade not disputed
- `INFRA_ERROR` — IPFS gateway or scanner unavailable
- `NOT_FOUND` — trade not found
- `RATE_LIMIT_EXCEEDED` — too many uploads

## Environment variables

| Variable | Default | Description |
|---|---|---|
| `EVIDENCE_MAX_BYTES` | `52428800` (50 MB) | Maximum upload size |
| `EVIDENCE_SCAN_REQUIRED` | `false` | Fail closed if scanner unavailable |
| `EVIDENCE_METADATA_RETENTION_DAYS` | `90` | Metadata retention window |
| `IPFS_GATEWAY_URLS` | (comma-separated) | List of IPFS gateway base URLs for failover |
| `IPFS_STREAM_TIMEOUT_MS` | `10000` | Per-gateway stream timeout |