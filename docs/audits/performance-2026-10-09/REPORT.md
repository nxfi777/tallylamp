# Tallylamp performance audit — 9 October 2026

The audit found redundant network refreshes, repeated SQLite compilation, duplicate in-flight captures, unnecessary extension storage/UI work, hidden desktop capture, and an animation that kept running after a live reduced-motion change. These are corrected locally. No image resolution, codec quality, permission check, audit durability, or browser isolation was reduced.

This is a measured audit of the implemented surfaces, with explicit gaps. It is **not a claim that every possible action, production load level, operating system, or third-party website has been benchmarked**. Measurements were collected from local changes before committing. No deployment was performed during the audit. The service baseline was commit `84a7493` (v0.11.4); the website baseline was `cfee3bb`.

## Measured improvements

| Workload | Before | After | Evidence boundary |
|---|---:|---:|---|
| Live dashboard update after an idle period | 1,515 ms | 12–19 ms | Real HTTP + SSE; before one, after three observations |
| List 200 browsers, HTTP p50 / p95 | 19.25 / 67.04 ms | 6.90 / 9.75 ms | Real HTTP and SQLite; 20 warm samples; fixture Chrome |
| Save browser details | 323 ms, 15 requests | 221 ms, 8 requests | Real dashboard and HTTP; 4× CPU, 40 ms request latency; one observation per revision |
| Save / change / remove site record | 299–308 ms | 196–205 ms | Same browser test; each loses seven redundant requests |
| Lifecycle action with a slow worker, p50 | 924 ms | 488 ms | Shipped orchestration; simulated 400 ms worker; ten samples, rendering stubbed |
| Eight simultaneous thumbnails, 21 batches | 168 captures | 21 captures | Identical returned bytes and quality; only overlapping work shared |
| Restore 16 extension attachments, p50 | 88.84 ms | 23.84 ms | Shipped worker in VM, simulated 5 ms Chrome API delay |
| Stop sharing 16 tabs, p50 | 88.22 ms | 5.58 ms | Same VM; permissions revoked before asynchronous detach completes |
| 100 tab-title updates | 100 writes / 300 badge calls / 100 broadcasts | 0 / 0 / 1 | Same worker fixture; actual sharing permissions remain unchanged |
| API event-loop pause during a 16 MiB / 1,024-file clone | 205 ms | 3.4 ms | Median of five real filesystem samples; copy completion 204 → 308 ms |
| Event-loop pause during profile deletion | 45 ms | 3.8 ms | Same file fixture; median of five samples |
| Native desktop click → matching frame, p50 / p95 | 130.81 / 234.99 ms | 59.49 / 93.80 ms | Real Linux Chrome/Xvfb, 20 correlated clicks, varied frame phase |
| Native desktop connection → first frame | 404 ms | 126 ms | One observation per revision; same image quality |
| Hidden native desktop, 1.2 seconds | 7 frames / 251 KB / 4 CPU ticks | 0 / 0 / 0 | Animated page, real encoder; visible resource use increases (below) |
| Live reduced-motion toggle | 152 film DOM mutations in one second | 0 | Real production website build, playback paused |

Final verification completed the initial 59 API workflows and 13 additional runtime/transfer workflows: the 200-browser HTTP list measured 5.58 / 6.29 ms p50/p95. `api-after-final.json`, `api-extra-after-final.json` and `api-runtime-after-final.json` preserve those fresh samples separately from the original matched comparison.

The improvement claims use matched workloads. Millisecond-scale variation on unrelated actions is not described as a win. The extension VM results establish less work and fewer serialized round trips; they do not represent observed Chrome/network latency.

## What changed

- Dashboard SSE updates now refresh immediately after idle, retain the 1.5-second rate ceiling during event bursts, and defer background refreshes until the page is visible. An open action menu is preserved.
- Dashboard mutation handlers now refresh once through `render()`. Parallel dataset completions share a card repaint within one animation frame. A stale scheduled repaint cannot overwrite a newer route; busy feedback stays active until the action's render finishes.
- A bounded, per-database statement cache reuses compiled SQLite queries, never result data. Browser serialization avoids reading the same row again, and agent counts use one grouped query.
- Simultaneous thumbnail captures and page-info refreshes share only their pending operation. Later requests get fresh data, and a replacement runtime cannot inherit the previous runtime's result.
- Profile cloning and deletion now use asynchronous filesystem operations. Pending clones reserve agent capacity and names; the source snapshot is protected from modification or deletion until publication. Export/shutdown and cleanup preserve lifecycle boundaries. This reduces pauses for unrelated requests; the measured clone itself takes longer (204 → 308 ms median), with unchanged files and profile fidelity.
- CDP discovery has an actual deadline covering both connection and response-body reads. Previously one hung fetch could defeat the surrounding ten-second retry deadline.
- Extension restoration verifies up to four attachments at once, preserving order and security checks. Stop-all removes permissions immediately and overlaps detach calls. Metadata changes skip unchanged storage and badge updates; broadcasts coalesce within one microtask.
- The extension panel queries independent startup data together, rejects stale tab-query results, and updates only the offline countdown text. Its countdown timer stops while hidden.
- Native desktop capture stops while hidden and restarts with fresh frame state. Control streams run at 15 fps; watch streams retain 6 fps. Raw X11 probing is bounded, and stale-modifier cleanup skips xdotool's artificial waits while keeping the same ordered key releases. JPEG quality, dimensions, backpressure and input authorization remain unchanged.
- The website cancels its film loop immediately when reduced motion is enabled and paints the current chapter's settled frame.

## Coverage and evidence

| Surface | Measured coverage | Where to inspect |
|---|---|---|
| HTTP/API | 46 before/after workflows plus 26 supplemental workflows, 20 repeated samples each; 88 of 89 registrations locally, plus the native X11 route exercised successfully on Linux | [Backend inventory](backend-inventory.md), route map and raw JSON alongside it |
| Dashboard | 17 actual DOM/HTTP actions at normal and 4× CPU; repeated normal/slow-worker orchestration; 375/768/1440 px screenshots | [Every measured UI action](ui-website-timings.md), `evidence/ui-before`, `evidence/ui-after` |
| Website | Homepage: three cold and three warm loads at each of three widths and two CPU/network settings; 20 additional routes; 24 button/disclosure actions | [Website tables](ui-website-timings.md), `evidence/website-before`, `evidence/website-after` |
| Extension | Repeated worker orchestration; 13 rendered states at all three widths; real Chrome extension/MCP end-to-end run | [Extension measurements](extension-performance.md), `evidence/linked-real.log` and `linked-real/action-timings.json` |
| Native Linux desktop | Real Chrome, Xvfb, isolated main/worker, 20 correlated clicks, paste/key input, first frame, visibility and native route timing | `evidence/linux-*.json` |
| Production | Read-only 24-hour Railway resource and HTTP metrics, five-minute resource samples and hourly latency buckets | `evidence/production-24h.json`, `production-routes-24h.json` |

These counts describe workflows and route registrations, not 89 independent latency distributions. All 89 statically enumerated registrations now have a successful measured path, including the native worker X11 route on Linux. The 72 local workflows contribute 1,440 repeated samples plus first observations; the additional Linux fixture uses real Chrome and Xvfb. WebSocket messages and array-defined discovery/static routes are outside that route denominator. Existing functional tests cover more behaviors than this timing harness.

## Real linked Chrome and MCP

The extension was loaded into two fresh, sequential real Chrome instances against the local service. All 38 functional assertions passed, including pairing, reconnecting three shared tabs, agent snapshots and input, revocation, blocked dashboard/foreign-site navigation, late cross-site frames, and isolation of another extension's content. Actual timed observations were:

| Action | Observed round trip |
|---|---:|
| First bind to a linked browser | 417 / 444 ms |
| List pages | 5–15 ms |
| Accessibility snapshot | 8–12 ms |
| Screenshot | 18 ms |
| Click | 260 ms |
| Allowed navigation | 129 ms |
| New page | 141 ms |
| Stop sharing all tabs | 2.7 ms |

These are after-change, one/few observations, not p95 estimates or before/after speedups. MCP click/evaluation includes the tool's settling behavior. Real extension `getState` was usually under 7 ms but had 178–259 ms outliers while Chrome was busy; no tail-latency guarantee is inferred. API calls returning an intentional permission-refusal message remain in the raw trace and are validated by the separate E2E assertions.

## Real managed Chrome and viewer

A real managed Chrome rendered a deterministic fixture with an encoded visual action ID. For each of 20 viewer clicks, the benchmark decoded the actual streamed image and required the corresponding ID; it did not mistake an unrelated next frame for a response.

| Action | p50 / p95 or single observation |
|---|---:|
| Real thumbnail HTTP request, 20 samples | 20.86 / 21.54 ms |
| Viewer input → matching frame receipt, 20 samples | 59.95 / 61.66 ms |
| Viewer connection → first frame receipt | 13.97 ms, one observation |

The frame timing ends at receipt, before final client decoding and screen presentation. Existing JPEG quality, encoded width, and refinement behavior are unchanged. Local transport and a simple deterministic page do not represent complex websites or remote-worker latency.

Initial attempts to navigate the managed browser through its egress path timed out at 8 and 20 seconds on this Mac. A network-free injected document succeeded and supplied the viewer results above; it intentionally bypasses that unresolved navigation path. The API's “running” response took 331–598 ms in three attempts, but that is not renderer-ready time. Managed Chrome shutdown also reached roughly 10 seconds in this environment. These are recorded failures and follow-up items, not successful end-to-end startup measurements. The linked-browser navigation test succeeded separately.

Raw managed attempts, the successful injected fixture, and profile operation samples are in `managed-*.json` and `profile-clone-*.json` alongside this report.

## Native Linux desktop: measured, tuned and rechecked

The Mac navigation failures above did not reproduce in the deployment's Linux runtime. A disposable main service, worker, database, Chrome and Xvfb ran on loopback inside the Linux container, using fresh temporary profiles. Final navigation reached the deterministic fixture in 34 ms and graceful shutdown took 160 ms. The installed production modules supplied the baseline; only reviewed compiled capture modules were overlaid into a temporary copy for the final run. No deployed module or production browser was modified.

`evidence/linux-phase-before.json` and `linux-final.json` are the matched baseline/final comparison. Clicks follow a fixed 0/13/47/83/29 ms inter-action delay sequence to vary their position within the capture cadence. Every click, paste and key sample requires its action ID to appear in the actual streamed JPEG, including the Chrome toolbar offset.

| Linux action | Before p50 / p95 | Final p50 / p95 | Samples per revision |
|---|---:|---:|---:|
| Click → matching desktop frame | 130.81 / 234.99 ms | 59.49 / 93.80 ms | 20 |
| Paste → matching desktop frame | 146.12 / 147.64 ms | 42.99 / 108.27 ms | 5 |
| Key → matching desktop frame | 143.00 / 146.08 ms | 43.55 / 48.72 ms | 5 |
| Connection → first control frame | 403.88 ms | 126.46 ms | 1 |
| Worker X11 mousemove through process exit | 4.01 / 5.80 ms | 4.00 / 5.88 ms | 20 |

The subprocess path itself is fast. Four stale-modifier releases were the avoidable delay: default xdotool timing took 55.19 / 57.65 ms, versus 4.34 / 5.58 ms with explicit zero delay. Only these cleanup releases changed. Actual operator keydown/up and held-input cleanup retain their behavior. The [official xdotool source](https://github.com/jordansissel/xdotool/blob/v3.20160805.1/cmd_key.c#L16) defines the per-command delay; its [X event implementation](https://github.com/jordansissel/xdotool/blob/v3.20160805.1/xdo.c#L1415-L1439) preserves synchronization and ordering when that wait is zero.

Probe32 reduced capture startup without changing encoding. Its fixed value is narrowly allowed by the worker validator. The [FFmpeg format documentation](https://www.ffmpeg.org/ffmpeg-all.html#Format-Options) describes input probing and output flushing. A separate flush-packets experiment did not establish a distinct startup improvement, so that flag was not adopted. Intermediate lifecycle/probe/cadence experiments remain in `linux-*-experiment.json` and related files rather than being presented as additional matched wins.

**Resource and resume tradeoffs:** during 1.2 seconds of animation, the final control stream sent 15 frames / 537 KB and used 11 encoder CPU ticks, versus 7 frames / 251 KB / 4 ticks at baseline. At the container's 100 ticks per second, that short window is roughly 9.2% versus 3.3% of one CPU core for ffmpeg alone. This is a simple 1280×800 fixture, not a complex-page bandwidth or fleet-capacity estimate. The unchanged socket buffer limit continues to bound outgoing queued frames.

Hidden capture fell from 7 frames / 251 KB / 4 ticks to zero. Restarting capture adds a freshness delay after returning: control resume was 122 ms versus the baseline's continuously running 67 ms. Final watch resume was 228 / 233 ms across three cycles, with zero frames in every hidden interval; watch first-frame time was 223 ms. No hidden encoder is retained just to hide that cost. A previous equivalent control experiment measured 84 / 136 ms click p50/p95; short samples on a shared host vary, so the final numbers are not a latency guarantee.

Native JPEGs were visually inspected. The saved baseline and changed images have matching 1280×800 dimensions, quantization tables, precision and component sampling; see `native-jpeg-quality-check.json`. Existing spatial sharpness and compression are retained while control cadence increases. Main and worker must receive the matching release together because the worker must recognize the new fixed probe flag.

## Website and UX findings

After the change, cold homepage LCP medians are 392 / 384 / 380 ms at 375 / 768 / 1440 px under 4× CPU, with 40 ms latency, 10 Mbit/s download and 5 Mbit/s upload. The maximum measured CLS is 0.0342. This is a local production build; navigation TTFB remains local. A calibration fetch took about 51 ms. The initial baseline used an older throttling command, so page-load improvement is not claimed from that comparison. The current page already paints promptly; its visual quality was retained.

Visible animations delivered about 61 rAF callbacks per second in the bounded test. Offscreen animation already stopped correctly. Four scroll/GC sweeps ended at 4.965, 4.979, 4.989 and 4.999 MB JS heap, with no material growth during that short check. This is not a long-running leak guarantee.

The existing design system was retained. Website, dashboard and extension screenshots were reviewed at 375, 768 and 1440 px, with no horizontal overflow. Reconnecting, offline, blocked sharing, pairing and error states remain legible. A live API-error fixture retained the previous agent list, showed an explicit error with Retry, then recovered on retry.

The requested UX skills informed concrete decisions: **Doherty** for prompt feedback and fewer serial round trips; **Jakob** for preserving the existing controls and layout; **Postel** for keeping explicit recovery and permission-refusal behavior. The motion review checked reverse scrolling, offscreen teardown and live reduced motion. This was a performance pass on established screens, not a redesign or a complete accessibility audit.

## Production interpretation

The worst non-empty hourly p95 bucket in the sampled day was 40 ms for browser listing, 38 ms for status, 6 ms for the dashboard document and 33 ms for the marketing service. MCP's worst hourly p95 was about 18.7 seconds, with a 30-second p99 bucket. MCP includes navigation, waits, tracing and other long operations, so that figure cannot be treated as simple API overhead or attributed to a specific tool without per-tool data.

Main-service resource samples peaked at 3.94 CPU cores and 11.82 GB memory; worker peaks were 1.21 cores and 1.96 GB. Those are sampled peaks, not proof of a leak or a capacity requirement. The isolated remote audit browser contributed some load. No production configuration was changed.

Remote connector calls lost emulation/trace state between calls during this audit. The local regression verifies that one MCP session retains its bridge across emulation, traces and tunnel operations. Sharing DevTools state across different sessions would weaken isolation, so it was not used as a workaround. The isolated remote audit browser was subsequently absent, and its tunnel client confirmed “browser gone”; no unrelated browser was touched.

## Limits and next measurements

The local machine was under substantial existing memory pressure. Tests used one benchmark Chrome at a time, capped Node heaps, isolated profiles and sequential samples. This protects the user's session but does not simulate a production fleet at saturation.

The native Linux path now has real measurements; its transport is loopback within one hosting container, and timing ends at frame receipt. Local worker placement/move and real tar/gzip/upload throughput are also measured, with fixture Chrome. Inter-host transport, sustained concurrent-agent capacity, large authenticated production profiles, physical-device input-to-display latency, and all third-party page behaviors remain separate measurements. No stream frame rate or visual fidelity was lowered to make a result look faster.

## Validation and cleanup

- Final service `npm test`: **489 passed**, 77 suites, zero failures or skips; 155 seconds. This final run includes asynchronous copy/deletion, live dashboard updates, desktop visibility/cadence and native-input changes (`evidence/service-tests-desktop-final.log`).
- Additional focused regressions: **89 passed**, including held-copy/deletion, shutdown, ownership/capacity, profile, transfer, worker and dashboard cases.
- Real Chrome extension/MCP E2E: **38 assertions passed**. Real managed viewer: **20 clicks matched their encoded frames**. The final Linux desktop run matched **20 clicks, five pastes and five keys**, plus three watch hide/resume cycles, with no failures.
- Service TypeScript build passed. Dashboard/extension syntax checks and both repositories' whitespace checks passed.
- Website production build, lint, and **18 tests** passed. The production-build browser check verifies the live reduced-motion behavior and rendered layouts.

The first broad test run exposed two test-fixture expectations that needed updating (one error-message regex and one stub that did not model `render()`'s owned refresh); both were corrected before the 487-test green run; the later desktop changes passed the final 489-test run. Initial failed measurements remain in the evidence rather than being erased.

Owned benchmark Chrome/Xvfb processes, extension fixture profiles, local preview servers and the tunnel client were stopped or removed. The Linux container returned to its initial process count with no audit directories remaining; `evidence/linux-cleanup.log` records the check. Logs, samples and screenshots remain. No unrelated browser process, authenticated profile, production data, or deployed service was changed.

## Reproduction

From `service/`: `npm run bench:api -- after`, `BENCH_PHASE=extra npm run bench:api -- extra-after`, `BENCH_PHASE=runtime npm run bench:api -- runtime-after`, `node scripts/benchmark-extension.mjs after`, `node scripts/benchmark-dashboard.mjs`, and `node scripts/linked-e2e.mjs <output-directory>`. For profile operations use `node --import tsx scripts/benchmark-profile-clone.ts after`; for the successful managed viewer fixture use `BENCH_STARTS=1 BENCH_FIXTURE_MODE=inject node --import tsx scripts/benchmark-managed.ts injected-after`. The scripts describe their fixtures and arguments. `scripts/preview-performance.ts` creates the disposable local dashboard lab; `scripts/benchmark-ui.mjs <lab-url> <output-directory> [baseline-app.js]` measures it and refuses non-local hosts.

For the isolated Linux fixture, `python3 scripts/run-linux-benchmark.py --help` documents the authenticated SSH runner. It creates temporary loopback services and its own single Chrome/Xvfb, optionally overlays reviewed capture modules into a disposable copy, and removes its files/processes. It does not deploy or use production browser profiles. Check container headroom first.

From `website/`, build and start the production app, then run `node scripts/benchmark-browser.mjs <local-url> <output-directory>`. Keep the same Chrome version, build, fixture, CPU/network settings and sample counts when comparing revisions. Browser harnesses checkpoint JSON and clean up their owned browser. Browser measurements use the [Chrome DevTools Network protocol](https://chromedevtools.github.io/devtools-protocol/tot/Network/) on the same CDP session, with a calibration fetch to check the applied delay.
