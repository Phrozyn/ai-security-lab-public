// Lists the gate results in which the app's leak guard replaced the model's
// answer, from a promptfoo JSON output file written by
// `promptfoo eval -c ci-cd/redteam/promptfooconfig.yaml -o <file>`. Each such
// answer is one the model alone returned with a reproduction of the system
// prompt. Appends the table to $GITHUB_STEP_SUMMARY when it is set.
//
//   bun ci-cd/redteam/report-leakguard.ts <promptfoo-output.json>
//
// Throws if the file has no results, or a result lacks the provider's
// leakBlocked/rawOutput metadata and is not a provider error.

import { appendFileSync, readFileSync } from "node:fs";

type Result = {
  success?: boolean;
  error?: string;
  testCase?: { description?: string };
  response?: { metadata?: { leakBlocked?: unknown; rawOutput?: unknown } };
};

export function summarize(results: Result[]): { lines: string[]; blocked: number; total: number } {
  if (results.length === 0) throw new Error("promptfoo output has no results");
  const lines = ["| test | guard blocked | gate result |", "| --- | --- | --- |"];
  let blocked = 0;
  for (const [i, r] of results.entries()) {
    const name = r.testCase?.description ?? `result ${i}`;
    const meta = r.response?.metadata;
    if (meta === undefined || typeof meta.leakBlocked !== "boolean" || typeof meta.rawOutput !== "string") {
      // A failed assertion also sets r.error, so only a result with no
      // response at all counts as a provider error.
      if (r.response === undefined && r.error) {
        lines.push(`| ${name} | no answer (provider error) | ERROR |`);
        continue;
      }
      throw new Error(`${name}: response has no leakBlocked/rawOutput metadata; was the gate run with guarded-gateway-provider.ts?`);
    }
    if (meta.leakBlocked) blocked++;
    lines.push(`| ${name} | ${meta.leakBlocked ? "yes" : "no"} | ${r.success ? "PASS" : "FAIL"} |`);
  }
  return { lines, blocked, total: results.length };
}

if (import.meta.main) {
  const file = process.argv[2];
  if (!file) throw new Error("usage: bun ci-cd/redteam/report-leakguard.ts <promptfoo-output.json>");
  const results = JSON.parse(readFileSync(file, "utf8"))?.results?.results;
  if (!Array.isArray(results)) throw new Error(`${file} has no results.results array`);
  const { lines, blocked, total } = summarize(results);
  const text = [`App leak guard replaced ${blocked} of ${total} model answers.`, "", ...lines, ""].join("\n");
  console.log(text);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### Live gate: app leak guard\n\n${text}\n`);
}
