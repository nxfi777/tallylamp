# Extension orchestration performance

`node --max-old-space-size=128 scripts/benchmark-extension.mjs before` / `after` runs the shipped background worker in a VM with simulated Chrome APIs. All Chrome API operations used for attachment checks and detach completion have an explicit 5 ms simulated round trip. This isolates ordering and redundant calls. These numbers are **not observed Chrome or network latency**. Every workload runs 20 times; raw samples and operation counts are in `extension-before.json` and `extension-after.json`.

| Workload | Before p50 / p95 ms | After p50 / p95 ms | Observed work |
|---|---:|---:|---|
| Restore 16 existing attachments | 88.84 / 90.85 | 23.84 / 25.65 | The same 16 verifications, at most 4 in flight. |
| Stop sharing 16 tabs | 88.22 / 89.67 | 5.58 / 6.38 | All permissions removed before any detach completes; 16 detaches overlap. |
| 100 title changes with 16 shared tabs | 0.24 / 0.53 | 0.08 / 0.26 | 100 session writes, 300 badge calls and 100 state broadcasts become 0, 0 and 1. |
| Share then unshare one tab | 22.17 / 22.85 | 23.41 / 24.35 | No claimed speedup; required debugger checks remain. |
| Read current panel state | 0.01 / 0.01 | 0.01 / 0.01 | Already negligible in this fixture. |

Restoration publishes only verified attachments, retains their stored order and lets detach/navigation events revoke each verified tab while other checks remain in flight. No new attachment is made while restoring. Stop-all permissions are revoked synchronously, so an agent cannot use a tab while Chrome's detach response is pending. URL/title updates no longer persist unchanged sharing permissions or repaint unchanged toolbar badges. The public state broadcast is batched within one microtask, without a debounce delay.

Panel changes preserve its existing layout and content. Initial service-worker state and current-tab reads run together. Chrome already supplies the updated tab in metadata events, so those events no longer perform another tabs query. Rapid active-tab query results cannot overwrite a newer selection. The offline countdown updates one span instead of rebuilding the entire interface each second; its timer stops when hidden or expired and recomputes on visibility return.

Doherty drove immediate busy feedback and removing serial round trips. Postel's error recovery kept debugger refusal checks and service-worker restart verification intact. Existing components were reused; there are no new effects or image-quality changes. Browser rendering, real debugger attachment, actual extension-service latency and input-to-paint remain separate measurements. The root audit's rendered panel screenshots cover the pixels; this file reports VM evidence only.

Dedicated tests verify all-share revocation while detach promises are held, metadata coalescing without permission writes, reconnection/grace behavior, shared-tab guards and hidden countdown teardown. See the [main report](REPORT.md) for the final full-suite result and the separately measured real linked-browser workflows.
