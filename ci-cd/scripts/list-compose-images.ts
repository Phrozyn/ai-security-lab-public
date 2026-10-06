// Single source of truth for which container images CI scans: the compose file
// itself. Prints the image refs as a JSON array (consumed as the supply-chain
// job's matrix), and FAILS if any image is not pinned by sha256 digest, so a
// floating tag can never be re-introduced -- and a Dependabot digest bump is
// scanned automatically with no second list to keep in sync.

import { readFileSync, appendFileSync } from "node:fs";
import { resolve } from "node:path";

const compose = readFileSync(resolve(import.meta.dir, "../../gateway/docker-compose.yml"), "utf8");
const images = [...compose.matchAll(/^\s*image:\s*(\S+)\s*$/gm)].map((m) => m[1]);
if (images.length < 2) throw new Error(`expected >=2 images in compose, found ${images.length}`);

const unpinned = images.filter((i) => !/@sha256:[0-9a-f]{64}$/.test(i));
if (unpinned.length > 0) {
  console.error("Images must be pinned by digest (name:tag@sha256:<64 hex>):");
  for (const i of unpinned) console.error(`  - ${i}`);
  process.exit(1);
}
const json = JSON.stringify(images);
console.log(json);
if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `images=${json}\n`);
