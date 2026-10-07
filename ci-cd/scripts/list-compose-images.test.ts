import { describe, expect, test } from "bun:test";
import { checkImages, declaredImages, digestOf, repoOf } from "./list-compose-images";

const A = "a".repeat(64);
const B = "b".repeat(64);
const compose = [`pgvector/pgvector:pg16@sha256:${A}`, `ghcr.io/berriai/litellm:main-stable@sha256:${B}`];

const wf = (yaml: string) => declaredImages(yaml, "ci.yml", "workflow");

describe("workflow runtime declarations", () => {
  test("a static service image is returned with its path", () => {
    const r = wf(`jobs:\n  t:\n    services:\n      postgres:\n        image: pgvector/pgvector:pg16@sha256:${A}\n`);
    expect(r.errors).toEqual([]);
    expect(r.images).toEqual([{ file: "ci.yml: jobs.t.services.postgres.image", image: `pgvector/pgvector:pg16@sha256:${A}` }]);
  });

  test("a service image from an expression fails with the exact path", () => {
    const r = wf("jobs:\n  t:\n    services:\n      postgres:\n        image: ${{ vars.POSTGRES_IMAGE }}\n");
    expect(r.images).toEqual([]);
    expect(r.errors).toEqual([
      'ci.yml: jobs.t.services.postgres.image: image must be a static string, found "${{ vars.POSTGRES_IMAGE }}"',
    ]);
  });

  test("a job container image from an expression fails, as a mapping and as a string", () => {
    expect(wf("jobs:\n  t:\n    container:\n      image: ${{ vars.CI_IMAGE }}\n").errors[0]).toContain("jobs.t.container.image");
    expect(wf("jobs:\n  t:\n    container: ${{ vars.CI_IMAGE }}\n").errors[0]).toContain("jobs.t.container:");
  });

  test("a static container image, string or mapping, is returned", () => {
    expect(wf(`jobs:\n  t:\n    container: node:20@sha256:${A}\n`).images[0].image).toBe(`node:20@sha256:${A}`);
    expect(wf(`jobs:\n  t:\n    container:\n      image: node:20@sha256:${A}\n`).images[0].image).toBe(`node:20@sha256:${A}`);
  });

  test("docker:// step images are runtime declarations; other uses are not", () => {
    const r = wf(
      `jobs:\n  t:\n    steps:\n      - uses: docker://alpine:3.19@sha256:${A}\n      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1\n      - uses: docker://alpine:latest\n`,
    );
    expect(r.errors).toEqual([]);
    expect(r.images.map((i) => i.image)).toEqual([`alpine:3.19@sha256:${A}`, "alpine:latest"]);
    expect(r.images[1].file).toContain("steps[2].uses");
  });

  test("strategy.matrix.image and an action's image input are not runtime declarations", () => {
    const r = wf(
      "jobs:\n  t:\n    strategy:\n      matrix:\n        image: ${{ fromJSON(needs.images.outputs.list) }}\n    steps:\n      - uses: some/scan@abc\n        with:\n          image: ${{ matrix.image }}\n",
    );
    expect(r).toEqual({ images: [], errors: [] });
  });

  test("a service without an image is an error", () => {
    expect(wf("jobs:\n  t:\n    services:\n      postgres:\n        env:\n          A: b\n").errors[0]).toContain("missing");
  });

  test("a commented image line is ignored", () => {
    expect(wf("jobs:\n  t:\n    services:\n      p:\n        # image: floating:latest\n        image: x:1@sha256:" + A + "\n").images).toHaveLength(1);
  });

  test("malformed structure and invalid YAML throw", () => {
    expect(() => wf("on: push\n")).toThrow("no jobs mapping");
    expect(() => wf("jobs:\n  t: 5\n")).toThrow("jobs.t must be a mapping");
    expect(() => wf("jobs:\n  t:\n    services: [a]\n")).toThrow("services must be a mapping");
    expect(() => wf("jobs:\n  t:\n    steps: x\n")).toThrow("steps must be a list");
    expect(() => wf("jobs: [unclosed\n  - x: : :\n")).toThrow("ci.yml");
    expect(() => wf("- a\n- b\n")).toThrow("top level must be a mapping");
  });
});

describe("compose declarations", () => {
  const dc = (yaml: string) => declaredImages(yaml, "docker-compose.yml", "compose");

  test("static images are returned", () => {
    const r = dc(`services:\n  db:\n    image: pgvector/pgvector:pg16@sha256:${A}\n  app:\n    build: .\n`);
    expect(r.errors).toEqual([]);
    expect(r.images.map((i) => i.image)).toEqual([`pgvector/pgvector:pg16@sha256:${A}`]);
  });

  test("a variable in an image fails", () => {
    expect(dc("services:\n  db:\n    image: ${DB_IMAGE:-postgres}\n").errors[0]).toContain("must be a static string");
  });

  test("shell metacharacters in an image ref fail with the exact path and value", () => {
    for (const bad of ['x";id;#', "x$(id)", "x`id`", "x y", "x'y", "x|y", "x&y", "x\\y"]) {
      const ref = `${bad}@sha256:${A}`;
      const r = dc(`services:\n  db:\n    image: ${JSON.stringify(ref)}\n`);
      expect(r.images).toEqual([]);
      expect(r.errors).toEqual([
        `docker-compose.yml: services.db.image: image contains characters outside [A-Za-z0-9._/:@-], found ${JSON.stringify(ref)}`,
      ]);
    }
  });

  test("leading or trailing whitespace in a quoted image fails; it is not trimmed away", () => {
    for (const ref of [` img:tag@sha256:${A}`, `img:tag@sha256:${A} `, `img:tag@sha256:${A}\n`, `\timg:tag@sha256:${A}`]) {
      const r = dc(`services:\n  db:\n    image: ${JSON.stringify(ref)}\n`);
      expect(r.images).toEqual([]);
      expect(r.errors).toEqual([
        `docker-compose.yml: services.db.image: image contains characters outside [A-Za-z0-9._/:@-], found ${JSON.stringify(ref)}`,
      ]);
    }
  });

  test("a workflow image with shell metacharacters fails the same way", () => {
    const ref = `x";id;#@sha256:${A}`;
    const r = wf(`jobs:\n  t:\n    services:\n      s:\n        image: ${JSON.stringify(ref)}\n`);
    expect(r.images).toEqual([]);
    expect(r.errors).toEqual([
      `ci.yml: jobs.t.services.s.image: image contains characters outside [A-Za-z0-9._/:@-], found ${JSON.stringify(ref)}`,
    ]);
  });

  test("registry host, port, mixed-case tag and digest are accepted", () => {
    const ref = `registry.example:5000/team/app:V1.2_rc-1@sha256:${A}`;
    const r = dc(`services:\n  db:\n    image: ${ref}\n`);
    expect(r.errors).toEqual([]);
    expect(r.images.map((i) => i.image)).toEqual([ref]);
  });

  test("a compose file without services throws", () => {
    expect(() => dc("version: '3'\n")).toThrow("no services mapping");
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
    expect(checkImages([...compose, "nginx:latest"], [])).toEqual(["compose image is not pinned by digest: nginx:latest"]);
  });
  test("a malformed digest (wrong length) counts as unpinned", () => {
    expect(checkImages(compose, [{ file: "ci.yml", image: "x:1@sha256:abc" }])).toHaveLength(1);
  });
});
