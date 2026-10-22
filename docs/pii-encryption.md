# PII Encryption at Rest

**Owner:** Backend/Security (`@Ndifreke000`)
**Status:** Living document — update whenever a new PII-bearing column is added.
**Related:** `backend/src/services/encryption.service.ts`, `backend/src/services/manifest.service.ts`, `backend/src/lib/piiAudit.ts`, `backend/scripts/verify-pii-encryption.ts`

---

## 1. Classified PII Inventory

**Last audited against `backend/prisma/schema.prisma`: 2026-10-19.**

| Column | Table | Classification | Encrypted? | Search need |
|---|---|---|---|---|
| `driverName` | `DeliveryManifest` | Direct identifier (name) | ✅ App-layer AES-256-GCM | No — mediator/seller view only |
| `driverIdNumber` | `DeliveryManifest` | Direct identifier (gov't ID) | ✅ App-layer AES-256-GCM | No |
| `vehicleRegistration` | `DeliveryManifest` | Indirect identifier | ✅ App-layer AES-256-GCM | No |
| `routeDescription` | `DeliveryManifest` | Free-text, may contain address fragments | ✅ App-layer AES-256-GCM | No |
| `driverNameHash` / `driverIdHash` | `DeliveryManifest` | SHA-256 blind index of the above | N/A (already a one-way hash) | Yes — equality match, see §3 |
| `content` | `TradeNote` | Private free-text note (may contain names/addresses/contact details) | ✅ App-layer AES-256-GCM (`TradeNotesService`) | No — decrypt only for author/admin |
| `displayName` | `User` | Direct identifier (name) | ❌ **Not encrypted — gap F2** | No |
| `phoneNumber` | `NotificationPreference` | Direct identifier (E.164 phone number) | ❌ **Not encrypted — gap F1** | No today; add blind index only if lookup is ever required |
| `reason` | `Dispute` | Free-text, may contain direct identifiers or contact details | ❌ **Not encrypted — gap F3** | No |
| `filename` | `TradeEvidence` | Free-text metadata, may contain names/addresses | ❌ **Not encrypted — gap F3** | No |
| `walletAddress` | `User`, `Trade.buyerAddress/sellerAddress`, etc. | Pseudonymous identifier (Stellar public key) | Not encrypted — public by design, required for on-chain joins and is not classified as PII under NDPR guidance for public blockchain addresses | Yes — primary key lookups |

### Operational free-text reviewed (not classified, may still capture PII)

| Column | Table | Why it matters | Status |
|---|---|---|---|
| `title`, `message`, `metadata` | `InAppNotification` | Generated from trade events; may echo names, addresses, or contact details | Review notification builders; mask/minimise — gap F4 |
| `responseBody` | `WebhookDeliveryAttempt` | Third-party response bodies can echo user data | Redact/retain — gap F7 |
| `note` | `AdminActionAudit` | Operator-supplied free text | Redact/retain — gap F7 |
| `terminationReason`, `lockReason` | `Stream` | Operator notes | Redact/retain — gap F7 |
| `reason` | `ContractPauseLog` | Operator notes | Redact/retain — gap F7 |
| `lastError`, `notes` | `JobHeartbeat` | Error strings may contain user data | Redact/retain — gap F7 |
| `extra` | `EscrowAudit` | Event metadata; should stay public-chain-derived | Confirm no off-chain PII is copied into it |

`NotificationPreference.phoneNumber` was added after the original inventory was
written. It is currently persisted and returned in plaintext by
`backend/src/routes/notifications.preferences.routes.ts`; treat this as the
highest-priority gap below.

## 1a. Audit findings and follow-ups (2026-10-19)

| ID | Priority | Finding | Follow-up |
|---|---|---|---|
| F1 | High | `NotificationPreference.phoneNumber` is a direct identifier stored and returned in plaintext. | Encrypt on write/decrypt on read using `EncryptionService` (record id = user wallet address), backfill existing rows, add the column to `PII_COLUMNS`, and add route tests asserting ciphertext at rest. No search path exists today; add a blind index only if lookup is later required. |
| F2 | High | `User.displayName` is a direct identifier stored in plaintext. | Decide product requirement: encrypt with the same envelope scheme, or replace with a pseudonymous display value. If equality search is needed, add a blind index (see §3). |
| F3 | Medium | `Dispute.reason` and `TradeEvidence.filename` are free-text fields that can carry names/addresses/contact details; neither is encrypted. | Add input constraints + PII-safe copy in UI, then encrypt at rest or apply documented retention/access controls. Add both to the inventory/verifier once encrypted. |
| F4 | Medium | `InAppNotification.title`/`message`/`metadata` can duplicate PII from trade/manifest events. | Audit notification builders to use masked fields; encrypt or minimise notification payloads. |
| F5 | Medium | `TradeNote.content` is encrypted but was missing from this inventory and from the verifier. | **Fixed in this change:** added to the inventory and to `PII_COLUMNS`. |
| F6 | Medium | `TradeNotesService.listNotes` decrypts note content without the `logPiiAccess()` audit trail used by manifests. | Add decrypt access logging consistent with §5 (resource `trade_note`, recordId = trade ID, actor = caller). |
| F7 | Low | Operator free-text and webhook response bodies can capture PII. | Apply log redaction/retention rules and document them in the relevant ops docs; do not store request bodies or PII in notes/errors. |
| F8 | Low | The KMS-backed envelope roadmap is still outstanding; `JWT_SECRET` remains the root key. | Track via the roadmap in §2. |

Follow-ups should be filed as dedicated security issues before implementation;
this table is the source of truth until then. Re-run the audit whenever a Prisma
model gains a name, contact, address, identifier, or free-text field.

## 2. Encryption Design

`EncryptionService` (`backend/src/services/encryption.service.ts`) implements envelope-style encryption:

- **Cipher:** AES-256-GCM (authenticated encryption).
- **Key derivation:** a per-record data key is derived with `pbkdf2Sync(masterSecret, salt, 200_000, 32, "sha256")`, where `salt = sha256(masterSecret:recordId:keyVersion)`. `recordId` is the trade ID today, which means every trade's manifest is encrypted under a distinct derived key even though they share one root secret (`JWT_SECRET` by default) — the "envelope" layer. Ciphertext is stored as `keyVersion:salt:iv:ciphertext:tag`.
- **Rotation:** `rotateCiphertext()` re-derives under a new `keyVersion` and re-encrypts, so old and new key versions can co-exist during a rotation (dual-version acceptance).

### Roadmap to full KMS-backed envelope encryption

The current design derives data keys from a single root secret in application config rather than a managed KMS. This is tracked as a **TODO**: swap `masterSecret` for a per-environment Data Encryption Key (DEK) fetched from a KMS (AWS KMS / GCP KMS / Vault Transit) and wrapped by a KMS Customer Master Key, so compromising `JWT_SECRET` alone no longer compromises PII ciphertext. This does not require a schema change — only `EncryptionService`'s key-sourcing.

## 3. Search-by-identity via blind index

Direct equality search on `driverName` / `driverIdNumber` is supported without decrypting rows, via `driverNameHash` / `driverIdHash` — SHA-256 hashes of the plaintext computed at write time (`manifest.service.ts::sha256`). These are deterministic, so `WHERE driverNameHash = sha256(query)` performs an equality blind-index lookup. They are intentionally **not** used for the on-chain audit trail's confidentiality guarantee alone — see `docs/threat-model.md` TH-D-02 for the preimage-reveal caveat during disputes.

## 4. Migration & Rollback

Ciphertext columns (`driverName`, `driverIdNumber`, `vehicleRegistration`, `routeDescription`, `TradeNote.content`) are plain `VARCHAR`/`TEXT` columns — encryption is transparent at the application layer (`ManifestService.submitManifest` and `TradeNotesService.addNote` always encrypt before `create`). No separate backfill migration was required because these columns were introduced encrypted-by-default (migration `20260326000001_add_manifest_evidence` plus `feat(backend): encrypt sensitive trade data at rest`).

Run `backend/scripts/verify-pii-encryption.ts` after any migration or backfill touching these tables to assert **zero plaintext remnants** in every column listed as encrypted in §1:

```bash
npx ts-node backend/scripts/verify-pii-encryption.ts
```

It walks every column in the inventory table above and fails (exit code 1) if any stored value doesn't match the `keyVersion:salt:iv:ciphertext:tag` ciphertext envelope. Rollback plan: if a future migration needs to decrypt in bulk (e.g. moving to a new KMS scheme), use `EncryptionService.decrypt` / `rotateCiphertext` in a batched script guarded by the dual-version window described in §2, never a raw SQL `UPDATE`.

## 5. Access Logging on Decrypt

Every decrypt of manifest PII (`ManifestService.getManifestByTradeId`) writes a structured audit event via `logPiiAccess()` (`backend/src/lib/piiAudit.ts`), following the same `audit: true` convention as escrow audit logs (`backend/src/lib/escrowAudit.ts`). Each entry records `resource`, `recordId` (trade ID), `fields` decrypted, `actor` (caller wallet address), and `action`. Ship these logs to the same aggregator as other audit events and alert on unexpected `actor` values relative to trade participants/mediator allowlist.

`TradeNotesService.listNotes` currently decrypts `TradeNote.content` without a `logPiiAccess()` event — tracked as follow-up F6 in §1a.

## 6. Key Rotation Procedure & Drill

1. Introduce a new `keyVersion` (e.g. `v2`) constant.
2. Deploy `EncryptionService` accepting decrypts of both `v1` and `v2` payloads (already supported — `decrypt()` reads `keyVersion` from the payload itself, so old and new ciphertexts co-exist with no code change needed).
3. Run a batch job calling `rotateCiphertext(ciphertext, tradeId, "v2")` over all `DeliveryManifest` and `TradeNote` rows, writing the result back.
4. Run `verify-pii-encryption.ts` to confirm every row is re-encrypted and well-formed.
5. Once 100% migrated, retire the old master secret.

**Drill status:** TODO — schedule a staging drill rotating the manifest data key end-to-end (rotate → verify → retire) and record the outcome here with a date and owner, mirroring the format used in `docs/admin-secret-rotation.md`.

## 7. Performance Impact

TODO — measure p50/p95 latency of `POST /trades/:id/manifest` and `GET /trades/:id/manifest` with encryption enabled vs. a stubbed pass-through `EncryptionService`, and confirm the overhead is under the 10% budget set in issue #208. Not yet measured in this change.
