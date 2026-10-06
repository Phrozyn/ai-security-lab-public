// Builds prompt.guardrail.json for the guardrail suite from guardrail_check() in
// rag-app/src/ragapp/ollama_client.py, so the suite sends the messages the app
// sends and not a copy of them.
//
// guardrail_check() makes one httpx.post() to {OLLAMA_BASE_URL}/api/chat with
// json={"model": GUARDRAIL_MODEL, "messages": [...], "stream": False}. This
// script parses that call and checks the endpoint and body keys match what
// guardrail-provider.ts sends. The messages list is written out as a promptfoo
// chat prompt, with the Python variables role and content becoming the
// promptfoo variables {{role}} and {{content}}. A message content of
// _single_line(content) is written as {"single_line": "{{content}}"}, which
// guardrail-provider.ts applies with its singleLine(); the body of the Python
// _single_line() must equal SINGLE_LINE_BODY below.
//
//   bun ci-cd/redteam/sync-guardrail-prompt.ts           # (re)generate prompt.guardrail.json
//   bun ci-cd/redteam/sync-guardrail-prompt.ts --check   # CI: exit 1 if the file drifted
//
// Env GUARDRAIL_SOURCE_PATH overrides the Python source path and
// GUARDRAIL_PROMPT_PATH the output path (used by sync-guardrail-prompt.test.ts
// to test drift and parse failures against temp copies).
//
// Throws on any Python syntax or request shape it does not parse. It never
// falls back to a partial or default template.

import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const sourcePath = process.env.GUARDRAIL_SOURCE_PATH
  ? resolve(process.env.GUARDRAIL_SOURCE_PATH)
  : resolve(import.meta.dir, "../../rag-app/src/ragapp/ollama_client.py");
const target = process.env.GUARDRAIL_PROMPT_PATH
  ? resolve(process.env.GUARDRAIL_PROMPT_PATH)
  : resolve(import.meta.dir, "prompt.guardrail.json");

// The request guardrail-provider.ts sends. The parsed Python call must match it.
const ENDPOINT = "/api/chat";
const BODY_KEYS = ["messages", "model", "stream"];
const MODEL_IDENT = "GUARDRAIL_MODEL";
const VARS: Record<string, string> = { role: "{{role}}", content: "{{content}}" };
// The one supported transform. singleLine() in guardrail-provider.ts mirrors it.
const SINGLE_LINE_FN = "_single_line";
const SINGLE_LINE_BODY = 'return " ".join(text.split())';

// ---------- a small parser for the Python expression subset used in the call ----------

type Expr =
  | { t: "str"; v: string }
  | { t: "fstr"; parts: (string | { ident: string })[] }
  | { t: "ident"; v: string }
  | { t: "const"; v: boolean | null }
  | { t: "num"; v: number }
  | { t: "list"; items: Expr[] }
  | { t: "dict"; entries: [Expr, Expr][] }
  | { t: "call"; fn: string; args: Expr[] };

type Tok = { k: "str" | "fstr" | "ident" | "num" | "punct"; v: string };

function tokenize(s: string): Tok[] {
  const toks: Tok[] = [];
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === " " || c === "\n" || c === "\t" || c === "\r") {
      i++;
    } else if (c === "#") {
      while (i < s.length && s[i] !== "\n") i++;
    } else if (c === '"' || ((c === "f" || c === "F") && s[i + 1] === '"')) {
      const isF = c !== '"';
      i += isF ? 2 : 1;
      if (s.startsWith('""', i)) throw new Error("triple-quoted strings are not supported in the httpx.post() call");
      let body = "";
      for (;;) {
        if (i >= s.length || s[i] === "\n") throw new Error("unterminated string literal in the httpx.post() call");
        if (s[i] === '"') break;
        if (s[i] === "\\") {
          const e = s[i + 1];
          if (e === "n") body += "\n";
          else if (e === "\\" || e === '"' || e === "'") body += e;
          else throw new Error(`unsupported escape \\${e} in the httpx.post() call`);
          i += 2;
        } else {
          body += s[i++];
        }
      }
      i++;
      toks.push({ k: isF ? "fstr" : "str", v: body });
    } else if (c === "'") {
      throw new Error("single-quoted strings are not supported in the httpx.post() call");
    } else if (/[A-Za-z_]/.test(c)) {
      let j = i;
      while (j < s.length && /[A-Za-z0-9_]/.test(s[j])) j++;
      toks.push({ k: "ident", v: s.slice(i, j) });
      i = j;
    } else if (/[0-9]/.test(c)) {
      let j = i;
      while (j < s.length && /[0-9]/.test(s[j])) j++;
      if (/[A-Za-z0-9_.]/.test(s[j] ?? "")) throw new Error("only integer literals are supported in the httpx.post() call");
      toks.push({ k: "num", v: s.slice(i, j) });
      i = j;
    } else if ("{}[]():,=".includes(c)) {
      toks.push({ k: "punct", v: c });
      i++;
    } else {
      throw new Error(`unsupported character ${JSON.stringify(c)} in the httpx.post() call`);
    }
  }
  return toks;
}

function parseFString(body: string): Expr {
  const parts: (string | { ident: string })[] = [];
  const re = /\{([^{}]*)\}|([^{}]+)|(\{|\})/g;
  for (const m of body.matchAll(re)) {
    if (m[3]) throw new Error(`unbalanced brace in f-string ${JSON.stringify(body)}`);
    if (m[2] !== undefined) parts.push(m[2]);
    else if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(m[1])) parts.push({ ident: m[1] });
    else throw new Error(`unsupported f-string expression {${m[1]}}`);
  }
  return { t: "fstr", parts };
}

class Parser {
  i = 0;
  constructor(readonly toks: Tok[]) {}
  peek(): Tok | undefined {
    return this.toks[this.i];
  }
  next(): Tok {
    const t = this.toks[this.i++];
    if (!t) throw new Error("unexpected end of the httpx.post() call");
    return t;
  }
  isPunct(v: string): boolean {
    const t = this.peek();
    return t?.k === "punct" && t.v === v;
  }
  expect(v: string) {
    const t = this.next();
    if (t.k !== "punct" || t.v !== v) throw new Error(`expected ${JSON.stringify(v)} in the httpx.post() call, got ${JSON.stringify(t.v)}`);
  }
  expr(): Expr {
    const t = this.next();
    if (t.k === "str") {
      let v = t.v;
      // Adjacent plain string literals concatenate, as in Python.
      while (this.peek()?.k === "str") v += this.next().v;
      if (this.peek()?.k === "fstr") throw new Error("mixing plain and f-string literals is not supported");
      return { t: "str", v };
    }
    if (t.k === "fstr") {
      if (this.peek()?.k === "str" || this.peek()?.k === "fstr") throw new Error("concatenated f-strings are not supported");
      return parseFString(t.v);
    }
    if (t.k === "num") return { t: "num", v: Number(t.v) };
    if (t.k === "ident") {
      if (this.isPunct("(") && t.v === SINGLE_LINE_FN) {
        this.expect("(");
        const args: Expr[] = [];
        while (!this.isPunct(")")) {
          args.push(this.expr());
          if (!this.isPunct(")")) this.expect(",");
        }
        this.expect(")");
        return { t: "call", fn: t.v, args };
      }
      if (this.isPunct("(") || this.isPunct("[")) throw new Error(`calls and subscripts are not supported (at ${t.v})`);
      if (t.v === "True") return { t: "const", v: true };
      if (t.v === "False") return { t: "const", v: false };
      if (t.v === "None") return { t: "const", v: null };
      return { t: "ident", v: t.v };
    }
    if (t.v === "[") {
      const items: Expr[] = [];
      while (!this.isPunct("]")) {
        items.push(this.expr());
        if (!this.isPunct("]")) this.expect(",");
      }
      this.expect("]");
      return { t: "list", items };
    }
    if (t.v === "{") {
      const entries: [Expr, Expr][] = [];
      while (!this.isPunct("}")) {
        const key = this.expr();
        this.expect(":");
        entries.push([key, this.expr()]);
        if (!this.isPunct("}")) this.expect(",");
      }
      this.expect("}");
      return { t: "dict", entries };
    }
    throw new Error(`unsupported token ${JSON.stringify(t.v)} in the httpx.post() call`);
  }
  // Call arguments up to the closing paren: positional, then name=expr.
  args(): { positional: Expr[]; keywords: Map<string, Expr> } {
    const positional: Expr[] = [];
    const keywords = new Map<string, Expr>();
    while (!this.isPunct(")")) {
      const t = this.peek();
      if (t?.k === "ident" && this.toks[this.i + 1]?.k === "punct" && this.toks[this.i + 1].v === "=") {
        this.i += 2;
        if (keywords.has(t.v)) throw new Error(`duplicate keyword argument ${t.v}`);
        keywords.set(t.v, this.expr());
      } else {
        if (keywords.size > 0) throw new Error("positional argument after keyword argument");
        positional.push(this.expr());
      }
      if (!this.isPunct(")")) this.expect(",");
    }
    this.expect(")");
    if (this.i !== this.toks.length) throw new Error("trailing tokens after the httpx.post() call");
    return { positional, keywords };
  }
}

// ---------- extraction ----------

// Body (indented lines) of a top-level def; throws unless exactly one exists.
function functionBody(src: string, name: string): string {
  const re = new RegExp(`^def ${name}\\([^)]*\\)[^:\\n]*:\\n((?:(?:    .*|[ \\t]*)\\n)*)`, "gm");
  const found = [...src.matchAll(re)];
  if (found.length !== 1) throw new Error(`expected exactly one def ${name}() in ${sourcePath}, found ${found.length}`);
  return found[0][1];
}

// The code of _single_line() with its docstring removed must be SINGLE_LINE_BODY.
function checkSingleLine(src: string) {
  if (!/^def _single_line\(text: str\) -> str:$/m.test(src)) {
    throw new Error("def _single_line(text: str) -> str: not found; guardrail-provider.ts singleLine() mirrors that signature");
  }
  const body = functionBody(src, SINGLE_LINE_FN);
  const code = body
    .replace(/^\s*"""[\s\S]*?"""\s*\n/, "")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l !== "" && !l.startsWith("#"));
  if (code.length !== 1 || code[0] !== SINGLE_LINE_BODY) {
    throw new Error(
      `${SINGLE_LINE_FN}() body is ${JSON.stringify(code)}; expected [${JSON.stringify(SINGLE_LINE_BODY)}]. ` +
        "If the transform changed, change singleLine() in guardrail-provider.ts and SINGLE_LINE_BODY here to match.",
    );
  }
}

type OutMessage = { role: string; content: string | { single_line: string } };

export function extractMessages(src: string): string {
  const body = functionBody(src, "guardrail_check");

  if (/\/api\/generate/.test(body)) throw new Error("guardrail_check() references /api/generate; the suite only models /api/chat");
  const calls = [...body.matchAll(/httpx\.post\(/g)];
  if (calls.length !== 1) throw new Error(`expected exactly one httpx.post( in guardrail_check(), found ${calls.length}`);
  if (/httpx\.(get|put|patch|request|stream|Client|AsyncClient)\b/.test(body)) {
    throw new Error("guardrail_check() makes an httpx call other than httpx.post(); refusing to model it");
  }

  // Slice out the argument text up to the matching close paren, skipping strings and comments.
  const start = calls[0].index! + "httpx.post(".length;
  let depth = 1;
  let i = start;
  for (; i < body.length && depth > 0; i++) {
    const c = body[i];
    if (c === '"') {
      i++;
      while (i < body.length && body[i] !== '"') i += body[i] === "\\" ? 2 : 1;
    } else if (c === "#") {
      while (i < body.length && body[i] !== "\n") i++;
    } else if ("([{".includes(c)) depth++;
    else if (")]}".includes(c)) depth--;
  }
  if (depth !== 0) throw new Error("unbalanced httpx.post( call in guardrail_check()");
  const argText = body.slice(start, i);

  const { positional, keywords } = new Parser(tokenize(argText)).args();

  // URL: f"{OLLAMA_BASE_URL}/api/chat"
  const url = positional[0];
  if (
    positional.length !== 1 ||
    url.t !== "fstr" ||
    url.parts.length !== 2 ||
    typeof url.parts[0] === "string" ||
    url.parts[0].ident !== "OLLAMA_BASE_URL" ||
    url.parts[1] !== ENDPOINT
  ) {
    throw new Error(`httpx.post() URL must be f"{OLLAMA_BASE_URL}${ENDPOINT}" and the only positional argument`);
  }

  for (const k of keywords.keys()) {
    if (k !== "json" && k !== "timeout") throw new Error(`unsupported httpx.post() keyword argument ${k}=; the provider does not send it`);
  }
  const json = keywords.get("json");
  if (!json || json.t !== "dict") throw new Error("httpx.post() must pass json= as a dict literal");

  const fields = new Map<string, Expr>();
  for (const [k, v] of json.entries) {
    if (k.t !== "str") throw new Error("request body keys must be string literals");
    if (fields.has(k.v)) throw new Error(`duplicate request body key ${k.v}`);
    fields.set(k.v, v);
  }
  const keys = [...fields.keys()].sort();
  if (JSON.stringify(keys) !== JSON.stringify(BODY_KEYS)) {
    throw new Error(`request body keys are ${JSON.stringify(keys)}; guardrail-provider.ts sends ${JSON.stringify(BODY_KEYS)}`);
  }
  const model = fields.get("model")!;
  if (model.t !== "ident" || model.v !== MODEL_IDENT) throw new Error(`request body "model" must be ${MODEL_IDENT}`);
  const stream = fields.get("stream")!;
  if (stream.t !== "const" || stream.v !== false) throw new Error('request body "stream" must be False');

  const messages = fields.get("messages")!;
  if (messages.t !== "list" || messages.items.length === 0) throw new Error('request body "messages" must be a non-empty list literal');

  const used = new Set<string>();
  const toValue = (e: Expr, where: string): string => {
    if (e.t === "ident") {
      const v = VARS[e.v];
      if (!v) throw new Error(`unsupported variable ${e.v} in ${where}; only ${Object.keys(VARS).join(", ")} map to promptfoo vars`);
      used.add(e.v);
      return v;
    }
    if (e.t === "str") {
      if (/\{\{|\}\}|\{%|%\}/.test(e.v)) throw new Error(`string literal in ${where} contains promptfoo/nunjucks syntax`);
      return e.v;
    }
    throw new Error(`unsupported expression in ${where}; expected a string literal or variable`);
  };

  let singleLineUsed = false;
  const out: OutMessage[] = messages.items.map((m, n) => {
    if (m.t !== "dict") throw new Error(`messages[${n}] must be a dict literal`);
    let role: string | undefined;
    let content: OutMessage["content"] | undefined;
    for (const [k, v] of m.entries) {
      if (k.t !== "str" || (k.v !== "role" && k.v !== "content")) throw new Error(`messages[${n}] has unsupported key; only "role" and "content" are modelled`);
      const where = `messages[${n}].${k.v}`;
      if (k.v === "role") {
        if (role !== undefined) throw new Error(`messages[${n}] has duplicate key role`);
        role = toValue(v, where);
      } else {
        if (content !== undefined) throw new Error(`messages[${n}] has duplicate key content`);
        if (v.t === "call") {
          if (v.args.length !== 1) throw new Error(`${SINGLE_LINE_FN}() in ${where} must take exactly one argument`);
          content = { single_line: toValue(v.args[0], where) };
          singleLineUsed = true;
        } else {
          content = toValue(v, where);
        }
      }
    }
    if (role === undefined || content === undefined) throw new Error(`messages[${n}] must have "role" and "content"`);
    return { role, content };
  });
  if (singleLineUsed) checkSingleLine(src);
  for (const v of Object.keys(VARS)) {
    if (!used.has(v)) throw new Error(`messages never use the variable ${v}`);
  }
  return `${JSON.stringify(out, null, 2)}\n`;
}

if (import.meta.main) {
  const out = extractMessages(readFileSync(sourcePath, "utf8"));
  if (process.argv.includes("--check")) {
    let current: string;
    try {
      current = readFileSync(target, "utf8");
    } catch {
      console.error(`${target} is missing. Run: bun ci-cd/redteam/sync-guardrail-prompt.ts`);
      process.exit(1);
    }
    if (current !== out) {
      console.error(`${target} has drifted from guardrail_check() in ollama_client.py. Run: bun ci-cd/redteam/sync-guardrail-prompt.ts`);
      process.exit(1);
    }
    console.log("OK: prompt.guardrail.json matches guardrail_check() in ollama_client.py.");
  } else {
    writeFileSync(target, out);
    console.log(`wrote ${target}`);
  }
}
