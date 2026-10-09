# Composition function reference

Executable reference for [`docs/composition-function.md`](../../docs/composition-function.md). It is not a pipeline component. Thresholds and level values in it are placeholders for testing, not calibrated values.

- `ce_reference.ts`: the composition function, the linkage evidence score, the response rung gate, the count and capability ledgers, the release fence, the store-failure proxy, and the property checks P1 to P22 with negative controls. It exits 0 when every check passes and prints the number of assertions per property.
- `cap_mutants.ts`: applies one-line mutants to a copy of `ce_reference.ts`. Each mutant must make the reference fail with a named property. A mutant whose source line is not found exactly once throws, and a mutant that runs longer than 120 seconds counts as survived.

Run from this directory with bun:

    bun ce_reference.ts
    bun cap_mutants.ts
