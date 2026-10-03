import path from "path";
import { fileURLToPath } from "url";
import { promises as fs } from "node:fs";
import type { Plugin } from "vite";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { viteSingleFile } from "vite-plugin-singlefile";
import { buildZipBuffer, ZIP_NAME } from "./scripts/build-zip.mjs";

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

export default defineConfig({
  // Relative base so the same build works at a domain root (Vercel) and at a
  // GitHub Pages project subpath (/Rideshare-Retroflectivapp/). Routing is
  // hash-based, so the document path never changes and relative URLs stay valid.
  base: "./",
  plugins: [react(), tailwindcss(), viteSingleFile(), zipPlugin()],
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
});