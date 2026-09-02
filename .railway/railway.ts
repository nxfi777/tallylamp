import { defineRailway, project, service, volume } from "railway/iac";

/**
 * Tallylamp project intent.
 *
 * A Railway volume is required: Chrome profiles and the SQLite control
 * database live under /data. Replicas cannot be used with a volume.
 * ADMIN_SECRET must be set as a Railway variable (do not commit it).
 */
export default defineRailway(() => {
  const data = volume("tallylamp-data", { sizeMB: 5120 });

  const tallylamp = service("Tallylamp", {
    healthcheck: "/healthz",
    healthcheckTimeout: 120,
    start: "node dist/index.js",
    volumeMounts: {
      "/data": data,
    },
    env: {
      HOST: "0.0.0.0",
      PORT: "8080",
      TALLYLAMP_DATA_DIR: "/data",
      TALLYLAMP_XVFB: "1",
      TALLYLAMP_SANDBOX: "auto",
      TALLYLAMP_MAX_BROWSERS: "4",
      TALLYLAMP_GPU: "auto",
      TALLYLAMP_ALLOW_PRIVATE_NETWORK: "0",
    },
  });

  return project("tallylamp", {
    resources: [tallylamp, data],
  });
});
