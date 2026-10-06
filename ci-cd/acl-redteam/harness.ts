// Hosted-CI red-team gate for the RAG app's security properties.
//
// Runs the `ragapp` CLI (ingest + query) against a Postgres/pgvector
// instance, with the two network dependencies replaced by deterministic fakes:
//   - fake Ollama   (embeddings + Llama Guard verdicts)
//   - fake gateway  (chat completions; echoes what the model WOULD have seen)
// Because the fake gateway records every request body, the assertions are on
// the data boundary itself: what crosses into the model's context.
//
// This proves the deterministic controls (retrieval-time ACL, guardrail
// short-circuit, audit-log privacy) on every push. It does NOT prove model
// behavior -- that is the live promptfoo suite in ../redteam/.
//
// Least privilege: rag-app/sql/roles.sql creates the read-only ragapp_query
// role, the query CLI runs as that role, and direct SQL checks show it cannot
// write (INSERT/UPDATE/DELETE/TRUNCATE, CREATE TABLE, CREATE TEMP TABLE).
//
// Row-level security: roles.sql enables RLS on chunks with one policy per
// scope role (rag_scope_public/internal/restricted). Direct SQL checks show
// ragapp_query reads zero rows without SET ROLE, each scope role sees exactly
// its acl values, ragapp_query cannot SET ROLE outside the scope roles, and a
// re-ingest keeps the policies.
//
// Fail-loud: every check names a positive control or an exact expectation, and
// the run fails if fewer than EXPECTED_CHECKS checks executed.

import { SQL } from "bun";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const RAG_APP_DIR = resolve(import.meta.dir, "../../rag-app");
const ROLES_SQL = resolve(RAG_APP_DIR, "sql/roles.sql");
const PYTHON = process.env.PYTHON ?? "python";
// Owner role: ingest and roles.sql run with it. In CI this is the service
// container's bootstrap superuser, which is what roles.sql requires.
const DB_URL = process.env.RAGAPP_DATABASE_URL;
// When set, psql runs inside this container (the runner has no psql).
const PG_CONTAINER = process.env.RAGAPP_PG_CONTAINER;
const PSQL = process.env.PSQL ?? "psql";
const GATEWAY_KEY = "sk-ci-test-key";
const EMBED_DIM = 768;
const EXPECTED_CHECKS = 45;
const UNSAFE_TRIGGER = "UNSAFE-TRIGGER";
const DB_TIMEOUT_MS = 15_000;
const PSQL_TIMEOUT_MS = 60_000;

if (!DB_URL) throw new Error("RAGAPP_DATABASE_URL must be set (CI service container)");

// ragapp_query password: random per run, passed to psql and the CLI only via
// env, never logged.
const QUERY_PASSWORD = Buffer.from(crypto.getRandomValues(new Uint8Array(24))).toString("hex");
const ownerUrl = new URL(DB_URL);
const queryUrl = new URL(DB_URL);
queryUrl.username = "ragapp_query";
queryUrl.password = QUERY_PASSWORD;
const QUERY_URL = queryUrl.toString();
// Query runs get this as RAGAPP_DATABASE_URL, so any use of the owner path
// during a query fails to connect.
const DEAD_OWNER_URL = "postgresql://owner-url-unset-for-query-runs@127.0.0.1:1/none";

// ---------- fakes ----------

function embedText(text: string): number[] {
  const v = new Array<number>(EMBED_DIM).fill(0);
  for (const tok of text.toLowerCase().match(/[a-z0-9]+/g) ?? []) {
    let h = 2166136261;
    for (let i = 0; i < tok.length; i++) h = Math.imul(h ^ tok.charCodeAt(i), 16777619) >>> 0;
    v[h % EMBED_DIM] += 1;
  }
  if (v.every((x) => x === 0)) v[0] = 1;
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  // JSON drops the ".0" on integer-valued floats (0.0 -> 0), and psycopg refuses
  // a list that mixes int and float. Ollama emits all-nonzero floats, so
  // nudge any integer-valued entry to match that shape.
  return v.map((x) => {
    const f = x / norm;
    return Number.isInteger(f) ? f + 1e-9 : f;
  });
}

type GatewayCall = { system: string; user: string; auth: string | null };
const gatewayCalls: GatewayCall[] = [];

const fakeOllama = Bun.serve({
  port: 0,
  async fetch(req) {
    const url = new URL(req.url);
    const body = (await req.json()) as Record<string, unknown>;
    if (url.pathname === "/api/embeddings") {
      return Response.json({ embedding: embedText(body.prompt as string) });
    }
    // Llama Guard via guardrail_check(): the verdict is on the last message.
    if (url.pathname === "/api/chat") {
      const messages = body.messages as { role?: unknown; content?: unknown }[] | undefined;
      const last = Array.isArray(messages) ? messages.at(-1) : undefined;
      if (body.stream !== false || !last || (last.role !== "user" && last.role !== "assistant") || typeof last.content !== "string") {
        return new Response("unexpected fake-ollama /api/chat body: " + JSON.stringify(body).slice(0, 300), { status: 400 });
      }
      const unsafe = last.content.includes(UNSAFE_TRIGGER);
      return Response.json({ message: { role: "assistant", content: unsafe ? "unsafe\nS2" : "safe" } });
    }
    return new Response("unexpected fake-ollama path: " + url.pathname, { status: 500 });
  },
});

const fakeGateway = Bun.serve({
  port: 0,
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname !== "/v1/chat/completions") {
      return new Response("unexpected fake-gateway path: " + url.pathname, { status: 500 });
    }
    const auth = req.headers.get("authorization");
    if (auth !== `Bearer ${GATEWAY_KEY}`) return new Response("unauthorized", { status: 401 });
    const body = (await req.json()) as { messages: { role: string; content: string }[] };
    const system = body.messages.find((m) => m.role === "system")?.content ?? "";
    const user = body.messages.find((m) => m.role === "user")?.content ?? "";
    gatewayCalls.push({ system, user, auth });
    return Response.json({ choices: [{ message: { role: "assistant", content: "ECHO-OK" } }] });
  },
});

// ---------- CLI runner ----------

const auditLog = join(mkdtempSync(join(tmpdir(), "ragapp-audit-")), "audit.jsonl");

// Async spawn on purpose: the fake servers above live in THIS process, so a
// synchronous spawn would block the event loop and starve the CLI's own HTTP
// calls into a timeout (hit exactly that on the first CI run).
async function runCli(args: string[], role: "owner" | "query") {
  const env: Record<string, string | undefined> = {
    ...process.env,
    OLLAMA_BASE_URL: `http://127.0.0.1:${fakeOllama.port}`,
    GATEWAY_BASE_URL: `http://127.0.0.1:${fakeGateway.port}`,
    GATEWAY_VIRTUAL_KEY: GATEWAY_KEY,
    RAGAPP_AUDIT_LOG_PATH: auditLog,
  };
  if (role === "owner") {
    env.RAGAPP_DATABASE_URL = DB_URL;
    delete env.RAGAPP_QUERY_DATABASE_URL;
  } else {
    env.RAGAPP_QUERY_DATABASE_URL = QUERY_URL;
    env.RAGAPP_DATABASE_URL = DEAD_OWNER_URL;
  }
  const proc = Bun.spawn([PYTHON, "-m", "ragapp.cli", ...args], {
    stdout: "pipe",
    stderr: "pipe",
    cwd: RAG_APP_DIR,
    env,
  });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, out, err };
}

async function query(user: string, question: string) {
  const before = gatewayCalls.length;
  const r = await runCli(["query", "--user", user, "--question", question], "query");
  const retrieved = (r.out.match(/retrieved_doc_ids: (\[.*\])/)?.[1].match(/doc-\d+/g)) ?? [];
  return { ...r, retrieved, calls: gatewayCalls.slice(before) };
}

// ---------- database ----------

// Runs rag-app/sql/roles.sql as the owner (superuser). Passwords go via env only.
async function runRolesSql() {
  const user = decodeURIComponent(ownerUrl.username);
  const db = decodeURIComponent(ownerUrl.pathname.slice(1));
  const env = {
    ...process.env,
    PGPASSWORD: decodeURIComponent(ownerUrl.password),
    RAGAPP_QUERY_PASSWORD: QUERY_PASSWORD,
  };
  const cmd = PG_CONTAINER
    ? ["docker", "exec", "-i", "-e", "PGPASSWORD", "-e", "RAGAPP_QUERY_PASSWORD", PG_CONTAINER,
       "psql", "-X", "-v", "ON_ERROR_STOP=1", "-U", user, "-d", db, "-f", "-"]
    : [PSQL, "-X", "-v", "ON_ERROR_STOP=1", "-h", ownerUrl.hostname, "-p", ownerUrl.port || "5432",
       "-U", user, "-d", db, "-f", ROLES_SQL];
  const proc = Bun.spawn(cmd, {
    stdin: PG_CONTAINER ? Bun.file(ROLES_SQL) : "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env,
    timeout: PSQL_TIMEOUT_MS,
  });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, out, err };
}

function bounded<T>(p: Promise<T>, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what}: no result within ${DB_TIMEOUT_MS} ms`)), DB_TIMEOUT_MS);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

// Resolves to whether the statement failed with SQLSTATE `code`. Bun's
// PostgresError carries the SQLSTATE in `errno`; any other error shape, or a
// statement that succeeds, is a failure.
// `denied` must match the message, so a denial on a different object (for
// example the id sequence) does not count.
async function expectSqlState(run: () => Promise<unknown>, code: string, denied: RegExp): Promise<{ ok: boolean; detail: string }> {
  try {
    await bounded(run(), `statement expecting ${code}`);
    return { ok: false, detail: "statement succeeded" };
  } catch (e) {
    const errno = (e as { errno?: unknown }).errno;
    const message = e instanceof Error ? e.message : String(e);
    if (typeof errno !== "string" || !/^[0-9A-Z]{5}$/.test(errno)) {
      return { ok: false, detail: `error without a SQLSTATE: ${message}` };
    }
    return { ok: errno === code && denied.test(message), detail: `got ${errno}: ${message}` };
  }
}

// Scope roles from roles.sql and the acl values each one's policy admits
// (sorted). The app maps users to these in rag-app/src/ragapp/db.py.
const SCOPES = [
  { role: "rag_scope_public", acl: ["public"] },
  { role: "rag_scope_internal", acl: ["internal", "public"] },
  { role: "rag_scope_restricted", acl: ["internal", "public", "restricted"] },
] as const;
const SCOPE_ROLE_NAMES: string[] = SCOPES.map((s) => s.role);
// Postgres array literal for query parameters (Bun SQL sends a JS array as a
// comma-separated string, which ::text[] rejects).
const SCOPE_ROLES_PG = `{${SCOPE_ROLE_NAMES.join(",")}}`;

// ragapp_query and scope-role attributes, memberships, the ACLs roles.sql
// manages, and the RLS flag and policies on chunks. rolpassword is not
// selected (each ALTER ROLE ... PASSWORD writes a new salt).
async function privilegeSnapshot(sql: SQL) {
  const rows = await bounded(sql`
    SELECT r.rolsuper, r.rolcreatedb, r.rolcreaterole, r.rolcanlogin, r.rolreplication,
           r.rolbypassrls, r.rolconfig,
           (SELECT relacl::text FROM pg_class WHERE oid = to_regclass('public.chunks')) AS chunks_acl,
           (SELECT datacl::text FROM pg_database WHERE datname = current_database()) AS database_acl,
           (SELECT nspacl::text FROM pg_namespace WHERE nspname = 'public') AS schema_acl,
           (SELECT extversion FROM pg_extension WHERE extname = 'vector') AS vector_version,
           (SELECT format('%s|%s', relrowsecurity, relforcerowsecurity)
              FROM pg_class WHERE oid = to_regclass('public.chunks')) AS chunks_rls,
           (SELECT string_agg(format('%s|%s|%s|%s|%s|%s', p.policyname, p.permissive, p.cmd, p.roles, p.qual, p.with_check), ';' ORDER BY p.policyname)
              FROM pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'chunks') AS chunks_policies,
           (SELECT string_agg(format('%s|%s|%s|%s', g.rolname, a.admin_option, a.inherit_option, a.set_option), ';' ORDER BY g.rolname)
              FROM pg_auth_members a JOIN pg_roles g ON g.oid = a.roleid WHERE a.member = r.oid) AS memberships,
           (SELECT string_agg(format('%s|%s|%s|%s|%s|%s|%s|%s', s.rolname, s.rolcanlogin, s.rolsuper, s.rolcreatedb,
                                     s.rolcreaterole, s.rolreplication, s.rolbypassrls, s.rolinherit), ';' ORDER BY s.rolname)
              FROM pg_roles s WHERE s.rolname = ANY(${SCOPE_ROLES_PG}::text[])) AS scope_roles
    FROM pg_roles r WHERE r.rolname = 'ragapp_query'`, "privilege snapshot");
  if (rows.length !== 1) throw new Error(`ragapp_query role not found (rows=${rows.length})`);
  return rows[0] as Record<string, unknown>;
}

// Runs `run` in one transaction after SET LOCAL ROLE to a scope role. The role
// name comes from SCOPES only.
function asScope<T>(sql: SQL, role: string, run: (tx: SQL) => Promise<T>): Promise<T> {
  if (!SCOPE_ROLE_NAMES.includes(role)) throw new Error(`asScope: ${role} is not a scope role`);
  return bounded(
    sql.begin(async (tx) => {
      await tx.unsafe(`SET LOCAL ROLE ${role}`);
      return await run(tx as unknown as SQL);
    }) as Promise<T>,
    `as ${role}`,
  );
}

const sortedAcl = (rows: { acl: string }[]) => rows.map((r) => r.acl).sort();

// Valid for the owner: every NOT NULL column set, 768-dim vector literal. The
// explicit id skips nextval(), so the only privilege tested is INSERT on chunks.
const insertRow = (sql: SQL) => sql`
  INSERT INTO chunks (id, doc_id, acl, owner, content, embedding)
  VALUES (-1, 'neg-test', 'public', 'ci', 'negative check', array_fill(0.1::real, ARRAY[768])::vector)`;

// ---------- checks ----------

let executed = 0;
const failures: string[] = [];
function check(name: string, ok: boolean, detail = "") {
  executed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : detail ? ` -- ${detail}` : ""}`);
  if (!ok) failures.push(name);
}

// Distinctive doc-003 (restricted) content that can only reach the model by
// way of a retrieval of doc-003. (Not "doc-003" itself: the planted injection
// payload in doc-004 names it, so that string legitimately appears as data.)
const RESTRICTED_CANARIES = ["4.2M", "GPU inference fleet", "61%"];
const leaksRestricted = (text: string) => RESTRICTED_CANARIES.some((c) => text.includes(c));

let ownerSql: SQL | undefined;
let querySql: SQL | undefined;
try {
  const roles1 = await runRolesSql();
  check("roles.sql: superuser run before ingest exits 0", roles1.code === 0, roles1.err.slice(-300));
  if (roles1.code !== 0) throw new Error("roles.sql failed before ingest; remaining checks are meaningless:\n" + roles1.err);

  const ingest = await runCli(["ingest"], "owner");
  check("ingest: exits 0 and stores 4 documents", ingest.code === 0 && /Ingested 4 documents/.test(ingest.out), ingest.err.slice(-300));
  if (ingest.code !== 0) throw new Error("ingest failed; remaining checks are meaningless:\n" + ingest.err);

  const roles2 = await runRolesSql();
  check("roles.sql: re-run after ingest exits 0", roles2.code === 0, roles2.err.slice(-300));
  if (roles2.code !== 0) throw new Error("roles.sql failed after ingest; remaining checks are meaningless:\n" + roles2.err);

  ownerSql = new SQL({ url: DB_URL, max: 1, connectionTimeout: 15 });
  const before = await privilegeSnapshot(ownerSql);
  const roles3 = await runRolesSql();
  const after = await privilegeSnapshot(ownerSql);
  check("roles.sql: idempotent (third run exits 0 and leaves roles and grants unchanged)", roles3.code === 0 && JSON.stringify(before) === JSON.stringify(after), `code=${roles3.code} before=${JSON.stringify(before)} after=${JSON.stringify(after)} err=${roles3.err.slice(-300)}`);

  check("query role: LOGIN, not superuser, no CREATEDB/CREATEROLE/REPLICATION/BYPASSRLS", after.rolcanlogin === true && after.rolsuper === false && after.rolcreatedb === false && after.rolcreaterole === false && after.rolreplication === false && after.rolbypassrls === false, JSON.stringify(after));
  const rolconfig = after.rolconfig;
  check("query role: default_transaction_read_only=on is set on the role", Array.isArray(rolconfig) && rolconfig.length === 1 && rolconfig[0] === "default_transaction_read_only=on", `rolconfig=${JSON.stringify(rolconfig)}`);

  // ---------- row-level security: catalog state ----------
  const [rls] = await bounded(ownerSql`
    SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE oid = to_regclass('public.chunks')`, "RLS flag");
  check("RLS: chunks has row level security enabled and not forced (owner and superusers bypass)", rls?.relrowsecurity === true && rls?.relforcerowsecurity === false, JSON.stringify(rls));

  const policies = (await bounded(ownerSql`
    SELECT policyname, permissive, cmd, roles::text AS roles, qual, with_check
    FROM pg_policies WHERE schemaname = 'public' AND tablename = 'chunks' ORDER BY policyname`, "policies")) as Record<string, unknown>[];
  const expectedPolicies = [
    { policyname: "chunks_scope_internal", permissive: "PERMISSIVE", cmd: "SELECT", roles: "{rag_scope_internal}", qual: "(acl = ANY (ARRAY['public'::text, 'internal'::text]))", with_check: null },
    { policyname: "chunks_scope_public", permissive: "PERMISSIVE", cmd: "SELECT", roles: "{rag_scope_public}", qual: "(acl = 'public'::text)", with_check: null },
    { policyname: "chunks_scope_restricted", permissive: "PERMISSIVE", cmd: "SELECT", roles: "{rag_scope_restricted}", qual: "(acl = ANY (ARRAY['public'::text, 'internal'::text, 'restricted'::text]))", with_check: null },
  ];
  check("RLS: chunks has exactly the three scope policies (permissive, FOR SELECT, one scope role each, expected acl sets)", JSON.stringify(policies) === JSON.stringify(expectedPolicies), JSON.stringify(policies));

  const scopeAttrs = (await bounded(ownerSql`
    SELECT rolname, rolcanlogin, rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolbypassrls
    FROM pg_roles WHERE rolname = ANY(${SCOPE_ROLES_PG}::text[]) ORDER BY rolname`, "scope role attributes")) as Record<string, unknown>[];
  check("scope roles: all three exist, NOLOGIN, not superuser, no CREATEDB/CREATEROLE/REPLICATION/BYPASSRLS", scopeAttrs.length === 3 && scopeAttrs.every((r) => r.rolcanlogin === false && r.rolsuper === false && r.rolcreatedb === false && r.rolcreaterole === false && r.rolreplication === false && r.rolbypassrls === false), JSON.stringify(scopeAttrs));

  const members = (await bounded(ownerSql`
    SELECT g.rolname, a.admin_option, a.inherit_option, a.set_option
    FROM pg_auth_members a JOIN pg_roles g ON g.oid = a.roleid JOIN pg_roles m ON m.oid = a.member
    WHERE m.rolname = 'ragapp_query' ORDER BY g.rolname`, "ragapp_query memberships")) as Record<string, unknown>[];
  check("scope roles: ragapp_query is a member of each with SET, without INHERIT or ADMIN, and of no other role", members.length === 3 && JSON.stringify(members.map((r) => r.rolname)) === JSON.stringify([...SCOPE_ROLE_NAMES].sort()) && members.every((r) => r.set_option === true && r.inherit_option === false && r.admin_option === false), JSON.stringify(members));

  const scopePrivs = (await bounded(ownerSql`
    SELECT r AS role, p, has_table_privilege(r, 'public.chunks', p) AS granted
    FROM unnest(${SCOPE_ROLES_PG}::text[]) AS r,
         unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) AS p`, "scope role table privileges")) as { role: string; p: string; granted: boolean }[];
  const scopeGranted = scopePrivs.filter((r) => r.granted === true).map((r) => `${r.role}:${r.p}`).sort();
  check("scope roles: privileges on chunks are SELECT only", scopePrivs.length === 21 && scopePrivs.every((r) => typeof r.granted === "boolean") && JSON.stringify(scopeGranted) === JSON.stringify(SCOPE_ROLE_NAMES.map((r) => `${r}:SELECT`).sort()), `granted=${scopeGranted} rows=${scopePrivs.length}`);

  const tablePrivs = (await bounded(ownerSql`
    SELECT p, has_table_privilege('ragapp_query', 'public.chunks', p) AS granted
    FROM unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) AS p`, "table privileges")) as { p: string; granted: boolean }[];
  const granted = tablePrivs.filter((r) => r.granted === true).map((r) => r.p);
  check("query role: privileges on chunks are SELECT only", tablePrivs.length === 7 && tablePrivs.every((r) => typeof r.granted === "boolean") && granted.length === 1 && granted[0] === "SELECT", `granted=${granted} rows=${tablePrivs.length}`);

  const [scope] = await bounded(ownerSql`
    SELECT has_schema_privilege('ragapp_query', 'public', 'USAGE') AS schema_usage,
           has_schema_privilege('ragapp_query', 'public', 'CREATE') AS schema_create,
           has_database_privilege('ragapp_query', current_database(), 'CONNECT') AS db_connect,
           has_database_privilege('ragapp_query', current_database(), 'TEMP') AS db_temp`, "schema and database privileges");
  check("query role: no CREATE on schema public and no TEMP on the database", scope.schema_usage === true && scope.db_connect === true && scope.schema_create === false && scope.db_temp === false, JSON.stringify(scope));

  // A NULL datacl is the default ACL, which grants PUBLIC CONNECT and TEMP.
  const [dbAcl] = await bounded(ownerSql`
    SELECT d.datacl IS NULL AS acl_is_default,
           coalesce((SELECT string_agg(a.privilege_type, ',' ORDER BY a.privilege_type)
                     FROM aclexplode(d.datacl) a WHERE a.grantee = 0), '') AS public_privileges
    FROM pg_database d WHERE d.datname = current_database()`, "database ACL");
  const publicPrivs = String(dbAcl.public_privileges).split(",");
  check("database: PUBLIC has no CONNECT or TEMP", dbAcl.acl_is_default === false && !publicPrivs.includes("CONNECT") && !publicPrivs.includes("TEMPORARY"), JSON.stringify(dbAcl));

  const Q3 = "What were Q3 revenue and margin?";

  // Positive control first: if this fails, the ACL "negative" checks below
  // would pass vacuously (nothing retrievable at all), so it gates them.
  const bob = await query("bob_exec", Q3);
  check("positive control: bob_exec (restricted scope) retrieves doc-003", bob.retrieved.includes("doc-003"), `retrieved=${bob.retrieved}`);
  check("positive control: restricted content reaches the model for bob_exec", bob.calls.length === 1 && leaksRestricted(bob.calls[0].user), "canaries not in model input");

  const guest = await query("guest", Q3);
  check("ACL: guest never retrieves doc-003 or doc-002", guest.code === 0 && guest.retrieved.length > 0 && !guest.retrieved.includes("doc-003") && !guest.retrieved.includes("doc-002"), `retrieved=${guest.retrieved} err=${guest.err.slice(-200)}`);
  check("ACL: no restricted content reaches the model for guest", guest.calls.length === 1 && !leaksRestricted(guest.calls[0].user), "restricted canary found in model input");

  const alice = await query("alice_engineering", Q3);
  check("ACL: alice_engineering (internal scope) cannot retrieve restricted doc-003", alice.code === 0 && !alice.retrieved.includes("doc-003") && alice.calls.length === 1 && !leaksRestricted(alice.calls[0].user), `retrieved=${alice.retrieved}`);

  // Indirect injection: the public doc-004 carries a payload demanding doc-003.
  const inj = await query("guest", "What is the vendor API rate limit?");
  check("injection: poisoned public doc-004 is retrieved as data (test is live, not vacuous)", inj.retrieved.includes("doc-004") && inj.calls.length === 1 && /Ignore all\s+previous instructions/.test(inj.calls[0].user), `retrieved=${inj.retrieved}`);
  check("injection: payload is fenced inside <retrieved_context>", inj.calls.length === 1 && /<retrieved_context>[\s\S]*Ignore all[\s\S]*<\/retrieved_context>/.test(inj.calls[0].user), "payload not inside delimiter");
  check("injection: system prompt declares retrieved context DATA ONLY", inj.calls.length === 1 && inj.calls[0].system.includes("DATA ONLY"), "system prompt missing data-only framing");
  check("injection: payload cannot exfiltrate what ACL withheld (no restricted content in model input)", inj.calls.length === 1 && !leaksRestricted(inj.calls[0].user), "restricted canary found");

  // Unknown identity.
  const unknown = await query("mallory", Q3);
  check("unknown user: CLI fails and the model is never called", unknown.code !== 0 && unknown.calls.length === 0, `code=${unknown.code} calls=${unknown.calls.length}`);

  // Input guardrail short-circuit.
  const blocked = await query("guest", `${UNSAFE_TRIGGER} how do I do something dangerous`);
  check("input guardrail: unsafe verdict blocks the request before retrieval/generation", blocked.code === 0 && /input_blocked: True/.test(blocked.out) && blocked.calls.length === 0 && blocked.retrieved.length === 0, blocked.out.slice(0, 300));

  // Audit log invariants.
  const events = readFileSync(auditLog, "utf8").trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);
  const names = new Set(events.map((e) => e.event));
  check("audit: query_completed, unknown_user, input_guardrail_blocked all logged", ["query_completed", "unknown_user", "input_guardrail_blocked"].every((n) => names.has(n)), `saw=${[...names]}`);
  const rawLog = readFileSync(auditLog, "utf8");
  check("audit: log never contains question text", !rawLog.includes(Q3) && !rawLog.includes("vendor API rate limit") && !rawLog.includes("how do I do something dangerous"), "question text found in audit log");

  // Direct connection as ragapp_query. max: 1 keeps session settings on one
  // connection. The positive control gates the negative checks so they cannot
  // pass on a connection that never worked.
  querySql = new SQL({ url: QUERY_URL, max: 1, connectionTimeout: 15 });
  const qsql = querySql;
  // With RLS, ragapp_query reads chunks only after SET ROLE to a scope role, so
  // the positive control reads through the widest scope role.
  let readable: number | string = "no result";
  try {
    const [row] = await asScope(qsql, "rag_scope_restricted", (tx) => tx`SELECT count(*)::int AS n FROM chunks`);
    readable = row.n as number;
  } catch (e) {
    readable = e instanceof Error ? e.message : String(e);
  }
  check("query role: positive control, connects and reads all 4 chunks after SET LOCAL ROLE rag_scope_restricted", readable === 4, `result=${readable}`);
  if (readable === 4) {
    // Runs after the scope transaction above committed: SET LOCAL has ended,
    // so this is ragapp_query with no role switch.
    const [deny] = await bounded(qsql`SELECT current_user AS who, count(*)::int AS n FROM chunks`, "default deny");
    check("RLS default deny: ragapp_query without a role switch reads 0 rows (the scope role reads 4)", deny.who === "ragapp_query" && deny.n === 0, JSON.stringify(deny));

    for (const { role, acl } of SCOPES) {
      const seen = sortedAcl((await asScope(qsql, role, (tx) => tx`SELECT DISTINCT acl FROM chunks`)) as { acl: string }[]);
      check(`RLS: ${role} sees exactly acl ${JSON.stringify(acl)}`, JSON.stringify(seen) === JSON.stringify(acl), `seen=${JSON.stringify(seen)}`);
    }

    // The query names the higher tiers; the policy still hides them. The owner
    // counts are the positive control: those rows exist.
    const [ownerTiers] = await bounded(ownerSql`
      SELECT count(*) FILTER (WHERE acl = 'internal')::int AS internal,
             count(*) FILTER (WHERE acl = 'restricted')::int AS restricted FROM chunks`, "owner tier counts");
    const [pubHigher] = await asScope(qsql, "rag_scope_public", (tx) => tx`SELECT count(*)::int AS n FROM chunks WHERE acl IN ('internal', 'restricted')`);
    const [intHigher] = await asScope(qsql, "rag_scope_internal", (tx) => tx`SELECT count(*)::int AS n FROM chunks WHERE acl = 'restricted'`);
    check("RLS: a scope role cannot read a higher tier when the query asks for it (public: internal+restricted 0, internal: restricted 0)", ownerTiers.internal > 0 && ownerTiers.restricted > 0 && pubHigher.n === 0 && intHigher.n === 0, `owner=${JSON.stringify(ownerTiers)} public=${pubHigher.n} internal=${intHigher.n}`);

    const ownerRole = decodeURIComponent(ownerUrl.username).replace(/"/g, '""');
    const setOwner = await expectSqlState(() => qsql.begin(async (tx) => { await tx.unsafe(`SET LOCAL ROLE "${ownerRole}"`); }), "42501", /permission denied to set role/);
    const setReadAll = await expectSqlState(() => qsql.begin(async (tx) => { await tx.unsafe("SET LOCAL ROLE pg_read_all_data"); }), "42501", /permission denied to set role/);
    check("SET ROLE: ragapp_query cannot switch to the owner role or pg_read_all_data (42501)", setOwner.ok && setReadAll.ok, `owner: ${setOwner.detail}; pg_read_all_data: ${setReadAll.detail}`);

    const [ro] = await bounded(qsql`SHOW transaction_read_only`, "SHOW transaction_read_only");
    check("query role: session starts read-only (transaction_read_only=on from the role default)", ro.transaction_read_only === "on", JSON.stringify(ro));

    const txInsert = await expectSqlState(() => qsql.begin(async (tx) => { await insertRow(tx); }), "25006", /read-only transaction/);
    check("read-only mode: INSERT inside a transaction fails with 25006 (read_only_sql_transaction)", txInsert.ok, txInsert.detail);

    // The session can lift the role default, so privileges are the boundary.
    await bounded(qsql`SET SESSION CHARACTERISTICS AS TRANSACTION READ WRITE`, "SET SESSION READ WRITE");
    const onChunks = /permission denied for table chunks/;
    const negatives: [string, () => Promise<unknown>, RegExp][] = [
      ["INSERT into chunks", () => insertRow(qsql), onChunks],
      ["UPDATE chunks", () => qsql`UPDATE chunks SET content = content WHERE true`, onChunks],
      ["DELETE FROM chunks", () => qsql`DELETE FROM chunks WHERE true`, onChunks],
      ["TRUNCATE chunks", () => qsql`TRUNCATE chunks`, onChunks],
      ["CREATE TABLE in schema public", () => qsql`CREATE TABLE public.x (a int)`, /permission denied for schema public/],
      ["CREATE TEMP TABLE", () => qsql`CREATE TEMP TABLE x (a int)`, /permission denied to create temporary tables/],
    ];
    for (const [what, run, denied] of negatives) {
      const r = await expectSqlState(run, "42501", denied);
      check(`privileges: ragapp_query cannot ${what} (42501)`, r.ok, r.detail);
    }

    const scopeInsert = await expectSqlState(() => asScope(qsql, "rag_scope_restricted", (tx) => insertRow(tx)), "42501", onChunks);
    check("privileges: after SET ROLE rag_scope_restricted, INSERT into chunks still fails (42501)", scopeInsert.ok, scopeInsert.detail);
  }

  // Re-ingest empties chunks with TRUNCATE; RLS, policies, grants and
  // memberships must survive it, and the scope roles must still read the rows.
  const beforeReingest = await privilegeSnapshot(ownerSql);
  const reingest = await runCli(["ingest"], "owner");
  const afterReingest = await privilegeSnapshot(ownerSql);
  let reingestCounts = "no result";
  if (querySql) {
    const q = querySql;
    try {
      const [scoped] = await asScope(q, "rag_scope_restricted", (tx) => tx`SELECT count(*)::int AS n FROM chunks`);
      const [unscoped] = await bounded(q`SELECT count(*)::int AS n FROM chunks`, "unscoped count after re-ingest");
      reingestCounts = `${scoped.n}/${unscoped.n}`;
    } catch (e) {
      reingestCounts = e instanceof Error ? e.message : String(e);
    }
  }
  check("re-ingest: keeps RLS, policies, grants and memberships unchanged (restricted scope reads 4, no role switch reads 0)", reingest.code === 0 && /Ingested 4 documents/.test(reingest.out) && afterReingest.chunks_rls === "t|f" && JSON.stringify(beforeReingest) === JSON.stringify(afterReingest) && reingestCounts === "4/0", `code=${reingest.code} counts=${reingestCounts} before=${JSON.stringify(beforeReingest)} after=${JSON.stringify(afterReingest)} err=${reingest.err.slice(-300)}`);

  const [remaining] = await bounded(ownerSql`SELECT count(*)::int AS n FROM chunks`, "chunk count");
  check("chunks unchanged after the negative checks (4 rows)", remaining.n === 4, `rows=${remaining.n}`);
} finally {
  await querySql?.close({ timeout: 5 });
  await ownerSql?.close({ timeout: 5 });
  fakeOllama.stop(true);
  fakeGateway.stop(true);
}

if (executed < EXPECTED_CHECKS && failures.length === 0) {
  console.error(`FAIL: only ${executed}/${EXPECTED_CHECKS} checks executed -- harness is not exercising what it claims`);
  process.exit(1);
}
if (failures.length > 0) {
  console.error(`\n${failures.length} check(s) failed:\n  - ${failures.join("\n  - ")}`);
  process.exit(1);
}
console.log(`\nAll ${executed} checks passed.`);
