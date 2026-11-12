#!/usr/bin/env bun
// Checks the MITRE technique IDs on every Sigma rule in detections/rules/, and in each
// --optional-rules <dir>, against MITRE data pinned by commit and SHA-256.
//
// ATT&CK IDs are Sigma tags (attack.t1110, attack.t1098.001). pySigma's attacktag validator
// checks that each tag exists in ATT&CK; this check adds that every technique tag shares a
// tactic with the tactic tags on the same rule, so a rule cannot name a technique under a
// tactic ATT&CK does not file it under.
//
// ATLAS IDs are in x-atlas, a list of AML.T IDs. The Sigma tag namespaces are fixed
// (pySigma's namespace_tag validator refuses atlas.*), so ATLAS IDs cannot be tags.
//
// Coverage: every rule has an x-atlas key. A rule in detections/rules/ needs at least one
// technique ID (an ATT&CK technique tag or an x-atlas entry). A rule in an --optional-rules
// directory may have none (x-atlas: [] and no technique tag); that directory's README lists
// those rules and the reason.
//
// The data is downloaded from the pinned URLs, or read from --attack <file> and
// --atlas <file>; either way a SHA-256 that differs from the pinned value fails the check.
//
// Usage: bun detections/check-technique-ids.ts [--attack <file>] [--atlas <file>]
//          [--optional-rules <dir>]...

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const ATTACK = {
  version: "Enterprise ATT&CK 20.1",
  url: "https://raw.githubusercontent.com/mitre-attack/attack-stix-data/a8db2f52eb933c9c99060c123e088b3326d3a607/enterprise-attack/enterprise-attack-20.1.json",
  sha256: "539a843a7b53ed9749740b2123dddae3726b1a4831841c32aca740b011b910b5",
};
export const ATLAS = {
  version: "ATLAS 2026.10",
  url: "https://raw.githubusercontent.com/mitre-atlas/atlas-data/f56c1468731d6428e5bf875263b4643b46d67437/dist/v6/ATLAS-2026.10.yaml",
  sha256: "ac41ee9f99a47084ba5fdfc77ae83a28687e12390240fffeb37df7914ffe142d",
};

const REPO = join(import.meta.dir, "..");
export type RuleDir = { dir: string; needsTechnique: boolean };
const DETECTION_RULES: RuleDir = { dir: join(REPO, "detections", "rules"), needsTechnique: true };
const ATTACK_TECHNIQUE_TAG = /^attack\.t\d{4}(\.\d{3})?$/;
const ATLAS_ID = /^AML\.T\d{4}(\.\d{3})?$/;

export type AttackData = { techniques: Map<string, { name: string; tactics: string[] }>; tactics: Set<string> };
export type AtlasData = Map<string, { name: string }>;
export type RuleRef = { source: string; title: string; doc: Record<string, unknown>; needsTechnique: boolean };

function fail(msg: string): never {
  throw new Error(`check-technique-ids: ${msg}`);
}

export function sha256Hex(bytes: Uint8Array): string {
  return new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
}

export function requirePinned(bytes: Uint8Array, expected: string, what: string): void {
  const got = sha256Hex(bytes);
  if (got !== expected) fail(`${what}: SHA-256 ${got} is not the pinned ${expected}`);
}

// Active ATT&CK techniques (not revoked, not deprecated) keyed by lowercase ID, each with
// the shortnames of its tactics; and the set of active tactic shortnames.
export function parseAttack(text: string): AttackData {
  const bundle = JSON.parse(text) as { objects?: unknown };
  if (!Array.isArray(bundle.objects)) fail("ATT&CK data has no objects list");
  const techniques = new Map<string, { name: string; tactics: string[] }>();
  const tactics = new Set<string>();
  for (const o of bundle.objects as Record<string, any>[]) {
    if (o.revoked === true || o.x_mitre_deprecated === true) continue;
    if (o.type === "x-mitre-tactic") {
      if (typeof o.x_mitre_shortname !== "string") fail(`tactic ${o.id} has no shortname`);
      tactics.add(o.x_mitre_shortname);
    } else if (o.type === "attack-pattern") {
      const ref = (o.external_references ?? []).find((r: any) => r.source_name === "mitre-attack");
      if (!ref) continue;
      if (typeof ref.external_id !== "string" || typeof o.name !== "string") fail(`attack-pattern ${o.id} has no ID or name`);
      const phases = (o.kill_chain_phases ?? []).filter((k: any) => k.kill_chain_name === "mitre-attack").map((k: any) => k.phase_name);
      if (phases.length === 0) fail(`${ref.external_id} has no tactic`);
      techniques.set(ref.external_id.toLowerCase(), { name: o.name, tactics: phases });
    }
  }
  if (techniques.size === 0 || tactics.size === 0) fail("ATT&CK data holds no active techniques or tactics");
  return { techniques, tactics };
}

export function parseAtlas(text: string): AtlasData {
  const doc = Bun.YAML.parse(text) as { techniques?: unknown };
  if (doc.techniques === null || typeof doc.techniques !== "object" || Array.isArray(doc.techniques)) {
    fail("ATLAS data has no techniques map");
  }
  const out: AtlasData = new Map();
  for (const t of Object.values(doc.techniques as Record<string, any>)) {
    if (typeof t?.id !== "string" || typeof t?.name !== "string") fail("ATLAS technique without id or name");
    out.set(t.id, { name: t.name });
  }
  if (out.size === 0) fail("ATLAS data holds no techniques");
  return out;
}

// Problems with one rule; an empty list means the rule passes.
export function checkRule(rule: RuleRef, attack: AttackData, atlas: AtlasData): string[] {
  const where = `${rule.source}: ${rule.title}`;
  const errs: string[] = [];
  const tagsRaw = rule.doc.tags ?? [];
  if (!Array.isArray(tagsRaw) || tagsRaw.some((t) => typeof t !== "string")) return [`${where}: tags is not a list of strings`];
  const tags = tagsRaw as string[];
  const tacticTags = new Set(tags.filter((t) => t.startsWith("attack.") && !ATTACK_TECHNIQUE_TAG.test(t)).map((t) => t.slice(7)));
  for (const t of tacticTags) if (!attack.tactics.has(t)) errs.push(`${where}: attack.${t} is not an ATT&CK tactic in ${ATTACK.version}`);

  const techniqueTags = tags.filter((t) => ATTACK_TECHNIQUE_TAG.test(t));
  for (const tag of techniqueTags) {
    const id = tag.slice(7);
    const tech = attack.techniques.get(id);
    if (!tech) {
      errs.push(`${where}: ${tag} is not an active technique in ${ATTACK.version}`);
      continue;
    }
    if (!tech.tactics.some((x) => tacticTags.has(x))) {
      errs.push(`${where}: ${tag} (${tech.name}) is filed under ${tech.tactics.join(", ")}; the rule tags none of them`);
    }
  }

  if (!Object.hasOwn(rule.doc, "x-atlas")) {
    errs.push(`${where}: no x-atlas key (write x-atlas: [] when no ATLAS technique applies)`);
    return errs;
  }
  const atlasRaw = rule.doc["x-atlas"];
  if (!Array.isArray(atlasRaw) || atlasRaw.some((x) => typeof x !== "string")) {
    errs.push(`${where}: x-atlas is not a list of strings`);
    return errs;
  }
  const seen = new Set<string>();
  for (const id of atlasRaw as string[]) {
    if (!ATLAS_ID.test(id)) errs.push(`${where}: x-atlas ${JSON.stringify(id)} is not an AML.T ID`);
    else if (!atlas.has(id)) errs.push(`${where}: x-atlas ${id} is not a technique in ${ATLAS.version}`);
    if (seen.has(id)) errs.push(`${where}: x-atlas ${id} is listed twice`);
    seen.add(id);
  }
  if (rule.needsTechnique && techniqueTags.length === 0 && atlasRaw.length === 0) {
    errs.push(`${where}: no technique ID (an attack.tNNNN tag or an x-atlas entry)`);
  }
  return errs;
}

// The documents of one rule file, single or multi-document. Block scalars, which the gateway
// rules use, are accepted.
export function ruleDocs(text: string, source: string): Record<string, unknown>[] {
  const parsed = Bun.YAML.parse(text);
  const docs = /^---\s*$/m.test(text) ? parsed : [parsed];
  if (!Array.isArray(docs)) fail(`${source}: a multi-document file did not parse to a list`);
  for (const d of docs) if (d === null || typeof d !== "object" || Array.isArray(d)) fail(`${source}: a document is not a map`);
  return docs as Record<string, unknown>[];
}

export function loadRules(dirs: RuleDir[] = [DETECTION_RULES]): RuleRef[] {
  const out: RuleRef[] = [];
  for (const { dir, needsTechnique } of dirs) {
    const files = readdirSync(dir).filter((f) => f.endsWith(".yml")).sort();
    if (files.length === 0) fail(`no rule files in ${dir}`);
    for (const f of files) {
      const source = join(dir, f).slice(REPO.length + 1);
      for (const doc of ruleDocs(readFileSync(join(dir, f), "utf8"), source)) {
        if (typeof doc.title !== "string") fail(`${source}: a rule has no title`);
        out.push({ source, title: doc.title, doc, needsTechnique });
      }
    }
  }
  return out;
}

async function data(arg: string | undefined, pin: typeof ATTACK, what: string): Promise<string> {
  let bytes: Uint8Array;
  if (arg !== undefined) bytes = readFileSync(arg);
  else {
    const res = await fetch(pin.url);
    if (!res.ok) fail(`${what}: GET ${pin.url} returned ${res.status}`);
    bytes = new Uint8Array(await res.arrayBuffer());
  }
  requirePinned(bytes, pin.sha256, what);
  return new TextDecoder().decode(bytes);
}

function argValues(argv: string[], flag: string): string[] {
  const out: string[] = [];
  argv.forEach((a, i) => {
    if (a !== flag) return;
    const v = argv[i + 1];
    if (v === undefined || v.startsWith("--")) fail(`${flag} needs a value`);
    out.push(v);
  });
  return out;
}

function argValue(argv: string[], flag: string): string | undefined {
  const vs = argValues(argv, flag);
  if (vs.length > 1) fail(`${flag} given twice`);
  return vs[0];
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const FLAGS = new Set(["--attack", "--atlas", "--optional-rules"]);
  argv.forEach((a, i) => {
    if (a.startsWith("--") && !FLAGS.has(a)) fail(`unknown option ${a}`);
    if (!a.startsWith("--") && !FLAGS.has(argv[i - 1] ?? "")) fail(`unexpected argument ${a}`);
  });
  const attack = parseAttack(await data(argValue(argv, "--attack"), ATTACK, "ATT&CK"));
  const atlas = parseAtlas(await data(argValue(argv, "--atlas"), ATLAS, "ATLAS"));
  const rules = loadRules([DETECTION_RULES, ...argValues(argv, "--optional-rules").map((d) => ({ dir: join(process.cwd(), d), needsTechnique: false }))]);
  const errs = rules.flatMap((r) => checkRule(r, attack, atlas));
  let ids = 0;
  for (const r of rules) {
    const tech = ((r.doc.tags ?? []) as string[]).filter((t) => ATTACK_TECHNIQUE_TAG.test(t));
    const aml = (r.doc["x-atlas"] ?? []) as string[];
    ids += tech.length + (Array.isArray(aml) ? aml.length : 0);
    const names = [
      ...tech.map((t) => `${t.slice(7).toUpperCase()} ${attack.techniques.get(t.slice(7))?.name ?? "?"}`),
      ...(Array.isArray(aml) ? aml.map((a) => `${a} ${atlas.get(a)?.name ?? "?"}`) : []),
    ];
    console.log(`${r.source}: ${r.title}: ${names.length > 0 ? names.join("; ") : "none"}`);
  }
  if (errs.length > 0) {
    for (const e of errs) console.error(`FAIL ${e}`);
    process.exit(1);
  }
  console.log(`${rules.length} rules, ${ids} technique IDs, checked against ${ATTACK.version} and ${ATLAS.version}`);
}
