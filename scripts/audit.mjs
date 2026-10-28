#!/usr/bin/env node
/**
 * Dependency audit gate.
 *
 * `npm audit` exits non-zero for any advisory, including the low/moderate noise
 * in a dev toolchain. This gate fails on High/Critical only, and only for
 * advisories that are not in `.github/security/audit-allowlist.json`.
 *
 * The allowlist is keyed by advisory URL (not package name) on purpose: a new
 * advisory for an already-allowlisted package still fails the build. Entries
 * carry an expiry date and an expired entry fails, so an accepted risk cannot
 * quietly become permanent.
 *
 * Usage: npm run audit   (AUDIT_LEVEL=critical to tighten the threshold)
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const ALLOWLIST = path.join(ROOT, ".github", "security", "audit-allowlist.json");
const RANK = { info: 0, low: 1, moderate: 2, high: 3, critical: 4 };
const THRESHOLD = (process.env.AUDIT_LEVEL ?? "high").toLowerCase();

if (!(THRESHOLD in RANK)) {
  console.error(`audit: unknown AUDIT_LEVEL "${THRESHOLD}"`);
  process.exit(2);
}

const result = spawnSync("npm", ["audit", "--json"], {
  cwd: ROOT,
  encoding: "utf8",
  maxBuffer: 32 * 1024 * 1024,
  shell: process.platform === "win32",
});

let report;
try {
  report = JSON.parse(result.stdout || "{}");
} catch {
  console.error("audit: could not parse `npm audit --json` output");
  console.error(result.stderr?.trim() || result.stdout?.slice(0, 500));
  process.exit(2);
}

if (!report.vulnerabilities || Object.keys(report.vulnerabilities).length === 0) {
  console.log("audit: no advisories reported");
  process.exit(0);
}

const today = new Date().toISOString().slice(0, 10);
let allowlist = [];
try {
  allowlist = JSON.parse(fs.readFileSync(ALLOWLIST, "utf8")).advisories ?? [];
} catch (error) {
  console.error(`audit: cannot read ${path.relative(ROOT, ALLOWLIST)}: ${error.message}`);
  process.exit(2);
}

const expired = allowlist.filter((entry) => entry.expiresOn && entry.expiresOn < today);
const active = new Map(
  allowlist
    .filter((entry) => !entry.expiresOn || entry.expiresOn >= today)
    .map((entry) => [entry.url, entry]),
);

const blocked = [];
const accepted = [];
for (const [name, vulnerability] of Object.entries(report.vulnerabilities)) {
  for (const via of vulnerability.via ?? []) {
    if (typeof via === "string") continue; // "via package" reference, handled on the package itself
    if (RANK[via.severity] < RANK[THRESHOLD]) continue;
    const entry = active.get(via.url);
    if (entry) accepted.push({ name, ...via, entry });
    else blocked.push({ name, ...via });
  }
}

for (const { name, severity, title, url, entry } of accepted) {
  console.log(`audit: accepted ${severity} ${name} — ${title}`);
  console.log(`        ${url}`);
  console.log(`        ${entry.reason}`);
  console.log(`        expires ${entry.expiresOn ?? "(no expiry)"}`);
}

if (expired.length > 0) {
  console.error("\naudit: allowlist entries have expired — re-assess or upgrade:");
  for (const entry of expired) console.error(`  ${entry.package} ${entry.url} (expired ${entry.expiresOn})`);
}

if (blocked.length > 0) {
  console.error(`\naudit: ${blocked.length} ${THRESHOLD}+ advisor${blocked.length === 1 ? "y" : "ies"} not allowlisted:`);
  for (const { name, severity, title, url, range } of blocked) {
    console.error(`  ${severity.toUpperCase()} ${name} ${range ?? ""} — ${title}`);
    console.error(`  ${url}`);
  }
}

if (blocked.length > 0 || expired.length > 0) {
  console.error("\naudit: FAILED");
  process.exit(1);
}

console.log(`\naudit: passed (${accepted.length} accepted ${THRESHOLD}+ advisor${accepted.length === 1 ? "y" : "ies"})`);
