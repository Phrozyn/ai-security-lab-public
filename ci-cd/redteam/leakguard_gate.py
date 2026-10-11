"""Apply the RAG app's system-prompt leak guard to one model answer.

Used by guarded-gateway-provider.ts so the live gate tests the answer the app
would return, not the raw model output. Runs the app's own leaks() from
rag-app/src/ragapp/leakguard.py with the SYSTEM_PROMPT, PROMPT_TRIPWIRES and
LEAK_REFUSAL values from rag-app/src/ragapp/query.py. query.py is parsed, not
imported, because importing it needs psycopg, the database and Ollama.

    stdin:  {"answer": "<model output>"}
    stdout: {"blocked": true|false, "output": "<answer or LEAK_REFUSAL>"}

Standard library only. Any missing value or malformed input exits non-zero.
"""

import ast
import importlib.util
import json
import sys
from pathlib import Path

APP_SRC = Path(__file__).resolve().parents[2] / "rag-app" / "src" / "ragapp"
REQUIRED = ("SYSTEM_PROMPT", "PROMPT_TRIPWIRES", "LEAK_REFUSAL")


def load_leakguard():
    spec = importlib.util.spec_from_file_location("leakguard", APP_SRC / "leakguard.py")
    if spec is None or spec.loader is None:
        raise RuntimeError(f"cannot load {APP_SRC / 'leakguard.py'}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def query_constants() -> dict:
    tree = ast.parse((APP_SRC / "query.py").read_text(encoding="utf-8"))
    found = {}
    for node in ast.walk(tree):
        # Any other kind of write to these names would make the parsed value
        # differ from the one the app uses at run time.
        if isinstance(node, (ast.AugAssign, ast.AnnAssign)) and isinstance(node.target, ast.Name) and node.target.id in REQUIRED:
            raise RuntimeError(f"{node.target.id} is modified in query.py in a form this parser does not evaluate")
        if isinstance(node, ast.Assign) and node not in tree.body:
            names = [t.id for t in node.targets if isinstance(t, ast.Name) and t.id in REQUIRED]
            if names:
                raise RuntimeError(f"{names[0]} is assigned outside module level in query.py")
    for node in tree.body:
        if isinstance(node, ast.Assign) and len(node.targets) == 1 and isinstance(node.targets[0], ast.Name):
            name = node.targets[0].id
            if name in REQUIRED:
                if name in found:
                    raise RuntimeError(f"{name} is assigned more than once in query.py")
                found[name] = ast.literal_eval(node.value)
    missing = [n for n in REQUIRED if n not in found]
    if missing:
        raise RuntimeError(f"query.py has no literal assignment for {', '.join(missing)}")
    if not isinstance(found["SYSTEM_PROMPT"], str) or not isinstance(found["LEAK_REFUSAL"], str):
        raise RuntimeError("SYSTEM_PROMPT and LEAK_REFUSAL must be strings")
    tripwires = found["PROMPT_TRIPWIRES"]
    if not isinstance(tripwires, tuple) or not tripwires or not all(isinstance(t, str) for t in tripwires):
        raise RuntimeError("PROMPT_TRIPWIRES must be a non-empty tuple of strings")
    return found


def main() -> int:
    request = json.loads(sys.stdin.read())
    if not isinstance(request, dict) or set(request) != {"answer"} or not isinstance(request["answer"], str):
        raise RuntimeError('input must be {"answer": <string>}')
    answer = request["answer"]
    leakguard = load_leakguard()
    const = query_constants()
    shingles = leakguard.prompt_shingles(const["SYSTEM_PROMPT"])
    blocked = leakguard.leaks(answer, shingles, const["PROMPT_TRIPWIRES"])
    json.dump({"blocked": blocked, "output": const["LEAK_REFUSAL"] if blocked else answer}, sys.stdout)
    return 0


if __name__ == "__main__":
    sys.exit(main())
