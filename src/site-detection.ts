import { CdpClient } from "./cdp.js";
import { isSiteDetectionDismissed, listSiteAccess, reportSiteAccess } from "./site-access.js";

// A visit, avatar, or cookie is not proof of authentication. Only inspect
// visible actionable sign-out controls; never return page text or credentials.
export const SIGN_IN_OBSERVATION = `(() => {
  if (!/^https?:$/.test(location.protocol)) return null;
  const signedIn = Array.from(document.querySelectorAll('button, a, [role="button"], [role="menuitem"], input[type="submit"]'))
    .slice(0, 500).some(el => {
      const style = getComputedStyle(el);
      if (!el.getClientRects().length || style.visibility !== 'visible' || style.opacity === '0') return false;
      const label = (el.getAttribute('aria-label') || el.innerText || el.value || '').trim();
      return /^(sign[ -]?out|log[ -]?out)$/i.test(label);
    });
  return { origin: location.origin, signedIn };
})()`;

export class SiteDetector {
  private busy = new Set<string>();
  private lastScan = new Map<string, number>();

  async scan(browserId: string, pages: Array<{ type: string; url: string; webSocketDebuggerUrl?: string }>, isRunning: () => boolean): Promise<void> {
    if (this.busy.has(browserId) || Date.now() - (this.lastScan.get(browserId) ?? 0) < 15_000) return;
    this.busy.add(browserId);
    this.lastScan.set(browserId, Date.now());
    try {
      for (const page of pages.filter(p => p.type === "page" && /^https?:\/\//.test(p.url)).slice(0, 8)) {
        if (!isRunning() || !page.webSocketDebuggerUrl) break;
        const cdp = new CdpClient(page.webSocketDebuggerUrl);
        try {
          await cdp.connect();
          const response = await cdp.send("Runtime.evaluate", { expression: SIGN_IN_OBSERVATION, returnByValue: true, timeout: 1000 }) as {
            result?: { value?: { origin?: string; signedIn?: boolean } };
          };
          const observation = response.result?.value;
          if (!isRunning() || observation?.signedIn !== true || typeof observation.origin !== "string") continue;
          // Do not let a navigation race attribute a signal to a different site.
          if (observation.origin !== new URL(page.url).origin) continue;
          if (isSiteDetectionDismissed(browserId, observation.origin)) continue;
          if (listSiteAccess(browserId).some(site => site.origin === observation.origin)) continue;
          reportSiteAccess(browserId, { origin: observation.origin, state: "confirmed" }, { type: "system", id: "sign-in-detector" });
        } catch {
          // A closed tab or unsupported page is an unknown state, not a sign-out.
        } finally {
          await cdp.close();
        }
      }
    } finally {
      this.busy.delete(browserId);
    }
  }

  forget(browserId: string): void {
    this.lastScan.delete(browserId);
  }
}
