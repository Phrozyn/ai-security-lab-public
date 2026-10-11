// promptfoo custom provider for the GATE suite: sends the chat request to the
// gateway, then applies the RAG app's system-prompt leak guard to the answer
// (leakguard_gate.py, which runs leaks() from rag-app/src/ragapp/leakguard.py
// with the values in query.py). The gate therefore tests the answer the app
// returns: an answer the guard flags becomes the app's LEAK_REFUSAL text.
//
// The raw model answer and the guard decision are kept in the response
// metadata (rawOutput, leakBlocked), so each result shows what the model
// returned without the guard.
//
// With REDTEAM_RECORD set to a file path, each call also appends one JSON line
// {description, promptSha256, rawOutput, output, leakBlocked} to that file.
// promptfooconfig.model.yaml replays the raw answers from it
// (replay-provider.ts), so the model-only suite scores the same generation
// the gate scored. The file must not exist when the run starts, and each test
// description may be recorded once; either fault throws.
//
// The prompt promptfoo passes in is prompt.json rendered. It must parse as a
// non-empty JSON array of {role: "system" | "user", content: string}; anything
// else throws.
//
// Env: GATEWAY_URL and GATEWAY_VIRTUAL_KEY (required, no default),
// LEAKGUARD_PYTHON (default python3), REDTEAM_RECORD (optional).

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, closeSync, openSync } from "node:fs";
import { resolve } from "node:path";

type ChatMessage = { role: "system" | "user"; content: string };

export const MODEL = "local-gemma";
export const TEMPERATURE = 0;
// gemma4:e2b is a thinking model: a small budget is spent entirely on
// reasoning and returns empty content (which would pass every not-icontains).
// Completion tokens for this suite peaked at 644 of 800 until 2026-10-06, then
// two runs reached 800 and the fence-breakout test with a re-opened fake
// retrieved_context failed the non-empty check. 1600 leaves headroom.
export const MAX_TOKENS = 1600;

export type AnswerRecord = {
  description: string;
  promptSha256: string;
  rawOutput: string;
  output: string;
  leakBlocked: boolean;
};

export function promptSha256(prompt: string): string {
  return createHash("sha256").update(prompt).digest("hex");
}

export function testDescription(context: unknown): string {
  const description = (context as { test?: { description?: unknown } } | undefined)?.test?.description;
  if (typeof description !== "string" || description === "") throw new Error("promptfoo passed no test description; recorded answers are keyed on it");
  return description;
}

// Descriptions recorded per file in this process. All checks and writes are
// synchronous, so concurrent callApi calls cannot interleave between them.
const recorded = new Map<string, Set<string>>();

// Creates the record file on the first call for a path. Called before the
// gateway request, so a file left from an earlier run costs no model call.
export function openRecordFile(path: string): Set<string> {
  let seen = recorded.get(path);
  if (seen === undefined) {
    try {
      closeSync(openSync(path, "wx"));
    } catch (e) {
      throw new Error(`cannot create REDTEAM_RECORD file ${path} (it must not exist when the run starts): ${(e as Error).message}`);
    }
    seen = new Set();
    recorded.set(path, seen);
  }
  return seen;
}

export function recordAnswer(path: string, record: AnswerRecord): void {
  const seen = openRecordFile(path);
  if (seen.has(record.description)) throw new Error(`test description ${JSON.stringify(record.description)} recorded twice; descriptions must be unique`);
  seen.add(record.description);
  appendFileSync(path, `${JSON.stringify(record)}\n`);
}

const GATE_SCRIPT = resolve(import.meta.dirname, "leakguard_gate.py");

export function parseMessages(prompt: string): ChatMessage[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(prompt);
  } catch {
    throw new Error(`gate prompt is not JSON: ${JSON.stringify(prompt.slice(0, 200))}`);
  }
  if (!Array.isArray(parsed) || parsed.length === 0) throw new Error("gate prompt must be a non-empty JSON array of messages");
  return parsed.map((m, i) => {
    if (typeof m !== "object" || m === null) throw new Error(`messages[${i}] is not an object`);
    const keys = Object.keys(m).sort().join(",");
    if (keys !== "content,role") throw new Error(`messages[${i}] keys are ${keys}; expected content,role`);
    const { role, content } = m as Record<string, unknown>;
    if (role !== "system" && role !== "user") throw new Error(`messages[${i}].role is ${JSON.stringify(role)}; expected system or user`);
    if (typeof content !== "string") throw new Error(`messages[${i}].content is not a string`);
    return { role, content };
  });
}

export type GuardResult = { blocked: boolean; output: string };

export function applyLeakGuard(answer: string, python = process.env.LEAKGUARD_PYTHON ?? "python3"): GuardResult {
  const run = spawnSync(python, ["-I", GATE_SCRIPT], {
    input: JSON.stringify({ answer }),
    encoding: "utf8",
    timeout: 60_000,
  });
  if (run.error) throw new Error(`leakguard_gate.py did not run (${python}): ${run.error.message}`);
  if (run.status !== 0) throw new Error(`leakguard_gate.py exited ${run.status}: ${run.stderr.trim()}`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(run.stdout);
  } catch {
    throw new Error(`leakguard_gate.py printed non-JSON: ${JSON.stringify(run.stdout.slice(0, 200))}`);
  }
  const r = parsed as Record<string, unknown>;
  if (typeof r !== "object" || r === null || typeof r.blocked !== "boolean" || typeof r.output !== "string") {
    throw new Error(`leakguard_gate.py output has the wrong shape: ${run.stdout.slice(0, 200)}`);
  }
  return { blocked: r.blocked, output: r.output };
}

export default class GuardedGatewayProvider {
  id() {
    return "guarded-gateway";
  }

  async callApi(prompt: string, context?: unknown): Promise<{ output: string; metadata: { rawOutput: string; leakBlocked: boolean } }> {
    const base = process.env.GATEWAY_URL;
    if (!base) throw new Error("GATEWAY_URL is not set");
    const key = process.env.GATEWAY_VIRTUAL_KEY;
    if (!key) throw new Error("GATEWAY_VIRTUAL_KEY is not set");
    const recordPath = process.env.REDTEAM_RECORD;
    // Checked before the request so these faults cost no model call.
    const description = recordPath ? testDescription(context) : undefined;
    if (recordPath) openRecordFile(recordPath);
    const messages = parseMessages(prompt);
    const resp = await fetch(`${base.replace(/\/+$/, "")}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
      body: JSON.stringify({ model: MODEL, messages, temperature: TEMPERATURE, max_tokens: MAX_TOKENS }),
      signal: AbortSignal.timeout(600_000),
    });
    if (!resp.ok) throw new Error(`gateway /v1/chat/completions returned HTTP ${resp.status}`);
    const json = (await resp.json()) as { choices?: { message?: { content?: unknown } }[] };
    const content = json.choices?.[0]?.message?.content;
    if (typeof content !== "string") throw new Error("gateway response has no string choices[0].message.content");
    const guard = applyLeakGuard(content);
    if (recordPath && description !== undefined) {
      recordAnswer(recordPath, { description, promptSha256: promptSha256(prompt), rawOutput: content, output: guard.output, leakBlocked: guard.blocked });
    }
    return { output: guard.output, metadata: { rawOutput: content, leakBlocked: guard.blocked } };
  }
}
