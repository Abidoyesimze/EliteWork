# Release Note — Rebrand: EziAgric → EliteWork

> Date: 2026-10-19
> Type: Docs / brand migration
> Status: Rebrand shipped; residual-reference cleanup tracked below

## Overview

The project has been rebranded from **EziAgric** to **EliteWork** across the
product name, documentation, UI copy, and repository references. This note
records what changed, which legacy identifiers are intentionally retained for
compatibility, and the cleanup that is still outstanding so the history is not
lost to git-log archaeology.

## Feature

### What changed

- Brand-facing references now use **EliteWork** instead of **EziAgric**.
- Repository and organisation links point at
  [`Elite-Work/EliteWork`](https://github.com/Elite-Work/EliteWork).
- UI copy shown to users refers to EliteWork (for example the Freighter
  wrong-network message).
- New documentation follows the EliteWork name; this release note records the
  migration itself.

### Naming map

| Layer | Current name | Notes |
|---|---|---|
| Product / docs / UI | **EliteWork** | Canonical brand name going forward |
| GitHub organisation / repo | **Elite-Work / EliteWork** | Old `EziAgric` URLs rely on GitHub redirects |
| Backend package / service identifiers | `amana-*`, `Amana*` | Legacy internal codename; not user-facing, left unchanged to avoid a breaking rename |
| On-chain contract crate | `amana_escrow` | Contract/package identifier; renaming would require a deployment/migration |
| Pact consumer/provider names | `AmanaFrontend`, `AmanaBackend` | Contract identifiers; changing them would orphan existing pact files |

### Known residual references (follow-up cleanup)

The following references were found during the rebrand audit and are **not**
fixed by this note. They are safe to update incrementally, but each needs its
own review because some are external-facing links or package identifiers.

| Area | Path / reference | Follow-up |
|---|---|---|
| Top-level README | `README.md` heading and body | Replace remaining EziAgric copy with EliteWork |
| Frontend i18n | `frontend/src/lib/i18n/messages/{en,fr}.ts` | Update wrong-network copy to EliteWork |
| Frontend docs | `frontend/docs/i18n.md` | Update EziAgric references |
| Backend docs | `backend/docs/retry-classification.md`, `backend/docs/health-probe-semantics.md` | Update titles and image references |
| Infra docs | `infra/terraform/modules/{vpc,rds}/README.md` | Update module descriptions |
| Scripts | `scripts/verify-secrets-rotation.sh` | Update banner text |
| Doc references | `docs/admin-route-contribution-guide.md`, `docs/admin-secret-management.md` | Update EziAgric copy |
| External issue links | `docs/storage-layout-gate.md`, `docs/deadline-extension-caps.md`, `docs/mediator-quorum.md`, `docs/slo-review-log.md` | Repoint old `EziAgric/EziAgric` issue links to `Elite-Work/EliteWork` |
| Shared schemas | `docs/shared-schemas.md` | Decide whether `@eziagric/domain-schemas` is renamed; document the package migration first |
| Contract docs | `docs/eziagric_contract_overview.md` and `contracts/amana_escrow/INTERFACE.md` | Rename the overview doc and update inbound links in the same PR |
| Release template | `docs/releases/release-note-template.md` | Updated to EliteWork in this change |

### External links, bookmarks, and integrations

- GitHub redirects old `github.com/EziAgric/...` URLs to
  `github.com/Elite-Work/EliteWork`, but third-party bookmarks, dashboards,
  webhook payloads, and runbook links may still embed the old org/repo path.
- Check alert routing, Grafana links, CI badges, npm/PyPI package pages, and
  deployment manifests for hard-coded `EziAgric` URLs before announcing the
  rename externally.
- Old bookmarks to `docs/eziagric_contract_overview.md` should be redirected or
  kept working until the doc rename ships.

## Verification

- [x] Rebrand note stored under `docs/releases/`
- [x] Naming map records which legacy identifiers are intentionally retained
- [x] Residual references listed with actionable follow-ups
- [ ] Residual references above cleaned up in follow-up PRs
- [ ] External bookmarks/links audited by comms/ops

## Related Issues

- Closes #126
