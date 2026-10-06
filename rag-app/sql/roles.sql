-- Database roles for the RAG app (least privilege for the query path).
--
-- Run by a superuser against the ragapp database:
--   RAGAPP_QUERY_PASSWORD=... psql -X -v ON_ERROR_STOP=1 -d ragapp -f rag-app/sql/roles.sql
-- Optional: -v owner_role=<name> (default ragapp), the role ingestion uses.
-- Requires psql 15+ (\getenv). Idempotent: every run converges to the same
-- roles and grants. Run it again after the first ingest (ingestion creates
-- the chunks table) and after any re-creation of chunks, to grant SELECT.
--
-- Result: ragapp_query can log in, has SELECT on public.chunks and nothing
-- else, and its sessions default to read-only transactions.

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

-- vector is an untrusted extension, so a superuser creates it once here.
CREATE EXTENSION IF NOT EXISTS vector;

SELECT 'CREATE ROLE ragapp_query'
WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'ragapp_query') \gexec

-- Attributes and password are set on every run so they converge.
ALTER ROLE ragapp_query WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE
  NOREPLICATION NOBYPASSRLS INHERIT PASSWORD :'query_password';
ALTER ROLE ragapp_query SET default_transaction_read_only = on;

-- Database: CONNECT for the owner role and ragapp_query only. PUBLIC loses its
-- default CONNECT and TEMP, and ragapp_query gets no TEMP.
SELECT format('REVOKE ALL ON DATABASE %I FROM PUBLIC', current_database()) \gexec
SELECT format('REVOKE ALL ON DATABASE %I FROM ragapp_query', current_database()) \gexec
SELECT format('GRANT CONNECT ON DATABASE %I TO %I, ragapp_query',
              current_database(), :'owner_role') \gexec

-- Schema: lookup only, no object creation.
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
REVOKE CREATE ON SCHEMA public FROM ragapp_query;
GRANT USAGE ON SCHEMA public TO ragapp_query;

-- Table: SELECT on chunks only. No default privileges, so tables created
-- later are not readable by ragapp_query.
SELECT to_regclass('public.chunks') IS NOT NULL AS chunks_exists \gset
\if :chunks_exists
  REVOKE ALL ON TABLE public.chunks FROM ragapp_query;
  GRANT SELECT ON TABLE public.chunks TO ragapp_query;
\else
  \echo 'roles.sql: table public.chunks does not exist yet (ingestion creates it). Run this script again after the first ingest to grant SELECT on it.'
\endif
