// Policy gate: serialized model artifacts are never committed to this repo.
// Models are pulled by pinned digest (see ../models.lock.json) and scanned
// where they land; a pickle/checkpoint arriving through a PR is exactly the
// supply-chain path (OWASP LLM03, MITRE ATLAS AML.T0010) this gate closes.
//
// Fails loud: if git can't list files, or any tracked path has a banned
// extension, exit 1. No allowlist by default -- add one deliberately, in-diff.

const BANNED = [
  ".pkl", ".pickle", ".joblib", ".pt", ".pth", ".ckpt", ".bin", ".h5", ".hdf5",
  ".keras", ".onnx", ".pb", ".tflite", ".gguf", ".ggml", ".safetensors", ".npy", ".npz",
];

const proc = Bun.spawnSync(["git", "ls-files", "-z"]);
if (proc.exitCode !== 0) {
  throw new Error(`git ls-files failed (exit ${proc.exitCode}): ${proc.stderr.toString()}`);
}
const files = proc.stdout.toString().split("\0").filter(Boolean);
if (files.length === 0) throw new Error("git ls-files returned nothing -- wrong working directory?");

const offenders = files.filter((f) => BANNED.some((ext) => f.toLowerCase().endsWith(ext)));
if (offenders.length > 0) {
  console.error("Serialized model artifacts are not allowed in the repo:");
  for (const f of offenders) console.error(`  - ${f}`);
  process.exit(1);
}
console.log(`OK: ${files.length} tracked files, none with a model-artifact extension.`);
