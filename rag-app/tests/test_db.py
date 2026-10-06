"""db.get_connection() owner/query role selection, and which role the ingest
and query paths request (stdlib only).

psycopg, pgvector, yaml, frontmatter, httpx and presidio are replaced by stub
modules for each import, so these tests run without the rag-app dependencies.
The stubs and the freshly imported ragapp modules are removed afterwards so
other test modules import the installed modules.
"""

import contextlib
import os
import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

import ragapp  # noqa: E402

OWNER_URL = "postgresql://owner:owner-pw@db.example:5432/ragapp"
QUERY_URL = "postgresql://ragapp_query:query-pw@db.example:5432/ragapp"
DEFAULT_OWNER_URL = "postgresql://ragapp:ragapp@127.0.0.1:5432/ragapp"
READ_ONLY_SQL = "SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY"
GUARD_SQL = "SELECT has_table_privilege('chunks', 'INSERT, UPDATE, DELETE, TRUNCATE')"
FRESH = ("ragapp.db", "ragapp.query", "ragapp.ingest")


class FakeCursor:
    def __init__(self, row):
        self._row = row

    def fetchone(self):
        return self._row


class FakeConnection:
    def __init__(self, guard_result=False):
        self.guard_result = guard_result
        self.executed: list[str] = []
        self.closed = False

    def execute(self, sql, params=None):
        self.executed.append(sql)
        if "has_table_privilege" in sql:
            return FakeCursor((self.guard_result,))
        return FakeCursor(None)

    def close(self):
        self.closed = True


def _module(name, **attrs):
    m = types.ModuleType(name)
    for k, v in attrs.items():
        setattr(m, k, v)
    return m


@contextlib.contextmanager
def fresh_import(module_name, extra_stubs=None):
    """Import module_name with stubbed third-party modules; undo on exit."""
    connect = mock.MagicMock(name="psycopg.connect")
    register_vector = mock.MagicMock(name="register_vector")
    psycopg_stub = _module("psycopg", connect=connect, Connection=FakeConnection)
    pgvector_psycopg = _module("pgvector.psycopg", register_vector=register_vector)
    stubs = {
        "psycopg": psycopg_stub,
        "pgvector": _module("pgvector", psycopg=pgvector_psycopg),
        "pgvector.psycopg": pgvector_psycopg,
        **(extra_stubs or {}),
    }
    saved_attrs = {n.split(".")[1]: getattr(ragapp, n.split(".")[1], None) for n in FRESH}
    with mock.patch.dict(sys.modules, stubs):
        for n in FRESH:
            sys.modules.pop(n, None)
        try:
            __import__(module_name)
            yield sys.modules[module_name], connect, register_vector
        finally:
            for n in FRESH:
                sys.modules.pop(n, None)
            for attr, value in saved_attrs.items():
                if value is None:
                    if hasattr(ragapp, attr):
                        delattr(ragapp, attr)
                else:
                    setattr(ragapp, attr, value)


def _env(**values):
    """Patch os.environ with only the RAGAPP_* variables given."""
    env = {k: v for k, v in os.environ.items() if not k.startswith("RAGAPP_")}
    env.update(values)
    return mock.patch.dict(os.environ, env, clear=True)


class OwnerConnection(unittest.TestCase):
    def test_uses_ragapp_database_url_when_set(self):
        with fresh_import("ragapp.db") as (db, connect, register_vector), _env(
            RAGAPP_DATABASE_URL=OWNER_URL, RAGAPP_QUERY_DATABASE_URL=QUERY_URL
        ):
            conn = FakeConnection()
            connect.return_value = conn
            self.assertIs(db.get_connection(readonly=False), conn)
            connect.assert_called_once_with(OWNER_URL, autocommit=True)
            register_vector.assert_called_once_with(conn)
            self.assertEqual(conn.executed, [])
            self.assertFalse(conn.closed)

    def test_default_url_when_unset(self):
        with fresh_import("ragapp.db") as (db, connect, _), _env():
            connect.return_value = FakeConnection()
            db.get_connection()
            connect.assert_called_once_with(DEFAULT_OWNER_URL, autocommit=True)

    def test_env_read_at_call_time(self):
        with fresh_import("ragapp.db") as (db, connect, _):
            connect.return_value = FakeConnection()
            with _env(RAGAPP_DATABASE_URL=OWNER_URL):
                db.get_connection(readonly=False)
            connect.assert_called_once_with(OWNER_URL, autocommit=True)


class QueryConnection(unittest.TestCase):
    def test_uses_query_url_never_owner_url(self):
        with fresh_import("ragapp.db") as (db, connect, register_vector), _env(
            RAGAPP_DATABASE_URL=OWNER_URL, RAGAPP_QUERY_DATABASE_URL=QUERY_URL
        ):
            conn = FakeConnection(guard_result=False)
            connect.return_value = conn
            self.assertIs(db.get_connection(readonly=True), conn)
            connect.assert_called_once_with(QUERY_URL, autocommit=True)
            self.assertEqual(conn.executed, [READ_ONLY_SQL, GUARD_SQL])
            register_vector.assert_called_once_with(conn)
            self.assertFalse(conn.closed)

    def test_unset_query_url_raises_without_connecting(self):
        for value in (None, ""):
            with self.subTest(value=value), fresh_import("ragapp.db") as (db, connect, _):
                env = {"RAGAPP_DATABASE_URL": OWNER_URL}
                if value is not None:
                    env["RAGAPP_QUERY_DATABASE_URL"] = value
                with _env(**env):
                    with self.assertRaisesRegex(RuntimeError, "RAGAPP_QUERY_DATABASE_URL"):
                        db.get_connection(readonly=True)
                connect.assert_not_called()

    def test_writable_role_is_refused(self):
        with fresh_import("ragapp.db") as (db, connect, register_vector), _env(
            RAGAPP_QUERY_DATABASE_URL=QUERY_URL
        ):
            conn = FakeConnection(guard_result=True)
            connect.return_value = conn
            with self.assertRaisesRegex(RuntimeError, "can write to chunks"):
                db.get_connection(readonly=True)
            self.assertTrue(conn.closed)
            register_vector.assert_not_called()


class ConnectionErrors(unittest.TestCase):
    def test_register_vector_failure_closes_and_propagates(self):
        for readonly in (False, True):
            with self.subTest(readonly=readonly), fresh_import("ragapp.db") as (
                db,
                connect,
                register_vector,
            ), _env(RAGAPP_DATABASE_URL=OWNER_URL, RAGAPP_QUERY_DATABASE_URL=QUERY_URL):
                conn = FakeConnection()
                connect.return_value = conn
                register_vector.side_effect = LookupError("vector type not found")
                with self.assertRaisesRegex(LookupError, "vector type not found"):
                    db.get_connection(readonly=readonly)
                self.assertTrue(conn.closed)

    def test_no_create_extension_in_either_mode(self):
        for readonly in (False, True):
            with self.subTest(readonly=readonly), fresh_import("ragapp.db") as (db, connect, _), _env(
                RAGAPP_DATABASE_URL=OWNER_URL, RAGAPP_QUERY_DATABASE_URL=QUERY_URL
            ):
                conn = FakeConnection()
                connect.return_value = conn
                db.get_connection(readonly=readonly)
                self.assertEqual(len(conn.executed), 2 if readonly else 0)
                for sql in conn.executed:
                    self.assertNotIn("CREATE EXTENSION", sql.upper())


class CallerRoles(unittest.TestCase):
    def test_ingest_requests_owner_connection(self):
        stubs = {
            "frontmatter": _module("frontmatter", load=mock.MagicMock()),
            "ragapp.ollama_client": _module("ragapp.ollama_client", embed=mock.MagicMock()),
        }
        with fresh_import("ragapp.ingest", stubs) as (ingest, _, _), tempfile.TemporaryDirectory() as d:
            get_connection = mock.MagicMock(name="get_connection")
            with mock.patch.object(ingest.db, "get_connection", get_connection), mock.patch.object(
                ingest.db, "init_schema"
            ), mock.patch.object(ingest.db, "clear_chunks"):
                self.assertEqual(ingest.ingest_corpus(Path(d)), 0)
            get_connection.assert_called_once_with(readonly=False)

    def test_query_requests_read_only_connection(self):
        ollama = _module(
            "ragapp.ollama_client",
            embed=mock.MagicMock(return_value=[0.1, 0.2]),
            generate=mock.MagicMock(return_value="The rate limit is 600 requests/minute."),
            guardrail_check=mock.MagicMock(return_value=(True, "safe")),
        )
        stubs = {
            "yaml": _module("yaml", safe_load=mock.MagicMock()),
            "ragapp.ollama_client": ollama,
            "ragapp.redact": _module("ragapp.redact", redact=lambda text: (text, [])),
        }
        hits = [{"doc_id": "doc-004", "acl": "public", "owner": "x", "content": "600/min", "distance": 0.1}]
        with fresh_import("ragapp.query", stubs) as (query, _, _):
            conn = mock.MagicMock(name="conn")
            get_connection = mock.MagicMock(name="get_connection", return_value=conn)
            search = mock.MagicMock(name="search", return_value=hits)
            users = {"guest": {"allowed_acl": ["public"]}}
            with mock.patch.object(query.db, "get_connection", get_connection), mock.patch.object(
                query.db, "search", search
            ), mock.patch.object(query, "load_users", return_value=users), mock.patch.object(
                query, "log_event"
            ):
                result = query.query(Path("/nonexistent"), "guest", "What is the rate limit?")
            get_connection.assert_called_once_with(readonly=True)
            search.assert_called_once()
            self.assertEqual(result.retrieved_doc_ids, ["doc-004"])
            conn.__exit__.assert_called_once()


if __name__ == "__main__":
    unittest.main()
