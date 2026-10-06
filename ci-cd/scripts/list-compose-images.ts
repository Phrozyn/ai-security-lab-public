// Single source of truth for which container images CI scans: the compose file
// itself. Prints the image refs as a JSON array (consumed as the supply-chain
// job's matrix) and FAILS when:
//   - an image in the compose file or in a workflow (services.*.image, container
//     images) is not pinned by sha256 digest, so a floating tag can not be
//     re-introduced, or
//   - a workflow pins the same image repository as the compose file with a
//     different digest, so a Dependabot bump of the compose pin can not leave a
//     stale second copy behind.
// A Dependabot digest bump of the compose file is scanned with no second list.
//
//   bun ci-cd/scripts/list-compose-images.ts

import { appendFileSync, readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const DIGEST = /@sha256:([0-9a-f]{64})$/;

/** Static `image:` values in a YAML file. Expressions (`${{ ... }}`) are skipped. */
export function extractImages(yaml: string): string[] {
  return [...yaml.matchAll(/^\s*image:\s*(\S+)\s*$/gm)].map((m) => m[1]).filter((i) => !i.startsWith("${{"));
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

function workflowImages(dir: string): { file: string; image: string }[] {
  const files = readdirSync(dir).filter((f) => /\.ya?ml$/.test(f)).sort();
  if (files.length === 0) throw new Error(`no workflow files in ${dir}`);
  return files.flatMap((f) => extractImages(readFileSync(resolve(dir, f), "utf8")).map((image) => ({ file: `.github/workflows/${f}`, image })));
}

if (import.meta.main) {
  const root = resolve(import.meta.dir, "../..");
  const composeImages = extractImages(readFileSync(resolve(root, "gateway/docker-compose.yml"), "utf8"));
  if (composeImages.length < 2) throw new Error(`expected >=2 images in compose, found ${composeImages.length}`);

  const errors = checkImages(composeImages, workflowImages(resolve(root, ".github/workflows")));
  if (errors.length > 0) {
    console.error("Image policy violations (images must be pinned as name:tag@sha256:<64 hex>):");
    for (const e of errors) console.error(`  - ${e}`);
    process.exit(1);
  }
  const json = JSON.stringify(composeImages);
  console.log(json);
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `images=${json}\n`);
}
