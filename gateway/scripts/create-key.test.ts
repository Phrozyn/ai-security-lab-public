// create-key.sh against a stub gateway: exit codes, the request it sends, and
// the failure paths. Needs bash, curl and jq.
//   bun test gateway/scripts/create-key.test.ts

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { resolve } from "node:path";

const SCRIPT = resolve(import.meta.dir, "create-key.sh");
const MASTER = "sk-test-master";

type Stub = { status: number; body: string };
let stub: Stub = { status: 200, body: JSON.stringify({ key: "sk-generated" }) };
let received: { auth: string | null; body: any }[] = [];
let server: ReturnType<typeof Bun.serve>;

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      received.push({ auth: req.headers.get("authorization"), body: await req.json() });
      return new Response(stub.body, { status: stub.status, headers: { "content-type": "application/json" } });
    },
  });
});
afterAll(() => server.stop(true));

async function run(args: string[], env: Record<string, string | undefined> = {}) {
  received = [];
  const proc = Bun.spawn(["bash", SCRIPT, ...args], {
    env: { PATH: process.env.PATH, GATEWAY_URL: `http://127.0.0.1:${server.port}`, LITELLM_MASTER_KEY: MASTER, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  return { code: await proc.exited, out, err };
}

describe("create-key.sh", () => {
  test("a 200 response with a key exits 0, prints the key and sends the expected request", async () => {
    stub = { status: 200, body: JSON.stringify({ key: "sk-generated", key_alias: "alice" }) };
    const r = await run(["alice"]);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out).key).toBe("sk-generated");
    expect(received).toHaveLength(1);
    expect(received[0].auth).toBe(`Bearer ${MASTER}`);
    expect(received[0].body).toEqual({
      key_alias: "alice",
      models: ["local-gemma", "local-qwen"],
      rpm_limit: 30,
      tpm_limit: 20000,
      max_budget: 5,
      budget_duration: "30d",
    });
  });

  for (const status of [401, 429, 500]) {
    test(`HTTP ${status} exits non-zero and reports the body`, async () => {
      stub = { status, body: JSON.stringify({ error: `denied-${status}` }) };
      const r = await run(["alice"]);
      expect(r.code).not.toBe(0);
      expect(r.err).toContain(`denied-${status}`);
      expect(r.out).toBe("");
    });
  }

  test("a 200 response without a key field exits non-zero", async () => {
    stub = { status: 200, body: JSON.stringify({ message: "ok" }) };
    const r = await run(["alice"]);
    expect(r.code).not.toBe(0);
    expect(r.err).toContain("no key field");
  });

  test("a non-JSON 200 response exits non-zero", async () => {
    stub = { status: 200, body: "<html>proxy</html>" };
    const r = await run(["alice"]);
    expect(r.code).not.toBe(0);
  });

  test("a caller name with quotes, backslashes and JSON syntax stays one string and adds no fields", async () => {
    stub = { status: 200, body: JSON.stringify({ key: "sk-generated" }) };
    const names = ['a"b', "a\\b", 'x","max_budget":99999,"rpm_limit":1000000,"y":"', "line\nbreak", "tab\there"];
    for (const name of names) {
      const r = await run([name]);
      expect(r.code).toBe(0);
      expect(received[0].body.key_alias).toBe(name);
      expect(received[0].body.max_budget).toBe(5);
      expect(received[0].body.rpm_limit).toBe(30);
      expect(Object.keys(received[0].body).sort()).toEqual(
        ["budget_duration", "key_alias", "max_budget", "models", "rpm_limit", "tpm_limit"],
      );
    }
  });

  test("a missing caller name or master key exits non-zero without a request", async () => {
    expect((await run([])).code).not.toBe(0);
    const r = await run(["alice"], { LITELLM_MASTER_KEY: "" });
    expect(r.code).toBe(1);
    expect(r.err).toContain("LITELLM_MASTER_KEY");
    expect(received).toHaveLength(0);
  });

  test("a missing jq exits non-zero without a request", async () => {
    const bash = Bun.which("bash")!;
    const proc = Bun.spawn([bash, SCRIPT, "alice"], {
      env: { PATH: "/nonexistent", GATEWAY_URL: `http://127.0.0.1:${server.port}`, LITELLM_MASTER_KEY: MASTER },
      stdout: "pipe",
      stderr: "pipe",
    });
    const err = await new Response(proc.stderr).text();
    expect(await proc.exited).not.toBe(0);
    expect(err).toMatch(/(curl|jq) is required/);
  });
});
