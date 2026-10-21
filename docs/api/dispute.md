# Dispute Endpoints

Dispute endpoints are split into two groups:

- **Mediator endpoints** (`/disputes`, `/disputes/:id/transition`) — require a
  bearer token whose wallet address appears in the mediator allowlist
  (`ADMIN_STELLAR_PUBKEYS`). See [overview.md](./overview.md#authentication)
  and [admin.md](./admin.md) for the allowlist mechanism.
- **Dispute category endpoints** (`/dispute-categories`) — readable by any
  authenticated user; write endpoints require mediator access.

All endpoints are available at the legacy root paths and under the versioned
`/api/v1` prefix.

Responses generally follow the [error envelope](./errors.md) on failure.

## Mediator Endpoints

### List disputes (mediator only)

`GET /disputes`

Returns a paginated list of disputes.

**Authentication:** Bearer token required; caller must be a mediator.

**Query parameters**

| Param | Type | Notes |
|---|---|---|
| `status` | enum | `OPEN`, `UNDER_REVIEW`, `RESOLVED`, `CLOSED` (optional) |
| `page` | integer | default `1` |
| `limit` | integer | default `10`, max `100` |

**Response `200`**

```json
{
  "items": [
    {
      "id": 1,
      "tradeId": "trade-dispute-001",
      "initiator": "GCUSER...0001",
      "reason": "Goods not delivered",
      "status": "OPEN",
      "createdAt": "2026-01-01T10:00:00.000Z",
      "updatedAt": "2026-01-01T10:00:00.000Z",
      "resolvedAt": null,
      "trade": {
        "buyerAddress": "GCUSER...0001",
        "sellerAddress": "GCSELLER...0001",
        "amountUsdc": "500"
      }
    }
  ],
  "pagination": {
    "page": 1,
    "limit": 10,
    "total": 1,
    "totalPages": 1
  }
}
```

| Status | Meaning |
|---|---|
| `401` | Missing/invalid token |
| `403` | Caller is not a mediator |
| `500` | Unexpected server error |

### Transition dispute status (mediator only)

`POST /disputes/:id/transition`

Transitions a dispute to a new status. Only forward transitions are
permitted (`OPEN` → `UNDER_REVIEW` → `RESOLVED`/`CLOSED`). Idempotent:
re-requesting the same transition returns the current state without error.

**Authentication:** Bearer token required; caller must be a mediator.

**Path parameter**

| Name | Type | Description |
|---|---|---|
| `id` | string | Trade ID of the dispute to transition |

**Request body**

```json
{
  "status": "UNDER_REVIEW"
}
```

| Field | Required | Values |
|---|---|---|
| `status` | yes | `UNDER_REVIEW`, `RESOLVED`, `CLOSED` |

**Response `200`**

```json
{
  "id": 1,
  "tradeId": "trade-dispute-001",
  "initiator": "GCUSER...0001",
  "reason": "Goods not delivered",
  "status": "UNDER_REVIEW",
  "createdAt": "2026-01-01T10:00:00.000Z",
  "updatedAt": "2026-01-01T10:05:00.000Z",
  "resolvedAt": null,
  "trade": {
    "buyerAddress": "GCUSER...0001",
    "sellerAddress": "GCSELLER...0001",
    "amountUsdc": "500"
  }
}
```

| Status | Meaning |
|---|---|
| `400` | Invalid status transition (see `DISPUTE_STATUS_TRANSITION_INVALID` in [errors.md](./errors.md)) |
| `401` | Missing/invalid token |
| `403` | Caller is not a mediator |
| `404` | No dispute found for the given trade ID |
| `409` | Concurrent modification — dispute was modified by another request (see `DISPUTE_STATUS_CONFLICT` in [errors.md](./errors.md)) |

## Dispute Categories

Categories classify the type of dispute (e.g., "Non-delivery", "Quality
issue"). They are managed by mediators but readable by anyone.

### List categories

`GET /dispute-categories`

Returns all active categories. Mediators can also see inactive categories.

**Authentication:** Bearer token required. Non-mediators receive only active
categories.

**Query parameters**

| Param | Type | Notes |
|---|---|---|
| `includeInactive` | boolean | `true` to include inactive categories; requires mediator access |

**Response `200`**

```json
{
  "items": [
    {
      "id": 1,
      "name": "Non-delivery",
      "description": "Buyer reports goods were not delivered",
      "isActive": true,
      "createdAt": "2026-01-01T00:00:00.000Z",
      "updatedAt": "2026-01-01T00:00:00.000Z"
    },
    {
      "id": 2,
      "name": "Quality issue",
      "description": "Delivered goods do not match description",
      "isActive": true,
      "createdAt": "2026-01-01T00:00:00.000Z",
      "updatedAt": "2026-01-01T00:00:00.000Z"
    }
  ]
}
```

### Get category by ID

`GET /dispute-categories/:id`

**Authentication:** Bearer token required.

**Response `200`** — same object shape as list items.

| Status | Meaning |
|---|---|
| `401` | Missing/invalid token |
| `404` | Category not found |

### Create category (mediator only)

`POST /dispute-categories`

**Authentication:** Bearer token required; caller must be a mediator.

**Request body**

```json
{
  "name": "Non-delivery",
  "description": "Buyer reports goods were not delivered",
  "isActive": true
}
```

| Field | Required | Notes |
|---|---|---|
| `name` | yes | 1–100 characters, unique |
| `description` | no | Up to 1000 characters |
| `isActive` | no | Default `true` |

**Response `201`** — created category object.

| Status | Meaning |
|---|---|
| `400` | Validation failed |
| `401` | Missing/invalid token |
| `403` | Caller is not a mediator |
| `409` | Category with this name already exists |

### Update category (mediator only)

`PATCH /dispute-categories/:id`

**Authentication:** Bearer token required; caller must be a mediator.

**Request body** — all fields optional:

```json
{
  "name": "Non-delivery (updated)",
  "description": "Updated description",
  "isActive": false
}
```

**Response `200`** — updated category object.

| Status | Meaning |
|---|---|
| `400` | Validation failed |
| `401` | Missing/invalid token |
| `403` | Caller is not a mediator |
| `404` | Category not found |
| `409` | Another category with the new name already exists |

### Delete category (mediator only)

`DELETE /dispute-categories/:id`

Soft-deletes the category by setting `isActive = false`. The record is
retained for audit purposes.

**Authentication:** Bearer token required; caller must be a mediator.

**Response `204`** — no body.

| Status | Meaning |
|---|---|
| `401` | Missing/invalid token |
| `403` | Caller is not a mediator |
| `404` | Category not found |

## Dispute Status Transitions

The allowed transitions are:

```
OPEN → UNDER_REVIEW
UNDER_REVIEW → RESOLVED
UNDER_REVIEW → CLOSED
```

Attempting any other transition (including backwards or sideways moves)
returns `400` with code `DISPUTE_STATUS_TRANSITION_INVALID`.

## Rate limits

Dispute endpoints are subject to the API-wide rate limits described in
[overview.md](./overview.md#rate-limits); there is no endpoint-specific
bucket for dispute transitions.

## Dispute-specific error codes

See [errors.md](./errors.md#dispute-specific-codes) for:

- `DISPUTE_INVALID_CATEGORY`
- `DISPUTE_STATUS_TRANSITION_INVALID`
- `DISPUTE_STATUS_CONFLICT`
- `DISPUTE_NOT_FOUND`