/**
 * BFF entry point.
 *
 *   npm run bff:build   → dist-server/bff.mjs
 *   npm run bff:start   → node dist-server/bff.mjs
 *
 * Boots the same-origin session service described in docs/security/bff.md:
 * static hosting for the built SPA plus `/bff/*` JSON endpoints. Refuses to
 * start when a production-critical setting is missing rather than silently
 * degrading to a weaker mode.
 */

import path from "node:path";
import { createRequire } from "node:module";
import { promises as fs } from "node:fs";
import type { Queryable } from "../db/types";
import { BffConfigError, describeConfigGaps, readBffConfig, type EnvLike } from "./config";
import { createBffRouter, type BffLogger } from "./router";
import {
  createFileSessionStore,
  createMemorySessionStore,
  createPostgresSessionStore,
  type SessionStore,
} from "./sessions";
import { createUpstream } from "./upstream";
import { createBffServer } from "./node";

const require = createRequire(import.meta.url);

interface PgPool extends Queryable {
  end(): Promise<void>;
}

function loadPg(): { Pool: new (options: { connectionString: string; max?: number }) => PgPool } | null {
  try {
    // `pg` is deliberately not a hard dependency: deployments using the file
    // store never install a database driver.
    return require("pg") as { Pool: new (options: { connectionString: string; max?: number }) => PgPool };
  } catch {
    return null;
  }
}

const consoleLogger: BffLogger = {
  info(message, meta) {
    console.log(`[bff] ${message}`, meta ?? "");
  },
  warn(message, meta) {
    console.warn(`[bff] ${message}`, meta ?? "");
  },
  error(message, meta) {
    console.error(`[bff] ${message}`, meta ?? "");
  },
};

export interface StartedBff {
  server: ReturnType<typeof createBffServer>;
  port: number;
  close(): Promise<void>;
}

export async function startBff(
  env: EnvLike = process.env as EnvLike,
  options: { logger?: BffLogger } = {},
): Promise<StartedBff> {
  const logger = options.logger ?? consoleLogger;
  const config = readBffConfig(env);
  const key = config.sessionKey;

  let store: SessionStore;
  let pool: PgPool | null = null;

  if (config.sessionStore === "postgres") {
    const pg = loadPg();
    if (!pg) {
      throw new BffConfigError("BFF_SESSION_STORE=postgres requires the `pg` package: npm install pg");
    }
    if (!config.databaseUrl) throw new BffConfigError("BFF_DATABASE_URL is required for the postgres session store");
    pool = new pg.Pool({ connectionString: config.databaseUrl, max: 10 });
    const table = await pool.query<{ t: string | null }>("select to_regclass('public.bff_sessions') as t");
    if (!table.rows[0]?.t) {
      throw new BffConfigError(
        "the postgres session store needs public.bff_sessions — apply supabase/migrations/0007_bff_sessions.sql",
      );
    }
    store = createPostgresSessionStore(pool, { key });
  } else if (config.sessionStore === "file" && config.sessionFile) {
    store = createFileSessionStore({
      file: config.sessionFile,
      key,
      onCorrupt: (error) => logger.error("bff: session file is unreadable, refusing to overwrite it", { reason: String(error) }),
    });
  } else {
    logger.warn("bff: using the in-memory session store — every session is lost on restart");
    store = createMemorySessionStore();
  }

  const staticDir = config.staticDir ? path.resolve(config.staticDir) : undefined;
  if (staticDir) {
    await fs.stat(staticDir).catch(() => {
      throw new BffConfigError(`BFF_STATIC_DIR does not exist: ${staticDir}`);
    });
  }

  const handler = createBffRouter({
    config,
    sessions: store,
    upstream: createUpstream({ url: config.supabaseUrl, anonKey: config.anonKey }),
    logger,
  });

  const server = createBffServer({
    handler,
    staticDir,
    maxBodyBytes: config.maxBodyBytes,
    onError: (error) => logger.error("bff: request failed", { reason: String(error) }),
  });

  const port = Number(env.BFF_PORT ?? env.PORT ?? "8080");
  const host = env.BFF_HOST ?? "0.0.0.0";

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => resolve());
  });

  const purge = setInterval(() => {
    void store.purgeExpired(Date.now()).catch((error) => logger.warn("bff: session purge failed", { reason: String(error) }));
  }, 10 * 60 * 1000);
  purge.unref?.();

  const listeningPort = (server.address() as { port: number } | null)?.port ?? port;
  logger.info("bff listening", { host, port: listeningPort, store: config.sessionStore, static: staticDir ?? "disabled" });
  for (const gap of describeConfigGaps(config)) logger.warn(`bff: ${gap}`);

  return {
    server,
    port: listeningPort,
    async close() {
      clearInterval(purge);
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await pool?.end().catch(() => undefined);
    },
  };
}

// The bundle is only ever executed as the entry point.
const isEntry = process.argv[1] && import.meta.url === new URL(`file://${path.resolve(process.argv[1])}`).href;
if (isEntry || process.env.BFF_AUTOSTART === "1") {
  startBff().then(
    () => undefined,
    (error) => {
      console.error("[bff] failed to start:", error instanceof Error ? error.message : error);
      process.exitCode = 1;
    },
  );
}
