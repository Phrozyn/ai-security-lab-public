"""db.get_connection() owner/query role selection, which role the ingest
and query paths request, the scope-role mapping, the SET LOCAL ROLE in
db.search, and the RLS statements in init_schema/clear_chunks (stdlib only).

psycopg, pgvector, yaml, frontmatter, httpx and presidio are replaced by stub
modules for each import, so these tests run without the rag-app dependencies.
The stubs and the freshly imported ragapp modules are removed afterwards so
other test modules import the installed modules.
"""

import contextlib
import os
import re
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
READ_ONLY_SQL = "SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY"
GUARD_SQL = "SELECT has_table_privilege('chunks', 'INSERT, UPDATE, DELETE, TRUNCATE')"
FRESH = ("ragapp.db", "ragapp.query", "ragapp.ingest")


class FakeCursor:
    def __init__(self, row, rows=()):
        self._row = row
        self._rows = list(rows)

    def fetchone(self):
        return self._row

    def fetchall(self):
        return self._rows


class FakeSQL:
    """Stand-in for psycopg.sql.SQL: records the template and its arguments."""

    def __init__(self, template):
        self.template = template
        self.args = ()

    def format(self, *args):
        composed = FakeSQL(self.template)
        composed.args = args
        return composed


class FakeIdentifier:
    def __init__(self, name):
        self.name = name


class FakeConnection:
    def __init__(self, guard_result=False, rows=()):
        self.guard_result = guard_result
        self.rows = rows
        self.executed: list = []
        self.params: list = []
        self.closed = False

    def execute(self, sql, params=None):
        self.executed.append(sql)
        self.params.append(params)
        if isinstance(sql, str) and "has_table_privilege" in sql:
            return FakeCursor((self.guard_result,))
        return FakeCursor(None, self.rows)

    @contextlib.contextmanager
    def transaction(self):
        self.executed.append("BEGIN")
        try:
            yield
        except BaseException:
            self.executed.append("ROLLBACK")
            raise
        self.executed.append("COMMIT")

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
    sql_stub = _module("psycopg.sql", SQL=FakeSQL, Identifier=FakeIdentifier)
    psycopg_stub = _module("psycopg", connect=connect, Connection=FakeConnection, sql=sql_stub)
    pgvector_psycopg = _module("pgvector.psycopg", register_vector=register_vector)
    stubs = {
        "psycopg": psycopg_stub,
        "psycopg.sql": sql_stub,
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

    def test_owner_url_is_required(self):
        for value in (None, ""):
            with fresh_import("ragapp.db") as (db, connect, _), _env(
                **({} if value is None else {"RAGAPP_DATABASE_URL": value}), RAGAPP_QUERY_DATABASE_URL=QUERY_URL
            ):
                with self.assertRaisesRegex(RuntimeError, "RAGAPP_DATABASE_URL is not set"):
                    db.get_connection(readonly=False)
                connect.assert_not_called()

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


ROLES_SQL = ROOT / "sql" / "roles.sql"
USERS_YAML = ROOT / "corpus" / "users.yaml"


def _users_allowed_acl() -> dict[str, list[str]]:
    """users.yaml parsed with the stdlib: `  name:` then `    allowed_acl: [a, b]`."""
    users: dict[str, list[str]] = {}
    current = None
    for line in USERS_YAML.read_text().splitlines():
        m = re.match(r"^  (\w+):\s*$", line)
        if m:
            current = m.group(1)
            continue
        m = re.match(r"^    allowed_acl:\s*\[(.*)\]\s*$", line)
        if m:
            if current is None:
                raise AssertionError(f"allowed_acl outside a user entry: {line!r}")
            users[current] = [a.strip() for a in m.group(1).split(",")]
    if not users:
        raise AssertionError("no users parsed from users.yaml")
    return users


class ScopeRoles(unittest.TestCase):
    def test_every_user_in_users_yaml_maps_to_the_role_for_its_scope(self):
        expected = {
            "guest": "rag_scope_public",
            "alice_engineering": "rag_scope_internal",
            "bob_exec": "rag_scope_restricted",
        }
        with fresh_import("ragapp.db") as (db, _, _):
            users = _users_allowed_acl()
            self.assertEqual(set(users), set(expected))
            for name, allowed in users.items():
                with self.subTest(user=name):
                    self.assertEqual(db.scope_role(allowed), expected[name])

    def test_order_of_allowed_acl_does_not_matter(self):
        with fresh_import("ragapp.db") as (db, _, _):
            self.assertEqual(db.scope_role(["internal", "public"]), "rag_scope_internal")
            self.assertEqual(
                db.scope_role(["restricted", "public", "internal"]), "rag_scope_restricted"
            )

    def test_unknown_scope_raises_and_never_returns_a_role(self):
        unknown = [
            [],
            ["restricted"],
            ["internal"],
            ["public", "restricted"],
            ["internal", "restricted"],
            ["public", "internal", "restricted", "secret"],
            ["public", "public"],
            ["Public"],
            ["public "],
            "public",
            [None],
            ["rag_scope_restricted"],
        ]
        with fresh_import("ragapp.db") as (db, _, _):
            for allowed in unknown:
                with self.subTest(allowed=allowed):
                    with self.assertRaises(db.UnknownScopeError):
                        db.scope_role(allowed)

    def test_unknown_scope_error_is_a_value_error(self):
        with fresh_import("ragapp.db") as (db, _, _):
            self.assertTrue(issubclass(db.UnknownScopeError, ValueError))

    def test_mapping_matches_the_policies_in_roles_sql(self):
        policies = re.findall(
            r"FOR SELECT TO (\w+)\s+USING \((.*?)\);", ROLES_SQL.read_text(), re.S
        )
        from_sql = {frozenset(re.findall(r"'(\w+)'", using)): role for role, using in policies}
        self.assertEqual(len(policies), 3)
        with fresh_import("ragapp.db") as (db, _, _):
            self.assertEqual(from_sql, db.SCOPE_ROLES)


class SearchUnderScopeRole(unittest.TestCase):
    HITS = [("doc-004", "public", "x", "600/min", 0.1)]

    def test_set_local_role_then_select_inside_one_transaction(self):
        with fresh_import("ragapp.db") as (db, _, _):
            conn = FakeConnection(rows=self.HITS)
            hits = db.search(conn, [0.1, 0.2], ["public"], top_k=3)
            self.assertEqual(len(conn.executed), 4)
            begin, set_role, select, commit = conn.executed
            self.assertEqual((begin, commit), ("BEGIN", "COMMIT"))
            self.assertIsInstance(set_role, FakeSQL)
            self.assertEqual(set_role.template, "SET LOCAL ROLE {}")
            self.assertEqual(len(set_role.args), 1)
            self.assertIsInstance(set_role.args[0], FakeIdentifier)
            self.assertEqual(set_role.args[0].name, "rag_scope_public")
            self.assertIn("WHERE acl = ANY(%s)", select)
            self.assertEqual(conn.params, [None, ([0.1, 0.2], ["public"], 3)])
            self.assertEqual(
                hits,
                [{"doc_id": "doc-004", "acl": "public", "owner": "x", "content": "600/min", "distance": 0.1}],
            )

    def test_role_follows_the_scope(self):
        cases = {
            ("public",): "rag_scope_public",
            ("public", "internal"): "rag_scope_internal",
            ("public", "internal", "restricted"): "rag_scope_restricted",
        }
        with fresh_import("ragapp.db") as (db, _, _):
            for allowed, role in cases.items():
                with self.subTest(allowed=allowed):
                    conn = FakeConnection()
                    db.search(conn, [0.1], list(allowed))
                    self.assertEqual(conn.executed[1].args[0].name, role)

    def test_unknown_scope_runs_no_sql(self):
        with fresh_import("ragapp.db") as (db, _, _):
            conn = FakeConnection(rows=self.HITS)
            with self.assertRaises(db.UnknownScopeError):
                db.search(conn, [0.1], ["public", "secret"])
            self.assertEqual(conn.executed, [])


class SchemaStatements(unittest.TestCase):
    def test_init_schema_enables_rls_without_force(self):
        with fresh_import("ragapp.db") as (db, _, _):
            conn = FakeConnection()
            db.init_schema(conn)
            statements = [" ".join(s.split()).upper() for s in conn.executed]
            self.assertIn("ALTER TABLE CHUNKS ENABLE ROW LEVEL SECURITY", statements)
            for s in statements:
                self.assertNotIn("FORCE", s)
                self.assertNotIn("DISABLE ROW LEVEL SECURITY", s)
                self.assertNotIn("DROP", s)

    def test_clear_chunks_truncates_and_never_drops(self):
        with fresh_import("ragapp.db") as (db, _, _):
            conn = FakeConnection()
            db.clear_chunks(conn)
            self.assertEqual(conn.executed, ["TRUNCATE chunks"])


class QueryScopeCheck(unittest.TestCase):
    def test_unknown_scope_fails_before_the_model_or_database(self):
        ollama = _module(
            "ragapp.ollama_client",
            embed=mock.MagicMock(),
            generate=mock.MagicMock(),
            guardrail_check=mock.MagicMock(return_value=(True, "safe")),
        )
        stubs = {
            "yaml": _module("yaml", safe_load=mock.MagicMock()),
            "ragapp.ollama_client": ollama,
            "ragapp.redact": _module("ragapp.redact", redact=lambda text: (text, [])),
        }
        with fresh_import("ragapp.query", stubs) as (query, _, _):
            get_connection = mock.MagicMock(name="get_connection")
            users = {"eve": {"allowed_acl": ["public", "secret"]}}
            log_event = mock.MagicMock(name="log_event")
            with mock.patch.object(query.db, "get_connection", get_connection), mock.patch.object(
                query, "load_users", return_value=users
            ), mock.patch.object(query, "log_event", log_event):
                with self.assertRaises(query.db.UnknownScopeError):
                    query.query(Path("/nonexistent"), "eve", "What is the rate limit?")
            get_connection.assert_not_called()
            ollama.embed.assert_not_called()
            ollama.guardrail_check.assert_not_called()
            ollama.generate.assert_not_called()
            self.assertEqual(log_event.call_args.kwargs["event"], "unknown_scope")


if __name__ == "__main__":
    unittest.main()
