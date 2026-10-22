# Release Note Template

> Template for producing consistent release notes for new EliteWork features.
> Copy this file into `docs/releases/`, name it `YYYY-MM-DD-<feature>.md`, fill in
> each section, and delete the instructional comments. Ensure entries exist for
> every **admin feature**, **docs**, and **infra** change in the release.

## Overview

<!-- One to two sentences describing the feature and its value to stakeholders. -->

## Feature

### Admin features

<!-- List user-facing admin routes and contract entry points added or changed.
For each: the route / contract function, what it does, and who can call it. -->

- `POST /admin/...` — builds an unsigned XDR for `...` (admin only)
- `admin_clawback(trade_id, amount, destination)` — recovers escrowed funds (admin only)

### Contract changes

<!-- List on-chain changes: new/updated contract functions, emitted events,
state reads, invariants, and any migration notes. -->

- Event: `ClawbackExecutedEvent` (schema version, fields)
- View: `get_clawback_total(trade_id)`, `get_claimed_amount(trade_id)`
- Invariant: conservation of escrowed funds across partial clawbacks

### Docs

<!-- Point at the documentation written or updated for this release. -->

- `docs/releases/YYYY-MM-DD-<feature>.md` — this release note
- `docs/<feature>.md` — feature specification / reference

### Infra & operations

<!-- List infrastructure, deployment, secret, network, or CI changes that ship
with this feature and any operator actions required. -->

- Deployment: backend + contract artifact version
- Secrets: none / `ADMIN_SECRET_KEY` rotation if exposed
- Network: admin endpoints remain network-isolated
- CI/Policy: admin regression tests enforced

## Verification

<!-- How reviewers confirm the feature and its documentation are complete. -->

- [ ] Admin feature documented with route and caller
- [ ] Contract changes documented with events and views
- [ ] Docs section links resolve
- [ ] Infra/ops actions captured for operators
- [ ] Release note stored under `docs/releases/`

## Related Issues

- Closes #<!-- issue number -->
