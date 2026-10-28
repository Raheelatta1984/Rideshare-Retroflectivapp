#!/usr/bin/env node
/**
 * Grant (or re-grant) the reviewer role to an existing account, and end that
 * account's sessions so the next sign-in carries the new claim.
 *
 * Two transports, because deployments differ:
 *
 *   # SQL — needs a direct Postgres connection (the postgres role):
 *   DATABASE_URL='postgres://…' node scripts/grant-admin.mjs \
 *     --email tic.raheel@gmail.com --apply --revoke-sessions --via sql
 *
 *   # Admin API — needs only the service-role key, no database password:
 *   SUPABASE_URL='https://<project>.supabase.co' \
 *   SUPABASE_SERVICE_ROLE_KEY='…' \
 *     node scripts/grant-admin.mjs --email tic.raheel@gmail.com --apply --revoke-sessions --via api
 *
 * Idempotent either way. A dry run is the default.
 *
 * Why re-signing in is required: the role lives in the JWT
 * (`app_metadata.role`), and a token issued before the grant cannot gain it.
 * Ending the sessions turns "eventually" into "on the next request".
 */

import { connectPg, findUserId, grantReviewer, grantReviewerViaApi, revokeUserSessions } from "./db-hardening.mjs";

function parseArgs(argv) {
  const args = { apply: false, revokeSessions: false, email: "", via: "", url: "", json: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--apply") args.apply = true;
    else if (arg === "--dry-run") args.apply = false;
    else if (arg === "--revoke-sessions") args.revokeSessions = true;
    else if (arg === "--email") args.email = (argv[++index] ?? "").trim();
    else if (arg === "--via") args.via = (argv[++index] ?? "").trim();
    else if (arg === "--url") args.url = argv[++index] ?? "";
    else if (arg === "--json") args.json = true;
    else if (arg === "--help" || arg === "-h") args.help = true;
    else if (arg.trim()) throw new Error(`unknown argument: ${arg}`);
  }
  return args;
}

const HELP = `Grant the reviewer role to an existing Supabase account.

  --email <address>      the account (required)
  --apply                make the change (default: report only)
  --revoke-sessions      end the account's sessions so it must sign in again
  --via sql|api          transport (default: sql when DATABASE_URL is set)
  --url <connection>     Postgres connection string for sql mode
  --json                 machine-readable output

Environment:
  DATABASE_URL                 for --via sql
  SUPABASE_URL                 for --via api
  SUPABASE_SERVICE_ROLE_KEY    for --via api
`;

function log(...parts) {
  console.log(...parts);
}

/* ------------------------------------------------------------------ *
 * SQL transport
 * ------------------------------------------------------------------ */

async function viaSql(args) {
  const connectionString = args.url || process.env.DATABASE_URL || "";
  if (!connectionString) {
    throw new Error("DATABASE_URL is not set (needed for --via sql). Use --via api to avoid a database password.");
  }

  const { client, close } = await connectPg(connectionString);
  try {
    const user = await findUserId(client, args.email);
    if (!user) {
      return { ok: false, reason: "no-such-user", message: `No Supabase auth user with the address ${args.email}.` };
    }

    if (!args.apply) {
      const current = user.raw_app_meta_data ?? {};
      return { ok: true, dryRun: true, userId: user.id, role: current.role ?? null, wouldGrant: current.role !== "admin" };
    }

    const granted = await grantReviewer(client, args.email, { revokeSessions: args.revokeSessions });
    if (!granted.ok) return granted;

    let revoked = granted.revokedSessions ?? 0;
    if (args.revokeSessions && revoked === 0) {
      // The table may be absent (file/memory session store); that is fine, the
      // notice below tells the operator what to do instead.
      const extra = await revokeUserSessions(client, args.email);
      revoked = extra.revoked;
    }

    return { ok: true, userId: granted.userId, role: granted.role, revokedSessions: revoked };
  } finally {
    await close();
  }
}

/* ------------------------------------------------------------------ *
 * Entry
 * ------------------------------------------------------------------ */

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    log(HELP);
    return;
  }
  if (!args.email) {
    console.error("✗ --email is required");
    process.exit(1);
  }

  const via = args.via || (process.env.DATABASE_URL ? "sql" : process.env.SUPABASE_SERVICE_ROLE_KEY ? "api" : "");
  if (via !== "sql" && via !== "api") {
    console.error("✗ choose a transport: set DATABASE_URL (--via sql) or SUPABASE_SERVICE_ROLE_KEY (--via api)");
    process.exit(1);
  }

  log(`Account: ${args.email}`);
  log(`Transport: ${via}`);
  log(`Mode: ${args.apply ? "APPLY" : "dry run (pass --apply to change anything)"}\n`);

  const result = via === "sql"
    ? await viaSql(args)
    : await grantReviewerViaApi({
        baseUrl: process.env.SUPABASE_URL ?? "",
        serviceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY ?? "",
        email: args.email,
        apply: args.apply,
        revokeSessions: args.revokeSessions,
      });

  if (!result.ok) {
    console.error(`✗ ${result.message ?? result.reason}`);
    process.exitCode = 1;
    return;
  }

  if (result.dryRun) {
    log(`  user: ${result.userId}`);
    log(`  current role: ${result.role ?? "(none)"}`);
    log(result.wouldGrant ? "  would grant role=admin" : "  already a reviewer");
    log("\nNo changes were made.");
    return;
  }

  log(`✓ reviewer role set (user ${result.userId})`);
  if (args.revokeSessions) {
    if (via === "api") log(result.revoked ? "✓ account signed out everywhere" : "! the logout endpoint did not confirm — rotate the JWT secret if sessions must end now");
    else log(`✓ ended ${result.revokedSessions ?? 0} BFF session(s)`);
  } else {
    log("! existing sessions were left alone — add --revoke-sessions so the account has to sign in again");
  }

  log("\nNow:");
  log("  • the approval panel will accept decisions from this account");
  log("  • on the BFF adapter the next approve/reject reissues the token and picks the role up");
  log("  • on the static (browser-token) adapter sign in again — the old token has no claim");
  log("  • if it still refuses, the JWT predates the grant: sign out and back in once more");

  if (args.json) log(`\n${JSON.stringify(result, null, 2)}`);
}

main().catch((error) => {
  console.error(`✗ ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
