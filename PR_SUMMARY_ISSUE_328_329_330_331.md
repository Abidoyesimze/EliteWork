# PR Summary — CI gate coverage: money-math parity + CI script tests

Closes #328
Closes #329
Closes #330
Closes #331

Single reviewable PR covering all four tasks (each was acceptance-criteria-scoped
to "a single reviewable PR", so they are delivered together on one branch:
`fix/ci-script-test-coverage-and-money-math-parity`, pushed to
`https://github.com/Teetotola/EliteWork`).

Target branch for merge: `main` of Elite-Work/EliteWork (the upstream this fork
was created from).

---

## 1) ci: cross-check money-math-parity.yml against the invariant catalog (Closes #328)

### Gap found
`docs/money-math-invariant-catalog.md` lists 8 invariants (INV-001…INV-008),
but the CI job (`money-math-parity.yml`) only runs `cargo test parity_money_math`
plus the TypeScript parity jest suite. Four invariants were owned **only** by
`contracts/amana_escrow/src/tests/bps_fuzz_tests.rs`, which is outside the CI
test filter and therefore never ran in CI:

| Invariant | Previously enforced in CI? | Owner before this PR |
|---|---|---|
| INV-002 `fee >= 0` | No | `bps_fuzz_tests.rs` (`prop_fee_amount_non_negative`) |
| INV-003 `fee <= amount` | No | `bps_fuzz_tests.rs` (`prop_fee_amount_le_amount`) |
| INV-006 `loss >= 0` | No | `bps_fuzz_tests.rs` (`prop_loss_amount_non_negative`) |
| INV-007 `loss <= total` | No | `bps_fuzz_tests.rs` (`prop_loss_amount_le_total`) |

INV-001/004/005/008 were already asserted in CI-run tests.

### Changes
- `contracts/amana_escrow/tests/parity_money_math.rs` — added explicit `assert!`
  checks so the CI-run parity tests now assert every catalog invariant:
  - `fee_boundary_parity` / `fee_generated_parity`: INV-002 (`fee >= 0`) and
    INV-003 (`fee <= amount`) per corpus case
  - `loss_boundary_parity`: INV-006 (`loss >= 0`) and INV-007 (`loss <= total`)
    per corpus case
- `docs/money-math-invariant-catalog.md` — marked each owning test file as
  CI-enforced (or not), and added a "CI coverage of catalog invariants"
  cross-reference table mapping all 8 invariants to the CI test that asserts
  them, plus a "Gap history" note documenting the previously-undocumented gap
  and its closure
- `.github/workflows/money-math-parity.yml` — added
  `contracts/amana_escrow/tests/parity_money_math.rs` and
  `docs/money-math-invariant-catalog.md` to the `push`/`pull_request`
  `paths` triggers so future changes to the test or catalog re-run the parity
  job

### Verification
- New assertions mirror existing test style and run under the existing CI
  filter `cargo test parity_money_math`
- Note: no Rust toolchain is available in this environment, so the crate could
  not be compiled locally; the added `assert!` forms are identical in shape to
  existing assertions in the same file

---

## 2) testing: scripts/check-admin-test-coverage.sh coverage (Closes #329)

### Gap found
No matching test existed in `scripts/__tests__/` for this CI-invoked gate.

### Changes
- New `scripts/__tests__/check-admin-test-coverage.test.mjs` — end-to-end
  tests against throwaway git repos exercising both branches:
  - Pass: no changes since base ref; only non-admin files changed; admin
    source change paired with a matching `backend/src/__tests__/` test change
  - Fail: admin source change without any test change (exit 1, policy
    violation); each admin path prefix (`routes/`, `controllers/`,
    `middleware/`, `services/admin`)

---

## 3) testing: scripts/check-flag-catalog-drift.ts coverage (Closes #330)

### Gap found
No matching test existed in `scripts/__tests__/` for this CI-invoked gate.

### Changes
- New `scripts/__tests__/check-flag-catalog-drift.test.mjs` — runs the real
  script (copied to a temp `.mts` with the frontend catalog path overridden to
  a controlled file, executed via Node native type stripping) against:
  - Pass: catalog contains every backend flag (exit 0); extra env-only
    frontend flags allowed (exit 0); smoke test against the real
    `frontend/src/lib/featureFlags.ts` (exit 0)
  - Fail: backend flag missing from catalog (exit 1, names the missing flag);
    unparseable `FLAG_CATALOG` (exit 1); missing catalog file (exit 1)

---

## 4) testing: scripts/check-schema-parity.mjs coverage (Closes #331)

### Gap found
No matching test existed in `scripts/__tests__/` for this CI-invoked guard.

### Changes
- New `scripts/__tests__/check-schema-parity.test.mjs`:
  - Pass: read-only smoke test against the real
    `backend/src/schemas/domain/trade.ts` ≡ `frontend/src/lib/domain-schemas/trade.ts`
    pair (exit 0); patched copy with identical temp files (exit 0); identical
    bodies despite different leading doc comments (exit 0)
  - Fail: patched copy with diverged schema bodies (exit 1); missing `import { z }`
    anchor on one side (exit 1)

---

## Acceptance criteria

| Criterion | Status |
|---|---|
| Each task scoped to a single reviewable PR | ✅ One branch, one commit, one PR |
| Doc follows existing `docs/` formatting conventions | ✅ Catalog keeps its `### INV-XXX` structure, bold fields, and tables |
| Every catalog invariant has a CI-corresponding check; gap filed | ✅ CI coverage table added; INV-002/003/006/007 gap closed in-code |
| Each gate script has `__tests__/` coverage exercising pass/fail | ✅ 3 new test suites |
| Drips Wave complexity: 150 points per task | ✅ Addressed in this PR |

## Test results

```
$ pnpm test:scripts
Test Suites: 8 passed, 8 total
Tests:       66 passed, 66 total
```

(5 pre-existing suites untouched; 3 new suites: admin-test-coverage,
flag-catalog-drift, schema-parity.)

## Files changed

| File | Change |
|---|---|
| `.github/workflows/money-math-parity.yml` | `parity_money_math.rs` + catalog doc added to `paths` triggers |
| `contracts/amana_escrow/tests/parity_money_math.rs` | Explicit INV-002/003/006/007 assertions |
| `docs/money-math-invariant-catalog.md` | CI-enforced markers + CI coverage table + gap history |
| `scripts/__tests__/check-admin-test-coverage.test.mjs` | New — 6 end-to-end pass/fail cases |
| `scripts/__tests__/check-flag-catalog-drift.test.mjs` | New — 6 pass/fail cases |
| `scripts/__tests__/check-schema-parity.test.mjs` | New — 5 pass/fail cases |
| `PR_SUMMARY_ISSUE_328_329_330_331.md` | New — this summary |

## Merge note

The branch is pushed to `Teetotola/EliteWork` at
`fix/ci-script-test-coverage-and-money-math-parity` and is ready to be opened
as a PR against `Elite-Work/EliteWork:main`. The commit message and this
summary both carry `Closes #328`, `Closes #329`, `Closes #330`, and
`Closes #331`.
