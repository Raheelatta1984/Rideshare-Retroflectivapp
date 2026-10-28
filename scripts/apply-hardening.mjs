#!/usr/bin/env node
/**
 * Apply the Supabase access-control migrations (0005 + 0006) in one
 * transaction, verify the result, then optionally grant the reviewer role.
 *
 *   # 1. See exactly what would happen, changing nothing (applies inside a
 *   #    transaction and rolls it back):
 *   DATABASE_URL='postgres://…' node scripts/apply-hardening.mjs --dry-run
 *
 *   # 2. Apply, and grant the reviewer role in the same run:
 *   DATABASE_URL='postgres://…' node scripts/apply-hardening.mjs \
 *     --grant-admin tic.raheel@gmail.com --revoke-sessions --apply
 *
 *   # 3. The BFF uses the Postgres session store:
 *   DATABASE_URL='postgres://…' node scripts/apply-hardening.mjs --include-session-store --apply
 *
 * DATABASE_URL must be a direct/session connection with DDL rights (the
 * `postgres` role on Supabase), not the anon key and not a transaction-mode
 * pooler. Full ordering and the breaking changes are in
 * docs/security/rls-model.md.
 */

import {
  applyHardening,
  connectPg,
  grantReviewer,
  HARDENING_MIGRATIONS,
  SESSION_STORE_MIGRATION,
} from "./db-hardening.mjs";

function parseArgs(argv) {
  const args = {
    apply: false,
    dryRun: false,
    includeSessionStore: false,
    grantAdmin: "",
    revokeSessions: false,
    json: false,
    url: "",
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--apply") args.apply = true;
    else if (arg === "--dry-run") args.dryRun = true;
    else if (arg === "--include-session-store") args.includeSessionStore = true;
    else if (arg === "--grant-admin") args.grantAdmin = (argv[++index] ?? "").trim();
    else if (arg === "--revoke-sessions") args.revokeSessions = true;
    else if (arg === "--json") args.json = true;
    else if (arg === "--url") args.url = argv[++index] ?? "";
    else if (arg === "--help" || arg === "-h") args.help = true;
    else if (arg.trim()) throw new Error(`unknown argument: ${arg}`);
  }
  if (args.dryRun) args.apply = false;
  return args;
}

const HELP = `Apply the Supabase access-control migrations.

  --apply                  actually commit (default is a rollback dry run)
  --dry-run                apply inside a transaction, verify, roll back
  --include-session-store  also apply 0007 (only for BFF_SESSION_STORE=postgres)
  --grant-admin <email>    grant the reviewer role after the migration
  --revoke-sessions        end that account's BFF sessions so the next sign-in
                           carries the new claim
  --url <connection>       Postgres connection string (default: DATABASE_URL)
  --json                   machine-readable output

Environment:
  DATABASE_URL             direct/session connection with DDL rights

Order of operations (docs/security/rls-model.md):
  1. this script            2. sign the reviewer account in again
  3. deploy the app build that reads public_campaigns
`;

function log(...parts) {
  console.log(...parts);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    log(HELP);
    return;
  }

  const connectionString = args.url || process.env.DATABASE_URL || "";
  if (!connectionString) {
    console.error("✗ DATABASE_URL is not set. Pass --url or export DATABASE_URL.");
    console.error("  It must be a direct connection with DDL rights (the postgres role), not the anon key.");
    process.exit(1);
  }

  const { client, close } = await connectPg(connectionString);
  const plan = args.includeSessionStore ? [...HARDENING_MIGRATIONS, SESSION_STORE_MIGRATION] : HARDENING_MIGRATIONS;

  try {
    log(`Migrations: ${plan.join(", ")}`);
    log(`Mode:       ${args.apply ? "APPLY (committing)" : "dry run (rolls back)"}\n`);

    if (!args.apply) {
      // A dry run that actually executes the migrations inside a transaction and
      // rolls back proves the DDL is valid against this database — a plan that
      // is printed but never run proves nothing.
      let result;
      await client.query("begin");
      try {
        result = await applyHardening(client, { includeSessionStore: args.includeSessionStore, verify: true });
      } finally {
        await client.query("rollback").catch(() => undefined);
      }
      for (const check of result.checks) log(`  ${check.ok ? "✓" : "✗"} ${check.check}`);
      log("\nDry run complete — nothing was committed.");
      if (args.grantAdmin) log(`Would grant the reviewer role to ${args.grantAdmin} (re-run with --apply).`);
      return;
    }

    const result = await applyHardening(client, { includeSessionStore: args.includeSessionStore, verify: true });
    log(`✓ applied ${result.applied.join(", ")} in one transaction`);
    for (const check of result.checks) log(`  ${check.ok ? "✓" : "✗"} ${check.check}`);

    let grant = null;
    if (args.grantAdmin) {
      grant = await grantReviewer(client, args.grantAdmin, { revokeSessions: args.revokeSessions });
      if (!grant.ok) {
        log(`\n✗ reviewer role not granted: ${grant.message ?? grant.reason}`);
        log("  The migrations are applied and committed; fix the account and re-run only the grant:");
        log(`    node scripts/grant-admin.mjs --email ${args.grantAdmin} --apply`);
        process.exitCode = 1;
      } else {
        log(`\n✓ ${args.grantAdmin} is a reviewer (app_metadata.role = admin)`);
        if (args.revokeSessions) log(`✓ ended ${grant.revokedSessions ?? 0} BFF session(s) for that account`);
      }
    }

    log("\nNext:");
    if (args.grantAdmin && grant?.ok) {
      log("  • sign that account in again so the new token carries app_metadata.role");
    } else if (!args.grantAdmin) {
      log("  • grant the reviewer role: node scripts/grant-admin.mjs --email <owner> --apply --revoke-sessions");
    }
    log("  • they must complete Forgot password → email code → new password if the account");
    log("    was the one whose password leaked (docs/security/administrator-credential-rotation.md)");
    log("  • deploy this app build, then open it and confirm places and approvals load");

    if (args.json) log(`\n${JSON.stringify({ applied: result.applied, checks: result.checks, grant }, null, 2)}`);
  } finally {
    await close();
  }
}

main().catch((error) => {
  console.error(`\n✗ ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
