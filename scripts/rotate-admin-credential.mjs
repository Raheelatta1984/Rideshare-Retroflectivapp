#!/usr/bin/env node
/**
 * Rotate a leaked administrator credential through the Supabase Admin API.
 *
 * The leaked password in this repository was a real person's email password.
 * Removing the literal from source does not invalidate it — this script does
 * the part that *can* be automated (the Supabase identity, if one exists) and
 * refuses to pretend the rest is done.
 *
 * Usage
 *   # 1. Look, change nothing:
 *   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... \
 *     node scripts/rotate-admin-credential.mjs --email owner@example.com --dry-run
 *
 *   # 2. Apply, reading the new password from a pipe (never from argv):
 *   printf '%s' "$NEW_PASSWORD" | SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... \
 *     node scripts/rotate-admin-credential.mjs --email owner@example.com \
 *       --apply --password-stdin --revoke-sessions
 *
 * The service-role key is used here and ONLY here; it never enters the app.
 * Nothing in this script prints the password or a token.
 */

import { createInterface } from "node:readline";

const ADMIN_API = "/auth/v1/admin";

function parseArgs(argv) {
  const args = { apply: false, passwordStdin: false, revokeSessions: false, email: "", minimumLength: 12 };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--email") args.email = argv[++index] ?? "";
    else if (arg === "--apply") args.apply = true;
    else if (arg === "--dry-run") args.apply = false;
    else if (arg === "--password-stdin") args.passwordStdin = true;
    else if (arg === "--revoke-sessions") args.revokeSessions = true;
    else if (arg === "--min-length") args.minimumLength = Number(argv[++index] ?? 12);
    else if (arg === "--help" || arg === "-h") args.help = true;
    else if (arg.trim()) throw new Error(`unknown argument: ${arg}`);
  }
  return args;
}

function usage() {
  console.log(`Rotate a Supabase administrator credential.

  --email <address>     account to rotate (required)
  --dry-run             report only (default)
  --apply               actually change the password
  --password-stdin      read the new password from stdin
  --revoke-sessions     sign the account out everywhere after rotating
  --min-length <n>      reject shorter passwords (default 12)

Environment:
  SUPABASE_URL                https://<project>.supabase.co
  SUPABASE_SERVICE_ROLE_KEY   service role key (server-side only)

Out of band (this script cannot do these): the email account password itself,
other services where the same password was reused, and a review of the provider's
sign-in history. See docs/security/administrator-credential-rotation.md.
`);
}

function fail(message) {
  console.error(`\n✗ ${message}`);
  process.exit(1);
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8").replace(/\r?\n$/, "");
}

/** Never echo what was typed, even on a TTY. */
async function promptHidden(question) {
  if (!process.stdin.isTTY) return readStdin();
  process.stdout.write(question);
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  const previous = process.stdin.isRaw;
  process.stdin.setRawMode?.(true);
  const answer = await new Promise((resolve) => rl.question("", resolve));
  rl.close();
  process.stdin.setRawMode?.(previous ?? false);
  process.stdout.write("\n");
  return answer;
}

async function admin(path, init = {}) {
  const url = `${process.env.SUPABASE_URL.replace(/\/$/, "")}${ADMIN_API}${path}`;
  const response = await fetch(url, {
    ...init,
    headers: {
      apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
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

async function findUser(email) {
  for (let page = 1; page <= 20; page += 1) {
    const result = await admin(`/users?page=${page}&per_page=200`);
    if (!result.ok) return { error: `listing users failed (${result.status})` };
    const users = Array.isArray(result.body?.users) ? result.body.users : Array.isArray(result.body) ? result.body : [];
    if (users.length === 0) break;
    const match = users.find((user) => String(user.email ?? "").toLowerCase() === email.toLowerCase());
    if (match) return { user: match };
  }
  return { user: null };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    usage();
    return;
  }
  if (!args.email) fail("--email is required");
  if (!process.env.SUPABASE_URL) fail("SUPABASE_URL is not set");
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY) fail("SUPABASE_SERVICE_ROLE_KEY is not set (server-side only)");

  console.log(`Supabase project: ${process.env.SUPABASE_URL}`);
  console.log(`Account:          ${args.email}`);
  console.log(`Mode:             ${args.apply ? "APPLY" : "dry run (pass --apply to change anything)"}\n`);

  const { user, error } = await findUser(args.email);
  if (error) fail(error);
  if (!user) {
    console.log("No Supabase auth user with that address.");
    console.log("That is expected when the leaked password belonged to a personal email account rather than this project:");
    console.log("rotate it at the identity provider and treat every service that reused it as compromised.");
    console.log("Checklist: docs/security/administrator-credential-rotation.md");
    return;
  }

  console.log(`Found auth user ${user.id}`);
  console.log(`  created:  ${user.created_at ?? "unknown"}`);
  console.log(`  last sign in: ${user.last_sign_in_at ?? "never"}`);
  console.log(`  role claim: ${user.app_metadata?.role ?? "(none)"}\n`);

  if (!args.apply) {
    console.log("Would: set a new password, then");
    console.log(args.revokeSessions ? "      sign the account out everywhere." : "      leave existing sessions alone (add --revoke-sessions).");
    console.log("\nNo changes were made.");
    return;
  }

  const newPassword = args.passwordStdin || !process.stdin.isTTY
    ? await readStdin()
    : await promptHidden("New password (not echoed): ");

  if (newPassword.length < args.minimumLength) {
    fail(`the new password is shorter than ${args.minimumLength} characters`);
  }
  if (newPassword === args.email) fail("refusing a password that is the email address");

  const updated = await admin(`/users/${user.id}`, {
    method: "PUT",
    body: JSON.stringify({ password: newPassword }),
  });
  if (!updated.ok) fail(`password update failed (${updated.status}): ${JSON.stringify(updated.body).slice(0, 200)}`);
  console.log("✓ password updated");

  if (args.revokeSessions) {
    // GoTrue exposes "log out a user" as POST /admin/users/{id}/logout. If the
    // endpoint is not available, rotating the project's JWT secret is the
    // remaining way to invalidate every access token at once.
    const logout = await admin(`/users/${user.id}/logout`, { method: "POST" });
    if (logout.ok) {
      console.log("✓ every session for the account revoked");
    } else {
      console.log(`! session revocation returned ${logout.status}.`);
      console.log("  Rotate the project's JWT secret to invalidate all access tokens, then re-issue the anon key.");
    }
  } else {
    console.log("! existing sessions were left alone: add --revoke-sessions to end them");
  }

  // Prove the new credential works, then drop the session it creates.
  const verify = await fetch(`${process.env.SUPABASE_URL.replace(/\/$/, "")}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { apikey: process.env.SUPABASE_SERVICE_ROLE_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({ email: args.email, password: newPassword }),
  });
  if (verify.ok) {
    const session = await verify.json().catch(() => null);
    console.log("✓ the new password authenticates");
    if (session?.access_token) {
      await fetch(`${process.env.SUPABASE_URL.replace(/\/$/, "")}/auth/v1/logout`, {
        method: "POST",
        headers: { apikey: process.env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${session.access_token}` },
      }).catch(() => undefined);
    }
  } else {
    console.log("! the new password could not be verified by signing in (check email confirmation settings)");
  }

  console.log("\nStill required, out of band:");
  console.log("  • change the password on the email account itself");
  console.log("  • change it anywhere else it was reused, and review that provider's sign-in history");
  console.log("  • revoke active BFF sessions: they hold tokens issued before the rotation");
  console.log("  • confirm no new sign-ins from unfamiliar IPs since the leak");
}

main().catch((error) => fail(error instanceof Error ? error.message : String(error)));
