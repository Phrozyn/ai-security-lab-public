// Validates ci-cd/models.lock.json and cross-checks it against the models the
// deployed config references, so the lock can't silently drift from
// reality in either direction. Throws on anything unexpected.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dir, "../..");
const lock = JSON.parse(readFileSync(resolve(root, "ci-cd/models.lock.json"), "utf8"));

if (lock.schema !== 1) throw new Error(`unsupported lock schema: ${lock.schema}`);
if (!Array.isArray(lock.models) || lock.models.length === 0) throw new Error("lock has no models");

const normalize = (n: string) => (n.includes(":") ? n : `${n}:latest`);
const seen = new Set<string>();
for (const m of lock.models) {
  if (typeof m.name !== "string" || !m.name) throw new Error("model entry without a name");
  if (!/^[0-9a-f]{64}$/.test(m.manifest_sha256 ?? "")) {
    throw new Error(`${m.name}: manifest_sha256 must be 64 lowercase hex chars`);
  }
  const key = normalize(m.name);
  if (seen.has(key)) throw new Error(`duplicate model in lock: ${key}`);
  seen.add(key);
}

// Models the deployed system references, read from the config files.
const referenced = new Set<string>();
const litellm = readFileSync(resolve(root, "gateway/litellm_config.yaml"), "utf8");
for (const m of litellm.matchAll(/^\s*model:\s*ollama\/(\S+)\s*$/gm)) referenced.add(normalize(m[1]));
const env = readFileSync(resolve(root, "rag-app/.env.example"), "utf8");
for (const key of ["EMBED_MODEL", "GUARDRAIL_MODEL"]) {
  const m = env.match(new RegExp(`^${key}=(\\S+)`, "m"));
  if (!m) throw new Error(`${key} not found in rag-app/.env.example`);
  referenced.add(normalize(m[1]));
}
if (referenced.size < 4) throw new Error(`expected >=4 referenced models, found ${referenced.size}: ${[...referenced]}`);

const missing = [...referenced].filter((n) => !seen.has(n));
const stale = [...seen].filter((n) => !referenced.has(n));
if (missing.length || stale.length) {
  throw new Error(`lock/config drift. In config but not locked: [${missing}]. Locked but not in config: [${stale}]`);
}
console.log(`OK: ${seen.size} models locked, exactly matching the models the config references.`);
