// Which variables from .env reach which container. litellm must not receive the
// Postgres bootstrap superuser credentials, and must receive every variable that
// litellm_config.yaml reads.
//   bun test gateway/docker-compose.test.ts

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

type Mapping = Record<string, any>;

const parse = (file: string): Mapping => {
  const yaml = (Bun as unknown as { YAML?: { parse?: (s: string) => unknown } }).YAML;
  if (typeof yaml?.parse !== "function") throw new Error("Bun.YAML.parse is not available; use a newer Bun");
  return yaml.parse(readFileSync(resolve(import.meta.dir, file), "utf8")) as Mapping;
};

const services = parse("docker-compose.yml").services as Mapping;
const litellm = services.litellm as Mapping;
const postgres = services.postgres as Mapping;

describe("docker-compose.yml environment", () => {
  test("no service uses env_file", () => {
    for (const [name, service] of Object.entries(services)) {
      expect({ name, env_file: (service as Mapping).env_file }).toEqual({ name, env_file: undefined });
    }
  });

  test("litellm does not receive the Postgres bootstrap superuser credentials", () => {
    const keys = Object.keys(litellm.environment);
    expect(keys).not.toContain("POSTGRES_USER");
    expect(keys).not.toContain("POSTGRES_PASSWORD");
    // DATABASE_URL carries the gateway_app role, never the superuser.
    expect(litellm.environment.DATABASE_URL).toContain("${GATEWAY_DB_USER:?");
    expect(litellm.environment.DATABASE_URL).toContain("${GATEWAY_DB_PASSWORD:?");
    expect(litellm.environment.DATABASE_URL).not.toContain("POSTGRES_PASSWORD");
  });

  test("litellm receives every variable litellm_config.yaml reads", () => {
    const config = readFileSync(resolve(import.meta.dir, "litellm_config.yaml"), "utf8");
    const read = [...new Set([...config.matchAll(/os\.environ\/([A-Z0-9_]+)/g)].map((m) => m[1]))];
    expect(read.length).toBeGreaterThanOrEqual(3); // LITELLM_MASTER_KEY, DATABASE_URL, OLLAMA_BASE_URL
    for (const name of read) expect(Object.keys(litellm.environment)).toContain(name);
  });

  test("litellm receives the salt key and the master key, and fails to start without them", () => {
    expect(litellm.environment.LITELLM_MASTER_KEY).toContain("${LITELLM_MASTER_KEY:?");
    expect(litellm.environment.LITELLM_SALT_KEY).toContain("${LITELLM_SALT_KEY:?");
  });

  test("postgres does not receive the litellm admin or salt keys", () => {
    const keys = Object.keys(postgres.environment);
    expect(keys).not.toContain("LITELLM_MASTER_KEY");
    expect(keys).not.toContain("LITELLM_SALT_KEY");
    expect(keys).not.toContain("GATEWAY_DB_PASSWORD");
  });
});
