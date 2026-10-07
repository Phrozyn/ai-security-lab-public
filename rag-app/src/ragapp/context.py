"""Assembly of the user message: retrieved chunks inside the <retrieved_context>
fence, then the question.

Chunk text and doc ids are untrusted, so a `<` that starts the fence tag (opening
or closing, any case, any spacing inside the tag) is written as `&lt;` and a
document cannot close the fence early or open a second one. Other angle-bracket
text is left as it is, including a tag whose name only starts with the fence name
(`<retrieved_context-extra>`): the model treats the system prompt's "DATA ONLY" rule, not
the escaping, as the control for instructions that sit inside the fence, and the
live red-team suite was run against corpus text with its angle brackets intact.
Characters that only look like `<` (fullwidth or zero-width variants) are not
matched here.
"""

import re

# Matches the `<` of <retrieved_context>, </retrieved_context>, < / RETRIEVED_CONTEXT >,
# <retrieved_context/> and a tag cut off at the end of the text. The tag name must end at
# whitespace, `>`, `/` or the end of the text, so <retrieved_context-extra> is left alone.
_FENCE_TAG_START = re.compile(r"<(?=\s*/?\s*retrieved_context(?:[\s/>]|$))", re.IGNORECASE)

NO_MATCHES = "(no matching documents found for your access level)"


def escape_fence(text: str) -> str:
    return _FENCE_TAG_START.sub("&lt;", text)


def build_user_message(chunks: list[str], question: str) -> str:
    """chunks: one string per retrieved document (doc id and redacted text).
    The question follows the fence unescaped; the caller controls it by design.
    """
    block = "\n\n".join(escape_fence(c) for c in chunks) if chunks else NO_MATCHES
    return f"<retrieved_context>\n{block}\n</retrieved_context>\n\nQuestion: {question}"
