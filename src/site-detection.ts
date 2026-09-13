import { CdpClient } from "./cdp.js";
import { isSiteDetectionDismissed, listSiteAccess, reportSiteAccess } from "./site-access.js";

// A visit, avatar, or cookie is not proof of authentication. Only inspect
// visible sign-out/account controls; never return page text or credentials.
export const SIGN_IN_OBSERVATION = `(() => {
  if (!/^https?:$/.test(location.protocol)) return null;
  const google = /(^|\\.)google\\.com$/.test(location.hostname);
  const signedIn = Array.from(document.querySelectorAll('button, a, [role="button"], [role="menuitem"], input[type="submit"]'))
    .slice(0, 500).some(el => {
      const style = getComputedStyle(el);
      if (!el.getClientRects().length || style.visibility !== 'visible' || style.opacity === '0') return false;
      if (el.checkVisibility && !el.checkVisibility({checkOpacity: true, checkVisibilityCSS: true})) return false;
      const label = (el.getAttribute('aria-label') || el.innerText || el.value || '').trim();
      if (google) {
        if (/^Google Account:/i.test(label)) return true;
        try {
          const url = new URL(el.getAttribute('href') || '', location.href);
          if (url.hostname === 'accounts.google.com' && url.pathname === '/SignOutOptions') return true;
        } catch {}
      }
      return /^(sign[ -]?out|log[ -]?out)$/i.test(label);
    });
  return { origin: location.origin, signedIn, ...(google ? {name: 'Google'} : {}) };
})()`;

export class SiteDetector {
  private scans = new Map<string, Promise<void>>();
  private lastScan = new Map<string, number>();

  async scan(browserId: string, pages: Array<{ type: string; url: string; webSocketDebuggerUrl?: string }>, isRunning: () => boolean, force = false): Promise<void> {
    const active = this.scans.get(browserId);
    if (active) {
      await active;
      if (force) return this.scan(browserId, pages, isRunning, true);
      return;
    }
    if (!force && Date.now() - (this.lastScan.get(browserId) ?? 0) < 15_000) return;
    this.lastScan.set(browserId, Date.now());
    const work = this.inspect(browserId, pages, isRunning).finally(() => this.scans.delete(browserId));
    this.scans.set(browserId, work);
    return work;
  }

  private async inspect(browserId: string, pages: Array<{ type: string; url: string; webSocketDebuggerUrl?: string }>, isRunning: () => boolean): Promise<void> {
      const deadline = Date.now() + 4_000;
      for (const page of pages.filter(p => p.type === "page" && /^https?:\/\//.test(p.url)).slice(0, 8)) {
        if (!isRunning() || Date.now() >= deadline) break;
        if (!page.webSocketDebuggerUrl) continue;
        const cdp = new CdpClient(page.webSocketDebuggerUrl, 1_000);
        try {
          await cdp.connect();
          const response = await cdp.send("Runtime.evaluate", { expression: SIGN_IN_OBSERVATION, returnByValue: true, timeout: 1000 }) as {
            result?: { value?: { origin?: string; signedIn?: boolean; name?: string } };
          };
          const observation = response.result?.value;
          if (!isRunning() || observation?.signedIn !== true || typeof observation.origin !== "string") continue;
          // Do not let a navigation race attribute a signal to a different site.
          if (observation.origin !== new URL(page.url).origin) continue;
          if (isSiteDetectionDismissed(browserId, observation.origin)) continue;
          if (listSiteAccess(browserId).some(site => site.origin === observation.origin)) continue;
          reportSiteAccess(browserId, { origin: observation.origin, name: observation.name, state: "confirmed" }, { type: "system", id: "sign-in-detector" });
        } catch {
          // A closed tab or unsupported page is an unknown state, not a sign-out.
        } finally {
          await cdp.close();
        }
      }
  }

  forget(browserId: string): void {
    this.lastScan.delete(browserId);
  }
}
