"""pgvector-backed storage, in a dedicated `ragapp` database on the same
Postgres instance the gateway deployed, not a separate DB server.

Two roles: ingestion connects as the owner (RAGAPP_DATABASE_URL), the query
path as the read-only `ragapp_query` role (RAGAPP_QUERY_DATABASE_URL). A
superuser creates the vector extension, that role, the scope roles and the
row-level security policies on chunks with rag-app/sql/roles.sql.

Each search runs in one transaction after SET LOCAL ROLE to the scope role for
the caller's allowed_acl set (SCOPE_ROLES). Without the role switch,
ragapp_query reads zero rows from chunks.
"""

import os

import psycopg
from pgvector.psycopg import register_vector
from psycopg import sql

DEFAULT_DATABASE_URL = "postgresql://ragapp:ragapp@127.0.0.1:5432/ragapp"

EMBED_DIM = 768  # nomic-embed-text's output dimension

# allowed_acl set -> the scope role whose RLS policy admits exactly that set
# (rag-app/sql/roles.sql). Closed mapping: any other set raises.
SCOPE_ROLES: dict[frozenset[str], str] = {
    frozenset({"public"}): "rag_scope_public",
    frozenset({"public", "internal"}): "rag_scope_internal",
    frozenset({"public", "internal", "restricted"}): "rag_scope_restricted",
}


class UnknownScopeError(ValueError):
    """allowed_acl does not match a defined scope role."""


def scope_role(allowed_acl: list[str]) -> str:
    """The scope role for exactly this allowed_acl set. Raises
    UnknownScopeError for any set not in SCOPE_ROLES, including subsets and
    supersets of a defined scope; it never returns a broader role.
    """
    if isinstance(allowed_acl, str) or not all(isinstance(a, str) for a in allowed_acl):
        raise UnknownScopeError(f"allowed_acl must be a list of strings: {allowed_acl!r}")
    key = frozenset(allowed_acl)
    if len(key) != len(allowed_acl) or key not in SCOPE_ROLES:
        raise UnknownScopeError(f"no scope role for allowed_acl {sorted(key)!r}")
    return SCOPE_ROLES[key]


def get_connection(readonly: bool = False) -> psycopg.Connection:
    if readonly:
        url = os.environ.get("RAGAPP_QUERY_DATABASE_URL", "")
        if not url:
            raise RuntimeError("RAGAPP_QUERY_DATABASE_URL is not set (query path)")
    else:
        url = os.environ.get("RAGAPP_DATABASE_URL", DEFAULT_DATABASE_URL)

    conn = psycopg.connect(url, autocommit=True)
    try:
        if readonly:
            conn.execute("SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY")
            # Refuses a query URL that points at the owner or a superuser.
            can_write = conn.execute(
                "SELECT has_table_privilege('chunks', 'INSERT, UPDATE, DELETE, TRUNCATE')"
            ).fetchone()[0]
            if can_write:
                raise RuntimeError(
                    "the query role can write to chunks; RAGAPP_QUERY_DATABASE_URL "
                    "must connect as ragapp_query"
                )
        register_vector(conn)
    except BaseException:
        conn.close()
        raise
    return conn


def init_schema(conn: psycopg.Connection) -> None:
    conn.execute(
        f"""
        CREATE TABLE IF NOT EXISTS chunks (
            id SERIAL PRIMARY KEY,
            doc_id TEXT NOT NULL,
            acl TEXT NOT NULL,
            owner TEXT NOT NULL,
            content TEXT NOT NULL,
            embedding VECTOR({EMBED_DIM}) NOT NULL
        )
        """
    )
    conn.execute("CREATE INDEX IF NOT EXISTS chunks_acl_idx ON chunks (acl)")
    # A newly created chunks table has no policies, so with RLS enabled the
    # query path reads zero rows until roles.sql runs (fail closed). The owner
    # bypasses RLS (not forced), so ingestion is unaffected.
    conn.execute("ALTER TABLE chunks ENABLE ROW LEVEL SECURITY")


def clear_chunks(conn: psycopg.Connection) -> None:
    # TRUNCATE keeps the table, its grants and its RLS policies. Dropping and
    # re-creating chunks would remove them and require a roles.sql re-run.
    conn.execute("TRUNCATE chunks")


def insert_chunk(
    conn: psycopg.Connection,
    doc_id: str,
    acl: str,
    owner: str,
    content: str,
    embedding: list[float],
) -> None:
    conn.execute(
        "INSERT INTO chunks (doc_id, acl, owner, content, embedding) "
        "VALUES (%s, %s, %s, %s, %s)",
        (doc_id, acl, owner, content, embedding),
    )


def search(
    conn: psycopg.Connection,
    query_embedding: list[float],
    allowed_acl: list[str],
    top_k: int = 3,
) -> list[dict]:
    """The ACL enforcement point. Two checks on the same scope:
    - row-level security: the query runs after SET LOCAL ROLE to the scope
      role for allowed_acl, whose policy admits only that scope's rows;
    - allowed_acl filters the SQL WHERE clause itself.
    A chunk outside the caller's scope is never fetched from the database, let
    alone considered for ranking. This is retrieval-time enforcement, not a
    post-hoc filter on a fetched result set.
    """
    # Resolved before the transaction opens: an unknown scope raises without
    # running any SQL. The role name comes from SCOPE_ROLES, never from input.
    role = scope_role(allowed_acl)
    # Explicit ::vector cast: with a bare `%s` here (no target-column context
    # the way INSERT has), psycopg adapts a Python list of floats to
    # `double precision[]` by default, which pgvector's `<=>` operator can't
    # compare against; hit this live on the first query.
    # SET LOCAL ends with the transaction, so the connection returns to
    # ragapp_query (zero visible rows) after this block, on commit or error.
    with conn.transaction():
        conn.execute(sql.SQL("SET LOCAL ROLE {}").format(sql.Identifier(role)))
        rows = conn.execute(
            """
            SELECT doc_id, acl, owner, content,
                   embedding <=> %s::vector AS distance
            FROM chunks
            WHERE acl = ANY(%s)
            ORDER BY distance ASC
            LIMIT %s
            """,
            (query_embedding, allowed_acl, top_k),
        ).fetchall()
    return [
        {"doc_id": r[0], "acl": r[1], "owner": r[2], "content": r[3], "distance": r[4]}
        for r in rows
    ]
