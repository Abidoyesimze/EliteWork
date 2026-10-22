# Postmortem Archive

Published, blameless postmortems for P0/P1 incidents (and any P2/P3 the
reporter chose to write one for), one file per incident, named
`YYYY-MM-DD-short-slug.md` matching the incident's channel/ticket slug — see
[incident-response.md](../runbooks/incident-response.md#postmortem) for when
a postmortem is required and
[postmortem-template.md](../runbooks/postmortem-template.md) for the format
every entry here should follow.

## Index

| Date | Title | Severity | Postmortem |
|---|---|---|---|
| 2026-08-29 | Escrow balance drift without matching on-chain release events | P0 | [2026-08-29-escrow-drift.md](./2026-08-29-escrow-drift.md) |

Add a row here whenever a new postmortem is published, newest first.

## Read reminder

Postmortems only prevent recurrence if people actually read them. New
contributors: read every P0/P1 postmortem in this directory as part of
onboarding, before your first on-call rotation. Existing team: postmortems
published since the last review get a five-minute readout at the start of
the next team sync — this is a standing agenda item, not something that
needs to be re-scheduled each time.
