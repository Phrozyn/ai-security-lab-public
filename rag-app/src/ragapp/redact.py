"""Presidio-based redaction of retrieved context before it's assembled into
the prompt sent to the model. Runs on retrieved chunks, not on the corpus at
rest — the corpus documents keep their real content; only what crosses into
the model's context gets redacted.
"""

from presidio_analyzer import AnalyzerEngine
from presidio_anonymizer import AnonymizerEngine

_analyzer = AnalyzerEngine()
_anonymizer = AnonymizerEngine()

# Entities worth catching in an internal-docs corpus. Presidio's default set
# is broader (includes things like US-specific ID formats); narrowed here to
# what's plausible in this corpus so redaction output is a demonstration of
# a considered policy, not just "add all the entities."
ENTITIES = ["EMAIL_ADDRESS", "PHONE_NUMBER", "PERSON", "CREDIT_CARD", "IBAN_CODE"]


def redact(text: str) -> tuple[str, list[str]]:
    """Returns (redacted_text, entity_types_found)."""
    results = _analyzer.analyze(text=text, entities=ENTITIES, language="en")
    if not results:
        return text, []
    anonymized = _anonymizer.anonymize(text=text, analyzer_results=results)
    found = sorted({r.entity_type for r in results})
    return anonymized.text, found
