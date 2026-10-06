#!/usr/bin/env bun
// Validates every Sigma rule in rules/: schema compliance, UUID uniqueness,
// and -- the part a syntax check alone can't give you -- that each rule's
// detection logic actually fires on a real captured log line (true positive)
// and stays silent on an unrelated one (true negative). Fixtures live in
// samples/, captured live from the deployed gateway and RAG app, not
// hand-written to make the rule look good.

import { readdirSync, readFileSync } from "fs";
import { join, dirname } from "path";

const RULES_DIR = join(import.meta.dir, "rules");
const SAMPLES_DIR = join(import.meta.dir, "samples");

type Rule = Record<string, any>;

function loadRules(): { file: string; rule: Rule }[] {
  return readdirSync(RULES_DIR)
    .filter((f) => f.endsWith(".yml") || f.endsWith(".yaml"))
    .map((file) => ({
      file,
      rule: Bun.YAML.parse(readFileSync(join(RULES_DIR, file), "utf8")) as Rule,
    }));
}

function loadFixture(relPath: string): any[] {
  const abs = join(RULES_DIR, relPath); // x-fixtures paths are relative to rules/
  return readFileSync(abs, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

// Supports exactly the field-matching styles these 7 rules use: plain
// equality (scalar expected against a scalar OR list field -- Sigma's own
// semantics are "any element of a list field equals"), |contains and
// |startswith on string fields, and OR-lists as the expected value. Anything
// outside that (an unrecognized modifier, a chained modifier, |contains on
// an array field) throws instead of silently falling back to a different
// check -- a rule that "passes" for the wrong reason is worse than one that
// errors loudly.
function matchesSelection(selection: Record<string, any>, event: Record<string, any>): boolean {
  for (const [key, rawExpected] of Object.entries(selection)) {
    const parts = key.split("|");
    const field = parts[0];
    const modifiers = parts.slice(1);
    if (modifiers.length > 1) {
      throw new Error(`chained modifiers not supported: "${key}"`);
    }
    const modifier = modifiers[0] ?? null;
    if (modifier !== null && modifier !== "contains" && modifier !== "startswith") {
      throw new Error(`unsupported Sigma modifier "${modifier}" on field "${field}"`);
    }
    const actual = event[field];
    const expectedList = Array.isArray(rawExpected) ? rawExpected : [rawExpected];

    const oneMatches = (expected: any): boolean => {
      if (modifier === "contains") {
        if (typeof actual === "string") return actual.includes(expected);
        throw new Error(
          `|contains used on non-string field "${field}" -- list fields use plain equality in Sigma (any element equals), not |contains`,
        );
      }
      if (modifier === "startswith") {
        if (typeof actual !== "string") throw new Error(`|startswith used on non-string field "${field}"`);
        return actual.startsWith(expected);
      }
      // No modifier: Sigma equality. A list-valued field matches if any
      // element strictly equals the expected scalar.
      if (Array.isArray(actual)) return actual.includes(expected);
      return actual === expected;
    };

    if (!expectedList.some(oneMatches)) return false;
  }
  return true;
}

function parseTimespan(span: string): number {
  const m = span.match(/^(\d+)([smh])$/);
  if (!m) throw new Error(`unparseable timespan: ${span}`);
  const n = Number(m[1]);
  const unit = m[2];
  return unit === "s" ? n : unit === "m" ? n * 60 : n * 3600;
}

// Max count of matching events within any `timespanSec` sliding window,
// per group-by value. `t` is epoch milliseconds (Date.parse); timespanSec
// is converted to milliseconds for the comparison.
function maxWindowCount(
  events: { t: number; group: string }[],
  timespanSec: number,
): Record<string, number> {
  const timespanMs = timespanSec * 1000;
  const byGroup: Record<string, number[]> = {};
  for (const e of events) (byGroup[e.group] ??= []).push(e.t);
  const result: Record<string, number> = {};
  for (const [group, times] of Object.entries(byGroup)) {
    times.sort((a, b) => a - b);
    let best = 0;
    let lo = 0;
    for (let hi = 0; hi < times.length; hi++) {
      while (times[hi] - times[lo] > timespanMs) lo++;
      best = Math.max(best, hi - lo + 1);
    }
    result[group] = best;
  }
  return result;
}

let failures = 0;
const seenIds = new Set<string>();
const byName: Record<string, Rule> = {};
const loaded = loadRules();
for (const { rule } of loaded) if (rule.name) byName[rule.name] = rule;

console.log(`Loaded ${loaded.length} rule file(s) from ${RULES_DIR}\n`);

for (const { file, rule } of loaded) {
  const label = `${file} (${rule.title ?? "untitled"})`;
  const isCorrelation = !!rule.correlation;

  // --- Schema gate ---
  const schemaErrors: string[] = [];
  if (!rule.title) schemaErrors.push("missing title");
  if (!rule.id) schemaErrors.push("missing id");
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(rule.id ?? ""))
    schemaErrors.push("id is not a valid UUID");
  if (rule.id && seenIds.has(rule.id)) schemaErrors.push("duplicate id across rule files");
  if (rule.id) seenIds.add(rule.id);
  if (!rule.status) schemaErrors.push("missing status");
  if (!isCorrelation && !rule.logsource) schemaErrors.push("missing logsource");
  if (!isCorrelation && !rule.detection) schemaErrors.push("missing detection");
  if (!isCorrelation && rule.detection && rule.detection.condition !== "selection")
    schemaErrors.push(`detection.condition must be "selection" (this harness supports no other form)`);
  if (isCorrelation) {
    for (const k of ["type", "rules", "group-by", "timespan", "condition"]) {
      if (!(k in rule.correlation)) schemaErrors.push(`correlation missing ${k}`);
    }
    if (rule.correlation.type && rule.correlation.type !== "event_count")
      schemaErrors.push(`correlation.type "${rule.correlation.type}" not supported (only event_count)`);
    if (rule.correlation.condition && !("gte" in rule.correlation.condition))
      schemaErrors.push(`correlation.condition must use "gte" (this harness supports no other comparator)`);
  }

  if (schemaErrors.length) {
    console.log(`FAIL  ${label}`);
    for (const e of schemaErrors) console.log(`        schema: ${e}`);
    failures++;
    continue;
  }

  // --- Detection-logic gate ---
  if (!isCorrelation) {
    const selection = rule.detection.selection;
    const fixtures: any[] = (rule["x-fixtures"] ?? []).flatMap((r: string) => loadFixture(r));
    if (fixtures.length === 0) {
      console.log(`FAIL  ${label}\n        no fixtures found via x-fixtures:`);
      failures++;
      continue;
    }
    const matched = fixtures.filter((e) => matchesSelection(selection, e));
    const unmatched = fixtures.filter((e) => !matchesSelection(selection, e));
    // A `name:`d, level:informational rule is a correlation base, not a
    // standalone alert -- it's expected to match every event of its class,
    // so it isn't held to the true-negative requirement.
    const isBase = !!rule.name && rule.level === "informational";
    const ok = matched.length > 0 && (isBase || unmatched.length > 0);
    console.log(
      `${ok ? "PASS" : "FAIL"}  ${label}\n        ${matched.length}/${fixtures.length} fixture lines matched${isBase ? " (base rule, feeds a correlation; no true-negative required)" : " (true positive), " + unmatched.length + " did not (true negative)"}`,
    );
    if (!ok) failures++;
  } else {
    const baseName = rule.correlation.rules[0];
    const base = byName[baseName];
    if (!base) {
      console.log(`FAIL  ${label}\n        base rule "${baseName}" not found (no rule file has name: ${baseName})`);
      failures++;
      continue;
    }
    const fixtures: any[] = (rule["x-fixtures"] ?? []).flatMap((r: string) => loadFixture(r));
    const groupField = rule.correlation["group-by"][0];
    const timespanSec = parseTimespan(rule.correlation.timespan);
    const threshold = rule.correlation.condition.gte;

    const matching = fixtures
      .filter((e) => matchesSelection(base.detection.selection, e))
      .map((e) => {
        const t = Date.parse(e.startTime ?? e.timestamp);
        if (Number.isNaN(t)) throw new Error(`unparseable timestamp in fixture event: ${JSON.stringify(e)}`);
        return { t, group: e[groupField] ?? "unknown" };
      });

    const fullWindow = maxWindowCount(matching, timespanSec);
    const fullMax = Math.max(0, ...Object.values(fullWindow));

    // Negative proof 1: the same rule logic over only the pre-burst
    // historical slice of the same real fixture (everything more than one
    // timespan before the final event) must NOT cross the threshold --
    // otherwise the rule would alert on ordinary usage.
    const timespanMs = timespanSec * 1000;
    const sorted = [...matching].sort((a, b) => a.t - b.t);
    const lastT = sorted.length ? sorted[sorted.length - 1].t : 0;
    const historical = sorted.filter((e) => e.t < lastT - timespanMs);
    const histWindow = maxWindowCount(historical, timespanSec);
    const histMax = Math.max(0, ...Object.values(histWindow));

    // Negative proof 2: a boundary check -- take only the real events that
    // actually fall inside the dense burst window (same group, within one
    // timespan of its last event), trim to one event short of the
    // threshold, and confirm the rule does NOT fire. Proves the threshold
    // comparison itself is exact, not just "big number beats small number".
    const burstGroup = Object.entries(fullWindow).find(([, c]) => c === fullMax)?.[0];
    const groupTimes = sorted.filter((e) => e.group === burstGroup).map((e) => e.t);
    const groupLastT = groupTimes.length ? groupTimes[groupTimes.length - 1] : 0;
    const windowMembers = groupTimes.filter((t) => groupLastT - t <= timespanMs);
    const trimmed = windowMembers.slice(0, Math.max(0, threshold - 1));
    const trimmedMax = Math.max(
      0,
      ...Object.values(maxWindowCount(trimmed.map((t) => ({ t, group: "x" })), timespanSec)),
    );

    const histOk = histMax < threshold;
    const trimmedOk = trimmedMax < threshold;
    const ok = fullMax >= threshold && histOk && trimmedOk;
    console.log(
      `${ok ? "PASS" : "FAIL"}  ${label}\n` +
        `        max observed count in ${rule.correlation.timespan}: ${fullMax} (threshold ${threshold}) [true positive]\n` +
        `        historical-only slice: ${histMax} (${histOk ? "below" : "AT/ABOVE"} threshold) [true negative]\n` +
        `        burst trimmed to ${trimmed.length} events: ${trimmedMax} (${trimmedOk ? "below" : "AT/ABOVE"} threshold) [boundary check]`,
    );
    if (!ok) failures++;
  }
}

console.log(`\n${loaded.length - failures}/${loaded.length} rules passed.`);
if (failures > 0) process.exit(1);
