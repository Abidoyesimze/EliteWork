#!/usr/bin/env bash
# check-lockfile-drift.sh — Fails fast when a lockfile has drifted from its manifest.
#
# Covers:
#   Issue #118 — pnpm/npm lockfile drift (e.g. backend's pnpm-lock.yaml falling out
#                 of sync with package.json, which only surfaces at
#                 `pnpm install --frozen-lockfile` time).
#   Issue #119 — stray `package-lock.json` files reappearing in pnpm-managed
#                 subprojects (`frontend/`, `backend/`, `mobile/`).
#
# Checks:
#   1. pnpm-managed dirs (backend, frontend, mobile) must NOT contain an npm
#      `package-lock.json` / `npm-shrinkwrap.json` (stray npm install artifact).
#   2. pnpm-managed dirs must satisfy
#      `pnpm install --frozen-lockfile --lockfile-only --ignore-scripts`
#      (lockfile in sync with package.json, verified without touching
#      node_modules or rewriting the lockfile).
#   3. npm-managed dirs (repo root) must satisfy an
#      `npm install --package-lock-only` round-trip: the lockfile is regenerated
#      in a temp copy and byte-compared against the working-tree lockfile.
#      (npm has no native --frozen-lockfile equivalent.)
#
# Usage:
#   ./scripts/check-lockfile-drift.sh [--pnpm-only] [--npm-only]
#
# Exit codes:
#   0 — all lockfiles in sync, no stray npm lockfiles
#   1 — drift or stray lockfile found (prints details + remediation)

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

PNPM_DIRS=("backend" "frontend" "mobile")
NPM_DIRS=("") # "" = repo root
NPM_STRAY_FILES=("package-lock.json" "npm-shrinkwrap.json")

CHECK_PNPM=true
CHECK_NPM=true
for arg in "$@"; do
  case "$arg" in
    --pnpm-only) CHECK_NPM=false ;;
    --npm-only) CHECK_PNPM=false ;;
    -h|--help)
      echo "Usage: $0 [--pnpm-only] [--npm-only]"
      exit 0
      ;;
    *)
      echo "ERROR: unknown argument '$arg' (see --help)" >&2
      exit 1
      ;;
  esac
done

FAILURES=0

fail() {
  echo "  ✗ $1" >&2
  FAILURES=$((FAILURES + 1))
}

pass() {
  echo "  ✓ $1"
}

# ─── 1+2. pnpm-managed subprojects ──────────────────────────────────────────

if [[ "$CHECK_PNPM" == "true" ]]; then
  if ! command -v pnpm &>/dev/null; then
    fail "pnpm not found on PATH — install pnpm 10 (see packageManager in package.json)"
  else
    for dir in "${PNPM_DIRS[@]}"; do
      echo "Checking pnpm project: $dir/"

      # Issue #119: stray npm lockfiles must not exist in pnpm-managed dirs.
      for stray in "${NPM_STRAY_FILES[@]}"; do
        if [[ -e "$REPO_ROOT/$dir/$stray" ]]; then
          fail "$dir/$stray exists: $dir is pnpm-managed — delete it (git rm $dir/$stray) and use 'pnpm install' instead of 'npm install' there."
        else
          pass "$dir/$stray absent"
        fi
      done

      if [[ ! -f "$REPO_ROOT/$dir/package.json" ]]; then
        fail "$dir/package.json not found"
        continue
      fi
      if [[ ! -f "$REPO_ROOT/$dir/pnpm-lock.yaml" ]]; then
        fail "$dir/pnpm-lock.yaml not found — run 'pnpm install --lockfile-only' in $dir/"
        continue
      fi

      # Issue #118: frozen-lockfile verification (read-only: --lockfile-only
      # writes no node_modules and, combined with --frozen-lockfile, refuses
      # to update the lockfile — exiting non-zero on drift instead).
      if pnpm --dir "$REPO_ROOT/$dir" install --frozen-lockfile --lockfile-only --ignore-scripts >/dev/null 2>&1; then
        pass "$dir/pnpm-lock.yaml in sync with package.json"
      else
        fail "$dir/pnpm-lock.yaml is out of sync with package.json — run 'pnpm install --lockfile-only' in $dir/ and commit the result."
      fi
    done
  fi
fi

# ─── 3. npm-managed projects (repo root) ────────────────────────────────────

if [[ "$CHECK_NPM" == "true" ]]; then
  if ! command -v npm &>/dev/null; then
    fail "npm not found on PATH"
  else
    for dir in "${NPM_DIRS[@]}"; do
      label="${dir:-<repo root>}"
      echo "Checking npm project: $label"

      manifest="$REPO_ROOT/$dir/package.json"
      lockfile="$REPO_ROOT/$dir/package-lock.json"
      if [[ ! -f "$manifest" ]]; then
        fail "$label/package.json not found"
        continue
      fi
      if [[ ! -f "$lockfile" ]]; then
        fail "$label/package-lock.json not found — run 'npm install --package-lock-only' in $label and commit the result."
        continue
      fi

      # npm has no --frozen-lockfile: regenerate in a temp copy and diff.
      # The working tree is never modified by this check.
      tmpdir="$(mktemp -d)"
      trap 'rm -rf "$tmpdir"' RETURN
      cp "$manifest" "$tmpdir/package.json"
      cp "$lockfile" "$tmpdir/package-lock.json"
      if [[ -f "$REPO_ROOT/$dir/.npmrc" ]]; then
        cp "$REPO_ROOT/$dir/.npmrc" "$tmpdir/.npmrc"
      fi
      if (cd "$tmpdir" && npm install --package-lock-only --ignore-scripts --no-audit --no-fund >/dev/null 2>&1); then
        # A nameless package.json (like the repo root) makes npm stamp the
        # *directory* basename into the lockfile "name" field, which always
        # differs in a temp copy. Normalize it before byte-comparing so only
        # real dependency drift fails the check.
        node -e "
          const fs = require('fs');
          const orig = JSON.parse(fs.readFileSync(process.argv[1], 'utf8'));
          const regenPath = process.argv[2];
          const regen = JSON.parse(fs.readFileSync(regenPath, 'utf8'));
          regen.name = orig.name;
          fs.writeFileSync(regenPath, JSON.stringify(regen, null, 2) + '\n');
        " "$lockfile" "$tmpdir/package-lock.json"
        if cmp -s "$lockfile" "$tmpdir/package-lock.json"; then
          pass "$label/package-lock.json in sync with package.json"
        else
          fail "$label/package-lock.json is out of sync with package.json — run 'npm install --package-lock-only' in $label and commit the result."
        fi
      else
        fail "$label: 'npm install --package-lock-only' failed — package.json may reference uninstallable ranges."
      fi
      rm -rf "$tmpdir"
      trap - RETURN
    done
  fi
fi

# ─── Report ─────────────────────────────────────────────────────────────────

if [[ "$FAILURES" -gt 0 ]]; then
  echo ""
  echo "[lockfile-drift] FAILED — $FAILURES check(s) failed. See above for remediation." >&2
  exit 1
fi

echo ""
echo "[lockfile-drift] OK — all lockfiles in sync, no stray npm lockfiles."
exit 0
