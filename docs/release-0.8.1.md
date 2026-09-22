# Tallylamp 0.8.1

Tallylamp no longer caps how many browsers run at once. Before this release a
deployment stopped at four running browsers, the Railway template at two, and
each new OAuth connector at two.

## What changes

- **No fleet cap by default.** `TALLYLAMP_MAX_BROWSERS` unset or `0` means no
  limit on running Chromes. A positive number still caps the fleet, as before.
  `/api/v1/status` reports `maxBrowsers: null` when there is no cap, and the
  dashboard shows the running count on its own.
- **No per-agent cap by default.** New agents and new OAuth connectors start with
  a cap of `0`, meaning none. The consent page still lets you set one, and
  `TALLYLAMP_OAUTH_MAX_BROWSERS` still sets the connector default.
- **The Railway template no longer sets `TALLYLAMP_MAX_BROWSERS`.**

Chrome still needs memory: budget roughly 1–2 GB per active browser, plus the
server. Set `TALLYLAMP_MAX_BROWSERS` if your host needs a limit.

## Upgrading

No schema change. Existing agents and connectors keep the cap stored on them.
To remove one, reconnect the connector and enter `0` on the consent page, or send
`PATCH /api/v1/agents/:id` with `{"maxBrowsers": 0}`. A deployment that sets
`TALLYLAMP_MAX_BROWSERS` keeps that cap until you delete the variable.
