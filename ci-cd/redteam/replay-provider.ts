// promptfoo custom provider for the MODEL-ONLY suite: returns the raw model
// answer that the gate run recorded for the same test
// (guarded-gateway-provider.ts with REDTEAM_RECORD set), with no leak guard.
// Both suites therefore score one generation per test, and this suite makes no
// model or network call.
//
// Records are looked up by test description. The sha256 of the prompt
// promptfoo renders here must equal the one the gate recorded, so a replay
// against a changed prompt.json or tests.yaml throws. A missing file, a
// malformed or duplicate record, or a test with no record also throws;
// promptfoo reports each throw as an error result, and report-leakguard.ts
// fails on any such result.
//
// Env: REDTEAM_REPLAY (required): the file the gate run wrote to REDTEAM_RECORD.

import { readFileSync } from "node:fs";
import { type AnswerRecord, promptSha256, testDescription } from "./guarded-gateway-provider.ts";

const RECORD_KEYS = "description,leakBlocked,output,promptSha256,rawOutput";

export function loadRecords(path: string): Map<string, AnswerRecord> {
  const lines = readFileSync(path, "utf8").split("\n");
  if (lines.at(-1) === "") lines.pop();
  if (lines.length === 0) throw new Error(`${path} has no recorded answers`);
  const records = new Map<string, AnswerRecord>();
  for (const [i, line] of lines.entries()) {
    const where = `${path} line ${i + 1}`;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      throw new Error(`${where} is not JSON`);
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error(`${where} is not an object`);
    const keys = Object.keys(parsed).sort().join(",");
    if (keys !== RECORD_KEYS) throw new Error(`${where} keys are ${keys}; expected ${RECORD_KEYS}`);
    const r = parsed as Record<string, unknown>;
    if (typeof r.description !== "string" || r.description === "") throw new Error(`${where} description is not a non-empty string`);
    if (typeof r.promptSha256 !== "string" || !/^[0-9a-f]{64}$/.test(r.promptSha256)) throw new Error(`${where} promptSha256 is not a sha256 hex digest`);
    if (typeof r.rawOutput !== "string" || typeof r.output !== "string") throw new Error(`${where} rawOutput and output must be strings`);
    if (typeof r.leakBlocked !== "boolean") throw new Error(`${where} leakBlocked is not a boolean`);
    if (records.has(r.description)) throw new Error(`${where} repeats description ${JSON.stringify(r.description)}`);
    records.set(r.description, r as AnswerRecord);
  }
  return records;
}

export default class ReplayProvider {
  private records: Map<string, AnswerRecord> | undefined;

  id() {
    return "replay-gate-raw-answers";
  }

  async callApi(prompt: string, context?: unknown): Promise<{ output: string; metadata: { replayed: true; promptSha256: string } }> {
    const path = process.env.REDTEAM_REPLAY;
    if (!path) throw new Error("REDTEAM_REPLAY is not set");
    this.records ??= loadRecords(path);
    const description = testDescription(context);
    const record = this.records.get(description);
    if (record === undefined) throw new Error(`${path} has no recorded answer for ${JSON.stringify(description)}`);
    const sha = promptSha256(prompt);
    if (record.promptSha256 !== sha) throw new Error(`prompt for ${JSON.stringify(description)} differs from the one the gate run recorded`);
    return { output: record.rawOutput, metadata: { replayed: true, promptSha256: sha } };
  }
}
