/** Type declarations for scripts/db-hardening.mjs (used by the CLIs and the SQL test suite). */

export interface Queryable {
  query(sql: string, params?: unknown[]): Promise<{ rows: Array<Record<string, unknown>>; rowCount?: number | null }>;
  exec?(sql: string): Promise<unknown>;
}

export interface HardeningCheck {
  check: string;
  ok: boolean;
  detail: string;
}

export declare const migrationsDir: string;
export declare const HARDENING_MIGRATIONS: string[];
export declare const SESSION_STORE_MIGRATION: string;

export declare function readMigration(name: string): Promise<string>;
export declare function verifyHardening(client: Queryable): Promise<HardeningCheck[]>;

export declare function applyHardening(
  client: Queryable,
  options?: {
    migrations?: Array<{ name: string; sql: string }>;
    includeSessionStore?: boolean;
    verify?: boolean;
  },
): Promise<{ applied: string[]; checks: HardeningCheck[] }>;

export declare function findUserId(
  client: Queryable,
  email: string,
): Promise<{ id: string; raw_app_meta_data: Record<string, unknown> | null } | null>;

export declare function grantReviewer(
  client: Queryable,
  email: string,
  options?: { revokeSessions?: boolean },
): Promise<{
  ok: boolean;
  reason: string;
  userId?: string;
  role?: string | null;
  revokedSessions?: number;
  message?: string;
}>;

export declare function revokeUserSessions(
  client: Queryable,
  email: string,
): Promise<{ ok: boolean; revoked: number; note?: string }>;

export declare function grantReviewerViaApi(options: {
  baseUrl: string;
  serviceRoleKey: string;
  email: string;
  apply?: boolean;
  revokeSessions?: boolean;
  fetchImpl?: typeof fetch;
}): Promise<{
  ok: boolean;
  reason?: string;
  message?: string;
  userId?: string;
  role?: string | null;
  wouldGrant?: boolean;
  alreadyAdmin?: boolean;
  revoked?: boolean;
  dryRun?: boolean;
}>;

export declare function connectPg(connectionString: string): Promise<{
  client: Queryable;
  close(): Promise<void>;
}>;
