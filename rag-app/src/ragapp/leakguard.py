"""Deterministic output check: did the model reproduce its own system prompt?

The prompt's confidentiality rule is a request to the model, and the model can
be talked out of it (docs/threat-model.md, 2026-10-05 auditor-claim finding).
This is the control that does not depend on the model: refuse any answer that
contains a long verbatim run of the prompt. Dependency-free so it is testable
without the DB/Ollama stack.
"""

import re

# 12 words clears the legitimate "retrieved material contained a suspicious
# embedded instruction" note (7 words) yet catches full dumps.
LEAK_WINDOW_WORDS = 12


def _words(text: str) -> list[str]:
    return re.findall(r"[a-z0-9']+", text.lower())


def _shingles(words: list[str]) -> set[tuple[str, ...]]:
    n = LEAK_WINDOW_WORDS
    return {tuple(words[i : i + n]) for i in range(len(words) - n + 1)}


def prompt_shingles(prompt: str) -> set[tuple[str, ...]]:
    shingles = _shingles(_words(prompt))
    if not shingles:
        # An empty set would make leaks() return False for everything.
        raise ValueError(f"prompt shorter than {LEAK_WINDOW_WORDS} words; leak guard would be inert")
    return shingles


def _squash(text: str) -> str:
    return re.sub(r"[^a-z0-9]", "", text.lower())


def leaks(
    answer: str,
    shingles: set[tuple[str, ...]],
    tripwires: tuple[str, ...] = (),
) -> bool:
    """True if the answer holds a verbatim prompt run or any tripwire marker.

    The shingle check only sees English text copied from the prompt. A
    translation or other transformation shares no 12-word run with it, but an
    identifier such as a tripwire marker is carried through unchanged, so the
    marker check is language-independent. Markers are compared with everything
    except letters and digits removed, which also matches spaced or hyphen-split
    copies.
    """
    if not shingles.isdisjoint(_shingles(_words(answer))):
        return True
    squashed = _squash(answer)
    for marker in tripwires:
        key = _squash(marker)
        if not key:
            # An empty marker would match every answer.
            raise ValueError("empty tripwire marker")
        if key in squashed:
            return True
    return False
