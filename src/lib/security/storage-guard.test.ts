import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Regression guard for the vulnerability class this review is about:
 * credential material written to browser storage, plus the two sinks that make
 * any credential reachable (cookie writes and raw HTML injection).
 *
 * The shipped `src/` tree is scanned — tests are excluded because they are not
 * bundled and legitimately touch `localStorage` to set up scenarios. Every
 * allowed hit has to name a reason, and a stale entry fails: an allowlist that
 * outlives its finding hides the next one.
 */

// Vitest runs from the repository root; `import.meta.url` is an http URL under
// the jsdom environment, so the module URL cannot be used to locate files.
const ROOT = process.cwd();

const CREDENTIAL_STORAGE =
  /(localStorage|sessionStorage)\.(setItem|getItem|removeItem)\s*\(\s*[^,)]{0,40}(token|jwt|auth|session|secret|api[_-]?key|credential|refresh|id_token|access)/i;
const COOKIE_WRITE = /document\.cookie\s*=/;
const RAW_HTML = /dangerouslySetInnerHTML|\.innerHTML\s*=|document\.write\s*\(/;

/**
 * Reviewed exceptions. Each one is a decision recorded in
 * `docs/security/credential-storage-review-2026-10-28.md`, not an oversight.
 */
const ALLOWLIST: Array<{ file: string; why: string }> = [
  {
    file: "src/lib/storage.ts",
    why: "`rf:session` is a local driver id for a browser-only booth, not a bearer credential (finding 5).",
  },
  {
    file: "src/lib/backend/supabase.ts",
    why: "Supabase access/refresh token persistence — DECISION REQUIRED: needs a BFF for HttpOnly cookies (finding 3); opt-in memory mode added.",
  },
];

function sourceFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    if (/\.(test|spec)\.(ts|tsx)$/.test(entry.name)) return [];
    return /\.(ts|tsx|mjs|js)$/.test(entry.name) ? [full] : [];
  });
}

const files = sourceFiles(path.join(ROOT, "src")).map((file) => ({
  file: path.relative(ROOT, file).split(path.sep).join("/"),
  text: fs.readFileSync(file, "utf8"),
}));

function matchingFiles(pattern: RegExp): string[] {
  return files.filter((entry) => pattern.test(entry.text)).map((entry) => entry.file);
}

describe("no credentials in script-readable storage", () => {
  it("has no un-reviewed credential write or read", () => {
    const hits = matchingFiles(CREDENTIAL_STORAGE);
    const allowed = new Set(ALLOWLIST.map((entry) => entry.file));

    expect(hits.filter((hit) => !allowed.has(hit))).toEqual([]);
  });

  it("keeps every allowlist entry honest", () => {
    const hits = new Set(matchingFiles(CREDENTIAL_STORAGE));
    for (const entry of ALLOWLIST) {
      expect(entry.why.length, `${entry.file} needs a reason`).toBeGreaterThan(20);
      expect(hits.has(entry.file), `${entry.file} no longer matches — drop the allowlist entry`).toBe(true);
    }
  });

  it("never writes cookies from JavaScript", () => {
    // A JS-set cookie can never be HttpOnly, so this is the one rule with no
    // allowlist. Session handling belongs in a header or a server response.
    expect(matchingFiles(COOKIE_WRITE)).toEqual([]);
  });

  it("has no raw-HTML sink", () => {
    // React escapes by default; every one of these would bypass that.
    expect(matchingFiles(RAW_HTML)).toEqual([]);
  });
});
