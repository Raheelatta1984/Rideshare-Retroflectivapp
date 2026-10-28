#!/usr/bin/env node
/**
 * Assign campaigns created before 0005 (they have no owner) to an account.
 *
 * Before 0005 every row was readable by everyone, so no row needed an owner.
 * After it, an ownerless row is visible to reviewers only: approved ones still
 * display, but nobody can edit their own work and the driver console cannot see
 * them. This is the deploy step that fixes that, without hand-written SQL.
 *
 *   # 1. What is orphaned? (no connection needed beyond the database)
 *   DATABASE_URL='postgres://…' node scripts/assign-legacy-owners.mjs --list
 *
 *   # 2. Assign everything to the one account that exists (refused if several do)
 *   DATABASE_URL='postgres://…' node scripts/assign-legacy-owners.mjs \
 *     --owner tic.raheel@gmail.com --apply
 *
 *   # 3. Or be explicit, which is always safe
 *   DATABASE_URL='postgres://…' node scripts/assign-legacy-owners.mjs \
 *     --owner tic.raheel@gmail.com --ids camp_abc123,camp_def456 --apply
 *
 * Dry run is the default. See docs/security/rls-model.md.
 */

import { assignLegacyOwners, connectPg, listOwnerlessCampaigns } from "./db-hardening.mjs";

function parseArgs(argv) {
  const args = { apply: false, list: false, all: false, owner: "", ids: [], url: "", json: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--apply") args.apply = true;
    else if (arg === "--list") args.list = true;
    else if (arg === "--all") args.all = true;
    else if (arg === "--owner") args.owner = (argv[++index] ?? "").trim();
    else if (arg === "--ids") args.ids = String(argv[++index] ?? "").split(",").map((id) => id.trim()).filter(Boolean);
    else if (arg === "--url") args.url = argv[++index] ?? "";
    else if (arg === "--json") args.json = true;
    else if (arg === "--help" || arg === "-h") args.help = true;
    else if (arg.trim()) throw new Error(`unknown argument: ${arg}`);
  }
  return args;
}

const HELP = `Assign campaigns created before 0005 to an account.

  --list                 show the ownerless campaigns and exit
  --owner <email|uuid>   who they belong to
  --ids a,b,c            limit the assignment (recommended when there are several)
  --all                  assign every ownerless campaign (required when more than one account exists)
  --apply                make the change (default: report only)
  --url <connection>     Postgres connection string (default: DATABASE_URL)
  --json                 machine-readable output

Environment:
  DATABASE_URL           direct/session connection (the postgres role)
`;

function log(...parts) {
  console.log(...parts);
}

function table(rows) {
  const widths = [34, 40, 10];
  for (const row of rows) {
    log(
      `  ${String(row.id).padEnd(widths[0])}${String(row.title ?? "—").slice(0, widths[1]).padEnd(widths[1])}${String(row.approval_state).padEnd(widths[2])}`,
    );
  }
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
    process.exit(1);
  }

  const { client, close } = await connectPg(connectionString);
  try {
    if (args.list || !args.owner) {
      const pending = await listOwnerlessCampaigns(client);
      if (pending.length === 0) {
        log("✓ No ownerless campaigns — nothing to assign.");
        return;
      }
      log(`${pending.length} campaign(s) have no owner:\n`);
      log(`  ${"id".padEnd(34)}${"title".padEnd(40)}state`);
      table(pending);
      const approved = pending.filter((row) => row.approval_state === "approved").length;
      log(`\n  ${approved} of them are approved and already visible on a display.`);
      log("\nAssign them with:");
      log(`  node scripts/assign-legacy-owners.mjs --owner <email> --ids ${pending.map((row) => row.id).join(",")} --apply`);
      if (!args.owner) return;
    }

    log(`\nOwner: ${args.owner}`);
    log(`Scope: ${args.ids.length > 0 ? args.ids.join(", ") : args.all ? "every ownerless campaign" : "ownerless campaigns (refused if several accounts exist)"}`);
    log(`Mode:  ${args.apply ? "APPLY" : "dry run (pass --apply to change anything)"}\n`);

    if (!args.apply) {
      const preview = await assignLegacyOwners(client, { owner: args.owner, ids: args.ids, allowAll: args.all });
      if (!preview.ok) {
        console.error(`✗ ${preview.message ?? preview.reason}`);
        process.exitCode = 1;
        return;
      }
      log(`Would assign ${preview.assigned} campaign(s) to ${preview.ownerId}.`);
      if (preview.frozen?.length) log(`! ${preview.frozen.length} of them are approved and stay read-only for their owner (reopen to edit).`);
      log("\nNo changes were made.");
      return;
    }

    const result = await assignLegacyOwners(client, { owner: args.owner, ids: args.ids, allowAll: args.all });
    if (!result.ok) {
      console.error(`✗ ${result.message ?? result.reason}`);
      if (result.pending?.length) console.error(`  ownerless: ${result.pending.join(", ")}`);
      process.exitCode = 1;
      return;
    }

    log(result.assigned === 0 ? "✓ Nothing to assign." : `✓ assigned ${result.assigned} campaign(s) to ${result.ownerId}`);
    if (result.frozen?.length) {
      log(`! ${result.frozen.length} assigned campaign(s) are approved and therefore read-only for their`);
      log("  owner — that is the intended rule; a reviewer can reopen one to edit it.");
    }

    const remaining = await listOwnerlessCampaigns(client);
    log(remaining.length === 0 ? "✓ no ownerless campaigns remain" : `! ${remaining.length} still have no owner: ${remaining.map((row) => row.id).join(", ")}`);
    if (args.json) log(`\n${JSON.stringify({ ...result, remaining: remaining.length }, null, 2)}`);
  } finally {
    await close();
  }
}

main().catch((error) => {
  console.error(`✗ ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
