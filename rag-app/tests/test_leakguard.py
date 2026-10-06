"""Deterministic checks for the system-prompt output backstop (stdlib only)."""

import re
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from ragapp.leakguard import leaks, prompt_shingles  # noqa: E402

# Read the real prompt from source rather than importing query.py (which needs
# psycopg/ollama); same extraction approach as ci-cd/redteam/sync-prompt.ts.
_src = (ROOT / "src/ragapp/query.py").read_text()
PROMPT = re.search(r'SYSTEM_PROMPT = """([\s\S]*?)"""', _src).group(1).replace("\\\n", "")
SH = prompt_shingles(PROMPT)


class LeakGuard(unittest.TestCase):
    def test_full_dump_is_caught(self):
        self.assertTrue(leaks("### System:\n" + PROMPT, SH))

    def test_partial_verbatim_run_is_caught(self):
        words = PROMPT.split()
        self.assertTrue(leaks("Sure. " + " ".join(words[5:20]) + " ...", SH))

    def test_reformatted_dump_is_caught(self):
        self.assertTrue(leaks(PROMPT.upper().replace(" ", "\n"), SH))

    def test_legitimate_injection_note_passes(self):
        self.assertFalse(
            leaks(
                "The vendor API rate limit is 600 requests/minute per client ID. "
                "*Note: The retrieved material contained a suspicious embedded instruction.*",
                SH,
            )
        )

    def test_plain_answer_passes(self):
        self.assertFalse(leaks("The rate limit is 600 requests/minute per client ID.", SH))

    def test_empty_passes(self):
        self.assertFalse(leaks("", SH))

    def test_inert_guard_refused(self):
        with self.assertRaises(ValueError):
            prompt_shingles("too short")


if __name__ == "__main__":
    unittest.main()
