"""Ingestion: read the corpus, one chunk per document (the corpus docs are
short enough that paragraph-splitting would add complexity without adding a
meaningful test of ACL enforcement; the point here is the ACL boundary, not
chunking strategy), embed, store with metadata.
"""

from pathlib import Path

import frontmatter

from ragapp import db
from ragapp.ollama_client import embed


def _load_corpus(corpus_dir: Path) -> list[dict]:
    """Parses every document before anything is embedded or stored."""
    docs = []
    for path in sorted(corpus_dir.glob("*.md")):
        post = frontmatter.load(path)
        for key in ("acl", "owner"):
            if key not in post:
                raise ValueError(f"{path.name}: front matter is missing '{key}'")
        docs.append(
            {
                "doc_id": post.get("doc_id", path.stem),
                "acl": post["acl"],
                "owner": post["owner"],
                "content": post.content.strip(),
            }
        )
    if not docs:
        raise ValueError(f"no .md documents in {corpus_dir}")
    return docs


def ingest_corpus(corpus_dir: Path) -> int:
    docs = _load_corpus(corpus_dir)
    # Every embedding is computed before the database is touched, so an Ollama
    # failure or a malformed document leaves the stored corpus as it was.
    vectors = [embed(doc["content"]) for doc in docs]

    conn = db.get_connection(readonly=False)
    try:
        db.init_schema(conn)
        # TRUNCATE and the inserts commit together or not at all.
        with conn.transaction():
            db.clear_chunks(conn)
            for doc, vector in zip(docs, vectors):
                db.insert_chunk(conn, doc["doc_id"], doc["acl"], doc["owner"], doc["content"], vector)
    finally:
        conn.close()

    for doc in docs:
        print(f"ingested {doc['doc_id']} (acl={doc['acl']}, owner={doc['owner']}, {len(doc['content'])} chars)")
    return len(docs)
