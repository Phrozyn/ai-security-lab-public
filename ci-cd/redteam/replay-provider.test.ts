// Unit tests for the model-only suite's replay provider. No gateway or model
// needed.
//
//   bun test ci-cd/redteam/replay-provider.test.ts

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promptSha256 } from "./guarded-gateway-provider.ts";
import ReplayProvider, { loadRecords } from "./replay-provider.ts";

const prompt = readFileSync(resolve(import.meta.dir, "prompt.json"), "utf8").replace("{{user_input}}", "What is the vendor API rate limit?");
const record = (description: string, rawOutput: string, sha = promptSha256(prompt)) => ({
  description,
  promptSha256: sha,
  rawOutput,
  output: rawOutput,
  leakBlocked: false,
});
const ctx = (description: string) => ({ test: { description } });

let dir: string;
let file: string;
const write = (...lines: unknown[]) => writeFileSync(file, lines.map((l) => (typeof l === "string" ? l : JSON.stringify(l))).join("\n") + "\n");

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "redteam-replay-"));
  file = join(dir, "answers.jsonl");
  process.env.REDTEAM_REPLAY = file;
});

afterEach(() => {
  delete process.env.REDTEAM_REPLAY;
  rmSync(dir, { recursive: true, force: true });
});

describe("ReplayProvider", () => {
  test("returns the recorded raw answer, not the guarded one", async () => {
    write({ ...record("leak", "the raw leak"), output: "refused", leakBlocked: true }, record("rate", "600 per minute"));
    const p = new ReplayProvider();
    expect(await p.callApi(prompt, ctx("leak"))).toEqual({ output: "the raw leak", metadata: { replayed: true, promptSha256: promptSha256(prompt) } });
    expect((await p.callApi(prompt, ctx("rate"))).output).toBe("600 per minute");
  });

  test("throws when REDTEAM_REPLAY is not set", async () => {
    delete process.env.REDTEAM_REPLAY;
    await expect(new ReplayProvider().callApi(prompt, ctx("rate"))).rejects.toThrow("REDTEAM_REPLAY is not set");
  });

  test("throws when the file is missing", async () => {
    await expect(new ReplayProvider().callApi(prompt, ctx("rate"))).rejects.toThrow("ENOENT");
  });

  test("throws on a test with no record", async () => {
    write(record("rate", "600"));
    await expect(new ReplayProvider().callApi(prompt, ctx("other"))).rejects.toThrow('no recorded answer for "other"');
  });

  test("throws when the prompt differs from the recorded one", async () => {
    write(record("rate", "600"));
    await expect(new ReplayProvider().callApi(`${prompt} `, ctx("rate"))).rejects.toThrow("differs from the one the gate run recorded");
  });

  test("throws when promptfoo passes no description", async () => {
    write(record("rate", "600"));
    await expect(new ReplayProvider().callApi(prompt, {})).rejects.toThrow("no test description");
  });
});

describe("loadRecords", () => {
  test.each([
    ["an empty file", [""], "has no recorded answers"],
    ["a line that is not JSON", ["{"], "line 1 is not JSON"],
    ["an array", ["[]"], "line 1 is not an object"],
    ["a missing key", [{ description: "a", promptSha256: "0".repeat(64), rawOutput: "x", output: "x" }], "keys are"],
    ["an extra key", [{ ...record("a", "x"), extra: 1 }], "keys are"],
    ["a bad digest", [record("a", "x", "abc")], "not a sha256"],
    ["a non-string rawOutput", [{ ...record("a", "x"), rawOutput: 1 }], "must be strings"],
    ["a non-boolean leakBlocked", [{ ...record("a", "x"), leakBlocked: "no" }], "not a boolean"],
    ["an empty description", [record("", "x")], "description is not a non-empty string"],
    ["a repeated description", [record("a", "x"), record("a", "y")], 'line 2 repeats description "a"'],
  ])("throws on %s", (_name, lines, message) => {
    if (lines.length === 1 && lines[0] === "") writeFileSync(file, "");
    else write(...lines);
    expect(() => loadRecords(file)).toThrow(message);
  });
});

test("the replay provider makes no network call", () => {
  const src = readFileSync(resolve(import.meta.dir, "replay-provider.ts"), "utf8");
  expect(src).not.toMatch(/\bfetch\(|node:https?|node:net/);
});
