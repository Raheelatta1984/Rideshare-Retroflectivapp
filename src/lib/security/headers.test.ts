import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Security headers are configuration, not code, so nothing else in the test
 * suite would notice them disappearing. GitHub Pages cannot serve headers at
 * all, which is why the CSP also has to exist as a `<meta>` tag in the pages
 * that ship to it.
 */

// Vitest runs from the repository root; `import.meta.url` is an http URL under
// the jsdom environment, so the module URL cannot be used to locate files.
const ROOT = process.cwd();
const read = (relative: string) => fs.readFileSync(path.join(ROOT, relative), "utf8");

interface HeaderGroup {
  source: string;
  headers: Array<{ key: string; value: string }>;
}

const vercel = JSON.parse(read("vercel.json")) as { headers: HeaderGroup[] };
const flat = vercel.headers.flatMap((group) => group.headers);
const header = (name: string) => flat.find((entry) => entry.key.toLowerCase() === name.toLowerCase())?.value ?? "";

describe("vercel.json security headers", () => {
  it("applies to every path", () => {
    expect(vercel.headers.map((group) => group.source)).toEqual(["/(.*)"]);
  });

  it("sends the baseline header set", () => {
    expect(header("X-Content-Type-Options")).toBe("nosniff");
    expect(header("Referrer-Policy")).toBe("strict-origin-when-cross-origin");
    expect(header("X-Frame-Options")).toBe("DENY");
    expect(header("Strict-Transport-Security")).toContain("max-age=31536000");
    expect(header("Strict-Transport-Security")).not.toContain("preload");
  });

  it("carries the CSP directives a <meta> tag cannot express", () => {
    const policy = header("Content-Security-Policy");
    expect(policy).toContain("frame-ancestors 'none'");
    expect(policy).toContain("object-src 'none'");
    expect(policy).toContain("base-uri 'none'");
    expect(policy).toContain("form-action 'self'");
    // The full policy (with the bundle hash) is injected per-build; a script-src
    // here could only be satisfied by 'unsafe-inline'.
    expect(policy).not.toContain("script-src");
    expect(policy).not.toContain("unsafe-inline");
  });

  it("keeps browser features the app does not use switched off", () => {
    const policy = header("Permissions-Policy");
    expect(policy).toContain("camera=()");
    expect(policy).toContain("microphone=()");
    expect(policy).toContain("payment=()");
    // The motion-safety gate reads location while parked, so it must stay usable.
    expect(policy).toContain("geolocation=(self)");
  });
});

describe("static pages that cannot rely on headers", () => {
  it("tablet.html ships its own CSP and has no inline script", () => {
    const html = read("public/tablet.html");

    expect(html).toMatch(/<meta http-equiv="Content-Security-Policy" content="[^"]*script-src 'self'/);
    expect(html).not.toMatch(/script-src[^;]*unsafe-inline/);
    expect(html).not.toMatch(/<script\b(?![^>]*\bsrc=)[^>]*>[\s\S]*?<\/script>/i);
    expect(html).toContain('src="./tablet.js"');
    expect(fs.existsSync(path.join(ROOT, "public/tablet.js"))).toBe(true);
  });

  it("index.html has no inline handlers and no inline script body", () => {
    const html = read("index.html");

    expect(html).not.toMatch(/\son[a-z]+\s*=/i);
    expect(html).not.toMatch(/<script\b(?![^>]*\bsrc=)[^>]*>[\s\S]*?<\/script>/i);
    expect(html).toContain('src="/src/main.tsx"');
  });
});
