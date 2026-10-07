// Single source of truth for which container images CI scans: the compose file
// itself. Prints the image refs as a JSON array (consumed as the supply-chain
// job's matrix) and FAILS when:
//   - a runtime image declaration is not a static string pinned by sha256 digest.
//     Runtime declarations are compose services.*.image and, in workflows,
//     jobs.*.services.*.image, jobs.*.container (string or .image) and
//     steps[].uses of the form docker://<image>. An expression (${{ ... }}) or a
//     compose variable (${VAR}) in one of these places fails, because its value
//     can not be checked here. Keys elsewhere, such as strategy.matrix.image or
//     the image input of an action, are not runtime declarations and are ignored.
//   - a workflow pins the same image repository as the compose file with a
//     different digest, so a Dependabot bump of the compose pin can not leave a
//     stale second copy behind.
// A Dependabot digest bump of the compose file is scanned with no second list.
//
//   bun ci-cd/scripts/list-compose-images.ts

import { appendFileSync, readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const DIGEST = /@sha256:([0-9a-f]{64})$/;
const DOCKER_USES = "docker://";

type Decl = { where: string; value: unknown };
type Mapping = Record<string, unknown>;

function isMapping(v: unknown): v is Mapping {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function parseYaml(text: string, file: string): unknown {
  const yaml = (Bun as unknown as { YAML?: { parse?: (s: string) => unknown } }).YAML;
  if (typeof yaml?.parse !== "function") throw new Error("Bun.YAML.parse is not available; use a newer Bun");
  try {
    return yaml.parse(text);
  } catch (e) {
    throw new Error(`${file}: invalid YAML: ${e instanceof Error ? e.message : String(e)}`);
  }
}

function mappingAt(parent: Mapping, key: string, where: string): Mapping | undefined {
  const v = parent[key];
  if (v === undefined) return undefined;
  if (!isMapping(v)) throw new Error(`${where}.${key} must be a mapping`);
  return v;
}

function workflowDecls(doc: unknown, file: string): Decl[] {
  if (!isMapping(doc)) throw new Error(`${file}: top level must be a mapping`);
  const jobs = mappingAt(doc, "jobs", file);
  if (!jobs) throw new Error(`${file}: no jobs mapping`);
  const out: Decl[] = [];
  for (const [jobId, job] of Object.entries(jobs)) {
    if (!isMapping(job)) throw new Error(`${file}: jobs.${jobId} must be a mapping`);
    const base = `${file}: jobs.${jobId}`;

    for (const [serviceId, service] of Object.entries(mappingAt(job, "services", base) ?? {})) {
      if (!isMapping(service)) throw new Error(`${base}.services.${serviceId} must be a mapping`);
      out.push({ where: `${base}.services.${serviceId}.image`, value: service.image });
    }

    if (job.container !== undefined) {
      if (isMapping(job.container)) out.push({ where: `${base}.container.image`, value: job.container.image });
      else out.push({ where: `${base}.container`, value: job.container });
    }

    if (job.steps !== undefined) {
      if (!Array.isArray(job.steps)) throw new Error(`${base}.steps must be a list`);
      job.steps.forEach((step, i) => {
        if (isMapping(step) && typeof step.uses === "string" && step.uses.startsWith(DOCKER_USES)) {
          out.push({ where: `${base}.steps[${i}].uses`, value: step.uses.slice(DOCKER_USES.length) });
        }
      });
    }
  }
  return out;
}

function composeDecls(doc: unknown, file: string): Decl[] {
  if (!isMapping(doc)) throw new Error(`${file}: top level must be a mapping`);
  const services = mappingAt(doc, "services", file);
  if (!services) throw new Error(`${file}: no services mapping`);
  const out: Decl[] = [];
  for (const [serviceId, service] of Object.entries(services)) {
    if (!isMapping(service)) throw new Error(`${file}: services.${serviceId} must be a mapping`);
    if (service.image !== undefined) out.push({ where: `${file}: services.${serviceId}.image`, value: service.image });
  }
  return out;
}

/** Runtime image declarations in a workflow or compose file, with errors for values that are not static strings. */
export function declaredImages(
  yamlText: string,
  file: string,
  kind: "workflow" | "compose",
): { images: { file: string; image: string }[]; errors: string[] } {
  const doc = parseYaml(yamlText, file);
  const decls = kind === "workflow" ? workflowDecls(doc, file) : composeDecls(doc, file);
  const images: { file: string; image: string }[] = [];
  const errors: string[] = [];
  for (const { where, value } of decls) {
    if (typeof value !== "string" || value.trim() === "") {
      errors.push(`${where}: image is missing or not a string`);
    } else if (value.includes("${")) {
      errors.push(`${where}: image must be a static string, found ${JSON.stringify(value)}`);
    } else {
      images.push({ file: where, image: value.trim() });
    }
  }
  return { images, errors };
}

/** Repository part of an image ref: no tag, no digest, registry ports kept. */
export function repoOf(ref: string): string {
  const noDigest = ref.replace(DIGEST, "");
  const lastSlash = noDigest.lastIndexOf("/");
  const colon = noDigest.indexOf(":", lastSlash + 1);
  return colon === -1 ? noDigest : noDigest.slice(0, colon);
}

export function digestOf(ref: string): string | null {
  return ref.match(DIGEST)?.[1] ?? null;
}

/** Problems with the compose images and the workflow images; empty when the policy holds. */
export function checkImages(composeImages: string[], workflowImages: { file: string; image: string }[]): string[] {
  const errors: string[] = [];
  for (const i of composeImages) {
    if (!digestOf(i)) errors.push(`compose image is not pinned by digest: ${i}`);
  }
  const composeDigests = new Map<string, string>();
  for (const i of composeImages) {
    const d = digestOf(i);
    if (d) composeDigests.set(repoOf(i), d);
  }
  for (const { file, image } of workflowImages) {
    const d = digestOf(image);
    if (!d) {
      errors.push(`${file}: image is not pinned by digest: ${image}`);
      continue;
    }
    const composeDigest = composeDigests.get(repoOf(image));
    if (composeDigest && composeDigest !== d) {
      errors.push(`${file}: ${repoOf(image)} digest sha256:${d} differs from the compose digest sha256:${composeDigest}`);
    }
  }
  return errors;
}

if (import.meta.main) {
  const root = resolve(import.meta.dir, "../..");
  const composeFile = "gateway/docker-compose.yml";
  const compose = declaredImages(readFileSync(resolve(root, composeFile), "utf8"), composeFile, "compose");
  if (compose.images.length + compose.errors.length < 2) {
    throw new Error(`expected >=2 images in compose, found ${compose.images.length + compose.errors.length}`);
  }

  const workflowDir = resolve(root, ".github/workflows");
  const files = readdirSync(workflowDir).filter((f) => /\.ya?ml$/.test(f)).sort();
  if (files.length === 0) throw new Error(`no workflow files in ${workflowDir}`);
  const workflow = files.map((f) =>
    declaredImages(readFileSync(resolve(workflowDir, f), "utf8"), `.github/workflows/${f}`, "workflow"),
  );

  const composeImages = compose.images.map((i) => i.image);
  const errors = [
    ...compose.errors,
    ...workflow.flatMap((w) => w.errors),
    ...checkImages(composeImages, workflow.flatMap((w) => w.images)),
  ];
  if (errors.length > 0) {
    console.error("Image policy violations (runtime images must be static and pinned as name:tag@sha256:<64 hex>):");
    for (const e of errors) console.error(`  - ${e}`);
    process.exit(1);
  }
  const json = JSON.stringify(composeImages);
  console.log(json);
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `images=${json}\n`);
}
