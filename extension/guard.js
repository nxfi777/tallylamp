// What a shared tab may be asked to do.
//
// The debugger attaches to one tab, but CDP was designed for a trusted developer, so plenty
// of its methods reach past that tab: every cookie in the profile, the list of every other
// tab, any file on disk. A person who shared one tab did not agree to any of that.
//
// This runs in the extension and not on the server because the server is the party being
// limited. If it did the checking, a compromised or misconfigured server could skip it.
//
// It does not try to stop the agent using the shared tab itself. An agent can still navigate
// that tab and act with whatever this profile is signed in to. That is what sharing a tab
// means, the panel says so, and "this site only" is the control for it. The one exception is
// the Tallylamp server this browser is linked to. Its dashboard is where a person approves
// what agents ask for, and an agent driving it as that person would be approving itself.
//
// Pure functions, no chrome.* calls, so the rules can be tested under plain Node.

/** Target.* is allow-listed: nearly everything else in the domain is browser-wide. */
const TARGET_ALLOWED = new Set(["Target.setAutoAttach", "Target.getTargetInfo", "Target.detachFromTarget"]);

const REFUSED = new Map([
  // The whole profile's cookies, not this tab's.
  ["Storage.getCookies", "it reads every cookie in the browser, not just this tab's"],
  ["Storage.setCookies", "it writes cookies for any site in the browser"],
  ["Storage.clearCookies", "it clears every cookie in the browser"],
  ["Network.getAllCookies", "it reads every cookie in the browser, not just this tab's"],
  ["Network.clearBrowserCookies", "it clears every cookie in the browser"],
  ["Network.clearBrowserCache", "it clears the whole browser's cache"],
  // Disk.
  ["DOM.setFileInputFiles", "it uploads files from this computer's disk, which is off for linked browsers"],
  ["Page.setDownloadBehavior", "it chooses where on this computer downloads are written"],
  ["Browser.setDownloadBehavior", "it chooses where on this computer downloads are written"],
]);

/** Methods that name an origin to act on. They only get to name the tab's own. */
const ORIGIN_SCOPED = /^(DOMStorage|IndexedDB|CacheStorage|Storage)\./;

const NAVIGABLE = new Set(["http:", "https:"]);

export function siteOf(url) {
  try {
    const u = new URL(url);
    return NAVIGABLE.has(u.protocol) ? u.hostname.replace(/^www\./, "") : null;
  } catch {
    return null;
  }
}

/** A host is inside a site when it is that host or a subdomain of it. */
export function withinSite(url, site) {
  const host = siteOf(url);
  return Boolean(host && site && (host === site || host.endsWith(`.${site}`)));
}

/** A page of the linked Tallylamp server. `server` is its host, port included. */
export function onServer(url, server) {
  try {
    return Boolean(server) && new URL(url).host === server;
  } catch {
    return false;
  }
}

/** The address if it is an extension's page, any extension's. Otherwise null. */
export function extensionUrl(url) {
  return typeof url === "string" && /^chrome-extension:\/\//i.test(url) ? url : null;
}

/**
 * The extension page a CDP event says a debugger session is inside, or null.
 *
 * Chrome keeps one extension out of another's frames, but chrome://flags "Extensions on
 * chrome-extension:// URLs" lifts that, and then auto-attach hands the agent a session inside,
 * say, a password manager's menu. Chrome announces a frame that arrives later before it has an
 * address, so the session's own events are read as well: where its frame navigated, and the
 * origin of its main world. Content scripts' worlds carry an extension origin inside ordinary
 * pages too, which is why only the default world counts.
 */
export function extensionFrameIn(method, params = {}) {
  if (method === "Target.attachedToTarget" || method === "Target.targetInfoChanged") return extensionUrl(params.targetInfo?.url);
  if (method === "Page.frameNavigated") return extensionUrl(params.frame?.url);
  if (method === "Runtime.executionContextCreated" && params.context?.auxData?.isDefault) return extensionUrl(params.context.origin);
  return null;
}

function namedOrigins(params) {
  const found = [];
  for (const key of ["origin", "securityOrigin", "storageKey"]) if (typeof params?.[key] === "string") found.push(params[key]);
  for (const key of ["securityOrigin", "storageKey"]) if (typeof params?.storageId?.[key] === "string") found.push(params.storageId[key]);
  return found;
}

/**
 * Decide one CDP call against one shared tab.
 *
 * @param {{url: string, sites: string[] | null, server?: string | null}} tab  `sites` is set when the
 *   share is limited to those sites. `server` is the linked Tallylamp server's host.
 * @returns {{ok: true, params: object} | {ok: false, reason: string}}
 */
export function guard(tab, method, params = {}) {
  const refuse = (reason) => ({ ok: false, reason: `${method} is not allowed on a linked browser: ${reason}.` });

  if (REFUSED.has(method)) return refuse(REFUSED.get(method));
  if (method.startsWith("Target.") && !TARGET_ALLOWED.has(method)) return refuse("it reaches other tabs in this browser");

  if (method === "Target.getTargetInfo" && params.targetId !== undefined) {
    // Without a targetId it answers for this tab. With one it answers for any tab.
    const { targetId: _drop, ...rest } = params;
    return { ok: true, params: rest };
  }

  if (method === "Network.getCookies" && params.urls !== undefined) {
    // `urls` makes it answer for any site at all. Dropped, it answers for this page.
    const { urls: _drop, ...rest } = params;
    return { ok: true, params: rest };
  }

  if (method === "Network.setCookie" || method === "Network.deleteCookies" || method === "Network.setCookies") {
    const cookies = method === "Network.setCookies" ? (Array.isArray(params.cookies) ? params.cookies : []) : [params];
    const here = siteOf(tab.url);
    for (const c of cookies) {
      const host = typeof c.url === "string" ? siteOf(c.url) : typeof c.domain === "string" ? c.domain.replace(/^\./, "").replace(/^www\./, "") : here;
      if (!here || !host || !(host === here || here.endsWith(`.${host}`) || host.endsWith(`.${here}`))) {
        return refuse("it touches cookies for a different site than the one in this tab");
      }
    }
  }

  if (ORIGIN_SCOPED.test(method)) {
    let own = null;
    try {
      own = new URL(tab.url).origin;
    } catch {
      /* no origin to compare against, so nothing named can match it */
    }
    for (const named of namedOrigins(params)) {
      let origin = named;
      try {
        origin = new URL(named).origin;
      } catch {
        /* compared as written */
      }
      if (origin !== own) return refuse("it reads storage belonging to a different site than the one in this tab");
    }
  }

  if (method === "Page.navigate") {
    let target;
    try {
      target = new URL(String(params.url), tab.url);
    } catch {
      return refuse("the address is not a valid URL");
    }
    const blank = target.href === "about:blank";
    // file: would read this computer's disk; chrome: and javascript: are not pages at all.
    if (!blank && !NAVIGABLE.has(target.protocol)) return refuse(`only http and https pages can be opened, not ${target.protocol}`);
    if (onServer(target.href, tab.server)) {
      return refuse("that is the Tallylamp dashboard, where the person at this browser approves what agents ask for");
    }
    if (tab.sites && !blank && !tab.sites.some((site) => withinSite(target.href, site))) {
      return refuse(`this tab was shared for ${tab.sites.join(", ")} only, and ${target.hostname} is a different site. Ask the person at this browser to share it for any site`);
    }
  }

  return { ok: true, params };
}
