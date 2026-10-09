# MCP discovery and native-popup diagnostics

The reusable audit is [scripts/mcp-popup-audit.mjs](../../../scripts/mcp-popup-audit.mjs).
It can inspect tool discovery, create a disposable counter page, compare page
snapshot and UID actions across binding/session changes, and capture the browser's
native desktop when the diagnostic principal already has that permission.

## Running the audit

```sh
TALLYLAMP_URL=https://YOUR_HOST node scripts/mcp-popup-audit.mjs /tmp/tallylamp-popup-audit --fixture --native
```

`TALLYLAMP_TOKEN` must already be set. Keep credentials out of command arguments.
Omit `--fixture` for discovery only. The script acts on its newly created fixture,
uses per-call timeouts, checkpoints results, and deletes the fixture in `finally`.
It records failed cleanup so the operator can reconcile it before another run.

## Interpreting the results

- Compare the server's tool schemas before binding, after binding, after a
  repeated binding, and after reconnecting. Compare those results with the
  client's current tool catalog when diagnosing missing desktop tools.
- A direct SDK test and a hosted connector can use different principals and
  permission grants. Record which path each result exercises.
- Page IDs can change when the browser's page list changes. Get a fresh page list
  and snapshot after reconnecting before sending a UID action.
- Native desktop images may be scaled. Convert image coordinates using the
  reported native display size before submitting a desktop action.
- Native popups depend on focus. A normal extension tab does not establish that
  a toolbar notification can be opened or acted on.

The historical investigation found a client catalog missing tools advertised by
the server, and snapshot state lost during some binding/session sequences.
After restarting the client, the direct tool catalog and disposable native/page
counter checks succeeded. These observations describe the investigated sessions;
they do not establish the current behavior of every connector or deployment.

The original deployment, wallet, client-configuration and screenshot evidence is
retained locally outside the public repository. This public note contains the
reusable diagnostic procedure without those identifiers or session details.
