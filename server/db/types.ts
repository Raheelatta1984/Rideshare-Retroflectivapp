/**
 * Minimal driver-agnostic query contract.
 *
 * Both the primary pool (through PgBouncer) and every read replica satisfy
 * this shape, so the router above them never imports `pg` (or anything else)
 * directly — drivers are injected. That keeps the data plane testable without
 * a live database and deployable against `pg`, `postgres.js`, Neon's serverless
 * driver, or a mock.
 */

export interface QueryResult<R = Record<string, unknown>> {
  rows: R[];
  rowCount: number;
}

export interface Queryable {
  query<R = Record<string, unknown>>(sql: string, params?: readonly unknown[]): Promise<QueryResult<R>>;
}

/** A leased connection (transaction-mode aware), for multi-statement work. */
export interface LeasedConnection extends Queryable {
  release(): void;
}

export interface QueryEvent {
  kind: "read" | "write" | "cache-hit" | "cache-miss" | "replica-fallback" | "replica-error";
  detail: string;
}
