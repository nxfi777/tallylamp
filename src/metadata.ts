import { Err } from "./errors.js";

export const METADATA_LIMITS = {
  maxKeys: 16,
  maxKeyLength: 40,
  maxValueLength: 400,
  maxNestedDepth: 2,
  maxBytes: 4096,
  maxLabels: 8,
};

export type BrowserMetadata = {
  source?: string;
  sourceDisplayName?: string;
  project?: string;
  purpose?: string;
  task?: string;
  repository?: string;
  branch?: string;
  workspace?: string;
  sessionId?: string;
  agentName?: string;
  model?: string;
  labels?: Record<string, string>;
};

const STRING_FIELDS = [
  "source",
  "sourceDisplayName",
  "project",
  "purpose",
  "task",
  "repository",
  "branch",
  "workspace",
  "sessionId",
  "agentName",
  "model",
] as const;

function depthOf(value: unknown, d = 0): number {
  if (value && typeof value === "object") {
    if (Array.isArray(value)) return Math.max(d, ...value.map((v) => depthOf(v, d + 1)), d);
    return Math.max(d, ...Object.values(value as Record<string, unknown>).map((v) => depthOf(v, d + 1)), d);
  }
  return d;
}

export function sanitizeMetadata(input: unknown): BrowserMetadata {
  if (input === undefined || input === null) return {};
  if (typeof input !== "object" || Array.isArray(input)) {
    throw Err.invalidMetadata("metadata must be an object");
  }
  const raw = input as Record<string, unknown>;
  const encoded = JSON.stringify(raw);
  if (encoded.length > METADATA_LIMITS.maxBytes) {
    throw Err.invalidMetadata(`metadata exceeds ${METADATA_LIMITS.maxBytes} bytes`);
  }
  if (Object.keys(raw).length > METADATA_LIMITS.maxKeys) {
    throw Err.invalidMetadata(`metadata has more than ${METADATA_LIMITS.maxKeys} keys`);
  }
  if (depthOf(raw) > METADATA_LIMITS.maxNestedDepth) {
    throw Err.invalidMetadata(`metadata nested deeper than ${METADATA_LIMITS.maxNestedDepth}`);
  }
  const out: BrowserMetadata = {};
  for (const [k, v] of Object.entries(raw)) {
    if (k.length > METADATA_LIMITS.maxKeyLength) {
      throw Err.invalidMetadata(`metadata key too long: ${k}`);
    }
    if (k === "labels") {
      if (v === undefined) continue;
      if (typeof v !== "object" || v === null || Array.isArray(v)) {
        throw Err.invalidMetadata("labels must be a string map");
      }
      const labels: Record<string, string> = {};
      const entries = Object.entries(v as Record<string, unknown>);
      if (entries.length > METADATA_LIMITS.maxLabels) {
        throw Err.invalidMetadata(`more than ${METADATA_LIMITS.maxLabels} labels`);
      }
      for (const [lk, lv] of entries) {
        if (typeof lv !== "string") throw Err.invalidMetadata("label values must be strings");
        if (lk.length > METADATA_LIMITS.maxKeyLength || lv.length > METADATA_LIMITS.maxValueLength) {
          throw Err.invalidMetadata("label key or value too long");
        }
        labels[lk] = lv;
      }
      out.labels = labels;
      continue;
    }
    if ((STRING_FIELDS as readonly string[]).includes(k)) {
      if (v === undefined || v === null) continue;
      if (typeof v !== "string") throw Err.invalidMetadata(`${k} must be a string`);
      if (v.length > METADATA_LIMITS.maxValueLength) throw Err.invalidMetadata(`${k} is too long`);
      if (/secret|password|token|cookie|authorization/i.test(v)) {
        throw Err.invalidMetadata(`${k} looks like a secret and is not allowed`);
      }
      (out as Record<string, unknown>)[k] = v;
      continue;
    }
    throw Err.invalidMetadata(`unknown metadata field '${k}'`);
  }
  return out;
}

export const CREATE_BROWSER_TOOL_DESCRIPTION = `Create a headed persistent browser this agent can drive. When known, provide concise metadata describing your source, project and purpose. This is displayed to the user so they can understand why the browser exists. Metadata is optional. Do not include secrets, credentials, cookies, tokens or sensitive page content. Do not fabricate metadata when it is unknown.

Example: { "persistent": true, "metadata": { "source": "claude-code", "project": "tallylamp", "purpose": "Verify dashboard takeover behavior" } }`;
