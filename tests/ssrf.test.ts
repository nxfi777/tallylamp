import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { checkDestination, isPrivateIp, hostLooksPrivate, parseAuthority, pinnedLookup } from "../src/ssrf.js";

describe("ssrf", () => {
  it("flags loopback and RFC1918", () => {
    assert.equal(isPrivateIp("127.0.0.1"), true);
    assert.equal(isPrivateIp("10.0.0.5"), true);
    assert.equal(isPrivateIp("192.168.1.1"), true);
    assert.equal(isPrivateIp("172.16.0.1"), true);
    assert.equal(isPrivateIp("169.254.169.254"), true);
    assert.equal(isPrivateIp("::1"), true);
    assert.equal(isPrivateIp("8.8.8.8"), false);
  });

  it("flags localhost names", () => {
    assert.equal(hostLooksPrivate("localhost"), true);
    assert.equal(hostLooksPrivate("metadata.google.internal"), true);
  });

  it("parses CONNECT authorities", () => {
    assert.deepEqual(parseAuthority("example.com:443"), { host: "example.com", port: 443 });
    assert.deepEqual(parseAuthority("[::1]:443"), { host: "::1", port: 443 });
  });

  it("denies private destinations after DNS", async () => {
    const v = await checkDestination("localhost", 80);
    assert.equal(v.ok, false);
  });
  // Node's connect path asks for `all: true` under happy-eyeballs, which is the default.
  // Answering that with the scalar form fails the socket with "Invalid IP address:
  // undefined" and no request is ever sent, so both call shapes must be honoured.
  it("answers a pinned lookup in whichever shape node asked for", () => {
    const look = pinnedLookup("93.184.216.34", 4) as unknown as (
      host: string,
      opts: unknown,
      cb: (e: Error | null, a: unknown, f?: number) => void,
    ) => void;

    let all: unknown;
    look("example.com", { all: true }, (err, a) => {
      assert.equal(err, null);
      all = a;
    });
    assert.deepEqual(all, [{ address: "93.184.216.34", family: 4 }]);

    let scalar: unknown;
    let family: number | undefined;
    look("example.com", { all: false }, (err, a, f) => {
      assert.equal(err, null);
      scalar = a;
      family = f;
    });
    assert.equal(scalar, "93.184.216.34");
    assert.equal(family, 4);
  });
});
