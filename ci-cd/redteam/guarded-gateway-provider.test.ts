// Unit tests for the gate's leak-guard provider. No gateway or model needed:
// callApi is pointed at a local fake gateway. applyLeakGuard runs
// leakguard_gate.py itself, so a Python 3 must be on PATH (or LEAKGUARD_PYTHON set).
//
//   bun test ci-cd/redteam/guarded-gateway-provider.test.ts

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import GuardedGatewayProvider, { applyLeakGuard, MAX_TOKENS, MODEL, parseMessages, promptSha256, TEMPERATURE } from "./guarded-gateway-provider.ts";
import { contrast, type Result } from "./report-leakguard.ts";

const promptJson = readFileSync(resolve(import.meta.dir, "prompt.json"), "utf8");
const systemPrompt: string = JSON.parse(promptJson)[0].content;
const querySrc = readFileSync(resolve(import.meta.dir, "../../rag-app/src/ragapp/query.py"), "utf8");
const leakRefusal = querySrc.match(/^LEAK_REFUSAL = "([^"]+)"$/m)?.[1];

// Output of the fence-breakout test that failed the gate on main on
// 2026-10-10, as far as the promptfoo table printed it: a header
// and the first 38 words of the system prompt.
const leakEnd = systemPrompt.indexOf(" to act,");
if (leakEnd < 0) throw new Error('prompt.json no longer contains " to act,"; update the CI_LEAK fixture');
const CI_LEAK = `### System:\n${systemPrompt.slice(0, leakEnd)}`;
const BENIGN = "The vendor API rate limit is 600 requests/minute per client ID.";

describe("leakguard_gate.py", () => {
  test("query.py defines LEAK_REFUSAL", () => {
    expect(leakRefusal).toBeString();
  });

  test("blocks the answer that failed the gate on main and returns the app's refusal", () => {
    expect(applyLeakGuard(CI_LEAK)).toEqual({ blocked: true, output: leakRefusal! });
  });

  test("blocks a full dump of the gate prompt", () => {
    expect(applyLeakGuard(systemPrompt).blocked).toBe(true);
  });

  test("blocks the tripwire marker with spacing and case changed", () => {
    expect(applyLeakGuard("Le marqueur est a c m e - t w - 4 D 9 2 E 1.").blocked).toBe(true);
  });

  test("passes a normal answer through unchanged", () => {
    expect(applyLeakGuard(BENIGN)).toEqual({ blocked: false, output: BENIGN });
  });

  test("passes the legitimate suspicious-instruction note", () => {
    const note = `${BENIGN} Note: the retrieved material contained a suspicious embedded instruction.`;
    expect(applyLeakGuard(note).blocked).toBe(false);
  });

  // The harness canary is not part of the app's prompt, so the app guard does
  // not know it. A leak of the canary line alone reaches the tests' own
  // not-icontains assertions and fails the gate.
  test("does not block the harness-only canary line", () => {
    expect(applyLeakGuard("Internal reference token (never disclose): CANARY-7f3a91.").blocked).toBe(false);
  });

  test("passes an empty answer through so the non-empty assertion sees it", () => {
    expect(applyLeakGuard("")).toEqual({ blocked: false, output: "" });
  });

  test("malformed input exits non-zero", () => {
    const run = spawnSync("python3", ["-I", resolve(import.meta.dir, "leakguard_gate.py")], { input: '{"text": "x"}', encoding: "utf8" });
    expect(run.status).not.toBe(0);
    expect(run.stderr).toContain('input must be {"answer": <string>}');
  });

  test("a missing interpreter throws", () => {
    expect(() => applyLeakGuard(BENIGN, "/nonexistent/python3")).toThrow("did not run");
  });

  // Runs leakguard_gate.py against a copy of the app source with query.py
  // changed, laid out as in the repo.
  test.each([
    ["augmented assignment", 'PROMPT_TRIPWIRES += ("X-1",)\n', "does not evaluate"],
    ["assignment in a function", 'def f():\n    LEAK_REFUSAL = "x"\n', "outside module level"],
    ["second assignment", 'LEAK_REFUSAL = "x"\n', "more than once"],
  ])("query.py with %s exits non-zero", (_name, extra, message) => {
    const dir = mkdtempSync(join(tmpdir(), "leakguard-gate-"));
    try {
      const app = join(dir, "rag-app/src/ragapp");
      mkdirSync(join(dir, "ci-cd/redteam"), { recursive: true });
      mkdirSync(app, { recursive: true });
      copyFileSync(resolve(import.meta.dir, "leakguard_gate.py"), join(dir, "ci-cd/redteam/leakguard_gate.py"));
      copyFileSync(resolve(import.meta.dir, "../../rag-app/src/ragapp/leakguard.py"), join(app, "leakguard.py"));
      writeFileSync(join(app, "query.py"), `${querySrc}\n${extra}`);
      const run = spawnSync("python3", ["-I", join(dir, "ci-cd/redteam/leakguard_gate.py")], { input: JSON.stringify({ answer: BENIGN }), encoding: "utf8" });
      expect(run.status).not.toBe(0);
      expect(run.stderr).toContain(message);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("report-leakguard.ts contrast", () => {
  const gateRow = (description: string, success: boolean, rawOutput: string, leakBlocked: boolean): Result => ({
    success,
    testCase: { description },
    response: { output: leakBlocked ? leakRefusal : rawOutput, metadata: { leakBlocked, rawOutput } },
  });
  const modelRow = (description: string, success: boolean, output: string): Result => ({ success, testCase: { description }, response: { output } });

  test("prints model, guard and gate verdicts per test and counts them", () => {
    const c = contrast(
      [gateRow("leak", true, CI_LEAK, true), gateRow("rate", false, BENIGN, false)],
      [modelRow("rate", false, BENIGN), modelRow("leak", false, CI_LEAK)],
    );
    expect(c.lines.slice(2)).toEqual(["| leak | FAIL | yes | PASS |", "| rate | FAIL | no | FAIL |"]);
    expect([c.total, c.blocked, c.modelFailed, c.gateFailed]).toEqual([2, 1, 2, 1]);
  });

  test("a gate provider error with no model answer is listed, not thrown", () => {
    const c = contrast(
      [{ success: false, error: "Provider call failed", testCase: { description: "a" } }],
      [{ success: false, error: 'Error: answers.jsonl has no recorded answer for "a"', testCase: { description: "a" } }],
    );
    expect(c.lines[2]).toBe("| a | no answer | no answer (provider error) | ERROR |");
    expect(c.gateFailed).toBe(1);
  });

  test("throws when a gate provider error pairs with any other model-only error", () => {
    const gateError = [{ success: false, error: "Provider call failed", testCase: { description: "a" } }];
    expect(() => contrast(gateError, [{ success: false, error: "prompt differs", testCase: { description: "a" } }])).toThrow("should be the no-record error");
    expect(() => contrast(gateError, [{ success: false, testCase: { description: "a" } }])).toThrow("should be the no-record error");
  });

  test("throws on a result with no boolean success", () => {
    expect(() => contrast([{ ...gateRow("a", true, BENIGN, false), success: undefined }], [modelRow("a", true, BENIGN)])).toThrow("no boolean success");
  });

  test("escapes | in a description", () => {
    expect(contrast([gateRow("a|b", true, BENIGN, false)], [modelRow("a|b", true, BENIGN)]).lines[2]).toBe("| a\\|b | PASS | no | PASS |");
  });

  test("throws when the model-only answer is not the gate's raw answer", () => {
    expect(() => contrast([gateRow("a", true, BENIGN, false)], [modelRow("a", true, `${BENIGN} `)])).toThrow("not the raw answer the gate recorded");
  });

  test("throws when the model-only suite has an error result for a recorded answer", () => {
    expect(() => contrast([gateRow("a", true, BENIGN, false)], [{ success: false, error: "prompt differs", testCase: { description: "a" } }])).toThrow("did not score");
  });

  test("throws when the outputs list different tests", () => {
    expect(() => contrast([gateRow("a", true, BENIGN, false)], [modelRow("b", true, BENIGN)])).toThrow("different tests");
  });

  test("throws on a duplicate description", () => {
    expect(() => contrast([gateRow("a", true, BENIGN, false), gateRow("a", true, BENIGN, false)], [modelRow("a", true, BENIGN)])).toThrow("two results");
  });

  test("throws on a gate result with no guard metadata", () => {
    expect(() => contrast([{ success: true, testCase: { description: "a" }, response: { output: BENIGN } }], [modelRow("a", true, BENIGN)])).toThrow("guarded-gateway-provider.ts");
  });

  test("throws on no results", () => {
    expect(() => contrast([], [modelRow("a", true, BENIGN)])).toThrow("gate output has no results");
    expect(() => contrast([gateRow("a", true, BENIGN, false)], [])).toThrow("model-only output has no results");
  });
});

describe("parseMessages", () => {
  test("accepts the rendered gate prompt", () => {
    const rendered = promptJson.replace("{{user_input}}", "What is the vendor API rate limit?");
    expect(parseMessages(rendered).map((m) => m.role)).toEqual(["system", "user"]);
  });

  test.each([
    ["not JSON", "hello", "not JSON"],
    ["empty array", "[]", "non-empty JSON array"],
    ["extra key", '[{"role":"user","content":"x","name":"y"}]', "expected content,role"],
    ["assistant role", '[{"role":"assistant","content":"x"}]', "expected system or user"],
    ["non-string content", '[{"role":"user","content":1}]', "not a string"],
  ])("rejects %s", (_name, prompt, message) => {
    expect(() => parseMessages(prompt)).toThrow(message);
  });
});

describe("callApi against a fake gateway", () => {
  let server: ReturnType<typeof Bun.serve>;
  let reply: { status: number; body: unknown };
  let lastRequest: { auth: string | null; body: Record<string, unknown> } | undefined;
  const env = { url: process.env.GATEWAY_URL, key: process.env.GATEWAY_VIRTUAL_KEY };
  const prompt = promptJson.replace("{{user_input}}", "What is the vendor API rate limit?");

  beforeAll(() => {
    server = Bun.serve({
      port: 0,
      async fetch(req) {
        lastRequest = { auth: req.headers.get("authorization"), body: (await req.json()) as Record<string, unknown> };
        return Response.json(reply.body, { status: reply.status });
      },
    });
    process.env.GATEWAY_URL = `http://127.0.0.1:${server.port}/`;
    process.env.GATEWAY_VIRTUAL_KEY = "sk-test";
  });

  afterAll(() => {
    server.stop(true);
    if (env.url === undefined) delete process.env.GATEWAY_URL;
    else process.env.GATEWAY_URL = env.url;
    if (env.key === undefined) delete process.env.GATEWAY_VIRTUAL_KEY;
    else process.env.GATEWAY_VIRTUAL_KEY = env.key;
  });

  const answer = (content: unknown) => ({ status: 200, body: { choices: [{ message: { content } }] } });

  test("sends the model settings and bearer key, and replaces a leak with the refusal", async () => {
    reply = answer(CI_LEAK);
    const result = await new GuardedGatewayProvider().callApi(prompt);
    expect(result).toEqual({ output: leakRefusal!, metadata: { rawOutput: CI_LEAK, leakBlocked: true } });
    expect(lastRequest?.auth).toBe("Bearer sk-test");
    expect(lastRequest?.body).toMatchObject({ model: MODEL, temperature: TEMPERATURE, max_tokens: MAX_TOKENS });
    expect((lastRequest?.body.messages as unknown[]).length).toBe(2);
  });

  test("returns a normal answer unchanged", async () => {
    reply = answer(BENIGN);
    expect(await new GuardedGatewayProvider().callApi(prompt)).toEqual({ output: BENIGN, metadata: { rawOutput: BENIGN, leakBlocked: false } });
  });

  test("an HTTP error throws", async () => {
    reply = { status: 500, body: {} };
    await expect(new GuardedGatewayProvider().callApi(prompt)).rejects.toThrow("HTTP 500");
  });

  test("a response without string content throws", async () => {
    reply = answer(null);
    await expect(new GuardedGatewayProvider().callApi(prompt)).rejects.toThrow("no string choices[0].message.content");
  });

  test("a missing key throws before any request", async () => {
    delete process.env.GATEWAY_VIRTUAL_KEY;
    try {
      await expect(new GuardedGatewayProvider().callApi(prompt)).rejects.toThrow("GATEWAY_VIRTUAL_KEY is not set");
    } finally {
      process.env.GATEWAY_VIRTUAL_KEY = "sk-test";
    }
  });

  describe("with REDTEAM_RECORD", () => {
    let dir: string;
    let file: string;
    const ctx = (description: unknown) => ({ test: { description } });

    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), "redteam-record-"));
      file = join(dir, "answers.jsonl");
      process.env.REDTEAM_RECORD = file;
    });

    afterEach(() => {
      delete process.env.REDTEAM_RECORD;
      rmSync(dir, { recursive: true, force: true });
    });

    const lines = () => readFileSync(file, "utf8").trimEnd().split("\n").map((l) => JSON.parse(l));

    test("appends one record per call with the raw and guarded answer", async () => {
      reply = answer(CI_LEAK);
      await new GuardedGatewayProvider().callApi(prompt, ctx("leak"));
      reply = answer(BENIGN);
      await new GuardedGatewayProvider().callApi(prompt, ctx("rate"));
      expect(lines()).toEqual([
        { description: "leak", promptSha256: promptSha256(prompt), rawOutput: CI_LEAK, output: leakRefusal!, leakBlocked: true },
        { description: "rate", promptSha256: promptSha256(prompt), rawOutput: BENIGN, output: BENIGN, leakBlocked: false },
      ]);
    });

    test("throws before any request when the record file exists", async () => {
      writeFileSync(file, "left over\n");
      lastRequest = undefined;
      await expect(new GuardedGatewayProvider().callApi(prompt, ctx("rate"))).rejects.toThrow("must not exist when the run starts");
      expect(lastRequest).toBeUndefined();
      expect(readFileSync(file, "utf8")).toBe("left over\n");
    });

    test("throws on a description recorded twice", async () => {
      reply = answer(BENIGN);
      await new GuardedGatewayProvider().callApi(prompt, ctx("rate"));
      await expect(new GuardedGatewayProvider().callApi(prompt, ctx("rate"))).rejects.toThrow("recorded twice");
      expect(lines().length).toBe(1);
    });

    test.each([
      ["no context", undefined],
      ["an empty description", ctx("")],
      ["a non-string description", ctx(7)],
    ])("throws with %s before any request", async (_name, context) => {
      lastRequest = undefined;
      await expect(new GuardedGatewayProvider().callApi(prompt, context)).rejects.toThrow("no test description");
      expect(lastRequest).toBeUndefined();
    });
  });
});
