import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, delimiter } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

// Exercise the real gate with a fake npm process, never the network.
describe.skipIf(process.platform === "win32")("dependency audit gate", () => {
  function run(report: unknown, status: number) {
    const dir = mkdtempSync(join(tmpdir(), "rf-audit-"));
    try {
      writeFileSync(join(dir, "npm"), `#!/bin/sh\nprintf '%s' '${JSON.stringify(report)}'\nexit ${status}\n`, { mode: 0o755 });
      return spawnSync(process.execPath, ["scripts/audit.mjs"], {
        cwd: process.cwd(), encoding: "utf8", env: { ...process.env, PATH: `${dir}${delimiter}${process.env.PATH}`, AUDIT_LEVEL: "high" },
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it("accepts a valid clean report", () => {
    expect(run({ vulnerabilities: {} }, 0).status).toBe(0);
  });

  it("fails closed on registry errors and malformed reports", () => {
    expect(run({ error: { summary: "registry unavailable" } }, 1).status).toBe(2);
    expect(run({}, 0).status).toBe(2);
    expect(run({ vulnerabilities: {} }, 2).status).toBe(2);
  });

  it("blocks high severity advisories", () => {
    expect(run({ vulnerabilities: { example: { via: [{ severity: "high", title: "example", url: "https://example.com/advisory" }] } } }, 1).status).toBe(1);
  });
});
