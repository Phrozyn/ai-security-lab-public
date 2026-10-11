// Raw and guarded verdicts per test from one redteam-live run, read from the
// promptfoo JSON output files of the gate (promptfooconfig.yaml, run with
// REDTEAM_RECORD) and of the model-only suite (promptfooconfig.model.yaml,
// which replays the gate's raw answers). For each test it prints the
// model-only verdict, whether the app's leak guard replaced the answer, and
// the gate verdict, after checking that the model-only suite scored the exact
// raw answer the gate's guard saw. Prints verdicts only, never answer text.
// Appends the table to $GITHUB_STEP_SUMMARY when it is set.
//
//   bun ci-cd/redteam/report-leakguard.ts <gate-output.json> <model-output.json>
//
// The exit code does not depend on the verdicts: a model-only FAIL is
// information, and the gate step fails the job on its own. It throws (exit 1)
// when the two files do not describe the same tests and the same answers, or
// when the model-only suite has an error result (a replay fault).

import { appendFileSync, readFileSync } from "node:fs";

export type Result = {
  success?: boolean;
  error?: string;
  testCase?: { description?: string };
  response?: { output?: unknown; metadata?: { leakBlocked?: unknown; rawOutput?: unknown } };
};

function byDescription(results: Result[], suite: string): Map<string, Result> {
  if (results.length === 0) throw new Error(`${suite} output has no results`);
  const map = new Map<string, Result>();
  for (const [i, r] of results.entries()) {
    const name = r.testCase?.description;
    if (typeof name !== "string" || name === "") throw new Error(`${suite} result ${i} has no test description`);
    if (map.has(name)) throw new Error(`${suite} output has two results for ${JSON.stringify(name)}`);
    if (typeof r.success !== "boolean") throw new Error(`${suite} result for ${JSON.stringify(name)} has no boolean success field`);
    map.set(name, r);
  }
  return map;
}

export function contrast(gateResults: Result[], modelResults: Result[]) {
  const gate = byDescription(gateResults, "gate");
  const model = byDescription(modelResults, "model-only");
  const onlyGate = [...gate.keys()].filter((n) => !model.has(n));
  const onlyModel = [...model.keys()].filter((n) => !gate.has(n));
  if (onlyGate.length || onlyModel.length) {
    throw new Error(`the two outputs list different tests (gate only: ${JSON.stringify(onlyGate)}; model-only only: ${JSON.stringify(onlyModel)})`);
  }
  const lines = ["| test | model alone | guard replaced answer | gate |", "| --- | --- | --- | --- |"];
  let blocked = 0;
  let modelFailed = 0;
  let gateFailed = 0;
  for (const [name, g] of gate) {
    const m = model.get(name)!;
    const verdict = (r: Result) => (r.success ? "PASS" : "FAIL");
    // Markdown table cell: a | in a description would split the row.
    const cell = name.replaceAll("|", "\\|");
    if (g.response === undefined) {
      // A failed assertion also sets error, so only a result with no response
      // is a provider error. The gate recorded nothing for it, so the
      // model-only suite must have failed with the replay provider's
      // no-record error and nothing else.
      if (!g.error) throw new Error(`gate result for ${JSON.stringify(name)} has neither a response nor an error`);
      if (m.response !== undefined) throw new Error(`model-only suite has an answer for ${JSON.stringify(name)}, for which the gate got none`);
      if (!m.error?.includes("has no recorded answer")) {
        throw new Error(`model-only result for ${JSON.stringify(name)} should be the no-record error; got ${JSON.stringify(m.error ?? null)}`);
      }
      gateFailed++;
      lines.push(`| ${cell} | no answer | no answer (provider error) | ERROR |`);
      continue;
    }
    const meta = g.response.metadata;
    if (meta === undefined || typeof meta.leakBlocked !== "boolean" || typeof meta.rawOutput !== "string") {
      throw new Error(`gate result for ${JSON.stringify(name)} has no leakBlocked/rawOutput metadata; was the gate run with guarded-gateway-provider.ts?`);
    }
    if (m.response === undefined) throw new Error(`model-only suite did not score ${JSON.stringify(name)}: ${m.error ?? "no response and no error"}`);
    if (m.response.output !== meta.rawOutput) throw new Error(`model-only answer for ${JSON.stringify(name)} is not the raw answer the gate recorded`);
    if (meta.leakBlocked) blocked++;
    if (!m.success) modelFailed++;
    if (!g.success) gateFailed++;
    lines.push(`| ${cell} | ${verdict(m)} | ${meta.leakBlocked ? "yes" : "no"} | ${verdict(g)} |`);
  }
  return { lines, total: gate.size, blocked, modelFailed, gateFailed };
}

function readResults(file: string): Result[] {
  const results = JSON.parse(readFileSync(file, "utf8"))?.results?.results;
  if (!Array.isArray(results)) throw new Error(`${file} has no results.results array`);
  return results;
}

if (import.meta.main) {
  const [gateFile, modelFile] = process.argv.slice(2);
  if (!gateFile || !modelFile) throw new Error("usage: bun ci-cd/redteam/report-leakguard.ts <gate-output.json> <model-output.json>");
  const { lines, total, blocked, modelFailed, gateFailed } = contrast(readResults(gateFile), readResults(modelFile));
  const text = [
    `One model answer per test, scored twice. Model alone: ${modelFailed} of ${total} failed. App leak guard replaced ${blocked} of ${total} answers. Gate: ${gateFailed} of ${total} failed.`,
    "",
    ...lines,
    "",
  ].join("\n");
  console.log(text);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### Live red-team: raw and guarded verdicts\n\n${text}\n`);
}
