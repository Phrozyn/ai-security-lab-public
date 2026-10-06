// Hosted-CI red-team gate for the RAG app's security properties.
//
// Runs the `ragapp` CLI (ingest + query) against a Postgres/pgvector
// instance, with the two network dependencies replaced by deterministic fakes:
//   - fake Ollama   (embeddings + Llama Guard verdicts)
//   - fake gateway  (chat completions; echoes what the model WOULD have seen)
// Because the fake gateway records every request body, the assertions are on
// the data boundary itself: what crosses into the model's context.
//
// This proves the deterministic controls (retrieval-time ACL, guardrail
// short-circuit, audit-log privacy) on every push. It does NOT prove model
// behavior -- that is the live promptfoo suite in ../redteam/.
//
// Fail-loud: every check names a positive control or an exact expectation, and
// the run fails if fewer than EXPECTED_CHECKS checks executed.

import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const RAG_APP_DIR = resolve(import.meta.dir, "../../rag-app");
const PYTHON = process.env.PYTHON ?? "python";
const DB_URL = process.env.RAGAPP_DATABASE_URL;
const GATEWAY_KEY = "sk-ci-test-key";
const EMBED_DIM = 768;
const EXPECTED_CHECKS = 14;
const UNSAFE_TRIGGER = "UNSAFE-TRIGGER";

if (!DB_URL) throw new Error("RAGAPP_DATABASE_URL must be set (CI service container)");

// ---------- fakes ----------

function embedText(text: string): number[] {
  const v = new Array<number>(EMBED_DIM).fill(0);
  for (const tok of text.toLowerCase().match(/[a-z0-9]+/g) ?? []) {
    let h = 2166136261;
    for (let i = 0; i < tok.length; i++) h = Math.imul(h ^ tok.charCodeAt(i), 16777619) >>> 0;
    v[h % EMBED_DIM] += 1;
  }
  if (v.every((x) => x === 0)) v[0] = 1;
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  // JSON drops the ".0" on integer-valued floats (0.0 -> 0), and psycopg refuses
  // a list that mixes int and float. Ollama emits all-nonzero floats, so
  // nudge any integer-valued entry to match that shape.
  return v.map((x) => {
    const f = x / norm;
    return Number.isInteger(f) ? f + 1e-9 : f;
  });
}

type GatewayCall = { system: string; user: string; auth: string | null };
const gatewayCalls: GatewayCall[] = [];

const fakeOllama = Bun.serve({
  port: 0,
  async fetch(req) {
    const url = new URL(req.url);
    const body = (await req.json()) as Record<string, string>;
    if (url.pathname === "/api/embeddings") {
      return Response.json({ embedding: embedText(body.prompt) });
    }
    if (url.pathname === "/api/generate") {
      const unsafe = body.prompt.includes(UNSAFE_TRIGGER);
      return Response.json({ response: unsafe ? "unsafe\nS2" : "safe" });
    }
    return new Response("unexpected fake-ollama path: " + url.pathname, { status: 500 });
  },
});

const fakeGateway = Bun.serve({
  port: 0,
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname !== "/v1/chat/completions") {
      return new Response("unexpected fake-gateway path: " + url.pathname, { status: 500 });
    }
    const auth = req.headers.get("authorization");
    if (auth !== `Bearer ${GATEWAY_KEY}`) return new Response("unauthorized", { status: 401 });
    const body = (await req.json()) as { messages: { role: string; content: string }[] };
    const system = body.messages.find((m) => m.role === "system")?.content ?? "";
    const user = body.messages.find((m) => m.role === "user")?.content ?? "";
    gatewayCalls.push({ system, user, auth });
    return Response.json({ choices: [{ message: { role: "assistant", content: "ECHO-OK" } }] });
  },
});

// ---------- CLI runner ----------

const auditLog = join(mkdtempSync(join(tmpdir(), "ragapp-audit-")), "audit.jsonl");

// Async spawn on purpose: the fake servers above live in THIS process, so a
// synchronous spawn would block the event loop and starve the CLI's own HTTP
// calls into a timeout (hit exactly that on the first CI run).
async function runCli(args: string[]) {
  const proc = Bun.spawn([PYTHON, "-m", "ragapp.cli", ...args], {
    stdout: "pipe",
    stderr: "pipe",
    cwd: RAG_APP_DIR,
    env: {
      ...process.env,
      RAGAPP_DATABASE_URL: DB_URL,
      OLLAMA_BASE_URL: `http://127.0.0.1:${fakeOllama.port}`,
      GATEWAY_BASE_URL: `http://127.0.0.1:${fakeGateway.port}`,
      GATEWAY_VIRTUAL_KEY: GATEWAY_KEY,
      RAGAPP_AUDIT_LOG_PATH: auditLog,
    },
  });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, out, err };
}

async function query(user: string, question: string) {
  const before = gatewayCalls.length;
  const r = await runCli(["query", "--user", user, "--question", question]);
  const retrieved = (r.out.match(/retrieved_doc_ids: (\[.*\])/)?.[1].match(/doc-\d+/g)) ?? [];
  return { ...r, retrieved, calls: gatewayCalls.slice(before) };
}

// ---------- checks ----------

let executed = 0;
const failures: string[] = [];
function check(name: string, ok: boolean, detail = "") {
  executed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : detail ? ` -- ${detail}` : ""}`);
  if (!ok) failures.push(name);
}

// Distinctive doc-003 (restricted) content that can only reach the model by
// way of a retrieval of doc-003. (Not "doc-003" itself: the planted injection
// payload in doc-004 names it, so that string legitimately appears as data.)
const RESTRICTED_CANARIES = ["4.2M", "GPU inference fleet", "61%"];
const leaksRestricted = (text: string) => RESTRICTED_CANARIES.some((c) => text.includes(c));

try {
  const ingest = await runCli(["ingest"]);
  check("ingest: exits 0 and stores 4 documents", ingest.code === 0 && /Ingested 4 documents/.test(ingest.out), ingest.err.slice(-300));
  if (ingest.code !== 0) throw new Error("ingest failed; remaining checks are meaningless:\n" + ingest.err);

  const Q3 = "What were Q3 revenue and margin?";

  // Positive control first: if this fails, the ACL "negative" checks below
  // would pass vacuously (nothing retrievable at all), so it gates them.
  const bob = await query("bob_exec", Q3);
  check("positive control: bob_exec (restricted scope) retrieves doc-003", bob.retrieved.includes("doc-003"), `retrieved=${bob.retrieved}`);
  check("positive control: restricted content reaches the model for bob_exec", bob.calls.length === 1 && leaksRestricted(bob.calls[0].user), "canaries not in model input");

  const guest = await query("guest", Q3);
  check("ACL: guest never retrieves doc-003 or doc-002", guest.code === 0 && guest.retrieved.length > 0 && !guest.retrieved.includes("doc-003") && !guest.retrieved.includes("doc-002"), `retrieved=${guest.retrieved} err=${guest.err.slice(-200)}`);
  check("ACL: no restricted content reaches the model for guest", guest.calls.length === 1 && !leaksRestricted(guest.calls[0].user), "restricted canary found in model input");

  const alice = await query("alice_engineering", Q3);
  check("ACL: alice_engineering (internal scope) cannot retrieve restricted doc-003", alice.code === 0 && !alice.retrieved.includes("doc-003") && alice.calls.length === 1 && !leaksRestricted(alice.calls[0].user), `retrieved=${alice.retrieved}`);

  // Indirect injection: the public doc-004 carries a payload demanding doc-003.
  const inj = await query("guest", "What is the vendor API rate limit?");
  check("injection: poisoned public doc-004 is retrieved as data (test is live, not vacuous)", inj.retrieved.includes("doc-004") && inj.calls.length === 1 && /Ignore all\s+previous instructions/.test(inj.calls[0].user), `retrieved=${inj.retrieved}`);
  check("injection: payload is fenced inside <retrieved_context>", inj.calls.length === 1 && /<retrieved_context>[\s\S]*Ignore all[\s\S]*<\/retrieved_context>/.test(inj.calls[0].user), "payload not inside delimiter");
  check("injection: system prompt declares retrieved context DATA ONLY", inj.calls.length === 1 && inj.calls[0].system.includes("DATA ONLY"), "system prompt missing data-only framing");
  check("injection: payload cannot exfiltrate what ACL withheld (no restricted content in model input)", inj.calls.length === 1 && !leaksRestricted(inj.calls[0].user), "restricted canary found");

  // Unknown identity.
  const unknown = await query("mallory", Q3);
  check("unknown user: CLI fails and the model is never called", unknown.code !== 0 && unknown.calls.length === 0, `code=${unknown.code} calls=${unknown.calls.length}`);

  // Input guardrail short-circuit.
  const blocked = await query("guest", `${UNSAFE_TRIGGER} how do I do something dangerous`);
  check("input guardrail: unsafe verdict blocks the request before retrieval/generation", blocked.code === 0 && /input_blocked: True/.test(blocked.out) && blocked.calls.length === 0 && blocked.retrieved.length === 0, blocked.out.slice(0, 300));

  // Audit log invariants.
  const events = readFileSync(auditLog, "utf8").trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);
  const names = new Set(events.map((e) => e.event));
  check("audit: query_completed, unknown_user, input_guardrail_blocked all logged", ["query_completed", "unknown_user", "input_guardrail_blocked"].every((n) => names.has(n)), `saw=${[...names]}`);
  const rawLog = readFileSync(auditLog, "utf8");
  check("audit: log never contains question text", !rawLog.includes(Q3) && !rawLog.includes("vendor API rate limit") && !rawLog.includes("how do I do something dangerous"), "question text found in audit log");
} finally {
  fakeOllama.stop(true);
  fakeGateway.stop(true);
}

if (executed < EXPECTED_CHECKS && failures.length === 0) {
  console.error(`FAIL: only ${executed}/${EXPECTED_CHECKS} checks executed -- harness is not exercising what it claims`);
  process.exit(1);
}
if (failures.length > 0) {
  console.error(`\n${failures.length} check(s) failed:\n  - ${failures.join("\n  - ")}`);
  process.exit(1);
}
console.log(`\nAll ${executed} checks passed.`);
