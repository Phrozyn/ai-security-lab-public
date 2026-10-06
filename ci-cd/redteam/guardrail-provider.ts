// promptfoo custom provider that sends the same request as guardrail_check() in
// rag-app/src/ragapp/ollama_client.py: POST {OLLAMA_BASE_URL}/api/chat with
// body {model, messages, stream: false}. sync-guardrail-prompt.ts checks the
// Python call has this endpoint and these body keys, and generates the
// messages template (prompt.guardrail.json) from it.
//
// The prompt promptfoo passes in is prompt.guardrail.json with {{role}} and
// {{content}} rendered. It must parse as a non-empty JSON array of
// {role: "user" | "assistant", content: string | {single_line: string}};
// anything else throws, so a template that promptfoo did not render as JSON
// fails the test instead of being sent. {single_line: s} is sent as
// singleLine(s), the transform _single_line() applies in ollama_client.py.
//
// Env: OLLAMA_BASE_URL (required, no default), GUARDRAIL_MODEL (default
// llama-guard3, same default as the app).
// Returns message.content stripped, as the app does before startswith("safe").

type ChatMessage = { role: "user" | "assistant"; content: string };

// The code points Python's str.isspace() accepts, which str.split() with no
// arguments splits on. sync-guardrail-prompt.test.ts compares this set with
// the Python interpreter's.
export const PY_WHITESPACE =
  "\t\n\v\f\r\x1c\x1d\x1e\x1f \x85\xa0                　";
const PY_WHITESPACE_RUN = new RegExp(`[${PY_WHITESPACE}]+`, "gu");

// Python: " ".join(text.split())
export function singleLine(text: string): string {
  return text
    .split(PY_WHITESPACE_RUN)
    .filter((s) => s !== "")
    .join(" ");
}

export function parseMessages(prompt: string): ChatMessage[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(prompt);
  } catch {
    throw new Error(`guardrail prompt is not JSON: ${JSON.stringify(prompt.slice(0, 200))}`);
  }
  if (!Array.isArray(parsed) || parsed.length === 0) throw new Error("guardrail prompt must be a non-empty JSON array of messages");
  return parsed.map((m, i) => {
    if (typeof m !== "object" || m === null) throw new Error(`messages[${i}] is not an object`);
    const keys = Object.keys(m).sort().join(",");
    if (keys !== "content,role") throw new Error(`messages[${i}] keys are ${keys}; expected content,role`);
    const { role, content } = m as Record<string, unknown>;
    if (role !== "user" && role !== "assistant") throw new Error(`messages[${i}].role is ${JSON.stringify(role)}; expected user or assistant`);
    if (typeof content === "string") return { role, content };
    if (typeof content === "object" && content !== null && Object.keys(content).join(",") === "single_line") {
      const s = (content as Record<string, unknown>).single_line;
      if (typeof s !== "string") throw new Error(`messages[${i}].content.single_line is not a string`);
      return { role, content: singleLine(s) };
    }
    throw new Error(`messages[${i}].content must be a string or {single_line: string}`);
  });
}

export default class GuardrailProvider {
  id() {
    return "guardrail-chat";
  }

  async callApi(prompt: string): Promise<{ output: string }> {
    const base = process.env.OLLAMA_BASE_URL;
    if (!base) throw new Error("OLLAMA_BASE_URL is not set");
    const model = process.env.GUARDRAIL_MODEL ?? "llama-guard3";
    const messages = parseMessages(prompt);
    const resp = await fetch(`${base.replace(/\/+$/, "")}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model, messages, stream: false }),
      signal: AbortSignal.timeout(90_000),
    });
    if (!resp.ok) throw new Error(`ollama /api/chat returned HTTP ${resp.status}`);
    const json = (await resp.json()) as { message?: { content?: unknown } };
    if (typeof json.message?.content !== "string") throw new Error("ollama /api/chat response has no string message.content");
    return { output: json.message.content.trim() };
  }
}
