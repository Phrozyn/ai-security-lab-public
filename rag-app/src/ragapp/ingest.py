"""Ingestion: read the corpus, one chunk per document (the corpus docs are
short enough that paragraph-splitting would add complexity without adding a
meaningful test of ACL enforcement; the point here is the ACL boundary, not
chunking strategy), embed, store with metadata.
"""

from pathlib import Path

import frontmatter

from ragapp import db
from ragapp.ollama_client import embed


def ingest_corpus(corpus_dir: Path) -> int:
    conn = db.get_connection()
    db.init_schema(conn)
    db.clear_chunks(conn)

    count = 0
    for path in sorted(corpus_dir.glob("*.md")):
        post = frontmatter.load(path)
        doc_id = post.get("doc_id", path.stem)
        acl = post["acl"]
        owner = post["owner"]
        content = post.content.strip()

        vector = embed(content)
        db.insert_chunk(conn, doc_id, acl, owner, content, vector)
        count += 1
        print(f"ingested {doc_id} (acl={acl}, owner={owner}, {len(content)} chars)")

    return count
