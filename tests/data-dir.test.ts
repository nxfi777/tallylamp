import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { config } from "../src/config.js";

describe("data directory", () => {
  const prev = {
    volume: process.env.RAILWAY_VOLUME_MOUNT_PATH,
    data: process.env.TALLYLAMP_DATA_DIR,
  };

  function restore() {
    if (prev.volume === undefined) delete process.env.RAILWAY_VOLUME_MOUNT_PATH;
    else process.env.RAILWAY_VOLUME_MOUNT_PATH = prev.volume;
    if (prev.data === undefined) delete process.env.TALLYLAMP_DATA_DIR;
    else process.env.TALLYLAMP_DATA_DIR = prev.data;
  }

  it("uses the Railway volume when TALLYLAMP_DATA_DIR is the local relative default", () => {
    process.env.RAILWAY_VOLUME_MOUNT_PATH = "/data";
    process.env.TALLYLAMP_DATA_DIR = "./data";
    assert.equal(config.dataDir, "/data");
    restore();
  });

  it("keeps an explicit absolute TALLYLAMP_DATA_DIR", () => {
    process.env.RAILWAY_VOLUME_MOUNT_PATH = "/data";
    process.env.TALLYLAMP_DATA_DIR = "/data";
    assert.equal(config.dataDir, "/data");
    restore();
  });
});
