/**
 * Applying the Supabase access-control migrations, and granting the reviewer
 * role — the deploy step in `docs/security/rls-model.md`, as code.
 *
 * Why this is not just "run two files in the SQL editor":
 *
 *   1. **0005 and 0006 must land together.** 0005 revokes every anonymous
 *      privilege on `public.campaigns`; 0006 creates `public.public_campaigns`,
 *      the only anonymous read path left. Applied one at a time in separate
 *      transactions, a display that polls between the two shows an empty
 *      playlist. Applied in one transaction, there is no window — and if 0006
 *      fails, 0005 is rolled back instead of leaving the app with no read path.
 *
 *   2. **"Applied" is not "correct".** The function verifies the post-conditions
 *      (projection exists, legacy directory gone, anon has no table privileges,
 *      no permissive policy survived) *inside* the transaction, so a migration
 *      that silently does less than it claims fails the deploy rather than the
 *      app.
 *
 *   3. **The reviewer role is deployment state, not code.** `grant_admin` is
 *      not callable from the browser, and the account it names has to exist.
 *      This module grants it idempotently and can end the account's sessions so
 *      the next sign-in carries the new claim.
 */

import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
export const migrationsDir = path.resolve(here, "..", "supabase", "migrations");

/** Applied together, in this order, in one transaction. */
export const HARDENING_MIGRATIONS = ["0005_tenant_isolation.sql", "0006_public_projections.sql"];

/** Only needed when the BFF runs with BFF_SESSION_STORE=postgres. */
export const SESSION_STORE_MIGRATION = "0007_bff_sessions.sql";

/**
 * @typedef {{ query(sql: string, params?: unknown[]): Promise<{ rows: any[], rowCount?: number | null }> }} Queryable
 */

function asQueryable(client) {
  if (!client || typeof client.query !== "function") {
    throw new Error("db-hardening: expected a queryable client with a query() method");
  }
  return client;
}

/** Run a multi-statement script. Prefers exec() (PGlite) and falls back to query(). */
async function runScript(client, sql) {
  if (typeof client.exec === "function") return client.exec(sql);
  return client.query(sql);
}

async function scalar(client, sql, params = []) {
  const result = await client.query(sql, params);
  const row = result?.rows?.[0];
  if (!row) return undefined;
  return row[Object.keys(row)[0]];
}

export async function readMigration(name) {
  const sql = await readFile(path.join(migrationsDir, name), "utf8");
  return sql.replace(
    /create extension if not exists "pgcrypto";/g,
    "-- pgcrypto is unnecessary on PG13+: gen_random_uuid() is core.",
  );
}

/* ------------------------------------------------------------------ *
 * Verification
 * ------------------------------------------------------------------ */

/**
 * Every post-condition the hardening migrations promise, as rows of
 * `{ check, ok, detail }`. Runs inside the applying transaction, so a failing
 * check aborts and rolls back rather than shipping.
 */
export async function verifyHardening(client) {
  const q = asQueryable(client);
  const checks = [];

  const record = async (name, sql, params = []) => {
    try {
      const value = await scalar(q, sql, params);
      checks.push({
        check: name,
        ok: value === true || value === "t",
        detail: value === undefined ? "query returned no row" : String(value),
      });
    } catch (error) {
      // A check that cannot even run (a missing table, usually) is a failure,
      // not a crash: the operator needs the whole list, not the first problem.
      checks.push({ check: name, ok: false, detail: error instanceof Error ? error.message : String(error) });
    }
  };

  await record(
    "public_campaigns projection exists",
    "select to_regclass('public.public_campaigns') is not null",
  );
  await record("legacy booth_directory view is gone", "select to_regclass('public.booth_directory') is null");
  await record("anon cannot read campaigns", "select not has_table_privilege('anon', 'public.campaigns', 'select')");
  await record("anon cannot read approval_audit", "select not has_table_privilege('anon', 'public.approval_audit', 'select')");
  await record("anon cannot read campaign_events", "select not has_table_privilege('anon', 'public.campaign_events', 'select')");
  await record("anon cannot read booths", "select not has_table_privilege('anon', 'public.booths', 'select')");
  await record("anon cannot read devices", "select not has_table_privilege('anon', 'public.devices', 'select')");
  await record("anon can read the projection", "select has_table_privilege('anon', 'public.public_campaigns', 'select')");
  await record(
    "no permissive policy remains on tenant tables",
    `select count(*) = 0
       from pg_policies
      where schemaname = 'public'
        and tablename in ('campaigns', 'approval_audit', 'campaign_events', 'devices', 'booths')
        and cmd in ('SELECT', 'ALL')
        and coalesce(qual, 'true') = 'true'`,
  );
  await record("owner defaults to auth.uid()", `
    select exists (
      select 1 from information_schema.columns
       where table_schema = 'public' and table_name = 'campaigns' and column_name = 'owner'
         and column_default like '%auth.uid()%'
    )`);
  await record("reviewer helpers exist", "select to_regprocedure('public.is_admin()') is not null and to_regprocedure('public.grant_admin(text)') is not null");
  await record("pair code RPC exists", "select to_regprocedure('public.resolve_pair_code(text)') is not null");
  await record("grant_admin is not callable by browser roles", `
    select not has_function_privilege('anon', 'public.grant_admin(text)', 'execute')
       and not has_function_privilege('authenticated', 'public.grant_admin(text)', 'execute')`);

  return checks;
}

/* ------------------------------------------------------------------ *
 * Applying
 * ------------------------------------------------------------------ */

/**
 * Apply the hardening migrations and verify the result, atomically.
 *
 * @param {Queryable & { exec?: (sql: string) => Promise<unknown> }} client
 * @param {{ migrations?: Array<{ name: string, sql: string }>, includeSessionStore?: boolean, verify?: boolean }} [options]
 * @returns {Promise<{ applied: string[], checks: Array<{ check: string, ok: boolean, detail: string }> }>}
 */
export async function applyHardening(client, options = {}) {
  const q = asQueryable(client);
  const names = options.includeSessionStore ? [...HARDENING_MIGRATIONS, SESSION_STORE_MIGRATION] : HARDENING_MIGRATIONS;

  const scripts = options.migrations
    ?? (await Promise.all(names.map(async (name) => ({ name, sql: await readMigration(name) }))));

  await runScript(q, "begin");
  try {
    for (const script of scripts) {
      try {
        await runScript(q, script.sql);
      } catch (error) {
        throw new Error(`${script.name} failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    const checks = options.verify === false ? [] : await verifyHardening(q);
    const failed = checks.filter((check) => !check.ok);
    if (failed.length > 0) {
      throw new Error(
        `post-migration verification failed (rolled back): ${failed.map((check) => check.check).join("; ")}`,
      );
    }

    await runScript(q, "commit");
    return { applied: scripts.map((script) => script.name), checks };
  } catch (error) {
    await runScript(q, "rollback").catch(() => undefined);
    throw error;
  }
}

/* ------------------------------------------------------------------ *
 * Reviewer role
 * ------------------------------------------------------------------ */

export async function findUserId(client, email) {
  const q = asQueryable(client);
  const result = await q.query("select id, raw_app_meta_data from auth.users where lower(email) = lower($1) limit 1", [email]);
  return result?.rows?.[0] ?? null;
}

/**
 * Grant the reviewer role (idempotent) and optionally end that account's
 * sessions, including BFF sessions when the table exists.
 *
 * Re-signing in is still required: the claim lives in the token, and an access
 * token issued before the grant does not gain it. Ending the sessions makes
 * that immediate instead of "within the hour".
 */
export async function grantReviewer(client, email, options = {}) {
  const q = asQueryable(client);
  const user = await findUserId(q, email);
  if (!user) {
    return {
      ok: false,
      reason: "no-such-user",
      message: `No Supabase auth user with the address ${email}. Create or sign up that account first, then re-run — this is idempotent.`,
    };
  }

  await q.query("select public.grant_admin($1)", [email]);
  const after = await findUserId(q, email);
  const role = after?.raw_app_meta_data?.role ?? null;

  let revokedSessions = 0;
  if (options.revokeSessions) {
    const hasTable = await scalar(q, "select to_regclass('public.bff_sessions') is not null");
    if (hasTable === true || hasTable === "t") {
      const result = await q.query("delete from public.bff_sessions where user_id = $1", [String(user.id)]);
      revokedSessions = result?.rowCount ?? 0;
    }
  }

  return { ok: role === "admin", reason: role === "admin" ? "granted" : "not-applied", userId: user.id, role, revokedSessions };
}

/**
 * Delete every BFF session for an address. Useful after a credential rotation
 * or a role change: the sessions hold upstream tokens issued earlier.
 */
export async function revokeUserSessions(client, email) {
  const q = asQueryable(client);
  const hasTable = await scalar(q, "select to_regclass('public.bff_sessions') is not null");
  if (!(hasTable === true || hasTable === "t")) return { ok: true, revoked: 0, note: "bff_sessions does not exist (file or memory session store)" };
  const user = await findUserId(q, email);
  if (!user) return { ok: false, revoked: 0, note: `no auth user with the address ${email}` };
  const result = await q.query("delete from public.bff_sessions where user_id = $1", [String(user.id)]);
  return { ok: true, revoked: result?.rowCount ?? 0 };
}

/* ------------------------------------------------------------------ *
 * Admin API transport (no database password required)
 * ------------------------------------------------------------------ */

/**
 * Grant the reviewer role through the Supabase Admin API instead of SQL.
 *
 * GoTrue replaces `app_metadata` wholesale on update, so the existing keys are
 * merged rather than overwritten — dropping an unrelated claim (a plan, a
 * tenant) to gain this one would be a silent data loss.
 *
 * @param {{ baseUrl: string, serviceRoleKey: string, email: string, apply?: boolean, revokeSessions?: boolean, fetchImpl?: typeof fetch }} options
 */
export async function grantReviewerViaApi(options) {
  const base = (options.baseUrl ?? "").replace(/\/$/, "");
  const key = options.serviceRoleKey ?? "";
  const email = (options.email ?? "").trim();
  const doFetch = options.fetchImpl ?? fetch;

  if (!base) throw new Error("SUPABASE_URL is not set (needed for the Admin API transport)");
  if (!key) throw new Error("SUPABASE_SERVICE_ROLE_KEY is not set (needed for the Admin API transport)");
  if (!email) throw new Error("an email address is required");

  async function call(path, init = {}) {
    const response = await doFetch(`${base}/auth/v1/admin${path}`, {
      ...init,
      headers: { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json", ...(init.headers ?? {}) },
    });
    const text = await response.text();
    let body = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = text;
    }
    return { status: response.status, ok: response.ok, body };
  }

  async function find() {
    for (let page = 1; page <= 20; page += 1) {
      const result = await call(`/users?page=${page}&per_page=200`);
      if (!result.ok) throw new Error(`listing users failed (${result.status})`);
      const users = Array.isArray(result.body?.users) ? result.body.users : Array.isArray(result.body) ? result.body : [];
      if (users.length === 0) return null;
      const match = users.find((user) => String(user.email ?? "").toLowerCase() === email.toLowerCase());
      if (match) return match;
    }
    return null;
  }

  const user = await find();
  if (!user) {
    return {
      ok: false,
      reason: "no-such-user",
      message: `No Supabase auth user with the address ${email}. Create or sign up that account first, then re-run — this is idempotent.`,
    };
  }

  const existing = (user.app_metadata ?? {});
  const alreadyAdmin = existing.role === "admin";

  if (!options.apply) {
    return { ok: true, dryRun: true, userId: user.id, role: existing.role ?? null, wouldGrant: !alreadyAdmin };
  }

  if (!alreadyAdmin) {
    const updated = await call(`/users/${user.id}`, {
      method: "PUT",
      body: JSON.stringify({ app_metadata: { ...existing, role: "admin" } }),
    });
    if (!updated.ok) {
      return { ok: false, reason: "update-failed", message: `app_metadata update failed (${updated.status})` };
    }
  }

  let revoked = false;
  if (options.revokeSessions) {
    const logout = await call(`/users/${user.id}/logout`, { method: "POST" });
    revoked = logout.ok;
  }

  return { ok: true, userId: user.id, role: "admin", alreadyAdmin, revoked };
}

/* ------------------------------------------------------------------ *
 * Connecting
 * ------------------------------------------------------------------ */

/**
 * A single pooled connection, so BEGIN/COMMIT are meaningful. `pg` is an
 * optional dependency: only the SQL paths need it.
 */
export async function connectPg(connectionString) {
  if (!connectionString) throw new Error("db-hardening: a Postgres connection string is required (DATABASE_URL)");
  let pg;
  try {
    pg = await import("pg");
  } catch {
    throw new Error("db-hardening: the `pg` package is required for SQL mode — npm install pg");
  }
  const Pool = pg.default?.Pool ?? pg.Pool;
  const pool = new Pool({ connectionString, max: 1, application_name: "retroflex-hardening" });
  const client = await pool.connect();
  return {
    client,
    async close() {
      client.release();
      await pool.end().catch(() => undefined);
    },
  };
}
