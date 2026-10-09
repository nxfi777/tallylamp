import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { strict as assert } from "node:assert";
import { test } from "node:test";

const source = readFileSync(new URL("../dashboard/app.js", import.meta.url), "utf8");
function fn(name: string) {
  const start = source.search(new RegExp(`(?:async )?function ${name}\\(`));
  assert.notEqual(start, -1, `${name} exists`);
  return source.slice(start, source.indexOf("\n}", start) + 2);
}

// Small DOM fake for the dashboard's plain-script functions. Tests drive the actual callbacks,
// including unresolved requests, rather than checking whether a source substring exists.
class Element {
  children: Element[] = [];
  parent: Element | null = null;
  attrs: Record<string, string> = {};
  events: Record<string, (event: any) => any> = {};
  disabled = false;
  value = "";
  dataset: Record<string, string> = {};
  ownText = "";
  connected = true;
  open = false;
  constructor(public tag: string, public doc: any) {}
  get tagName() { return this.tag.toUpperCase(); }
  get isConnected() { return this.connected && (!this.parent || this.parent.isConnected); }
  get textContent(): string { return this.ownText + this.children.map(el => el.textContent).join(""); }
  set textContent(text: string) { this.ownText = text; this.children = []; }
  setAttribute(key: string, value: any) {
    this.attrs[key] = String(value);
    if (key === "value") this.value = String(value);
    if (key === "disabled") this.disabled = true;
    if (key.startsWith("data-")) this.dataset[key.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = String(value);
  }
  removeAttribute(key: string) { delete this.attrs[key]; }
  addEventListener(type: string, handler: any) { this.events[type] = handler; }
  contains(target: Element): boolean { return target === this || this.children.some(el => el.contains(target)); }
  closest(selector: string): Element | null { return this.matches(selector) ? this : this.parent?.closest(selector) || null; }
  append(...nodes: any[]) {
    for (const node of nodes.flat()) {
      if (node == null || node === false) continue;
      const el = node instanceof Element ? node : new Element("text", this.doc);
      if (!(node instanceof Element)) el.ownText = String(node);
      el.parent = this;
      this.children.push(el);
    }
    if (this.tag === "form") {
      for (const el of this.querySelectorAll("input, select, button")) {
        if (el.attrs.name) (this as any)[el.attrs.name] = el;
      }
    }
  }
  replaceChildren(...nodes: any[]) { this.children = []; this.append(...nodes); }
  remove() {
    this.connected = false;
    if (this.parent) this.parent.children = this.parent.children.filter(el => el !== this);
  }
  focus() { this.doc.activeElement = this; }
  matches(selector: string): boolean {
    if (selector.startsWith(".")) return (this.attrs.class || "").split(" ").includes(selector.slice(1));
    const match = /^(\w+)(?:\[([^=]+)="([^"]+)"\])?$/.exec(selector);
    return !!match && this.tag === match[1] && (!match[2] || this.attrs[match[2]] === match[3]);
  }
  querySelectorAll(selector: string): Element[] {
    const selectors = selector.split(",").map(value => value.trim());
    return this.children.flatMap(el => [
      ...(selectors.some(value => el.matches(value)) ? [el] : []),
      ...el.querySelectorAll(selector),
    ]);
  }
  querySelector(selector: string) { return this.querySelectorAll(selector)[0] || null; }
}

function harness(names: string[], extra: Record<string, unknown> = {}) {
  const listeners = new Map<string, (event: any) => void>();
  const document: any = {
    activeElement: null,
    addEventListener: (type: string, handler: any) => listeners.set(type, handler),
    removeEventListener: (type: string) => listeners.delete(type),
    getElementById: (id: string) => id === "app" ? app : null,
    querySelector: (selector: string) => document.body.querySelector(selector),
  };
  document.body = new Element("body", document);
  const app = new Element("div", document);
  document.body.append(app);
  const h = (tag: string, attrs: Record<string, unknown> = {}, ...kids: unknown[]) => {
    const el = new Element(tag, document);
    for (const [key, value] of Object.entries(attrs)) {
      if (key.startsWith("on")) el.events[key.slice(2).toLowerCase()] = value as any;
      else if (value !== false && value != null) el.setAttribute(key, value);
    }
    el.append(...kids);
    return el;
  };
  const state = { me: { id: "operator" }, agents: [], browsers: [], seeds: [], ...extra.state as object };
  const context: any = { h, document, state, knownProjects: () => [], ...extra };
  context.state = state;
  const functions = runInNewContext(`${names.map(fn).join("\n")}; ({${names.join(",")}})`, context);
  return { ...functions, document, state, h, app, key: (key: string) => listeners.get("keydown")?.({ key, preventDefault() {} }) };
}

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const event = () => ({ preventDefault() {} });
const flush = async () => { await Promise.resolve(); await Promise.resolve(); };
const forms = ["openModal", "askFor"];

test("pending forms cannot be dismissed and retain their committed result", async () => {
  const request = deferred();
  const env = harness(forms);
  const answer = env.askFor("Create agent", [{ name: "name", label: "Name" }], "Create agent", () => request.promise);
  const form = env.document.body.querySelector("form");
  form.querySelector("input").value = "Keep this name";
  const submitting = form.events.submit(event());
  const cancel = form.querySelector('button[type="button"]');
  assert.equal(cancel.disabled, true);
  cancel.events.click();
  env.key("Escape");
  const backdrop = env.document.body.querySelector(".modal");
  backdrop.events.mousedown({ target: backdrop });
  assert.equal(backdrop.isConnected, true);
  assert.equal(env.app.attrs.inert, "");
  assert.equal(env.document.body.querySelector(".modal-box").attrs["aria-busy"], "true");
  env.key("Tab");
  assert.equal(env.document.activeElement, env.document.body.querySelector(".modal-box"));
  request.resolve();
  await submitting;
  assert.equal((await answer).name, "Keep this name");
  assert.equal(env.document.body.querySelector(".modal"), null);
  assert.equal(env.app.attrs.inert, undefined);
});

test("a failed form retains fields and restores retry and cancellation", async () => {
  const env = harness(forms);
  const answer = env.askFor("Edit", [{ name: "name", label: "Name" }], "Save", async () => { throw new Error("Try again"); });
  const form = env.document.body.querySelector("form");
  form.querySelector("input").value = "Unsaved input";
  await form.events.submit(event());
  assert.equal(form.querySelector("input").value, "Unsaved input");
  assert.equal(form.querySelector('button[type="submit"]').disabled, false);
  assert.equal(form.querySelector('button[type="button"]').disabled, false);
  assert.equal(form.querySelector(".err").textContent, "Try again");
  env.key("Escape");
  assert.equal(await answer, null);
});

test("advanced fields stay collapsed, retain values and reveal themselves for native validation", async () => {
  const env = harness(forms);
  const answer = env.askFor("Create", [
    { name: "name", label: "Name", value: "Browser" },
    { name: "proxy", label: "Proxy", value: "http://proxy.test", required: true, advanced: true },
  ], "Create");
  const form = env.document.body.querySelector("form");
  const details = form.querySelector("details");
  const proxy = form.querySelector('input[name="proxy"]');
  assert.equal(details.open, false);
  assert.equal(details.querySelector("summary").textContent, "Advanced settings");
  assert.equal(env.document.activeElement, form.querySelector('input[name="name"]'));
  form.events.invalid({ target: proxy });
  assert.equal(details.open, true, "invalid event opens details before native focus happens");
  assert.equal(proxy.value, "http://proxy.test");
  details.open = false;
  await form.events.submit(event());
  assert.equal((await answer).proxy, "http://proxy.test", "collapsed controls remain part of the form result");
});

test("a form containing only advanced fields focuses the disclosure instead of a hidden input", async () => {
  const env = harness(forms);
  const answer = env.askFor("Advanced", [{ name: "proxy", label: "Proxy", advanced: true }], "Save");
  assert.equal(env.document.activeElement.tag, "summary");
  env.key("Escape");
  assert.equal(await answer, null);
});

test("one-time result dialogs require explicit acknowledgement", () => {
  let acknowledgements = 0;
  const env = harness(["openModal"]);
  const modal = env.openModal("Token", () => [], () => acknowledgements++, { dismissible: false });
  env.key("Escape");
  const backdrop = env.document.body.querySelector(".modal");
  backdrop.events.mousedown({ target: backdrop });
  assert.equal(acknowledgements, 0);
  modal.close();
  modal.close();
  assert.equal(acknowledgements, 1);
});

for (const action of ["editBrowser", "addSite"]) {
  test(`${action} saves inside the dialog and preserves input on rejection`, async () => {
    const calls: any[] = [];
    const env = harness([...forms, "currentOrigin", action], {
      api: async (path: string, options: any) => { calls.push({ path, options }); throw new Error("Service unavailable"); },
      act: async (work: any) => work(), refresh: async () => {}, render: () => {}, flash: () => {}, URL,
    });
    const actionDone = env[action]({ id: "b1", name: "Before", url: "https://a.test", metadata: { project: "Old" } });
    const form = env.document.body.querySelector("form");
    form.querySelector('input[name="name"]').value = "After";
    await form.events.submit(event());
    assert.equal(calls.length, 1);
    assert.equal(calls[0].options.body.name, "After");
    assert.equal(form.querySelector('input[name="name"]').value, "After");
    assert.match(form.querySelector(".err").textContent, /Service unavailable/);
    assert.equal(form.isConnected, true);
    env.key("Escape");
    await actionDone;
  });
}

test("failed sign-out retains the session and retry only navigates after confirmation", async () => {
  const routes: string[] = [];
  let fail = true;
  const env = harness([...forms, "logout"], {
    api: async () => { if (fail) throw new Error("Offline"); },
    go: (path: string) => routes.push(path), flash: () => {},
  });
  const loggingOut = env.logout();
  await flush();
  assert.equal(env.state.me.id, "operator");
  assert.deepEqual(routes, []);
  const form = env.document.body.querySelector("form");
  await form.events.submit(event());
  assert.match(form.querySelector(".err").textContent, /Offline/);
  assert.equal(env.state.me.id, "operator");
  assert.deepEqual(routes, []);
  fail = false;
  await form.events.submit(event());
  await loggingOut;
  assert.equal(env.state.me, null);
  assert.deepEqual(routes, ["/login"]);
});

test("dismissing failed sign-out retains the current page and permits another attempt", async () => {
  const routes: string[] = [];
  const env = harness([...forms, "logout"], {
    api: async () => { throw new Error("Offline"); },
    go: (path: string) => routes.push(path), flash: () => {},
  });
  const loggingOut = env.logout();
  await flush();
  env.key("Escape");
  await loggingOut;
  assert.equal(env.state.me.id, "operator");
  assert.equal(env.state.signingOut, false);
  assert.deepEqual(routes, []);
});

test("pairing denial cannot race approval and failed denial keeps the code retryable", async () => {
  const request = deferred();
  const screens: Element[] = [];
  const calls: string[] = [];
  let fail = true;
  const env = harness(["pairView"], {
    api: async (path: string, options?: any) => {
      if (!options) return { pairing: { state: "pending", userCode: "ABC123", deviceName: "My browser", createdAt: "now" } };
      calls.push(path);
      if (fail) return request.promise;
      return {};
    },
    agentPicker: () => ({ el: null, value: () => ({ anyAgent: false, agentIds: [] }) }),
    layout: (screen: Element) => screens.push(screen), ago: () => "now", go: () => {},
  });
  await env.pairView("ABC123");
  const form = screens[0].querySelector("form");
  const deny = (form as any).deny;
  const approve = (form as any).approve;
  const denying = deny.events.click();
  assert.equal(deny.disabled, true);
  assert.equal(approve.disabled, true);
  await form.events.submit(event());
  assert.equal(calls.length, 1, "pending denial blocks approval even if submitted programmatically");
  request.reject(new Error("Unavailable"));
  await denying;
  assert.equal(screens.length, 1, "failure does not render a success screen");
  assert.match(screens[0].textContent, /ABC123/);
  assert.match(form.querySelector(".err").textContent, /Could not confirm denial/);
  assert.equal(deny.disabled, false);
  assert.equal(approve.disabled, false);
  fail = false;
  await deny.events.click();
  assert.equal(screens.length, 2);
  assert.match(screens[1].textContent, /Request denied/);
});

test("saved profile sources exclude linked and worker browsers", () => {
  const env = harness(["eligibleProfileBrowsers"], { state: { browsers: [
    { id: "local", kind: "managed", worker: null },
    { id: "linked", kind: "linked", worker: null },
    { id: "worker", kind: "managed", worker: { id: "w1" } },
  ] } });
  assert.deepEqual([...env.eligibleProfileBrowsers()].map(b => b.id), ["local"]);
});

test("saved-profile updates never default to an ineligible source", async () => {
  let fields: any[] = [];
  const env = harness(["eligibleProfileBrowsers", "saveProfileTemplate"], {
    state: { browsers: [
      { id: "local", name: "Local", kind: "managed", worker: null },
      { id: "linked", name: "Linked", kind: "linked", worker: null },
      { id: "worker", name: "Worker", kind: "managed", worker: { id: "w1" } },
    ] },
    askFor: async (_title: string, shown: any[]) => { fields = shown; return null; },
  });
  await env.saveProfileTemplate(null, { id: "s1", name: "Saved", created_from_browser_id: "worker" });
  const picker = fields.find(field => field.name === "browserId");
  assert.equal(picker.value, "");
  assert.deepEqual([...picker.options].map(option => option.value), ["", "local"]);
});

test("token replacement explains the consequence before the request and retains failure for retry", async () => {
  let calls = 0;
  const tokens: string[] = [];
  const env = harness([...forms, "rotate"], {
    state: { agents: [{ id: "a1", name: "Research" }] },
    api: async () => { if (++calls === 1) throw new Error("Unavailable"); return { token: "one-time" }; },
    revealToken: (_title: string, token: string) => tokens.push(token),
  });
  const rotating = env.rotate("a1");
  assert.equal(calls, 0);
  assert.match(env.document.body.textContent, /current token will stop working immediately/);
  assert.match(env.document.body.textContent, /Research/);
  const form = env.document.body.querySelector("form");
  await form.events.submit(event());
  assert.deepEqual(tokens, []);
  assert.equal(form.isConnected, true);
  await form.events.submit(event());
  await rotating;
  assert.deepEqual(tokens, ["one-time"]);
});
