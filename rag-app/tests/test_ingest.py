"""ingest_corpus(): validation and embedding happen before the database is
touched, and TRUNCATE plus the inserts run in one transaction (stubs only).
Atomicity against Postgres is checked in ci-cd/acl-redteam/harness.ts.
"""

import contextlib
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent))

from test_db import FakeConnection, _module, fresh_import  # noqa: E402


class FakePost(dict):
    def __init__(self, content, **meta):
        super().__init__(**meta)
        self.content = content


def _corpus(d: Path, names):
    for name in names:
        (d / f"{name}.md").write_text("x")


def _frontmatter(posts):
    return _module("frontmatter", load=lambda path: posts[Path(path).stem])


class IngestCorpus(unittest.TestCase):
    def _run(self, posts, embed, insert=None, init_schema=None):
        """Runs ingest_corpus on a corpus holding one file per post. Returns
        (result_or_exception, conn, recorded database calls)."""
        calls: list = []
        conn = FakeConnection()
        stubs = {
            "frontmatter": _frontmatter(posts),
            "ragapp.ollama_client": _module("ragapp.ollama_client", embed=embed),
        }
        with fresh_import("ragapp.ingest", stubs) as (ingest, _, _), tempfile.TemporaryDirectory() as d:
            _corpus(Path(d), posts)

            def get_connection(readonly):
                calls.append(("get_connection", readonly))
                return conn

            with contextlib.ExitStack() as stack:
                stack.enter_context(mock.patch.object(ingest.db, "get_connection", get_connection))
                stack.enter_context(
                    mock.patch.object(ingest.db, "init_schema", init_schema or (lambda c: calls.append("init_schema")))
                )
                stack.enter_context(
                    mock.patch.object(ingest.db, "clear_chunks", lambda c: (calls.append("clear"), c.executed.append("TRUNCATE")))
                )
                stack.enter_context(
                    mock.patch.object(
                        ingest.db,
                        "insert_chunk",
                        insert or (lambda c, doc_id, *a: (calls.append(("insert", doc_id)), c.executed.append("INSERT " + doc_id))),
                    )
                )
                try:
                    result = ingest.ingest_corpus(Path(d))
                except Exception as exc:  # noqa: BLE001 - returned for assertion
                    result = exc
        return result, conn, calls

    def _posts(self):
        return {
            "doc-1": FakePost(" one ", acl="public", owner="a"),
            "doc-2": FakePost("two", acl="internal", owner="b"),
            "doc-3": FakePost("three", acl="restricted", owner="c", doc_id="custom-3"),
        }

    def test_success_runs_truncate_and_inserts_in_one_transaction_then_closes(self):
        embed = mock.MagicMock(side_effect=lambda text: [float(len(text))])
        result, conn, calls = self._run(self._posts(), embed)
        self.assertEqual(result, 3)
        self.assertEqual(
            conn.executed,
            ["BEGIN", "TRUNCATE", "INSERT doc-1", "INSERT doc-2", "INSERT custom-3", "COMMIT"],
        )
        self.assertTrue(conn.closed)
        self.assertEqual(calls[0], ("get_connection", False))
        embed.assert_any_call("one")  # content is stripped before embedding

    def test_embedding_failure_leaves_the_database_untouched(self):
        embed = mock.MagicMock(side_effect=[[0.1], RuntimeError("ollama timeout")])
        result, conn, calls = self._run(self._posts(), embed)
        self.assertIsInstance(result, RuntimeError)
        self.assertEqual(calls, [])  # no connection was opened
        self.assertEqual(conn.executed, [])

    def test_insert_failure_rolls_back_the_truncate_and_closes(self):
        seen = []

        def insert(conn, doc_id, *rest):
            seen.append(doc_id)
            if doc_id == "doc-2":
                raise RuntimeError("insert failed")
            conn.executed.append("INSERT " + doc_id)

        result, conn, _ = self._run(self._posts(), mock.MagicMock(return_value=[0.1]), insert=insert)
        self.assertIsInstance(result, RuntimeError)
        self.assertEqual(seen, ["doc-1", "doc-2"])
        self.assertEqual(conn.executed, ["BEGIN", "TRUNCATE", "INSERT doc-1", "ROLLBACK"])
        self.assertTrue(conn.closed)

    def test_schema_failure_closes_the_connection(self):
        def boom(conn):
            raise RuntimeError("schema failed")

        result, conn, _ = self._run(self._posts(), mock.MagicMock(return_value=[0.1]), init_schema=boom)
        self.assertIsInstance(result, RuntimeError)
        self.assertTrue(conn.closed)
        self.assertEqual(conn.executed, [])

    def test_missing_acl_or_owner_names_the_file_and_touches_nothing(self):
        for missing in ("acl", "owner"):
            posts = self._posts()
            meta = {"acl": "public", "owner": "a"}
            del meta[missing]
            posts["doc-2"] = FakePost("two", **meta)
            embed = mock.MagicMock(return_value=[0.1])
            result, conn, calls = self._run(posts, embed)
            self.assertIsInstance(result, ValueError)
            self.assertIn("doc-2.md", str(result))
            self.assertIn(missing, str(result))
            embed.assert_not_called()
            self.assertEqual(calls, [])

    def test_empty_corpus_is_an_error_not_a_wipe(self):
        embed = mock.MagicMock()
        result, conn, calls = self._run({}, embed)
        self.assertIsInstance(result, ValueError)
        embed.assert_not_called()
        self.assertEqual(calls, [])


if __name__ == "__main__":
    unittest.main()
