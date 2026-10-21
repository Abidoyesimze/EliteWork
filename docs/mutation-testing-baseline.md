# Mutation Testing Baseline — Money Math Pilot

> StrykerJS pilot on `backend/src/lib/feeComputation.ts` and
> `backend/src/lib/lossAllocation.ts`.
>
> See `.github/workflows/mutation-testing.yml` for the scheduled run.
> See `backend/stryker.money-math.config.json` for Stryker configuration.

---

## 1. Why mutation testing?

Line coverage says nothing about assertion strength. A test that calls
`computeReleaseFee(10_000n, 100)` and asserts only that it does not throw will
pass with 100% line coverage while missing dozens of arithmetic mutants (e.g.
`*` → `/`, `−` → `+`). Mutation testing inserts those changes and verifies
that your tests actually kill them.

**Pilot scope**: fee calculation and loss-ratio allocation — the two modules
where a surviving mutant would directly corrupt money arithmetic.

---

## 2. Pilot modules

| File | What it does |
|------|-------------|
| `backend/src/lib/feeComputation.ts` | Platform fee computation for all trade outcomes (release, refund, split, full\_seller, full\_buyer). BigInt BPS arithmetic mirroring on-chain Rust contract. |
| `backend/src/lib/lossAllocation.ts` | Largest-remainder BPS split ensuring zero-dust (sum == total) invariant. |

---

## 3. Target score

| Threshold | Score | Effect |
|-----------|-------|--------|
| **Target (green)** | ≥ 80% | `high` threshold in the Stryker config — the pilot is on target. |
| **Fail (red)** | < 80% | `break` threshold in the Stryker config — the `mutation-money-math` job fails. |

`"break": 80` is set in `backend/stryker.money-math.config.json` since the
pilot reached the target on both modules (see §5), so a weekly run below 80%
fails the `mutation-money-math` job instead of only warning. The job summary
re-derives the same score from the JSON report and fails below 80% as well
(`scripts/mutation-score.mjs --threshold 80`). The `low` threshold (70%) stays
as the absolute floor Stryker reports on.

---

## 4. Running locally

```bash
cd backend
pnpm install          # installs @stryker-mutator/core etc.
pnpm mutation         # runs StrykerJS, opens HTML report on completion
```

The HTML report is written to `backend/reports/mutation/money-math/index.html`,
the machine-readable report to
`backend/reports/mutation/money-math/mutation-report.json`.

The score can also be printed from the JSON report alone:

```bash
node scripts/mutation-score.mjs \
  --report backend/reports/mutation/money-math/mutation-report.json \
  --threshold 80
```

> The StrykerJS JSON reporter (schema 1.0) stores the per-mutant results and
> **no** score field, so the score has to be derived from them
> (`killed + timeout) / (killed + timeout + survived + noCoverage)`).
> `scripts/mutation-score.mjs` implements exactly that formula and is what the
> workflow reports in the job summary.

---

## 5. Baseline (pilot run)

> This section records the last measured run. Update after each triage cycle.

Measured with StrykerJS 8.7.1 / Jest 30.3.0, `pnpm mutation:ci`, 139 mutants
in 2 files, 93 tests in the dry run.

| Module | Killed | Survived | Score |
|--------|--------|----------|-------|
| `feeComputation.ts` | 53 | 0 | **100.00%** |
| `lossAllocation.ts` | 78 | 8 | **90.70%** |
| **Combined** | **131** | **8** | **94.24%** |

The combined score is **94.24%**, above the 80% target and above the 70% floor
enforced by the workflow. Both pilot modules are above the target, which is the
condition for expanding the scope (§8).

*Re-measure with `pnpm mutation:ci` after every triage cycle and update this
table — a drop below 80% fails the scheduled `mutation-money-math` job.*

---

## 6. Surviving mutant triage ritual

Run weekly (see GitHub Actions job `mutation-money-math`, scheduled Mondays at 03:00 UTC).

After each run:

1. Download the `mutation-report-money-math-<run>` artifact from the Actions run.
2. Open `index.html` in a browser.
3. For each surviving mutant, decide:

| Decision | Action |
|----------|--------|
| **Kill it** | Write a new test that specifically detects the change. See `*.mutation.test.ts` files for examples. |
| **Waive it** | Add a `// Stryker disable <MutatorName>` comment at the line with a one-line justification. |
| **Exclude it** | Add the mutation class to `excludedMutations` in `stryker.money-math.config.json` with a PR comment. |

### Open triage items (8 surviving mutants)

All eight survivors are in `backend/src/lib/lossAllocation.ts`:

| Line | Mutator | Change | Why it survives |
|------|---------|--------|-----------------|
| 97 | `ConditionalExpression` | `a.remainder > b.remainder` → negated | The sort comparator's tie-break order is not asserted — only the final allocation is. |
| 97 | `ConditionalExpression` | `a.remainder < b.remainder` → negated | Same as above. |
| 97 | `EqualityOperator` | `a.remainder >= b.remainder` | Equal remainders are never constructed in the tests, so the tie-break path is untested. |
| 97 | `EqualityOperator` | `a.remainder <= b.remainder` | Same as above. |
| 101 | `ConditionalExpression` | `a.remainder < b.remainder` → `true` | Same comparator, second branch. |
| 101 | `EqualityOperator` | `i <= n` → `i < n` | The loop bound is not observable with the current fixtures. |
| 101 | `UpdateOperator` | `i++` → `i--` | Same — the loop terminates on the first iteration for the tested inputs. |
| 133 | `ArithmeticOperator` | `buyerLossBps + sellerLossBps` → `-` | `splitLossRatio` is never called with a **valid** ratio in the money-math suite, so the sum check is never exercised. |

**Next step**: add a mutation test that calls `splitLossRatio` with a valid
70/30 ratio (and one with an invalid ratio), plus a test that constructs two
parties with an identical remainder to pin the tie-break order. That should kill
the comparator, loop-bound and sum-check mutants and lift `lossAllocation.ts`
to 100%.

---

## 7. Known justified waivers

| Location | Mutant | Reason |
|----------|--------|--------|
| — | none | No mutant is waived at the moment. |

The previous revision of this document claimed that `StringLiteral` mutants were
excluded globally through `excludedMutations` in
`stryker.money-math.config.json`. That setting is **not** present in the
config — the 26 `StringLiteral` mutants in the pilot scope are generated and
killed by the existing tests, and no mutant is currently waived.

---

## 8. Expanding scope

Once the pilot reaches ≥ 80% on both modules for two consecutive weekly runs:

1. Add the next module to `mutate` in `stryker.money-math.config.json`.
2. Document the new module in Section 2 above.
3. Run locally first to establish a local baseline before merging.

The pilot is currently at 100% (`feeComputation.ts`) and 90.70%
(`lossAllocation.ts`); it still needs a second consecutive weekly run at that
level before the scope is widened.

Suggested next modules (in priority order):
- `backend/src/lib/vestingSchedule.ts` (if present)
- Any frontend fee-display utilities that derive values from the backend breakdown

---

## 9. CI artefact retention

Mutation reports are retained for **30 days** (see `retention-days: 30` in the
workflow). Download the JSON artefact before expiry if you need historical
comparisons.
