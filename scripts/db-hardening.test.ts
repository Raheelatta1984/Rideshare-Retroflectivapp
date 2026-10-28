// @vitest-environment node
/**
 * The Admin API transport of the reviewer grant.
 *
 * The SQL transport is covered against real PostgreSQL in
 * `supabase/tests/hardening.test.ts`; this covers the transport used when only
 * a service-role key is available, with a stubbed GoTrue admin API.
 *
 * The behaviour that matters here is the merge: GoTrue replaces `app_metadata`
 * wholesale, so a naive update would silently delete every other claim.
 */

import { describe, expect, it } from "vitest";
import { grantReviewerViaApi } from "./db-hardening.mjs";

interface Call {
  url: string;
  method: string;
  body: unknown;
}

function adminApi(handler: (url: string, method: string, body: unknown) => { status?: number; body?: unknown }) {
  const calls: Call[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = String(input);
    const method = (init.method ?? "GET").toUpperCase();
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ url, method, body });
    const { status = 200, body: payload = {} } = handler(url, method, body);
    // 204/205 must not carry a body, and the Response constructor enforces it.
    const nullBody = status === 204 || status === 205;
    return new Response(nullBody ? null : JSON.stringify(payload), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

const base = { baseUrl: "https://project.supabase.co", serviceRoleKey: "service-key" };

describe("grantReviewerViaApi", () => {
  it("finds the account case-insensitively", async () => {
    const { fetchImpl, calls } = adminApi(() => ({
      body: { users: [{ id: "user-1", email: "Tic.Raheel@Gmail.com", app_metadata: {} }] },
    }));
    const result = await grantReviewerViaApi({ ...base, email: "tic.raheel@gmail.com", fetchImpl });
    expect(result).toMatchObject({ ok: true, dryRun: true, userId: "user-1", wouldGrant: true });
    expect(calls[0].url).toBe("https://project.supabase.co/auth/v1/admin/users?page=1&per_page=200");
    expect(calls[0].url).not.toContain("service-key");
  });

  it("merges app_metadata instead of replacing it", async () => {
    const { fetchImpl, calls } = adminApi((_url, method) => {
      if (method === "PUT") return { body: {} };
      return { body: { users: [{ id: "user-1", email: "tic.raheel@gmail.com", app_metadata: { plan: "fleet", tenant: "au" } }] } };
    });
    const result = await grantReviewerViaApi({ ...base, email: "tic.raheel@gmail.com", apply: true, fetchImpl });
    expect(result).toMatchObject({ ok: true, role: "admin", alreadyAdmin: false });

    const put = calls.find((call) => call.method === "PUT");
    expect(put?.url).toBe("https://project.supabase.co/auth/v1/admin/users/user-1");
    expect(put?.body).toEqual({ app_metadata: { plan: "fleet", tenant: "au", role: "admin" } });
  });

  it("does not rewrite an account that is already a reviewer", async () => {
    const { fetchImpl, calls } = adminApi(() => ({
      body: { users: [{ id: "user-1", email: "tic.raheel@gmail.com", app_metadata: { role: "admin" } }] },
    }));
    const result = await grantReviewerViaApi({ ...base, email: "tic.raheel@gmail.com", apply: true, fetchImpl });
    expect(result).toMatchObject({ ok: true, alreadyAdmin: true });
    expect(calls.filter((call) => call.method === "PUT")).toHaveLength(0);
  });

  it("says the account must exist first", async () => {
    const { fetchImpl } = adminApi(() => ({ body: { users: [] } }));
    const result = await grantReviewerViaApi({ ...base, email: "tic.raheel@gmail.com", apply: true, fetchImpl });
    expect(result).toMatchObject({ ok: false, reason: "no-such-user" });
    expect(result.message).toContain("tic.raheel@gmail.com");
    expect(result.message).toContain("Create or sign up");
  });

  it("ends the account's sessions when asked, and only then", async () => {
    const withRevoke = adminApi((url) =>
      url.endsWith("/logout") ? { status: 204, body: {} } : { body: { users: [{ id: "user-1", email: "tic.raheel@gmail.com", app_metadata: {} }] } },
    );
    const revoked = await grantReviewerViaApi({ ...base, email: "tic.raheel@gmail.com", apply: true, revokeSessions: true, fetchImpl: withRevoke.fetchImpl });
    expect(revoked).toMatchObject({ ok: true, revoked: true });
    expect(withRevoke.calls.some((call) => call.url.endsWith("/users/user-1/logout") && call.method === "POST")).toBe(true);

    const withoutRevoke = adminApi(() => ({ body: { users: [{ id: "user-1", email: "tic.raheel@gmail.com", app_metadata: {} }] } }));
    await grantReviewerViaApi({ ...base, email: "tic.raheel@gmail.com", apply: true, fetchImpl: withoutRevoke.fetchImpl });
    expect(withoutRevoke.calls.some((call) => call.url.endsWith("/logout"))).toBe(false);
  });

  it("reports a rejected update rather than pretending it worked", async () => {
    const { fetchImpl } = adminApi((_url, method) => {
      if (method === "PUT") return { status: 403, body: { message: "forbidden" } };
      return { body: { users: [{ id: "user-1", email: "tic.raheel@gmail.com", app_metadata: {} }] } };
    });
    const result = await grantReviewerViaApi({ ...base, email: "tic.raheel@gmail.com", apply: true, fetchImpl });
    expect(result).toMatchObject({ ok: false, reason: "update-failed" });
  });

  it("refuses to run without a key", async () => {
    await expect(grantReviewerViaApi({ ...base, serviceRoleKey: "", email: "a@b.co" })).rejects.toThrow(/SERVICE_ROLE_KEY/);
  });
});
