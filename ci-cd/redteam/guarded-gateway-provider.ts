// promptfoo custom provider for the GATE suite: sends the chat request to the
// gateway, then applies the RAG app's system-prompt leak guard to the answer
// (leakguard_gate.py, which runs leaks() from rag-app/src/ragapp/leakguard.py
// with the values in query.py). The gate therefore tests the answer the app
// returns: an answer the guard flags becomes the app's LEAK_REFUSAL text.
//
// The raw model answer and the guard decision are kept in the response
// metadata (rawOutput, leakBlocked), so each result shows what the model
// returned without the guard. promptfooconfig.model.yaml runs the same tests
// against the model with no guard.
//
// The prompt promptfoo passes in is prompt.json rendered. It must parse as a
// non-empty JSON array of {role: "system" | "user", content: string}; anything
// else throws.
//
// Env: GATEWAY_URL and GATEWAY_VIRTUAL_KEY (required, no default),
// LEAKGUARD_PYTHON (default python3).

import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

type ChatMessage = { role: "system" | "user"; content: string };

export const MODEL = "local-gemma";
// Same settings as the openai provider in promptfooconfig.model.yaml; see the
// max_tokens comment there.
export const TEMPERATURE = 0;
export const MAX_TOKENS = 1600;

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

  async callApi(prompt: string): Promise<{ output: string; metadata: { rawOutput: string; leakBlocked: boolean } }> {
    const base = process.env.GATEWAY_URL;
    if (!base) throw new Error("GATEWAY_URL is not set");
    const key = process.env.GATEWAY_VIRTUAL_KEY;
    if (!key) throw new Error("GATEWAY_VIRTUAL_KEY is not set");
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
    return { output: guard.output, metadata: { rawOutput: content, leakBlocked: guard.blocked } };
  }
}
