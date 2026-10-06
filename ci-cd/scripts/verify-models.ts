// Deploy-time check: compare the models a live Ollama actually serves against
// ci-cd/models.lock.json. Run it on the host (LLM_HOST) or through an ssh tunnel:
//
//   OLLAMA_URL=http://127.0.0.1:11434 bun ci-cd/scripts/verify-models.ts
//
// Exit 1 on any digest mismatch or missing locked model. Models present in
// Ollama but absent from the lock are reported (they are unvetted), and fail
// the run only with --strict.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const url = process.env.OLLAMA_URL ?? "http://127.0.0.1:11434";
const strict = process.argv.includes("--strict");
const lock = JSON.parse(readFileSync(resolve(import.meta.dir, "../models.lock.json"), "utf8"));

const res = await fetch(`${url}/api/tags`);
if (!res.ok) throw new Error(`GET ${url}/api/tags -> ${res.status}`);
const live = new Map<string, string>(
  ((await res.json()) as { models: { name: string; digest: string }[] }).models.map((m) => [m.name, m.digest]),
);
if (live.size === 0) throw new Error("Ollama reports zero models -- refusing to call that a pass");

let bad = 0;
for (const m of lock.models as { name: string; manifest_sha256: string }[]) {
  const got = live.get(m.name);
  if (!got) { console.error(`MISSING  ${m.name}`); bad++; continue; }
  if (got !== m.manifest_sha256) { console.error(`MISMATCH ${m.name}\n  locked ${m.manifest_sha256}\n  live   ${got}`); bad++; continue; }
  console.log(`OK       ${m.name}`);
}
const locked = new Set((lock.models as { name: string }[]).map((m) => m.name));
for (const n of live.keys()) if (!locked.has(n)) { console.warn(`UNLOCKED ${n} (served by Ollama, not in lock)`); if (strict) bad++; }

if (bad > 0) { console.error(`${bad} problem(s)`); process.exit(1); }
console.log("All locked models match the live registry digests.");
