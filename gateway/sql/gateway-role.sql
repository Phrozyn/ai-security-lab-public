-- Non-superuser database role for the LiteLLM gateway.
--
-- Run by a superuser (the Postgres bootstrap role) against any database:
--   GATEWAY_DB_PASSWORD=... psql -X -v ON_ERROR_STOP=1 -d postgres -f gateway/sql/gateway-role.sql
-- Optional: -v db=<name> (default litellm), the database the gateway uses.
-- Requires psql 15+ (\getenv). Idempotent: every run converges to the same
-- role, owner and grants.
--
-- Result:
--   * gateway_app can log in, is not a superuser, and cannot create roles or
--     databases. It owns the gateway database and every non-extension object
--     in it, which LiteLLM's start-up migrations need (ALTER TABLE, CREATE).
--   * PUBLIC loses CONNECT and TEMP on every non-template database, so a role
--     such as ragapp_query can no longer connect to the gateway or postgres
--     databases.
--   * Objects that belong to an extension (the pgvector functions installed in
--     the gateway database) keep their owner; PostgreSQL does not allow
--     changing the owner of individual extension members.
--
-- The bootstrap superuser stays the owner of the cluster, the postgres database
-- and the extension itself. It is no longer used by the gateway.
--
-- Rollback: point the gateway DATABASE_URL back at the bootstrap role and
-- recreate the service. Object ownership by gateway_app does not affect the
-- superuser. Full restore: the pg_dumpall taken before the change.

\set ON_ERROR_STOP on

\getenv gateway_password GATEWAY_DB_PASSWORD
\if :{?gateway_password}
\else
  DO $$ BEGIN RAISE EXCEPTION 'GATEWAY_DB_PASSWORD is not set'; END $$;
\endif

\if :{?db}
\else
  \set db litellm
\endif

-- Keep the password out of the server log for this session.
SET log_statement = 'none';
SET log_min_duration_statement = -1;
SET log_min_error_statement = panic;

SELECT :'gateway_password' = '' AS gateway_password_empty \gset
\if :gateway_password_empty
  DO $$ BEGIN RAISE EXCEPTION 'GATEWAY_DB_PASSWORD is empty'; END $$;
\endif

SELECT 'CREATE ROLE gateway_app'
WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'gateway_app') \gexec

-- Attributes and password are set on every run so they converge.
ALTER ROLE gateway_app WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE
  NOREPLICATION NOBYPASSRLS INHERIT PASSWORD :'gateway_password';

SELECT format('ALTER DATABASE %I OWNER TO gateway_app', :'db') \gexec

-- PUBLIC keeps no access to any non-template database. The owner role and the
-- superuser connect through their own privileges.
SELECT format('REVOKE ALL ON DATABASE %I FROM PUBLIC', datname)
FROM pg_database WHERE datallowconn AND NOT datistemplate \gexec

\connect :"db"

-- Tables, partitioned tables and foreign tables.
SELECT format('ALTER TABLE %s OWNER TO gateway_app', c.oid::regclass)
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE c.relkind IN ('r', 'p', 'f')
  AND n.nspname NOT IN ('pg_catalog', 'information_schema', 'pg_toast')
  AND pg_get_userbyid(c.relowner) <> 'gateway_app'
  AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = c.oid AND d.deptype = 'e') \gexec

SELECT format('ALTER VIEW %s OWNER TO gateway_app', c.oid::regclass)
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE c.relkind = 'v'
  AND n.nspname NOT IN ('pg_catalog', 'information_schema', 'pg_toast')
  AND pg_get_userbyid(c.relowner) <> 'gateway_app'
  AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = c.oid AND d.deptype = 'e') \gexec

SELECT format('ALTER MATERIALIZED VIEW %s OWNER TO gateway_app', c.oid::regclass)
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE c.relkind = 'm'
  AND n.nspname NOT IN ('pg_catalog', 'information_schema', 'pg_toast')
  AND pg_get_userbyid(c.relowner) <> 'gateway_app'
  AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = c.oid AND d.deptype = 'e') \gexec

-- Sequences owned by a column follow their table (deptype 'a') and are skipped.
SELECT format('ALTER SEQUENCE %s OWNER TO gateway_app', c.oid::regclass)
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE c.relkind = 'S'
  AND n.nspname NOT IN ('pg_catalog', 'information_schema', 'pg_toast')
  AND pg_get_userbyid(c.relowner) <> 'gateway_app'
  AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = c.oid AND d.deptype IN ('a', 'e')) \gexec

-- Standalone enum and domain types (array and table row types follow their element or table).
SELECT format('ALTER TYPE %s OWNER TO gateway_app', t.oid::regtype)
FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
WHERE t.typtype = 'e'
  AND n.nspname NOT IN ('pg_catalog', 'information_schema', 'pg_toast')
  AND pg_get_userbyid(t.typowner) <> 'gateway_app'
  AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = t.oid AND d.deptype = 'e') \gexec

SELECT format('ALTER DOMAIN %s OWNER TO gateway_app', t.oid::regtype)
FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
WHERE t.typtype = 'd'
  AND n.nspname NOT IN ('pg_catalog', 'information_schema', 'pg_toast')
  AND pg_get_userbyid(t.typowner) <> 'gateway_app'
  AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = t.oid AND d.deptype = 'e') \gexec

-- Functions, procedures and aggregates that do not belong to an extension.
SELECT format('ALTER %s %s OWNER TO gateway_app',
              CASE p.prokind WHEN 'p' THEN 'PROCEDURE' WHEN 'a' THEN 'AGGREGATE' ELSE 'FUNCTION' END,
              p.oid::regprocedure)
FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')
  AND pg_get_userbyid(p.proowner) <> 'gateway_app'
  AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = p.oid AND d.deptype = 'e') \gexec

-- Schemas other than public (public is owned by pg_database_owner and follows the database owner).
SELECT format('ALTER SCHEMA %I OWNER TO gateway_app', nspname)
FROM pg_namespace
WHERE nspname NOT LIKE 'pg\_%' AND nspname NOT IN ('information_schema', 'public')
  AND pg_get_userbyid(nspowner) <> 'gateway_app' \gexec

-- Fail loudly if any non-extension object is still owned by another role.
DO $$
DECLARE remaining text;
BEGIN
  SELECT string_agg(kind || ' ' || name, ', ') INTO remaining FROM (
    SELECT 'relation' AS kind, c.oid::regclass::text AS name
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname NOT IN ('pg_catalog', 'information_schema', 'pg_toast')
        AND c.relkind IN ('r', 'p', 'f', 'v', 'm', 'S')
        AND pg_get_userbyid(c.relowner) <> 'gateway_app'
        AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = c.oid AND d.deptype IN ('e', 'a'))
    UNION ALL
    SELECT 'type', t.oid::regtype::text FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
      WHERE t.typtype IN ('e', 'd') AND n.nspname NOT IN ('pg_catalog', 'information_schema', 'pg_toast')
        AND pg_get_userbyid(t.typowner) <> 'gateway_app'
        AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = t.oid AND d.deptype = 'e')
    UNION ALL
    SELECT 'function', p.oid::regprocedure::text FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')
        AND pg_get_userbyid(p.proowner) <> 'gateway_app'
        AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = p.oid AND d.deptype = 'e')
  ) s;
  IF remaining IS NOT NULL THEN
    RAISE EXCEPTION 'objects still not owned by gateway_app: %', remaining;
  END IF;
END $$;
