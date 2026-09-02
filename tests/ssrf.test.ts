import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { checkDestination, isPrivateIp, hostLooksPrivate, parseAuthority } from "../src/ssrf.js";

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
});
