// Builds prompt.guardrail.txt for the guardrail suite from guardrail_check() in
// rag-app/src/ragapp/ollama_client.py, so the suite tests the prompt the app
// sends and not a copy of it. The Python f-string placeholders {role} and
// {content} become promptfoo variables {{role}} and {{content}}.
//
//   bun ci-cd/redteam/sync-guardrail-prompt.ts           # (re)generate prompt.guardrail.txt
//   bun ci-cd/redteam/sync-guardrail-prompt.ts --check   # CI: exit 1 if the file drifted
//
// Env GUARDRAIL_SOURCE_PATH overrides the Python source path (used to test the
// drift and extraction failures against a temp copy).
//
// Throws if the template cannot be extracted or contains anything unexpected.

import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const sourcePath = process.env.GUARDRAIL_SOURCE_PATH
  ? resolve(process.env.GUARDRAIL_SOURCE_PATH)
  : resolve(import.meta.dir, "../../rag-app/src/ragapp/ollama_client.py");
const target = resolve(import.meta.dir, "prompt.guardrail.txt");

const src = readFileSync(sourcePath, "utf8");

const fn = src.match(/def guardrail_check\([^)]*\)[^:]*:\n([\s\S]*?)(?=\ndef |\n*$)/);
if (!fn) throw new Error(`guardrail_check() not found in ${sourcePath}`);

const block = fn[1].match(/^    prompt = \(\n([\s\S]*?)\n    \)\n/m);
if (!block) throw new Error("prompt = ( ... ) block not found in guardrail_check()");

// Concatenate the adjacent string literals, decoding the escapes Python would.
let template = "";
let literalCount = 0;
for (const rawLine of block[1].split("\n")) {
  const line = rawLine.trim();
  if (line === "" || line.startsWith("#")) continue;
  const lit = line.match(/^(f?)"((?:[^"\\]|\\.)*)"$/);
  if (!lit) throw new Error(`unsupported line in prompt block: ${JSON.stringify(line)}`);
  literalCount++;
  const body = lit[2].replace(/\\(.)/g, (_m, c: string) => {
    if (c === "n") return "\n";
    if (c === "\\" || c === '"' || c === "'") return c;
    throw new Error(`unsupported escape \\${c} in prompt block`);
  });
  template += body;
}
if (literalCount === 0) throw new Error("no string literals extracted from prompt block");

// Only {role} and {content} may appear as placeholders.
const placeholders = [...template.matchAll(/\{([^{}]*)\}/g)].map((x) => x[1]);
for (const p of placeholders) {
  if (p !== "role" && p !== "content") throw new Error(`unexpected placeholder {${p}} in template`);
}
if (!placeholders.includes("role") || !placeholders.includes("content")) {
  throw new Error("template is missing {role} or {content}");
}
if (template.includes("{{") || template.includes("}}") || template.includes("{%")) {
  throw new Error("template contains promptfoo/nunjucks syntax; refusing to generate");
}
for (const marker of ["<BEGIN CONVERSATION>", "<END CONVERSATION>", "First line must read"]) {
  if (!template.includes(marker)) throw new Error(`extracted template is missing ${marker}`);
}

const out = template.replaceAll("{role}", "{{role}}").replaceAll("{content}", "{{content}}");

if (process.argv.includes("--check")) {
  let current: string;
  try {
    current = readFileSync(target, "utf8");
  } catch {
    console.error("ci-cd/redteam/prompt.guardrail.txt is missing. Run: bun ci-cd/redteam/sync-guardrail-prompt.ts");
    process.exit(1);
  }
  if (current !== out) {
    console.error(
      "ci-cd/redteam/prompt.guardrail.txt has drifted from guardrail_check() in ollama_client.py. Run: bun ci-cd/redteam/sync-guardrail-prompt.ts",
    );
    process.exit(1);
  }
  console.log("OK: prompt.guardrail.txt matches guardrail_check() in ollama_client.py.");
} else {
  writeFileSync(target, out);
  console.log("wrote ci-cd/redteam/prompt.guardrail.txt");
}
