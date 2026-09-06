# Contributing to Tallylamp

- The runtime launches headed Chrome as child processes inside one container.
- MCP lives at `/mcp`. Lifecycle tools are `tallylamp_*`; everything else is
  chrome-devtools-mcp 1.8.0 forwarded against `--browser-url`.
- Metadata describes a browser. Provenance columns record the authenticated
  principal that created it.
- Human takeover is a lease in `control_leases`. Mutating MCP tools must fail
  with a retryable tool error while the lease is live.
- Lending between agents is `browser_grants` + `browser_requests`, gated on the
  `browser:lend` / `browser:borrow` scopes, which are NOT default. Requests return immediately. An owner can answer on its next tool call;
  eligible browsers can also be granted after an idle timeout because Tallylamp
  cannot wake an idle or crashed owner. A grant permits driving, never deletion.
- CDP and the viewer backend bind loopback. Do not publish 9222.
- A loopback tunnel is the only way a browser reaches a private address. It is
  one browser to one `host:port`, gated on the non-default `browser:tunnel`
  scope. The authority must be one the egress proxy would refuse. Public names
  are rejected because they would redirect traffic meant for a real site. The
  egress proxy is per browser, which is what makes that scoping enforceable.
  Lending a browser closes its tunnels: the binding is keyed on the browser, not
  on who is driving, so a borrower would otherwise inherit the owner's machine.
- `TALLYLAMP_FAKE_CHROME=1` is for tests. Do not ship it.
- Refresh `docs/research.md` if you bump Chrome, chrome-devtools-mcp, or the
  MCP SDK; run `npm test` and the realism job.

## Clean up after a local run

Local runs can spawn a dev server, Chrome processes, Xvfb, and MCP bridge
children. **Stop what you start before finishing the task.** Record the PIDs,
container IDs, and temporary profile paths you create. Stop those specific
processes and containers, then remove only their temporary profiles. Keep
persistent browser data unless the task explicitly calls for deleting it.

Then sweep for orphans, because killing a parent orphans a second cohort that the
first sweep could not have seen. Re-check after each kill:

```sh
ps -eo pid,ppid,rss,command | awk '$2==1 && /[Cc]hrome|tsx|Xvfb/'
```

- Prefer `TALLYLAMP_FAKE_CHROME=1` over a real browser for anything a fake can
  answer. It is in-process and costs nothing.
- Check headroom before a fan-out or a sweep. On macOS use `sysctl vm.swapusage`
  and `vm_stat`; on Linux use `free -h`. Size the work to available memory.
- Do not kill a Chrome whose parent is alive and belongs to someone else's
  session without saying so. An MCP server can restart its disposable browser
  on demand. If you stop that browser to reclaim memory, report that you did it.
