import path from "path";
import { fileURLToPath } from "url";
import { promises as fs } from "node:fs";
import type { Plugin } from "vite";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv } from "vite";
import { viteSingleFile } from "vite-plugin-singlefile";
import { buildZipBuffer, ZIP_NAME } from "./scripts/build-zip.mjs";
import { injectCspMeta, inlineScriptHashes } from "./scripts/csp.mjs";
import { buildCsp, cspSourcesFromEnv, type CspSources } from "./src/lib/security/csp.ts";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function zipPlugin(): Plugin {
  return {
    name: "repo-zip-emit",
    apply: "build",
    async closeBundle() {
      try {
        const buffer = await buildZipBuffer();
        const outDir = path.resolve(__dirname, "dist");
        await fs.mkdir(outDir, { recursive: true });
        await fs.writeFile(path.join(outDir, ZIP_NAME), buffer);

        const publicDir = path.resolve(__dirname, "public");
        await fs.mkdir(publicDir, { recursive: true });
        await fs.writeFile(path.join(publicDir, ZIP_NAME), buffer);
      } catch (err) {
        console.warn("zip emit failed", err);
      }
    },
  };
}

/**
 * Write the Content-Security-Policy into the built document.
 *
 * It has to happen after `vite-plugin-singlefile` has inlined the bundle,
 * because the policy pins that exact script by hash. GitHub Pages cannot send
 * response headers at all, so a `<meta>` policy is the only CSP that reaches
 * that deployment; `vercel.json` adds the directives a meta tag cannot carry.
 */
function cspPlugin(sources: Omit<CspSources, "scriptHashes">): Plugin {
  return {
    name: "repo-csp-meta",
    apply: "build",
    async closeBundle() {
      const file = path.resolve(__dirname, "dist", "index.html");
      const html = await fs.readFile(file, "utf8");
      const hashes = inlineScriptHashes(html);
      if (hashes.length === 0) {
        throw new Error("csp: the built document has no inline script to pin — refusing to emit a policy");
      }
      const policy = buildCsp({ ...sources, scriptHashes: hashes, upgradeInsecureRequests: true });
      await fs.writeFile(file, injectCspMeta(html, policy));
    },
  };
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, __dirname, "");

  return {
    // Relative base so the same build works at a domain root (Vercel) and at a
    // GitHub Pages project subpath (/Rideshare-Retroflectivapp/). Routing is
    // hash-based, so the document path never changes and relative URLs stay valid.
    base: "./",
    plugins: [react(), tailwindcss(), viteSingleFile(), zipPlugin(), cspPlugin(cspSourcesFromEnv(env))],
    resolve: {
      alias: {
        "@": path.resolve(__dirname, "src"),
      },
    },
    // Dev/preview only (never used by the static Vercel deploy).
    // Needed so the app is reachable through forwarded hosts: Codespaces,
    // tunnels, and any sandbox proxy that rewrites the Host header.
    server: {
      host: true,
      allowedHosts: true,
    },
    preview: {
      host: true,
      allowedHosts: true,
    },
  };
});
