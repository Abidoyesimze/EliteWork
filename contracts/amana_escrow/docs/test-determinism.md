# Contract Test Determinism & Snapshot Hygiene

This document defines the conventions that keep the `amana_escrow` contract
test suite deterministic across local runs and CI, and the procedures for
maintaining `test_snapshots/`.

---

## 1. Why determinism matters

Non-deterministic tests erode trust in CI. When a test fails only on certain
machines or at certain times of day, reviewers cannot distinguish a real
regression from environmental noise. Every contract test must produce the
**same outcome regardless of host, time, or parallel execution order.**

---

## 2. Common sources of non-determinism

| Source | Symptom | Fix |
|--------|---------|-----|
| **Wall-clock time** (`std::time::Instant`, `chrono::Utc::now()`) | Tests that pass at midnight but fail at noon; ledger-timestamp-dependent assertions break across time zones. | Inject a deterministic clock via the test fixture; never call system time inside a test. |
| **`HashMap` / `HashSet` iteration order** | Assertion output varies between runs because iteration is unordered. | Sort before asserting, or use `BTreeMap`/`BTreeSet` in the contract under test. |
| **Unseeded randomness** | Different values each run; snapshot diff noise. | Seed all RNGs explicitly (e.g., `rand::rngs::StdRng::seed_from_u64(42)`) and document the seed. |
| **Non-deterministic collection ordering in events** | Event lists appear in different order in `env.events().all()`. | Filter/sort events by a stable key (e.g., event type + trade_id) before asserting. |
| **Parallel test interference** | Shared global state mutated by concurrent tests. | Each test must create its own `Env` via `AdminSignerFixture::new()`; never share a global `Env`. |
| **Ledger sequence assumptions** | Tests assume `ledger_seq()` starts at 1 or advances by a fixed amount. | Assert relative ledger deltas (`env.ledger().get().seq + 1`) rather than absolute values. |
| **Environment variables** | CI sets env vars not present locally. | Never read `std::env::var` in contract code; pass configuration through function arguments or storage. |

---

## 3. Injecting a deterministic clock

The test fixture (`src/test_fixture.rs`) provides the canonical test
environment. All time-sensitive assertions must use the Soroban test
environment's controlled ledger time:

```rust,ignore
use soroban_sdk::testutils::Address as _;

let f = AdminSignerFixture::new();

// Advance the ledger clock to a known point — NOT wall-clock time
f.env.ledger().with_mut(|ledger| {
    ledger.timestamp = 1_700_000_000; // fixed Unix timestamp
    ledger.sequence_number = 1000;     // fixed ledger sequence
});

// Now all time-dependent contract logic sees the injected timestamp
let tid = f.funded_trade(1_000);
```

### Rules

1. **Never** use `std::time::SystemTime`, `chrono`, or any system clock
   inside contract code or tests.
2. **Never** use `env.ledger().with_mut` to advance time to a value derived
   from the current system time.
3. Every test that asserts on timestamps must set an explicit, documented
   timestamp before the assertion.
4. If a helper advances time, the helper must accept the target timestamp as
   a parameter — never hardcode "now + 1 day."

---

## 4. Ordering and collection assertions

### Event assertions

Events are collected via `env.events().all()` which may not preserve
insertion order across environments. Always sort before asserting:

```rust,ignore
let mut events: Vec<_> = f.env.events().all();
events.sort_by(|a, b| a.0 .0.cmp(&b.0 .0)); // sort by contract address

assert_eq!(events.len(), 2);
// Assert against the sorted slice
```

### Storage iteration

Do not assert against the order returned by Soroban persistent storage
iteration unless the contract explicitly stores data in a sorted structure.
If you need to assert a set of stored values, collect into a `BTreeSet` or
sort a `Vec` before comparison.

---

## 5. Snapshot hygiene

### What goes in `test_snapshots/`

| File type | Purpose |
|-----------|---------|
| `*.expected.json` | Expected serialization output of a contract state or event. |
| `*.expected.wasm` | Golden WASM binary for deployment safety checks. |
| `gas_baseline_*.json` | CPU/memory baselines from `gas_footprint_tests.rs`. |

### Snapshot lifecycle

1. **Generation** — run `cargo test` with the `UPDATE_SNAPSHOTS=1`
   environment variable set (or the project's equivalent flag). The test
   harness writes new snapshot files.
2. **Commit** — commit generated snapshots in the same PR as the code that
   changed them. Never commit a snapshot update without the corresponding
   code change.
3. **Review** — reviewers should inspect the snapshot diff alongside the
   code diff to confirm the change is intentional.
4. **Cleanup** — run `scripts/cleanup-test-snapshots.sh` (see below) to
   remove orphaned snapshots that no longer correspond to any test.

### Regeneration command (idempotent)

```bash
# From the repository root — regenerates all snapshots and removes orphans
bash scripts/cleanup-test-snapshots.sh

# Or regenerate without cleanup (just re-runs tests to overwrite snapshots)
UPDATE_SNAPSHOTS=1 cargo test --locked
```

The regeneration is **idempotent**: running it twice produces the same
snapshot files with no diff.

---

## 6. Parallel-safe assertions

### `cargo test` thread safety

Each test function must be independently safe to run in parallel:

- Create a fresh `AdminSignerFixture::new()` at the start of each test
  (which creates a fresh `Env`).
- Never write to files, environment variables, or global statics.
- Never use `lazy_static` or `once_cell` to share mutable test state.
- Do not assume a specific test execution order — `cargo test` does not
  guarantee order within a module.

### CI nightly determinism check

The `scripts/verify-test-determinism.sh` script runs the full test suite
50 times and asserts zero inter-run variance:

```bash
bash scripts/verify-test-determinism.sh
```

If any run produces a different result, the script exits with code 1 and
lists the failing test. This script is the authoritative check for
determinism; local spot checks (`cargo test` once) are insufficient.

The script itself is covered by
[`scripts/__tests__/verify-test-determinism.test.mjs`](../../../scripts/__tests__/verify-test-determinism.test.mjs),
which executes it with a stubbed `cargo` and asserts the passing branch
(identical summaries across runs) as well as the failing branches (a run that
fails, summaries that vary between runs, a missing contract directory). The
suite runs in the `Scripts Unit Tests` CI job, so a bug in the checker cannot
silently disable the determinism gate.

---

## 7. Adding a new test — checklist

Before submitting a PR with a new test:

- [ ] The test creates its own `AdminSignerFixture::new()` — no shared state.
- [ ] Time-dependent assertions use injected ledger timestamps, not system
      time.
- [ ] Collection assertions sort or use ordered types (`BTreeMap`,
      `BTreeSet`, `Vec` with `.sort()`).
- [ ] No `std::env::var` calls for configuration.
- [ ] No hardcoded assumptions about `ledger_seq()` absolute values.
- [ ] If the test writes snapshots, run `UPDATE_SNAPSHOTS=1 cargo test`
      once and commit the generated files.
- [ ] Run `bash scripts/cleanup-test-snapshots.sh` to verify no orphaned
      snapshots exist.

---

## 8. Related documents

- [Gas Estimation](./gas-estimation.md) — baseline thresholds for contract
  hot paths.
- [Security Review Checklist](./security-review-checklist.md) — security
  invariants that tests must cover.
- [Flaky Tests Policy](../../docs/flaky-tests-policy.md) — quarantine and
  retry rules for any remaining non-determinism.
