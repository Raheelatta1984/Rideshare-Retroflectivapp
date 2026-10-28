/**
 * Shared test harness for the SQL side of this repository.
 *
 * Both the RLS suite and the migration-ordering suite need a real PostgreSQL
 * with the Supabase objects the migrations touch. PGlite gives us Postgres 18
 * compiled to WebAssembly, so this runs in CI with no Docker and no hosted
 * project.
 *
 * The shim below recreates only what the migrations actually reference:
 * `auth.users`, `auth.jwt()`, `auth.uid()`, `auth.role()`, `storage.objects`,
 * `storage.buckets` and the `supabase_realtime` publication — with Supabase's
 * default grants, because without them the `revoke` statements in 0005 would be
 * no-ops and the tests could pass for the wrong reason.
 */

import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";

const here = path.dirname(fileURLToPath(import.meta.url));
export const migrationsDir = path.resolve(here, "..", "migrations");

export const ALL_MIGRATIONS = [
  "0001_signage_phase2.sql",
  "0002_compliance_mode.sql",
  "0003_terminal_signup.sql",
  "0004_next_id_image_shards.sql",
  "0005_tenant_isolation.sql",
  "0006_public_projections.sql",
  "0007_bff_sessions.sql",
] as const;

/** Everything up to and including the image/id plane, i.e. the "legacy" state. */
export const LEGACY_MIGRATIONS = ALL_MIGRATIONS.slice(0, 4);

export const DRIVER_A = "11111111-1111-1111-1111-111111111111";
export const DRIVER_B = "22222222-2222-2222-2222-222222222222";
export const ADMIN = "33333333-3333-3333-3333-333333333333";

/**
 * The Supabase surface the migrations assume.
 *
 * `pgcrypto` is the only thing removed from 0001 when a migration is loaded:
 * PGlite has no contrib extensions and `gen_random_uuid()` has been core since
 * PG13, so on Supabase (PG15+) that line is a no-op anyway.
 */
const SUPABASE_SHIM = `
  create role anon nologin;
  create role authenticated nologin;
  create role service_role nologin bypassrls;
  create schema if not exists auth;
  create schema if not exists storage;

  create table auth.users (
    id uuid primary key,
    email text unique,
    raw_app_meta_data jsonb default '{}'::jsonb,
    raw_user_meta_data jsonb default '{}'::jsonb,
    updated_at timestamptz default now()
  );

  create or replace function auth.jwt()
  returns jsonb language sql stable as $$
    select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb;
  $$;

  create or replace function auth.uid()
  returns uuid language sql stable as $$
    select nullif(auth.jwt() ->> 'sub', '')::uuid;
  $$;

  create or replace function auth.role()
  returns text language sql stable as $$
    select coalesce(nullif(current_setting('request.jwt.claim.role', true), ''), auth.jwt() ->> 'role');
  $$;

  create table storage.buckets (
    id text primary key,
    name text not null,
    public boolean not null default false
  );

  create table storage.objects (
    id uuid primary key default gen_random_uuid(),
    bucket_id text references storage.buckets (id),
    name text not null,
    owner uuid
  );
  alter table storage.objects enable row level security;

  create publication supabase_realtime;

  grant usage on schema public, auth, storage to anon, authenticated;
  grant execute on all functions in schema auth to anon, authenticated;
  alter default privileges in schema public grant all on tables to anon, authenticated;
  alter default privileges in schema public grant all on functions to anon, authenticated;
  alter default privileges in schema public grant all on sequences to anon, authenticated;
  alter default privileges in schema storage grant all on tables to anon, authenticated;
  grant all on storage.objects to anon, authenticated;
  grant all on storage.buckets to anon, authenticated;
`;

/** Read one migration, minus the extension line PGlite cannot satisfy. */
export async function readMigration(name: string): Promise<string> {
  const sql = await readFile(path.join(migrationsDir, name), "utf8");
  return sql.replace(
    /create extension if not exists "pgcrypto";/g,
    "-- pgcrypto is unnecessary on PG13+: gen_random_uuid() is core.",
  );
}

export interface TestDatabase {
  db: PGlite;
  close(): Promise<void>;
}

/**
 * A database with the Supabase shim and the requested migrations applied, in
 * order. Migration failures are reported with the file name — a bare Postgres
 * error is useless when seven files are involved.
 */
export async function createTestDatabase(
  names: readonly string[] = ALL_MIGRATIONS,
  options: { migrate?: boolean } = {},
): Promise<TestDatabase> {
  const db = await PGlite.create();
  await db.exec(SUPABASE_SHIM);

  if (options.migrate !== false) {
    for (const name of names) {
      const sql = await readMigration(name);
      try {
        await db.exec(sql);
      } catch (error) {
        throw new Error(`${name} failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  return {
    db,
    async close() {
      await db.close();
    },
  };
}

/* ------------------------------------------------------------------ *
 * Acting as a role
 * ------------------------------------------------------------------ */

export type Role = "anon" | "authenticated" | "service_role" | "postgres";

export interface Actor {
  role: Role;
  sub?: string;
  appMetadata?: Record<string, unknown>;
  email?: string;
}

export const anon: Actor = { role: "anon" };
export const driverA: Actor = { role: "authenticated", sub: DRIVER_A };
export const driverB: Actor = { role: "authenticated", sub: DRIVER_B };
export const reviewer: Actor = { role: "authenticated", sub: ADMIN, appMetadata: { role: "admin" } };

export function claimsFor(actor: Actor): string {
  return JSON.stringify({
    sub: actor.sub,
    role: actor.role,
    app_metadata: actor.appMetadata ?? {},
    email: actor.email ?? (actor.sub ? `${actor.sub}@example.com` : undefined),
  });
}

/** Run `fn` as a database role carrying a given JWT, then restore the superuser. */
export async function as<T>(db: PGlite, actor: Actor, fn: () => Promise<T>): Promise<T> {
  await db.exec(actor.role === "postgres" ? "reset role" : `set role ${actor.role}`);
  await db.query("select set_config('request.jwt.claims', $1, false)", [claimsFor(actor)]);
  try {
    return await fn();
  } finally {
    await db.exec("reset role");
    await db.query("select set_config('request.jwt.claims', '', false)", []);
  }
}

export async function rows<T = Record<string, unknown>>(
  db: PGlite,
  sql: string,
  params: unknown[] = [],
): Promise<T[]> {
  const result = await db.query<T>(sql, params);
  return result.rows;
}

/** Assert that a statement is rejected, and return the message it was rejected with. */
export async function denied(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error("expected the statement to be rejected, but it succeeded");
}

/* ------------------------------------------------------------------ *
 * Fixtures
 * ------------------------------------------------------------------ */

export function legalBlock(complete = true): Record<string, unknown> {
  const consent = (confirmed: boolean) => ({
    confirmed,
    signerName: "Priya Raman",
    agreementReference: "AGR-2026-001",
    email: "priya@example.com",
  });
  return {
    appOwner: consent(complete),
    driver: consent(complete),
    vehicleOwner: consent(complete),
    campaignOwner: consent(complete),
    trademarkAuthorization: consent(complete),
    safetyAssessment: consent(complete),
    merchantName: "Bondi Coffee",
    offerExpiry: "2026-12-31",
    privacyPolicyUrl: "https://example.com/privacy",
    qrTermsConfirmed: true,
    noRiderDataWithoutConsent: true,
  };
}

export function campaignPayload(id: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    title: `Campaign ${id}`,
    enabled: true,
    approved: false,
    mediaType: "image",
    displaySeconds: 10,
    legal: legalBlock(),
    ...overrides,
  };
}

/**
 * The same rows the RLS suite uses. Written as plain SQL so it works both
 * before and after the hardening migrations (which is the point: `owner` does
 * not exist in the legacy schema).
 */
export async function seedLegacy(db: PGlite): Promise<void> {
  await db.exec(`
    insert into auth.users (id, email, raw_app_meta_data) values
      ('${DRIVER_A}', 'a@example.com', '{}'::jsonb),
      ('${DRIVER_B}', 'b@example.com', '{}'::jsonb),
      ('${ADMIN}', 'admin@example.com', '{"role":"admin"}'::jsonb);

    insert into public.campaigns (id, title, approval_state, payload) values
      ('camp_a_draft',   'A draft',   'draft',    '${JSON.stringify(campaignPayload("camp_a_draft"))}'::jsonb),
      ('camp_a_pending', 'A pending', 'pending',  '${JSON.stringify(campaignPayload("camp_a_pending"))}'::jsonb),
      ('camp_b_draft',   'B draft',   'draft',    '${JSON.stringify(campaignPayload("camp_b_draft"))}'::jsonb),
      ('camp_approved',  'Approved',  'approved', '${JSON.stringify(campaignPayload("camp_approved", { approved: true }))}'::jsonb);

    insert into public.booths (owner, name, email, phone, city, pair_code, front_pair_code)
    values ('${DRIVER_A}', 'Booth A', 'a@example.com', '0400000000', 'Sydney', 'ABC123', 'FRONT1');

    insert into public.devices (id, name, pair_code, position, owner, device_key, origin)
    values
      ('term_a', 'A terminal', 'ABC123', 'rear', '${DRIVER_A}', 'dev-a', 'console'),
      ('term_b', 'B terminal', 'XYZ789', 'rear', '${DRIVER_B}', 'dev-b', 'console');

    insert into public.campaign_events (id, campaign_id, device_id, kind, at)
    values ('evt_seed', 'camp_approved', 'dev-a', 'proof-of-play', now());
  `);
}

/** Seed with owners, for a database that already ran 0005. */
export async function seedOwned(db: PGlite): Promise<void> {
  await db.exec(`
    insert into auth.users (id, email, raw_app_meta_data) values
      ('${DRIVER_A}', 'a@example.com', '{}'::jsonb),
      ('${DRIVER_B}', 'b@example.com', '{}'::jsonb),
      ('${ADMIN}', 'admin@example.com', '{"role":"admin"}'::jsonb);

    insert into public.campaigns (id, title, owner, approval_state, payload) values
      ('camp_a_draft',   'A draft',   '${DRIVER_A}', 'draft',    '${JSON.stringify(campaignPayload("camp_a_draft"))}'::jsonb),
      ('camp_a_pending', 'A pending', '${DRIVER_A}', 'pending',  '${JSON.stringify(campaignPayload("camp_a_pending"))}'::jsonb),
      ('camp_b_draft',   'B draft',   '${DRIVER_B}', 'draft',    '${JSON.stringify(campaignPayload("camp_b_draft"))}'::jsonb),
      ('camp_approved',  'Approved',  '${DRIVER_A}', 'approved', '${JSON.stringify(campaignPayload("camp_approved", { approved: true }))}'::jsonb);

    insert into public.booths (owner, name, email, phone, city, pair_code, front_pair_code)
    values ('${DRIVER_A}', 'Booth A', 'a@example.com', '0400000000', 'Sydney', 'ABC123', 'FRONT1');

    insert into public.devices (id, name, pair_code, position, owner, device_key, origin)
    values
      ('term_a', 'A terminal', 'ABC123', 'rear', '${DRIVER_A}', 'dev-a', 'console'),
      ('term_b', 'B terminal', 'XYZ789', 'rear', '${DRIVER_B}', 'dev-b', 'console');

    insert into public.campaign_events (id, campaign_id, device_id, kind, at)
    values ('evt_seed', 'camp_approved', 'dev-a', 'proof-of-play', now());
  `);
}
