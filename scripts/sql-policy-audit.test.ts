/**
 * Static audit of the Supabase migrations.
 *
 * The RLS integration suite (supabase/tests/rls.test.ts) proves the policies
 * behave; this file proves the *migrations* stay honest as they grow, which is
 * the failure mode that matters: a later migration quietly re-adding
 * `using (true)` would pass every behavioural test written against the seed
 * data. These checks fail the build instead.
 */

import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dir = path.join(root, "supabase", "migrations");

const files = readdirSync(dir).filter((name) => name.endsWith(".sql")).sort();
const migration = (name: string) => readFileSync(path.join(dir, name), "utf8");
const legacy = files.filter((name) => name < "0005").map(migration).join("\n");
const hardened = files.filter((name) => name >= "0005").map(migration).join("\n");
const all = files.map(migration).join("\n");

/** Policies deliberately kept because they are owner-scoped or public config. */
const RETAINED = new Set(["booths_own", "id_shards_read", "image_machines_read", "image_shards_read"]);

function createdPolicies(sql: string): Map<string, string> {
  const found = new Map<string, string>();
  const pattern = /create policy\s+"?([a-z0-9_]+)"?\s+on\s+([a-z0-9_."]+)/gi;
  for (const match of sql.matchAll(pattern)) found.set(match[1], match[2]);
  return found;
}

function droppedPolicies(sql: string): Set<string> {
  const found = new Set<string>();
  for (const match of sql.matchAll(/drop policy if exists\s+"?([a-z0-9_]+)"?/gi)) found.add(match[1]);
  return found;
}

describe("migration safety", () => {
  it("finds the migrations it is auditing", () => {
    expect(files.length).toBeGreaterThanOrEqual(5);
    expect(legacy).toContain("create policy campaigns_read");
    expect(hardened).toContain("create policy campaigns_own_read");
  });

  it("replaces or explicitly keeps every legacy policy", () => {
    const created = createdPolicies(legacy);
    const dropped = droppedPolicies(hardened);
    const surviving = [...created.keys()].filter((name) => !dropped.has(name) && !RETAINED.has(name));
    expect(surviving).toEqual([]);
  });

  it("never re-introduces a permissive policy in the hardened migrations", () => {
    const permissive = [
      ...hardened.matchAll(/create policy[\s\S]*?(using|with check)\s*\(\s*true\s*\)/gi),
    ];
    expect(permissive.map((match) => match[0].split("\n")[0])).toEqual([]);
  });

  it("keeps the retained policies narrow", () => {
    expect(migration("0003_terminal_signup.sql")).toMatch(/booths_own[\s\S]*?owner = auth\.uid\(\)/);
    // Public reads on the shard/machine map are infrastructure config, not data.
    for (const name of ["id_shards_read", "image_machines_read", "image_shards_read"]) {
      expect(all).toMatch(new RegExp(`create policy ${name} on public\\.[a-z_]+\\s+for select using \\(true\\)`, "i"));
    }
  });

  it("denies anonymous access to the campaign tables and exposes only the projection", () => {
    expect(hardened).toMatch(/revoke all on public\.campaigns from anon/);
    expect(hardened).toMatch(/revoke all on public\.approval_audit from anon/);
    expect(hardened).toMatch(/revoke all on public\.campaign_events from anon/);
    expect(hardened).toMatch(/grant select on public\.public_campaigns to anon/);
    expect(hardened).toMatch(/where c\.approval_state = 'approved'/);
  });

  it("removes the enumerable pair-code directory view", () => {
    expect(hardened).toMatch(/drop view if exists public\.booth_directory/);
    expect(hardened).toMatch(/revoke all on public\.booths from anon/);
    // The replacement returns a position and nothing else.
    expect(hardened).toMatch(/'position', case when v_booth\.front_pair_code = v_code then 'front' else 'rear' end/);
    expect(hardened).not.toMatch(/'owner', v_booth/);
  });

  it("makes every security-definer function pin its search_path", () => {
    let index = 0;
    while ((index = all.toLowerCase().indexOf("security definer", index)) !== -1) {
      const window = all.slice(index, index + 400).toLowerCase();
      expect(window).toContain("set search_path");
      index += "security definer".length;
    }
  });

  it("never grants a write privilege to anon", () => {
    const grants = [...all.matchAll(/grant\s+([a-z, ]+)\s+on\s+([a-z0-9_."]+)\s+to\s+([a-z, ]+)/gi)];
    const risky = grants
      .filter(([, privileges, , roles]) => /anon/.test(roles) && /(insert|update|delete|all)/i.test(privileges))
      // campaign_events INSERT is the one anonymous write, and it is scoped by
      // a policy that only matches approved campaigns.
      .filter(([, privileges, target]) => !(/insert/i.test(privileges) && /campaign_events/.test(target)));
    expect(risky.map((match) => match[0])).toEqual([]);
  });
});
