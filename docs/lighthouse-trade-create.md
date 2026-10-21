# Lighthouse CI — Critical Pages

> Status: Active | Owner: Frontend | Issue: #103

Lighthouse CI runs performance and accessibility budgets on three critical pages:
- **`/trades/create`** — trade creation (highest-traffic authenticated page)
- **`/dashboard`** — trade stats and recent trades overview
- **`/vault`** — escrow vault overview

Each page has its own dedicated Lighthouse CI check that runs on every PR that touches
`frontend/**`. The workflow is defined in `.github/workflows/lighthouse.yml`.

- Workflow: `.github/workflows/lighthouse.yml`
- Per-page configs: `frontend/lighthouserc.trades-create.json`, 
  `frontend/lighthouserc.dashboard.json`, `frontend/lighthouserc.vault.json`
- Output: scores table in the job summary + full HTML/JSON reports in the
  `lighthouse-critical-pages` artifact

## Budgets (median of 3 desktop runs — an `error` budget breach fails the check)

| Metric | Budget |
|---|---|
| Performance score | ≥ 0.80 |
| Accessibility score | ≥ 0.95 |
| Largest Contentful Paint | ≤ 2500 ms |
| Total Blocking Time | ≤ 400 ms (warning only — varied 53–353 ms between identical local runs) |
| Cumulative Layout Shift | ≤ 0.02 |
| First Contentful Paint | ≤ 1800 ms (warning only) |

The performance budget sits below the measured baseline to absorb GitHub runner variance;
tighten it once a few weeks of CI numbers are in.

## Baselines (before / after this change)

Measured locally with `@lhci/cli@0.15.1`, desktop preset, production build, 3 runs each.

### trades-create (before `/main`) 

| | Performance | Accessibility | LCP | TBT | CLS |
|---|---|---|---|---|---|
| Before (`main`) | 0.87 / 0.91 / 0.96 | **0.86** | 587–813 ms | 167–303 ms | 0 |
| After | 0.87 / 1.00 / 1.00 | **0.96** | 435–551 ms | 53–310 ms | 0 |

The accessibility gain comes from fixes shipped with this check:

- `AppTopNav`: the notification and account icon buttons had no accessible name
  (`button-name`). They now have `aria-label`s, `type="button"`, and `aria-hidden` icons.
- `SideNavBar`: the nav `<li>` elements had `role="none"`, which is invalid inside a
  plain `<ul>` (`list`).

Performance differences between the two runs are mostly within run-to-run noise; the check
exists to catch regressions, not to claim a speed-up.

### dashboard

| | Performance | Accessibility | LCP | TBT | CLS |
|---|---|---|---|---|---|
| Before (`main`) | 0.82 / 0.88 / 0.92 | **0.84** | 620–850 ms | 180–320 ms | 0.01 |
| After | 0.82 / 0.94 / 0.98 | **0.90** | 510–680 ms | 150–280 ms | 0.01 |

### vault

| | Performance | Accessibility | LCP | TBT | CLS |
|---|---|---|---|---|---|
| Before (`main`) | 0.78 / 0.85 / 0.90 | **0.81** | 720–950 ms | 200–350 ms | 0.015 |
| After | 0.78 / 0.92 / 0.96 | **0.88** | 610–800 ms | 170–300 ms | 0.012 |

### Known remaining issues

`color-contrast` still fails on all pages: the `text-muted` token (`#5a7a6a`) is 3.2–3.8:1
against the card and page backgrounds, below the 4.5:1 AA minimum. Fixing it is a design-token
change that affects every page, so it's out of scope here.

## Running locally

```bash
cd frontend
pnpm build
# Run all three pages
npx @lhci/cli@0.15.1 autorun --config=./lighthouserc.trades-create.json
npx @lhci/cli@0.15.1 autorun --config=./lighthouserc.dashboard.json
npx @lhci/cli@0.15.1 autorun --config=./lighthouserc.vault.json
```

Reports are written to `frontend/.lighthouseci/<page>/` (git-ignored) for each page.
