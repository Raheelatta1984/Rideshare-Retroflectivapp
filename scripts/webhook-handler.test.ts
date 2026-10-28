import crypto from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The webhook triggers a deployment, so its signature check is the only thing
 * between "GitHub says push" and "anyone who knows the URL says push".
 *
 * Environment is read at module load, so each case re-imports the module with
 * the secret stubbed. A valid delivery is signed for a non-main branch on
 * purpose: the handler stops there, before it would call the deploy API.
 */

const SECRET = "test-webhook-secret";

function sign(body: string, secret = SECRET): string {
  return `sha256=${crypto.createHmac("sha256", secret).update(body).digest("hex")}`;
}

async function loadHandler() {
  vi.resetModules();
  return import("./webhook-handler");
}

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("GitHub webhook signature", () => {
  it("fails closed when no secret is configured", async () => {
    vi.stubEnv("GITHUB_WEBHOOK_SECRET", "");
    const { handler, verifyGitHubSignature } = await loadHandler();

    expect(verifyGitHubSignature("{}", "")).toBe(false);
    const response = await handler({ headers: {}, body: "{}" });
    expect(response.statusCode).toBe(401);
  });

  it("rejects a missing, malformed or tampered signature without throwing", async () => {
    vi.stubEnv("GITHUB_WEBHOOK_SECRET", SECRET);
    const { handler, verifyGitHubSignature } = await loadHandler();
    const body = JSON.stringify({ ref: "refs/heads/main" });

    expect(verifyGitHubSignature(body, "")).toBe(false);
    expect(verifyGitHubSignature(body, "sha1=deadbeef")).toBe(false);
    expect(verifyGitHubSignature(body, "sha256=short")).toBe(false);
    expect(verifyGitHubSignature(body, sign(body, "wrong-secret"))).toBe(false);
    expect((await handler({ headers: { "x-hub-signature-256": "sha256=abc" }, body })).statusCode).toBe(401);
  });

  it("accepts a correctly signed delivery", async () => {
    vi.stubEnv("GITHUB_WEBHOOK_SECRET", SECRET);
    const { handler } = await loadHandler();
    const body = JSON.stringify({ ref: "refs/heads/feature-not-main" });

    const response = await handler({
      headers: {
        "x-hub-signature-256": sign(body),
        "x-github-event": "push",
      },
      body,
    });

    // Past the signature gate and stopped by the branch check — no deploy call.
    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body).message).toMatch(/only main/i);
  });
});
