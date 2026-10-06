-- Database roles and row-level security for the RAG app (least privilege for
-- the query path).
--
-- Run by a superuser against the ragapp database:
--   RAGAPP_QUERY_PASSWORD=... psql -X -v ON_ERROR_STOP=1 -d ragapp -f rag-app/sql/roles.sql
-- Optional: -v owner_role=<name> (default ragapp), the role ingestion uses.
-- Requires psql 15+ (\getenv) and PostgreSQL 16+ (GRANT role ... WITH INHERIT,
-- SET). Idempotent: every run converges to the same roles, grants, RLS flag and
-- policies. Run it again after the first ingest (ingestion creates the chunks
-- table) and after any drop and re-creation of chunks, to grant SELECT and
-- create the policies. ingest empties chunks with TRUNCATE, which keeps the
-- grants, the RLS flag and the policies, so a normal re-ingest needs no re-run.
-- A chunks table created by ingest has RLS enabled and no policies until this
-- script runs, so the query path reads zero rows (fail closed).
--
-- Result:
--   ragapp_query    LOGIN. SELECT on public.chunks and nothing else. Sessions
--                   default to read-only transactions. Member of the three
--                   scope roles with SET TRUE, INHERIT FALSE, ADMIN FALSE.
--   rag_scope_public, rag_scope_internal, rag_scope_restricted
--                   NOLOGIN. USAGE on schema public, SELECT on public.chunks.
--   public.chunks   ROW LEVEL SECURITY enabled, not forced, with one
--                   permissive FOR SELECT policy per scope role:
--                     rag_scope_public      acl = 'public'
--                     rag_scope_internal    acl IN ('public', 'internal')
--                     rag_scope_restricted  acl IN ('public', 'internal', 'restricted')
--
-- Design:
--   Scopes are cumulative (corpus/users.yaml: guest = public, alice_engineering
--   = public + internal, bob_exec = all three) and SET ROLE selects one current
--   role, so there is one role per cumulative scope, each with one policy that
--   lists every acl value the scope allows. The app maps a user's allowed_acl
--   set to exactly one scope role through a closed mapping in
--   rag-app/src/ragapp/db.py (an unknown set raises) and runs each search in
--   one transaction after SET LOCAL ROLE <scope role>. The SQL WHERE acl =
--   ANY(...) filter in db.search stays as a second check.
--   INHERIT FALSE: PostgreSQL applies a policy to the current role and to the
--   roles whose privileges it inherits. With INHERIT TRUE, ragapp_query would
--   match all three policies and read every row without a role switch. With
--   INHERIT FALSE, ragapp_query matches no policy and reads zero rows until it
--   runs SET ROLE (default deny).
--   No policy names ragapp_query, so a query run as ragapp_query without a role
--   switch returns zero rows rather than an error.
--   RLS is not forced: the table owner (owner_role, used by ingestion) and
--   superusers bypass RLS and see all rows. Roles with BYPASSRLS bypass it too;
--   ragapp_query and the scope roles are NOBYPASSRLS.
--
-- Limits:
--   RLS here limits what the query path reads when the application has a bug
--   in its ACL filter or the SQL it sends is attacker-influenced (SQL
--   injection), as long as the role switch happens before that SQL runs. It
--   does not protect against theft of the ragapp_query credentials: a holder
--   of those credentials can run SET ROLE rag_scope_restricted and read every
--   row. SQL injection that can issue its own SET ROLE can do the same.
--
-- Rollback (as a superuser or the owner):
--   ALTER TABLE chunks DISABLE ROW LEVEL SECURITY;
-- The policies and scope roles can stay in place; with RLS disabled they have
-- no effect, and the WHERE filter in db.search remains the only ACL check.

\set ON_ERROR_STOP on

\getenv query_password RAGAPP_QUERY_PASSWORD
\if :{?query_password}
\else
  DO $$ BEGIN RAISE EXCEPTION 'RAGAPP_QUERY_PASSWORD is not set'; END $$;
\endif

\if :{?owner_role}
\else
  \set owner_role ragapp
\endif

-- Keep the password out of the server log for this session.
SET log_statement = 'none';
SET log_min_duration_statement = -1;
SET log_min_error_statement = panic;

SELECT :'query_password' = '' AS query_password_empty \gset
\if :query_password_empty
  DO $$ BEGIN RAISE EXCEPTION 'RAGAPP_QUERY_PASSWORD is empty'; END $$;
\endif

-- GRANT role ... WITH INHERIT/SET below needs server version 16 or later.
SELECT current_setting('server_version_num')::int < 160000 AS server_too_old \gset
\if :server_too_old
  DO $$ BEGIN RAISE EXCEPTION 'roles.sql requires PostgreSQL 16 or later'; END $$;
\endif

-- vector is an untrusted extension, so a superuser creates it once here.
CREATE EXTENSION IF NOT EXISTS vector;

SELECT format('CREATE ROLE %I', r)
FROM unnest(ARRAY['ragapp_query', 'rag_scope_public', 'rag_scope_internal', 'rag_scope_restricted']) AS r
WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = r) \gexec

-- Attributes and password are set on every run so they converge.
ALTER ROLE ragapp_query WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE
  NOREPLICATION NOBYPASSRLS INHERIT PASSWORD :'query_password';
ALTER ROLE ragapp_query SET default_transaction_read_only = on;

ALTER ROLE rag_scope_public WITH NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE
  NOREPLICATION NOBYPASSRLS NOINHERIT PASSWORD NULL;
ALTER ROLE rag_scope_internal WITH NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE
  NOREPLICATION NOBYPASSRLS NOINHERIT PASSWORD NULL;
ALTER ROLE rag_scope_restricted WITH NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE
  NOREPLICATION NOBYPASSRLS NOINHERIT PASSWORD NULL;

-- Membership: ragapp_query can SET ROLE to each scope role, does not inherit
-- its privileges or policies, and cannot grant it on. Re-granting with the
-- options given updates an existing grant, so the options converge.
GRANT rag_scope_public, rag_scope_internal, rag_scope_restricted TO ragapp_query
  WITH ADMIN FALSE, INHERIT FALSE, SET TRUE;

-- Database: CONNECT for the owner role and ragapp_query only. PUBLIC loses its
-- default CONNECT and TEMP, and ragapp_query and the scope roles get no TEMP.
SELECT format('REVOKE ALL ON DATABASE %I FROM PUBLIC', current_database()) \gexec
SELECT format('REVOKE ALL ON DATABASE %I FROM ragapp_query, rag_scope_public, rag_scope_internal, rag_scope_restricted',
              current_database()) \gexec
SELECT format('GRANT CONNECT ON DATABASE %I TO %I, ragapp_query',
              current_database(), :'owner_role') \gexec

-- Schema: lookup only, no object creation.
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
REVOKE CREATE ON SCHEMA public FROM ragapp_query, rag_scope_public, rag_scope_internal, rag_scope_restricted;
GRANT USAGE ON SCHEMA public TO ragapp_query, rag_scope_public, rag_scope_internal, rag_scope_restricted;

-- Table: SELECT on chunks only, RLS enabled, one policy per scope role. No
-- default privileges, so tables created later are not readable by these roles.
-- One transaction, so no other session sees chunks with a partial policy set.
SELECT to_regclass('public.chunks') IS NOT NULL AS chunks_exists \gset
\if :chunks_exists
  BEGIN;
  REVOKE ALL ON TABLE public.chunks FROM ragapp_query, rag_scope_public, rag_scope_internal, rag_scope_restricted;
  GRANT SELECT ON TABLE public.chunks TO ragapp_query, rag_scope_public, rag_scope_internal, rag_scope_restricted;

  ALTER TABLE public.chunks ENABLE ROW LEVEL SECURITY;
  ALTER TABLE public.chunks NO FORCE ROW LEVEL SECURITY;

  -- Drop every policy on chunks, including ones this script did not create,
  -- then create the three scope policies.
  SELECT format('DROP POLICY IF EXISTS %I ON public.chunks', policyname)
  FROM pg_policies WHERE schemaname = 'public' AND tablename = 'chunks' \gexec

  CREATE POLICY chunks_scope_public ON public.chunks AS PERMISSIVE
    FOR SELECT TO rag_scope_public
    USING (acl = 'public');
  CREATE POLICY chunks_scope_internal ON public.chunks AS PERMISSIVE
    FOR SELECT TO rag_scope_internal
    USING (acl = ANY (ARRAY['public', 'internal']));
  CREATE POLICY chunks_scope_restricted ON public.chunks AS PERMISSIVE
    FOR SELECT TO rag_scope_restricted
    USING (acl = ANY (ARRAY['public', 'internal', 'restricted']));
  COMMIT;
\else
  \echo 'roles.sql: table public.chunks does not exist yet (ingestion creates it). Run this script again after the first ingest to grant SELECT on it and create its row-level security policies.'
\endif
