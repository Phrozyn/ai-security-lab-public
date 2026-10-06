// promptfoo custom provider that sends the same request as guardrail_check() in
// rag-app/src/ragapp/ollama_client.py: POST {OLLAMA_BASE_URL}/api/generate with
// body {model, prompt, stream: false}. promptfoo's built-in ollama provider
// does not send this body, so a plain fetch is used.
//
// Env: OLLAMA_BASE_URL (required, no default), GUARDRAIL_MODEL (default
// llama-guard3, same default as the app).
// Returns the verdict text stripped, as the app does before startswith("safe").

export default class GuardrailProvider {
  id() {
    return "guardrail-generate";
  }

  async callApi(prompt: string): Promise<{ output: string }> {
    const base = process.env.OLLAMA_BASE_URL;
    if (!base) throw new Error("OLLAMA_BASE_URL is not set");
    const model = process.env.GUARDRAIL_MODEL ?? "llama-guard3";
    const resp = await fetch(`${base.replace(/\/+$/, "")}/api/generate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model, prompt, stream: false }),
      signal: AbortSignal.timeout(90_000),
    });
    if (!resp.ok) throw new Error(`ollama /api/generate returned HTTP ${resp.status}`);
    const json = (await resp.json()) as { response?: unknown };
    if (typeof json.response !== "string") throw new Error("ollama response has no string 'response' field");
    return { output: json.response.trim() };
  }
}
