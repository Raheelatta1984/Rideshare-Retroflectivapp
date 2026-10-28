import { describe, expect, it } from "vitest";
import {
  DEFAULT_PEER_HOST,
  HEADER_ONLY_DIRECTIVES,
  buildCsp,
  cspSourcesFromEnv,
  peerSignallingOrigins,
} from "./csp";

const HASH = "sha256-AqeO3WtjhJjLoJq3p2az0OBvpaqMNbLL7ILeyzk0zE8=";

function directive(policy: string, name: string): string {
  const match = policy.match(new RegExp(`${name}\\s+([^;]+);`));
  return match ? match[1].trim() : "";
}

describe("CSP policy", () => {
  it("locks down the defaults that do not depend on the deployment", () => {
    const policy = buildCsp();

    expect(directive(policy, "default-src")).toBe("'self'");
    expect(directive(policy, "object-src")).toBe("'none'");
    expect(directive(policy, "base-uri")).toBe("'none'");
    expect(directive(policy, "form-action")).toBe("'self'");
    expect(directive(policy, "script-src")).toBe("'self'");
  });

  it("pins the inlined bundle by hash, never by 'unsafe-inline'", () => {
    const policy = buildCsp({ scriptHashes: [HASH] });

    expect(directive(policy, "script-src")).toBe(`'self' ${HASH}`);
    expect(policy).not.toMatch(/script-src[^;]*unsafe-inline/);
    expect(policy).not.toMatch(/script-src[^;]*unsafe-eval/);
    expect(policy).not.toContain("*");
  });

  it("allows inline styles only, because the build injects a <style> block and React writes style attributes", () => {
    const policy = buildCsp();
    expect(directive(policy, "style-src")).toContain("'unsafe-inline'");
    // No other directive may carry it.
    for (const name of ["default-src", "font-src", "img-src", "connect-src", "media-src"]) {
      expect(directive(policy, name), name).not.toContain("unsafe-inline");
    }
  });

  it("allows exactly the third-party origins that were inventoried", () => {
    const policy = buildCsp();

    expect(directive(policy, "font-src")).toContain("https://fonts.gstatic.com");
    expect(directive(policy, "style-src")).toContain("https://fonts.googleapis.com");
    expect(directive(policy, "img-src")).toContain("https://images.pexels.com");
    expect(directive(policy, "img-src")).toContain("https://api.qrserver.com");
    expect(directive(policy, "connect-src")).toContain(`wss://${DEFAULT_PEER_HOST}`);
    // Nothing else sneaks in.
    expect(policy).not.toMatch(/http:\/\//);
  });

  it("adds the Supabase project only when one is configured", () => {
    const without = buildCsp();
    expect(without).not.toContain("supabase");

    const withProject = buildCsp({ supabaseOrigin: "https://demo.supabase.co/" });
    expect(directive(withProject, "connect-src")).toContain("https://demo.supabase.co");
    expect(directive(withProject, "img-src")).toContain("https://demo.supabase.co");
    // Normalised to an origin: no path, no trailing slash.
    expect(directive(withProject, "connect-src")).not.toContain("supabase.co/");
  });

  it("drops origins that are not http(s)/ws(s) instead of quoting them", () => {
    const policy = buildCsp({
      supabaseOrigin: "javascript:alert(1)",
      relayOrigin: "data:text/html,<script>alert(1)</script>",
      peerSignallingOrigins: ["wss://ok.example", "file:///etc/passwd"],
    });

    expect(policy).not.toContain("javascript:");
    expect(policy).not.toContain("data:text/html");
    expect(policy).not.toContain("file:");
    expect(directive(policy, "connect-src")).toContain("wss://ok.example");
  });

  it("upgrades insecure requests only when asked (production builds)", () => {
    expect(buildCsp()).not.toContain("upgrade-insecure-requests");
    expect(buildCsp({ upgradeInsecureRequests: true })).toContain("upgrade-insecure-requests");
  });

  it("keeps frame-ancestors out of the meta policy, where browsers ignore it", () => {
    expect(buildCsp()).not.toContain("frame-ancestors");
    expect(HEADER_ONLY_DIRECTIVES).toContain("frame-ancestors 'none'");
  });
});

describe("CSP sources from the build environment", () => {
  it("derives PeerJS signalling origins from host and port", () => {
    expect(peerSignallingOrigins()).toEqual([`wss://${DEFAULT_PEER_HOST}`, `https://${DEFAULT_PEER_HOST}`]);
    expect(peerSignallingOrigins("peer.example", 9000)).toEqual([
      "wss://peer.example:9000",
      "https://peer.example:9000",
    ]);
    // A value with whitespace or a semicolon cannot inject a directive.
    expect(peerSignallingOrigins("bad host; script-src *", 443)).toEqual([]);
  });

  it("ignores unset or placeholder env values", () => {
    expect(cspSourcesFromEnv({ VITE_SUPABASE_URL: "$VITE_SUPABASE_URL" })).toEqual({
      supabaseOrigin: undefined,
      relayOrigin: undefined,
      peerSignallingOrigins: peerSignallingOrigins(),
    });

    const configured = cspSourcesFromEnv({
      VITE_SUPABASE_URL: "https://project.supabase.co",
      VITE_RELAY_SERVER: "https://relay.example.com",
      VITE_PEER_HOST: "peer.example.com",
      VITE_PEER_PORT: "443",
    });
    expect(configured.supabaseOrigin).toBe("https://project.supabase.co");
    expect(configured.relayOrigin).toBe("https://relay.example.com");
    expect(configured.peerSignallingOrigins).toEqual(["wss://peer.example.com", "https://peer.example.com"]);
  });
});
