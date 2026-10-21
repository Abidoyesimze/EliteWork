# Security Scanning

Amana runs automated dependency vulnerability scanning on every CI run and provides a local script for ad-hoc scans.

## CI Pipeline

The `Security Audit` workflow (`.github/workflows/security-audit.yml`) runs on every PR that
touches a manifest or lockfile and **fails the build** on any **high** or **critical**
severity advisory that is not covered by an unexpired waiver.

| Job | Tool | Command | Fail threshold |
|-----|------|---------|----------------|
| `npm-audit (backend)` | pnpm audit | `pnpm audit --audit-level high` (via `scripts/check-audit-waivers.mjs`) | high + critical |
| `npm-audit (frontend)` | pnpm audit | `pnpm audit --audit-level high` (via `scripts/check-audit-waivers.mjs`) | high + critical |
| `cargo-audit (contracts)` | cargo audit | `cargo audit --json` (via `scripts/check-audit-waivers.mjs`) | high + critical + unknown |
| `gitleaks` (`.github/workflows/secrets-scan.yml`) | Gitleaks | `gitleaks git --config=.gitleaks.toml` | any finding (see [secrets-policy.md](secrets-policy.md)) |

`contracts` is also audited with a plain `cargo audit` in `.github/workflows/ci.yml`; the
gate here adds the JavaScript workspaces, the waiver mechanism, and the scheduled scan.

A **weekly full scan** (Monday 06:00 UTC) runs `pnpm audit` / `cargo audit` at all severities
and uploads `security-reports/audit-report.md` as a workflow artifact (`dependency-audit-report`,
30-day retention).

Container image scanning via Trivy runs separately — see
[Container image scanning](#container-image-scanning) below.

## Waivers

When a high/critical advisory has no available fix, add a **dated** entry to
`.github/audit-waivers.json` instead of lowering the threshold:

```jsonc
{
  "npm": [
    {
      "advisory": "GHSA-xxxx-xxxx-xxxx", // GitHub advisory id (npm) — cargo uses RUSTSEC-YYYY-NNNN
      "package": "left-pad",             // informational
      "workspace": "backend",            // "backend" | "frontend" | "contracts"; omit to apply everywhere
      "reason": "No patched release; sink not reachable from request path. Tracking: #1234",
      "addedBy": "your-handle",
      "expires": "2026-11-30"            // YYYY-MM-DD (UTC). REQUIRED.
    }
  ],
  "cargo": []
}
```

Enforcement rules (`scripts/check-audit-waivers.mjs`):

- An advisory listed with an **unexpired** waiver for the matching workspace is suppressed.
- An **expired** waiver **fails the gate** even if the advisory no longer fires — it must be
  renewed (new `expires`) or removed after review.
- A waiver missing `advisory` or `expires` is a hard error.

Baseline waivers for any pre-existing debt should be added with realistic due dates and a
tracking issue per entry.

## Automated updates

`.github/dependabot.yml` opens grouped update PRs weekly:

- `npm` for `/backend`, `/frontend`, and repo root; `cargo` for `/contracts`; `github-actions` for `/`.
- Minor/patch version updates are grouped per ecosystem; security updates are grouped separately so
  they can be fast-tracked; major bumps come as individual PRs for isolated review.

## Container image scanning

The `Container Scan` workflow (`.github/workflows/container-scan.yml`) runs Trivy on every PR
that touches `docker-compose.yml`, `infra/**`, or any `Dockerfile`, plus weekly:

- `trivy config` over `docker-compose.yml` and `infra/k8s/` — IaC misconfiguration and the image
  references embedded in them.
- `trivy image` over each third-party base image (`postgres:17-alpine`, `redis:7-alpine`) —
  **blocks on fixable `CRITICAL`** (`--severity CRITICAL --ignore-unfixed`).

Exceptions live in `.trivyignore` with a `# expires: YYYY-MM-DD` marker per entry;
`scripts/check-trivyignore-expiry.mjs` fails the workflow on an expired marker.

Base-image digest pinning is tracked as a follow-up — use `scripts/pin-image-digests.sh` to
resolve `image:tag` references to `image:tag@sha256:…` once a registry-authenticated runner is
available.

## Running Scans Locally

```bash
# Run all scanners and write reports to security-reports/
bash scripts/security-scan.sh

# Override report directory
REPORT_DIR=/tmp/my-scan bash scripts/security-scan.sh
```

The script auto-skips tools that are not installed and summarises results in `security-reports/summary.txt`.

## Fixing Vulnerabilities

1. **npm** — Run `npm audit fix` in the affected workspace (`frontend/` or `backend/`). For breaking changes use `npm audit fix --force` and test thoroughly.
2. **cargo** — Update the affected crate in `Cargo.toml` and run `cargo update`.
3. If no fix is available, open a tracking issue and add an advisory exception in `contracts/.cargo/audit.toml` with a justification comment.

## Installing Optional Scanners

```bash
# cargo-audit (Rust advisories)
cargo install cargo-audit --locked

# Trivy (filesystem + container image scanning)
# https://aquasecurity.github.io/trivy/latest/getting-started/installation/
brew install trivy          # macOS
sudo apt install trivy      # Debian/Ubuntu
```
