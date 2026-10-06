import { describe, expect, test } from "bun:test";
import { checkImages, digestOf, extractImages, repoOf } from "./list-compose-images";

const A = "a".repeat(64);
const B = "b".repeat(64);
const compose = [`pgvector/pgvector:pg16@sha256:${A}`, `ghcr.io/berriai/litellm:main-stable@sha256:${B}`];

describe("extractImages", () => {
  test("reads static image values, skips expressions and comments", () => {
    const yaml = [
      "services:",
      "  postgres:",
      "    image: pgvector/pgvector:pg16",
      "    # image: commented/out:latest",
      "  other:",
      "    image: ${{ matrix.image }}",
      "    image:   ghcr.io/x/y:1   ",
    ].join("\n");
    expect(extractImages(yaml)).toEqual(["pgvector/pgvector:pg16", "ghcr.io/x/y:1"]);
  });
});

describe("repoOf and digestOf", () => {
  test("strip tag and digest, keep registry ports", () => {
    expect(repoOf(`pgvector/pgvector:pg16@sha256:${A}`)).toBe("pgvector/pgvector");
    expect(repoOf("registry.local:5000/team/app:1.2")).toBe("registry.local:5000/team/app");
    expect(repoOf("alpine")).toBe("alpine");
    expect(digestOf(`x:1@sha256:${A}`)).toBe(A);
    expect(digestOf("x:latest")).toBeNull();
  });
});

describe("checkImages", () => {
  test("a pinned workflow image with the compose digest passes", () => {
    expect(checkImages(compose, [{ file: "ci.yml", image: `pgvector/pgvector:pg16@sha256:${A}` }])).toEqual([]);
  });
  test("a floating workflow image fails", () => {
    const errors = checkImages(compose, [{ file: "ci.yml", image: "pgvector/pgvector:pg16" }]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("ci.yml");
    expect(errors[0]).toContain("not pinned");
  });
  test("a workflow digest that differs from the compose digest fails", () => {
    const errors = checkImages(compose, [{ file: "ci.yml", image: `pgvector/pgvector:pg16@sha256:${B}` }]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("differs from the compose digest");
  });
  test("a pinned workflow image that is not in compose passes", () => {
    expect(checkImages(compose, [{ file: "ci.yml", image: `redis:7@sha256:${B}` }])).toEqual([]);
  });
  test("a floating compose image fails", () => {
    const errors = checkImages([...compose, "nginx:latest"], []);
    expect(errors).toEqual(["compose image is not pinned by digest: nginx:latest"]);
  });
  test("a malformed digest (wrong length) counts as unpinned", () => {
    expect(checkImages(compose, [{ file: "ci.yml", image: "x:1@sha256:abc" }])).toHaveLength(1);
  });
});
