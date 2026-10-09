# UI and website timings — 9 October 2026

## Dashboard actions

A real browser loads the shipped dashboard against local Express and SQLite. Browser processes are fixtures here; real managed and linked Chrome are separate tests. CPU is throttled 4× and requests use 40 ms latency, 10 Mbit/s down, 5 Mbit/s up. Calibration fetch: about 51 ms. Each action below is one observation per revision, not a percentile. Completion ends at the last observed network/DOM change; it does not prove pixels have reached a physical screen. SSE is disabled only inside this action-isolation harness.

| Action | Before ms | After ms | Before / after requests |
|---|---:|---:|---:|
|navigate /|118.5|141.8|7 / 7|
|navigate /agents|112.8|105.7|7 / 7|
|navigate /seeds|111.9|101.0|7 / 7|
|navigate /workers|114.6|103.9|7 / 7|
|navigate /security|111.8|104.7|7 / 7|
|navigate /pair|111.2|110.7|7 / 7|
|navigate /|134.5|117.6|7 / 7|
|filter browsers|13.9|16.4|0 / 0|
|clear filter|17.2|16.5|0 / 0|
|edit browser details open|17.3|17.1|0 / 0|
|edit browser details submit|322.7|220.8|15 / 8|
|record signed-in site open|11.1|19.3|0 / 0|
|record signed-in site submit|307.6|202.6|15 / 8|
|mark needs login|299.2|205.2|15 / 8|
|remove site record|301.5|196.4|15 / 8|
|open browser actions|19.2|17.6|0 / 0|
|view stopped browser|161.1|206.1|9 / 9|

The unchanged stopped-browser view varied from 161 to 206 ms; no improvement is claimed there. All action requests succeeded. Sub-frame differences on filter/menu actions are noise. The four save/state actions consistently lose one complete seven-request refresh, confirmed by the independent repeated orchestration benchmark.

## Live updates through SSE

In a separate real EventSource test, an API rename took 1,515 ms to reach the dashboard before the change. Three after-change observations, separated by 1.6 seconds of idle time, took 12.1, 14.4 and 19.0 ms. This measures the resulting DOM mutation, not physical-screen presentation. Burst updates remain capped at one refresh per 1.5 seconds; hidden pages defer refresh and catch up on visibility return. An open menu is not replaced. Raw observations: `evidence/dashboard-sse.json`. A regression test exercises idle, burst, hidden and open-menu cases.

## Dashboard orchestration

Shipped async functions, rendering stubbed, ten samples per case; simulated 40 ms requests and a separate 400 ms worker case. This isolates serial round trips and redundant work, not rendering speed.

| Action / worker delay | Before p50 ms | After p50 ms | Before / after requests | Before / after card paints |
|---|---:|---:|---:|---:|
|render / 40 ms|87.0|88.1|7 / 7|7 / 2|
|call / 40 ms|204.0|128.1|15 / 8|7 / 2|
|setSiteState / 40 ms|205.8|128.0|15 / 8|7 / 2|
|removeSite / 40 ms|204.5|128.0|15 / 8|7 / 2|
|render / 400 ms|447.2|447.4|7 / 7|7 / 3|
|call / 400 ms|924.0|488.0|15 / 8|7 / 3|
|setSiteState / 400 ms|924.3|487.6|15 / 8|7 / 3|
|removeSite / 400 ms|924.5|488.3|15 / 8|7 / 3|

## Website production build

Three cold and three warm loads at each width, 900 px high. Same 4× CPU / 40 ms / 10 Mbit/s / 5 Mbit/s settings. These are localhost lab results, not mobile hardware or public-internet field metrics. Navigation TTFB remains local (~2–8 ms); resource/fetch throttling is verified by calibration. The before run used an older throttling command without this calibration, so no before/after page-load speedup is claimed.

| Width | Cold LCP median ms | Warm LCP median ms | Maximum CLS | Longest task ms |
|---|---:|---:|---:|---:|
|375|392|204|0.0342|62|
|768|384|200|0.0000|0|
|1440|380|192|0.0001|0|

| Additional route | LCP ms | CLS |
|---|---:|---:|
|/guides/another-extension-blocks-sharing|288|0.0000|
|/guides/browser-agent-login-handoff|292|0.0000|
|/guides/browser-agent-permissions|280|0.0000|
|/guides/browser-memory-and-idle-timeouts|280|0.0000|
|/guides/browser-profile-templates|284|0.0000|
|/guides/chrome-extensions-in-remote-browser|280|0.0000|
|/guides/connect-browser-mcp|288|0.0000|
|/guides/deploy-browser-on-railway|276|0.0000|
|/guides/per-browser-proxy|280|0.0000|
|/guides/persistent-browser-profiles|276|0.0000|
|/guides/reach-localhost-from-remote-browser|284|0.0000|
|/guides/self-host-browser-docker|292|0.0000|
|/guides/self-hosted-browser-for-ai-agents|284|0.0000|
|/guides/share-browser-for-sign-in|280|0.0000|
|/guides/test-mcp-connector-chatgpt-claude-grok|312|0.0000|
|/guides/upgrade-tallylamp|268|0.0000|
|/guides/use-your-own-browser-with-an-agent|284|0.0000|
|/guides|304|0.0000|
|/performance-missing-route|172|0.0000|
|/privacy|284|0.0000|

## Homepage button and disclosure actions

Programmatic activation through the shipped handlers; time to two animation frames is a paint opportunity, not hardware input latency or INP. External navigation and YouTube playback buffering are excluded.

| Action | Paint opportunity ms |
|---|---:|
|Pause the walkthrough|32.7|
|01Every browser, one screen|32.1|
|02Watch it live|32.6|
|03Take control|33.9|
|04Answer the 2FA prompt|33.5|
|05Hand it back|33.5|
|Pause the walkthrough|33.2|
|01Open Full browser|31.8|
|02Pin your extension|32.6|
|03It reads the chat|32.5|
|04Open the extension|33.1|
|05Still there after a restart|33.1|
|Claude Code|32.7|
|Codex|31.4|
|Cursor|33.2|
|Any client|33.5|
|Copy|35.5|
|Copy|34.2|
|Do I need to save my browser after signing in?+|35.3|
|What are profile templates?+|33.6|
|Can each browser use a different proxy?+|34.2|
|Can the browser reach localhost or a dev server on my laptop?+|34.6|
|What should I know before using sensitive accounts?+|33.6|
|Can it get past a CAPTCHA or avoid detection?+|33.2|

## Motion, heap and visual checks

The live reduced-motion toggle previously left 152 film DOM mutations in the one-second observation window. After the fix it leaves zero, with playback paused on the settled current chapter. Offscreen films already stopped correctly; that behavior was retained. At 4× CPU the visible page delivered about 61 requestAnimationFrame callbacks per second. Four full-page scroll sweeps with explicit GC ended at 4.965, 4.979, 4.989 and 4.999 MB JS heap. No material growth appeared in this bounded check; this is not a long-running leak proof.

The website, dashboard and extension were inspected at 375, 768 and 1440 px. No horizontal overflow appeared. The extension fixture set covers 13 states at all three widths (unpaired, error, pairing, connecting, ready, unshareable, dashboard, another extension blocking access, shared here, reconnecting, shared elsewhere, offline, notice). The offline timer changes its countdown text without replacing the panel or disturbing focus. Existing layout, typography, color and quality settings were retained. An additional live 503 fixture preserved the last successful agent list, showed the error and a Retry button, and recovered after restoring the API and pressing Retry.

Raw per-action timings, environment records and PNGs are in `evidence/website-before`, `website-after`, `ui-before`, and `ui-after`.
