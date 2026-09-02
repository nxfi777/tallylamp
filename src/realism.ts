import { CdpClient, browserWsUrl, evaluate } from "./cdp.js";
import { launchChrome, stopRuntime, withTempProfile, type ChromeRuntime } from "./chrome.js";
import { config } from "./config.js";

export type SurfaceMap = Record<string, unknown>;

const PROBE = `(() => {
  const chromeObj = typeof window.chrome === 'undefined' ? null : {
    runtime: typeof chrome.runtime !== 'undefined',
    keys: Object.keys(chrome || {}),
  };
  let webgl = null;
  try {
    const c = document.createElement('canvas');
    const gl = c.getContext('webgl') || c.getContext('experimental-webgl');
    if (gl) {
      const dbg = gl.getExtension('WEBGL_debug_renderer_info');
      webgl = {
        vendor: gl.getParameter(gl.VENDOR),
        renderer: gl.getParameter(gl.RENDERER),
        unmaskedVendor: dbg ? gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL) : null,
        unmaskedRenderer: dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : null,
      };
    }
  } catch (e) { webgl = { error: String(e) }; }
  let audio = null;
  try {
    const ac = new (window.AudioContext || window.webkitAudioContext)();
    audio = { sampleRate: ac.sampleRate, state: ac.state };
    ac.close();
  } catch (e) { audio = { error: String(e) }; }
  return {
    userAgent: navigator.userAgent,
    webdriver: navigator.webdriver,
    languages: [...navigator.languages],
    language: navigator.language,
    platform: navigator.platform,
    hardwareConcurrency: navigator.hardwareConcurrency,
    deviceMemory: navigator.deviceMemory,
    maxTouchPoints: navigator.maxTouchPoints,
    plugins: [...navigator.plugins].map(p => p.name),
    mimeTypes: [...navigator.mimeTypes].map(m => m.type),
    cookieEnabled: navigator.cookieEnabled,
    pdfViewerEnabled: navigator.pdfViewerEnabled,
    windowChrome: chromeObj,
    screen: { width: screen.width, height: screen.height, availWidth: screen.availWidth, colorDepth: screen.colorDepth, pixelDepth: screen.pixelDepth },
    window: { innerWidth: window.innerWidth, innerHeight: window.innerHeight, outerWidth: window.outerWidth, devicePixelRatio: window.devicePixelRatio },
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    locale: Intl.DateTimeFormat().resolvedOptions().locale,
    webgl,
    audio,
    webRTC: typeof RTCPeerConnection !== 'undefined',
    mediaDevices: !!(navigator.mediaDevices && navigator.mediaDevices.enumerateDevices),
    pointer: { maxTouchPoints: navigator.maxTouchPoints },
    uaData: navigator.userAgentData ? {
      brands: navigator.userAgentData.brands,
      mobile: navigator.userAgentData.mobile,
      platform: navigator.userAgentData.platform,
    } : null,
    cdpArtifacts: {
      runtimeEnabledHint: typeof window.__playwright !== 'undefined' || typeof window.__puppeteer !== 'undefined',
    },
  };
})()`;

export async function captureSurfaces(rt: ChromeRuntime): Promise<SurfaceMap> {
  const ws = await browserWsUrl(rt.cdpUrl);
  const cdp = new CdpClient(ws);
  await cdp.connect();
  try {
    return (await evaluate(cdp, PROBE)) as SurfaceMap;
  } finally {
    await cdp.close();
  }
}

export type DiffClass =
  | "match"
  | "automation artifact"
  | "container/environment artifact"
  | "deployment hardware artifact"
  | "intentional configuration"
  | "unavoidable difference"
  | "unknown";

export type DiffRow = { key: string; reference: unknown; tallylamp: unknown; classification: DiffClass };

function classify(key: string, a: unknown, b: unknown): DiffClass {
  if (JSON.stringify(a) === JSON.stringify(b)) return "match";
  if (key.includes("webdriver") || key.includes("cdpArtifacts") || key.includes("windowChrome")) {
    return "automation artifact";
  }
  if (key.includes("webgl") || key.includes("gpu") || key.includes("hardwareConcurrency") || key.includes("deviceMemory")) {
    return "deployment hardware artifact";
  }
  if (key.includes("screen") || key.includes("window") || key.includes("plugins")) {
    return "container/environment artifact";
  }
  if (key.includes("timezone") || key.includes("locale") || key.includes("languages")) {
    return "intentional configuration";
  }
  return "unknown";
}

function flatten(obj: unknown, prefix = ""): Record<string, unknown> {
  if (obj === null || typeof obj !== "object") return { [prefix || "value"]: obj };
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    const p = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === "object" && !Array.isArray(v)) Object.assign(out, flatten(v, p));
    else out[p] = v;
  }
  return out;
}

export function diffSurfaces(reference: SurfaceMap, tallylamp: SurfaceMap): DiffRow[] {
  const a = flatten(reference);
  const b = flatten(tallylamp);
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  return [...keys].sort().map((key) => ({
    key,
    reference: a[key],
    tallylamp: b[key],
    classification: classify(key, a[key], b[key]),
  }));
}

export async function runReferenceCapture(): Promise<SurfaceMap> {
  return withTempProfile(async (dir) => {
    const xvfbWas = config.xvfb;
    const rt = await launchChrome({ profileDir: dir, downloadDir: dir + "/dl" });
    try {
      return await captureSurfaces(rt);
    } finally {
      await stopRuntime(rt);
      void xvfbWas;
    }
  });
}

export function formatReport(rows: DiffRow[]): string {
  const lines = ["Browser realism report", ""];
  for (const r of rows) {
    const tag = r.classification === "match" ? "MATCH" : r.classification.toUpperCase();
    lines.push(`${r.key.padEnd(40)} ${tag}`);
  }
  return lines.join("\n");
}
