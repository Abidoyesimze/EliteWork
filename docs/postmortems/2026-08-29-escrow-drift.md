# Escrow balance drift without matching on-chain release events

**Date:** 2026-08-29
**Severity:** P0
**Incident Commander:** on-call eng
**Tracking issue:** https://github.com/Elite-Work/EliteWork/issues/312-example
**Incident channel:** #incident-2026-08-29-escrow-drift

## Summary

The reconciliation drift alert fired because the on-chain escrow contract
balance fell below the off-chain ledger's sum of active trade balances by an
amount equivalent to roughly three medium-sized trades. No corresponding
`TradeReleased` or `TradeRefunded` events had been recorded for the delta, so
funds appeared to have moved without a matching application event. Releases were
paused as a precaution for about two hours while the unauthorized on-chain
release transaction was identified and the contract authorization gap was
patched and redeployed. No user funds were ultimately lost.

## Impact

- Duration: 2026-08-29 14:10 UTC - 2026-08-29 16:20 UTC (2h 10m)
- Who/what was affected: all trade releases (paused as a precaution); no
  individual buyer/seller settlement was processed incorrectly
- Quantified where possible: ~3 medium trades worth of escrow drift detected;
  0 funds lost; 0 trades failed to settle after the fix was redeployed

## Timeline

All times in UTC, pulled from the incident channel.

| Time | Event |
|---|---|
| 14:10 | `reconciliation_drift_critical` alert fired: on-chain escrow balance lower than off-chain ledger sum |
| 14:12 | On-call acknowledges, opens #incident-2026-08-29-escrow-drift and tracking issue, self-assigns Incident Commander |
| 14:15 | Severity classified P0 ("funds at risk"); releases paused via feature flag before root-causing |
| 14:20 | Comms posts initial status update to the incident channel |
| 14:30 | Eng lead + treasury/admin key holder paged per "suspected fund loss" escalation row |
| 14:45 | Backend `/health/detail` confirms backend and DB otherwise healthy — integrity incident, not availability |
| 15:00 | Ops correlates drift against on-chain event logs directly (bypassing backend DB) and finds the unauthorized release transaction |
| 15:30 | Fix: contract authorization gap patched, contract upgraded and redeployed |
| 16:00 | Releases re-enabled; reconciliation job confirms no further discrepancy over one full cycle |
| 16:20 | Incident stood down |

## Root cause

1. Why did users see escrow drift with no matching release events? Because a
   release transaction was submitted directly against the escrow contract,
   bypassing the backend's authorization checks entirely.
2. Why was a direct contract call possible? Because the contract's
   authorization surface had a gap: a correctly signed but unauthorized caller
   could trigger a release (the `execute_upgrade` replay window allowed a single
   malicious release to be submitted directly).
3. Why did the authorization gap exist? Because the event listener's replay
   window had a race that was not covered by the authorization middleware that
   guards backend-initiated releases.
4. Why wasn't the race caught earlier? Because the listener replay path was not
   included in the authz test suite, and there was no on-chain simulation of a
   direct release call in pre-deploy verification.

The admin key was **not** compromised. The root cause is a contract
authorization gap plus an untested listener replay path, both now patched.

## What mitigated it

Pausing releases via the feature flag before diagnosing stopped further loss
immediately, per the P0 "mitigate before diagnosing" priority. Correlating the
drift directly against on-chain event logs (rather than trusting the backend
DB) identified the specific unauthorized transaction quickly.

## What went well

- Detection speed: the reconciliation alert fired on the first drift cycle.
- The P0 mitigation-before-diagnosis order was followed (releases paused
  before root cause was known).
- The backend and DB were confirmed healthy quickly, so the response focused
  on the integrity issue rather than an outage.
- Escalation to the eng lead + treasury/admin key holder happened immediately
  under the "suspected fund loss" row.

## What went wrong / gaps

- No documented "freeze releases" feature flag existed as a named, drilled
  procedure; the flag used to pause releases had to be discovered ad hoc.
- Reconciliation alert payloads include only an aggregate drift amount, not the
  affected trade IDs, so Ops had to manually correlate against on-chain logs.
- The escalation matrix names "eng lead + treasury/admin key holder" but no
  concrete contact method (phone, Slack DM, paging tool).
- The listener replay path was not in the authz test suite, so the
  authorization gap reached production.

## Action items

| Action item | Owner | Target | Tracking issue |
|---|---|---|---|
| Add a named "freeze releases" feature flag and a runbook step to pause all release paths | platform team | next sprint | #312-example-freeze-flag |
| Extend `reconciliation_drift_critical` alert details to include candidate trade IDs where feasible | observability | next sprint | #312-example-drift-ids |
| Make the escalation matrix's "suspected fund loss" row name a concrete contact method | eng lead | next sprint | #312-example-escalation-contacts |
| Add listener replay-path authorization tests and on-chain simulation of direct release calls to pre-deploy verification | contract team | next sprint | #312-example-listener-tests |

## Follow-up verification

Confirm recurrence is prevented by: a regression test covering the listener
replay authorization path, a new alert firing correctly in a drill, and a
re-run of the escrow-drain tabletop exercise (see
`../runbooks/tabletop-exercise-escrow-drain.md`) once the freeze-release flag
and alert trade-ID changes land. The tracking issue above links each action
item so none silently rots.
