# Dashboard UX fixes — 7 October 2026

Implemented the 21 findings in [the original audit](REPORT.md), retaining the dashboard’s native JavaScript interface, visual style and dependencies. Changes are local and have not been deployed.

## Changes and evidence

| Finding | Implemented behavior |
|---|---|
| F01 | Grid children can shrink. Agents, profiles and workers scroll within labelled table regions; the mobile page stays within its viewport. |
| F02 | Request actions wrap within the available width, including Deny. |
| F03 | Pending forms disable controls and prevent Escape, Cancel and backdrop dismissal. One-time tokens and URLs require Done. |
| F04 | Every dataset tracks loading, failure and its last successful update. Request, worker and guest-link failures have explicit retry controls. |
| F05 | Failed sign-out retains the current page and reports that sign-out is unconfirmed, with Retry and Cancel. |
| F06 | Pairing approval and denial cannot race. Failed denial keeps the code visible and never claims success. |
| F07 | Lease expiry cancels remote input and refreshes the browser’s controller state, restoring Take control. |
| F08 | Tabs support arrows, Home/End and Enter/Space with manual activation and focus restoration. Close events stay separate. New tab sits outside the tablist; tabs identify their panel. |
| F09 | Cards and detail show the controller’s name and the reported task. Late agent data updates the detail without reconnecting its viewer. |
| F10 | An immediate shell names loading work. Datasets render independently; guest links do not gate the viewer. GETs time out after ten seconds. Local retries immediately show pending feedback. |
| F11 | The status API exposes authoritative local `occupiedSlots`, using the same union of runtimes, starts and resume reservations as the cap. Linked and worker browsers are excluded; stopped browsers are counted separately. |
| F12 | Failed security refreshes mark retained facts with a warning and last-successful timestamp; cold failure shows no inferred security settings. |
| F13 | Browser edits and site records submit inside their forms, preserving entered values and retry controls after failure. |
| F14 | Profile sources exclude linked and worker browsers. Update requires an eligible local source. Selecting a saved profile fixes the creation host to this instance. |
| F15 | Replace token opens an agent-specific explanation of the invalidation before committing. |
| F16 | Compact mobile navigation, smaller card previews, collapsed permission explanation and advanced host/proxy fields reduce initial scrolling. Desktop preferences stay visible while the main pane scrolls. |
| F17 | Touch fields, buttons, switches, tab controls, disclosures and checkbox labels have at least 44px targets. Text fields use 16px text on touch devices. |
| F18 | Watching uses an outer outline and read-only chips; no inset glow tints the remote page. |
| F19 | Takeover copy identifies the actual owner and distinguishes preserving sign-ins on takeover from actions that can change them. |
| F20 | Feedback survives a same-route render and retains success/error semantics. New navigation clears old feedback. |
| F21 | Separate success text and fill tokens provide 8.04:1 dark-theme success-text contrast on the page background. |

Fitts’s Law informed target sizes and reachable actions; Hick’s Law informed the mobile disclosures and advanced fields. Doherty informed immediate loading and pending feedback. Peak–End informed confirmed outcomes, retained failures and explicit acknowledgement of one-time results.

## Validation

- `npm run build`: passed.
- `npm test`: **420 passed, zero failed**, across 72 suites.
- Final focused dashboard/action/site-access check after integration: **33 passed, zero failed**.
- Syntax and `git diff --check`: passed.
- Chrome DevTools: all six dashboard pages checked at **375×812, 768×1024 and 1440×900**, with no page overflow. A 375px table region remained 347px wide, held a 620px table and successfully scrolled 200px.
- Mobile navigation: **178px → 59px**. First browser card: **757px → 349px** in the audit fixtures. Request actions stay within 375px.
- Lighthouse accessibility: **100** on checked mobile/desktop fleet and live-view states, including dark success feedback. This supplements manual keyboard checks; it is not a complete assistive-technology certification.
- At 4× CPU slowdown and Fast 4G, the local fixture recorded **LCP 1,332ms, CLS 0.05**. These are synthetic lab observations, not production measurements or a statistically controlled performance comparison.

The fixture exercises populated, empty, loading, partial failure, stale security, failed mutations, pending writes, one-time output and lease expiry. Backend capacity tests use fake Chrome. Live production credentials, profile copying, OS desktop behavior and real remote-worker latency were not exercised.

## Rendered examples

- [Mobile fleet](after/fleet-375-light.jpg), [tablet fleet](after/fleet-768-light.jpg), [desktop fleet](after/fleet-1440-light.jpg)
- [Browser detail](after/detail-1440-light.jpg), [mobile creation](after/create-375-light.jpg)
- [Retained edit](after/edit-error-375-dark.jpg), [failed sign-out](after/logout-error-375-dark.jpg), [failed pairing denial](after/pair-denial-error-actions-375-light.jpg)
- [One-time token](after/one-time-token-375-dark.jpg), [dark success feedback](after/success-375-dark.jpg), [stale security warning](after/security-stale-375-light.jpg)
- [Verification data](after/verification.json)
